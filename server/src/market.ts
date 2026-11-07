// Live market views shared by the HTTP API and the MCP server: rank the stores
// selling an item using sellers' standing staked claims, and quote sellers the
// expected cost of a stake. Numbers come from the model and the rules only.
import type { DB } from './db.ts';
import { nowIso } from './db.ts';
import { buildGroups, features, loadListings, type Listing } from './features.ts';
import { explain, loadModel, loadReplayModel, predict } from './model.ts';
import { judge, makeTerms, round2, type ClaimType } from './rules.ts';
import { sellerAccount } from './sellers.ts';
import { adjustForStore, expectedLoss, expectedSellerCost, rank, storeLabel, type Candidate, type Risk } from './score.ts';

export interface StandingClaim {
  product_id: string;
  domain: string;
  claim_type: ClaimType;
  stake_usd: number;
  window_kind?: 'bf' | '14' | null; // no_price_drop only: until the day after Black Friday, or 14 days
}

export function standingClaims(db: DB, productId?: string): StandingClaim[] {
  const sql = `SELECT product_id, domain, claim_type, stake_usd, window_kind FROM seller_claims WHERE active = 1` + (productId ? ' AND product_id = ?' : '');
  return (productId ? db.prepare(sql).all(productId) : db.prepare(sql).all()) as unknown as StandingClaim[];
}

export function setStandingClaim(db: DB, c: StandingClaim & { active: boolean }) {
  db.prepare(
    `INSERT INTO seller_claims (product_id, domain, claim_type, stake_usd, active, updated_at, window_kind) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id, claim_type) DO UPDATE SET stake_usd=excluded.stake_usd, active=excluded.active, updated_at=excluded.updated_at, window_kind=excluded.window_kind`,
  ).run(c.product_id, c.domain, c.claim_type, c.stake_usd, c.active ? 1 : 0, nowIso(), c.window_kind ?? null);
}

// Live track record per store from judged live contracts.
// A store with its own PayPal seller also carries every contract paid to that
// merchant, so renaming the site does not reset the record. Its own site's
// contracts always count, so switching PayPal accounts does not clear it either.
// asOf: only verdicts reached on or before that day (replays see no future record).
export function liveRecord(db: DB, domain: string, asOf?: string): { hits: number; misses: number } {
  const acct = sellerAccount(db, domain);
  const r = db
    .prepare(
      `SELECT SUM(c.status='hit') AS hits, SUM(c.status='miss') AS misses FROM contracts c
       WHERE c.mode='live' AND (c.domain = ? OR (? IS NOT NULL AND c.paypal_merchant_id = ?))
         AND (? IS NULL OR EXISTS (SELECT 1 FROM judgments j WHERE j.contract_id = c.id AND substr(j.judged_at, 1, 10) <= ?))`,
    )
    .get(domain, acct?.merchant_id ?? null, acct?.merchant_id ?? null, asOf ?? null, asOf ?? null) as { hits: number | null; misses: number | null };
  return { hits: r.hits ?? 0, misses: r.misses ?? 0 };
}

export function marketGroups(db: DB) {
  return buildGroups(loadListings(db));
}

function latestDay(l: Listing): string | undefined {
  return [...l.series.keys()].sort().at(-1);
}

function risksFor(db: DB, l: Listing, peers: Listing[], claims: StandingClaim[]): { risks: Risk[]; price: number; day: string } | null {
  const day = latestDay(l);
  if (!day) return null;
  const price = l.series.get(day)!;
  const drop = loadModel('drop14');
  const lowest = loadModel('lowest7');
  const rec = liveRecord(db, l.domain);
  const f = features(l, day, peers);
  const stake = (t: ClaimType) => claims.find((c) => c.claim_type === t)?.stake_usd ?? 0;

  const pdm = f ? predict(drop, f) : (drop.data.positive_rate_train as number);
  const pd = adjustForStore(pdm, rec.hits, rec.misses);
  const hd = drop.shortfall_fraction.mean * price;
  const risks: Risk[] = [{ claim: 'no_price_drop', p_model: pdm, p_fail: pd, harm_usd: hd, stake_usd: stake('no_price_drop'), expected_loss_usd: expectedLoss(pd, hd, stake('no_price_drop')), source: f ? 'model drop14' : 'base rate' }];

  if (claims.some((c) => c.claim_type === 'lowest_price')) {
    const others = peers.filter((p) => p.product_id !== l.product_id).map((p) => p.series.get(day)).filter((x): x is number => x !== undefined);
    const gmin = others.length ? Math.min(...others) : price;
    const isMin = price <= gmin + 0.01;
    const pm = isMin ? (f ? predict(lowest, f) : (lowest.data.positive_rate_train as number)) : 1;
    const p = isMin ? adjustForStore(pm, rec.hits, rec.misses) : 1;
    const harm = isMin ? lowest.shortfall_fraction.mean * price : price - gmin;
    risks.push({ claim: 'lowest_price', p_model: pm, p_fail: p, harm_usd: harm, stake_usd: stake('lowest_price'), expected_loss_usd: expectedLoss(p, harm, stake('lowest_price')), source: isMin ? 'model lowest7' : 'already undercut' });
  }
  if (claims.some((c) => c.claim_type === 'genuine_sale')) {
    const t = makeTerms({ claim_type: 'genuine_sale', product_id: l.product_id, domain: l.domain, group_key: l.group_key, purchase_price: price, purchase_day: day, stake_usd: stake('genuine_sale') });
    const v = judge(t, { listing: l.series });
    const p = v.outcome === 'miss' ? 1 : 0;
    const harm = v.outcome === 'miss' ? Math.max(0, v.evidence_missing ? stake('genuine_sale') : price - ((v.used as any).threshold ?? price)) : 0;
    risks.push({ claim: 'genuine_sale', p_model: p, p_fail: p, harm_usd: harm, stake_usd: stake('genuine_sale'), expected_loss_usd: expectedLoss(p, harm, stake('genuine_sale')), source: 'rule on prior 30 days' });
  }
  return { risks, price, day };
}

// claimsOverride: hypothetical stakes used instead of the sellers' standing
// claims (experiments); nothing is written.
export function rankGroup(db: DB, groupKey: string, weight = 1, claimsOverride?: StandingClaim[]) {
  const g = marketGroups(db).get(groupKey);
  if (!g) throw new Error(`Unknown product group ${groupKey}`);
  const claims = claimsOverride ?? standingClaims(db);
  const cands: Candidate[] = [];
  let asOf = '';
  for (const l of g) {
    const mine = claims.filter((c) => c.product_id === l.product_id);
    const r = risksFor(db, l, g, mine);
    if (!r) continue;
    asOf = r.day > asOf ? r.day : asOf;
    const rec = liveRecord(db, l.domain);
    cands.push({ product_id: l.product_id, domain: l.domain, store: storeLabel(l.domain), price: r.price, hits: rec.hits, misses: rec.misses, risks: r.risks });
  }
  return { group_key: groupKey, as_of_day: asOf, weight, ranking: rank(cands, weight).map(({ domain, ...rest }) => ({ ...rest, staked_claims: claims.filter((c) => c.product_id === rest.product_id).map(({ domain: _d, ...c }) => c) })) };
}

export interface Quote {
  product_id: string;
  store: string;
  claim_type: ClaimType;
  stake_usd: number;
  price: number;
  as_of_day: string;
  p_fail: number | null;
  expected_shortfall_usd: number | null;
  expected_cost_per_order_usd: number | null;
  coupon_equivalent_pct: number | null;
  recommendation: string;
  drivers: { feature: string; contribution: number }[];
  model: { target: string; trained_at: string } | null;
}

export function quote(db: DB, productId: string, claimType: ClaimType, stake: number): Quote {
  const listings = loadListings(db);
  const l = listings.find((x) => x.product_id === productId);
  if (!l) throw new Error(`Product ${productId} has no single-store price history`);
  const groups = buildGroups(listings);
  const peers = [...groups.values()].find((ls) => ls.some((x) => x.product_id === productId)) ?? [];
  const day = latestDay(l)!;
  const price = l.series.get(day)!;
  const rec = liveRecord(db, l.domain);
  const f = features(l, day, peers);
  const base = { product_id: productId, store: storeLabel(l.domain), claim_type: claimType, stake_usd: stake, price, as_of_day: day };

  const fromModel = (target: 'drop14' | 'lowest7', pOverride?: number): Quote => {
    const m = loadModel(target);
    const pm = pOverride ?? (f ? predict(m, f) : (m.data.positive_rate_train as number));
    const p = adjustForStore(pm, rec.hits, rec.misses);
    const shortfall = m.shortfall_fraction.mean * price;
    const cost = expectedSellerCost(p, shortfall, stake);
    const rec_ =
      p > 0.5
        ? 'Not recommended: this claim is more likely to fail than hold. Fix the price or catalog first.'
        : stake > shortfall * 1.5
          ? `Stake above the expected shortfall ($${shortfall.toFixed(2)}) adds no ranking benefit.`
          : `Expected cost $${cost.toFixed(2)} per order for a $${stake.toFixed(2)} stake.`;
    return { ...base, p_fail: p, expected_shortfall_usd: round2(shortfall), expected_cost_per_order_usd: round2(cost), coupon_equivalent_pct: round2((cost / price) * 100), recommendation: rec_, drivers: f ? explain(m, f) : [], model: { target, trained_at: m.trained_at } };
  };

  switch (claimType) {
    case 'no_price_drop':
      return fromModel('drop14');
    case 'lowest_price': {
      const others = peers.filter((p) => p.product_id !== productId).map((p) => p.series.get(day)).filter((x): x is number => x !== undefined);
      if (others.length === 0) return { ...base, p_fail: null, expected_shortfall_usd: null, expected_cost_per_order_usd: null, coupon_equivalent_pct: null, recommendation: 'No other store with price data sells this item; lowest_price cannot be judged.', drivers: [], model: null };
      const gmin = Math.min(...others);
      if (price > gmin + 0.01) return { ...base, p_fail: 1, expected_shortfall_usd: round2(price - gmin), expected_cost_per_order_usd: round2(Math.min(stake, price - gmin)), coupon_equivalent_pct: round2((Math.min(stake, price - gmin) / price) / 100 * 10000), recommendation: `Not recommended: another store is $${(price - gmin).toFixed(2)} cheaper today. Every order would pay out.`, drivers: [], model: null };
      return fromModel('lowest7');
    }
    case 'genuine_sale': {
      const t = makeTerms({ claim_type: 'genuine_sale', product_id: productId, domain: l.domain, group_key: l.group_key, purchase_price: price, purchase_day: day, stake_usd: stake });
      const v = judge(t, { listing: l.series });
      const cost = v.outcome === 'miss' ? v.payout_usd : 0;
      return { ...base, p_fail: v.outcome === 'miss' ? 1 : 0, expected_shortfall_usd: null, expected_cost_per_order_usd: cost, coupon_equivalent_pct: round2((cost / price) * 100), recommendation: v.outcome === 'miss' ? `Not recommended: ${v.reason}` : `Holds today: ${v.reason}`, drivers: [], model: null };
    }
    case 'in_stock':
      return { ...base, p_fail: null, expected_shortfall_usd: null, expected_cost_per_order_usd: null, coupon_equivalent_pct: null, recommendation: 'Judged from the Channel3 availability at purchase; not modelled.', drivers: [], model: null };
  }
}

// Probability that a listing's price drops within `windowDays`, for promises
// longer than the 14-day model horizon (e.g. "until the day after Black
// Friday"). APPROXIMATION: the 14-day model is chained over consecutive
// 14-day blocks, moving only the days-to-Black-Friday feature forward; a
// partial block counts in proportion to its length. The training data holds
// no Black Friday, so the holiday effect is an extrapolation.
// asOf (replays): every series is cut at that day first and the track record
// counts only verdicts reached by then, so nothing after asOf is visible.
// For `asOf`, `loadReplayModel` picks either the temporal model trained only on
// 14-day windows resolved on or before `asOf` (t <= asOf - 14), or for earlier
// days before 14-day windows resolved, the out-of-group model trained with this
// product group held out.
export function cutAt(listings: Listing[], asOf: string): Listing[] {
  return listings.map((l) => ({ ...l, series: new Map([...l.series].filter(([d]) => d <= asOf)) }));
}

export function dropRisk(db: DB, productId: string, windowDays: number, asOf?: string): { p_drop: number; expected_drop_usd: number; method: string } {
  const all = loadListings(db);
  const fullGroup = [...buildGroups(all).entries()].find(([, ls]) => ls.some((x) => x.product_id === productId));
  const listings = asOf ? cutAt(all, asOf) : all;
  const l = listings.find((x) => x.product_id === productId);
  if (!l) throw new Error(`Product ${productId} has no single-store price history`);
  const peers = [...buildGroups(listings).values()].find((ls) => ls.some((x) => x.product_id === productId)) ?? [];
  const day = latestDay(l);
  if (!day) throw new Error(`Product ${productId} has no price on or before ${asOf}`);
  const price = l.series.get(day)!;
  const unit = fullGroup?.[0] ?? l.group_key ?? l.product_id;
  // A 7-day replay window uses the 7-day leak-free model (seller-agent simulation).
  const H = asOf && windowDays === 7 ? 7 : 14;
  const m = asOf ? loadReplayModel(asOf, unit, H) : loadModel('drop14');
  const baseRate = 'positive_rate_train' in m && m.positive_rate_train !== undefined ? m.positive_rate_train : ((m as any).data.positive_rate_train as number);
  const f = features(l, day, peers);
  const rec = liveRecord(db, l.domain, asOf);
  let noDrop = 1;
  for (let start = 0; start < windowDays; start += H) {
    const len = Math.min(H, windowDays - start);
    const pm = f ? predict(m, { ...f, days_to_black_friday: f.days_to_black_friday - start / 30 }) : baseRate;
    noDrop *= (1 - adjustForStore(pm, rec.hits, rec.misses)) ** (len / H);
  }
  const method = asOf
    ? (m as any).kind === 'as_of'
      ? `as-of ${(m as any).as_of_model} ${H}-day model (trained on ${(m as any).n_train} windows resolved by ${(m as any).cutoff_day}+${H}d)`
      : `out-of-group model (this product group excluded from training; <300 windows resolved by ${asOf})`
    : windowDays <= 14
      ? '14-day model'
      : `14-day model chained over ${windowDays} days (approximation)`;
  return {
    p_drop: 1 - noDrop,
    expected_drop_usd: round2(m.shortfall_fraction.mean * price),
    method,
  };
}
