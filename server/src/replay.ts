// Replay: real Channel3 daily prices, hypothetical stakes. Each day the agent
// ranks the stores selling the same item, buyers split by effective cost, and
// every claim on every order is judged by the same rules as live contracts
// once its window has passed. Store accuracy updates only from verdicts that
// were knowable on that day.
import { buildGroups, features, isTestUnit, loadListings, type Listing } from './features.ts';
import type { DB } from './db.ts';
import { groupLabel } from './labels.ts';
import { loadModel, predict } from './model.ts';
import { judge, makeTerms, type ClaimType, type Terms, type Verdict } from './rules.ts';
import { adjustForStore, expectedLoss, rank, shares, storeLabel, type Candidate, type Risk } from './score.ts';

export interface StakedClaim {
  domain: string;
  claim_type: Exclude<ClaimType, 'in_stock'>;
  stake_usd: number;
}

export interface ReplayParams {
  group_key: string;
  claims: StakedClaim[];
  buyers_per_day: number;
  weight: number; // agent's weight on unprotected expected loss
  tau_usd: number; // choice sensitivity
}

export interface DayStore {
  day: string;
  store: string;
  price: number;
  share: number;
  orders: number;
  rank: number;
  accuracy: number;
  p_drop: number;
  expected_loss_usd: number;
  effective_cost_usd: number;
  payout_usd: number; // paid on verdicts reached this day
  cum_payout_usd: number;
  cum_orders: number;
  hits: number;
  misses: number;
}

export interface ReplayContract {
  id: string;
  store: string;
  terms: Terms;
  orders: number;
  verdict: (Verdict & { judged_day: string }) | null;
}

export interface ReplayResult {
  group_key: string;
  title: string;
  disclaimer: string;
  days: string[];
  stores: { store: string; product_id: string; claims: StakedClaim[] }[];
  timeline: DayStore[];
  contracts: ReplayContract[];
  sample_ranking: { day: string; ranking: ReturnType<typeof rank> } | null;
  totals: { store: string; orders: number; payout_usd: number; hits: number; misses: number; accuracy: number; first_week_share: number; last_week_share: number }[];
}

export interface GroupInfo {
  group_key: string;
  title: string;
  stores: number;
  days: number;
  min_price: number;
  max_price: number;
  held_out: boolean; // not used to train the models
}

export function listGroups(db: DB): GroupInfo[] {
  const groups = buildGroups(loadListings(db));
  return [...groups.entries()]
    .map(([k, ls]) => {
      const all = ls.flatMap((l) => [...l.series.values()]);
      const days = new Set(ls.flatMap((l) => [...l.series.keys()]));
      return { group_key: k, title: groupLabel(db, k, ls[0].product_id), stores: ls.length, days: days.size, min_price: Math.min(...all), max_price: Math.max(...all), held_out: isTestUnit(k) };
    })
    .sort((a, b) => b.stores - a.stores || b.days - a.days);
}

export function groupListings(db: DB, groupKey: string): Listing[] {
  const g = buildGroups(loadListings(db)).get(groupKey);
  if (!g) throw new Error(`Unknown product group ${groupKey} (needs the same model at 2+ stores with history)`);
  return g;
}

// Largest-remainder rounding so integer orders sum to buyers_per_day.
function allocate(total: number, share: Map<string, number>): Map<string, number> {
  const ids = [...share.keys()];
  const raw = ids.map((id) => share.get(id)! * total);
  const base = raw.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - base[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) if (left-- > 0) base[i]++;
  return new Map(ids.map((id, i) => [id, base[i]]));
}

export function runReplay(db: DB, params: ReplayParams): ReplayResult {
  if (params.buyers_per_day < 1 || params.buyers_per_day > 1000) throw new Error('buyers_per_day must be 1..1000');
  if (!(params.tau_usd > 0)) throw new Error('tau_usd must be positive');
  const listings = groupListings(db, params.group_key);
  const drop = loadModel('drop14');
  const lowest = loadModel('lowest7');
  const byDomain = new Map(listings.map((l) => [l.domain, l]));
  for (const c of params.claims) {
    if (!byDomain.has(c.domain)) throw new Error(`Store ${c.domain} does not sell ${params.group_key}`);
    if ((c.claim_type as string) === 'in_stock') throw new Error('in_stock cannot be replayed: Channel3 history has no availability');
  }
  const label = (d: string) => storeLabel(d);
  const days = [...new Set(listings.flatMap((l) => [...l.series.keys()]))]
    .sort()
    .filter((d) => listings.filter((l) => l.series.has(d)).length >= 2);
  const lastDay = days[days.length - 1];

  const state = new Map(listings.map((l) => [l.product_id, { hits: 0, misses: 0, cumPayout: 0, cumOrders: 0 }]));
  const open: ReplayContract[] = [];
  const contracts: ReplayContract[] = [];
  const timeline: DayStore[] = [];
  let sample: ReplayResult['sample_ranking'] = null;
  let seq = 0;

  for (const day of days) {
    // 1. Verdicts that became knowable today.
    const paidToday = new Map<string, number>();
    for (let i = open.length - 1; i >= 0; i--) {
      const c = open[i];
      if (c.terms.judge_after_day > day) continue;
      const l = listings.find((x) => x.product_id === c.terms.product_id)!;
      const v = judge(c.terms, { listing: l.series, peers: new Map(listings.map((x) => [x.product_id, x.series])) });
      c.verdict = { ...v, judged_day: day };
      const s = state.get(l.product_id)!;
      if (v.outcome === 'hit') s.hits += c.orders;
      else s.misses += c.orders;
      const paid = v.payout_usd * c.orders;
      s.cumPayout += paid;
      paidToday.set(l.product_id, (paidToday.get(l.product_id) ?? 0) + paid);
      open.splice(i, 1);
    }

    // 2. Rank today's stores.
    const live = listings.filter((l) => l.series.has(day));
    const cands: (Candidate & { p_drop: number })[] = [];
    for (const l of live) {
      const f = features(l, day, listings);
      const price = l.series.get(day)!;
      const st = state.get(l.product_id)!;
      const pDropModel = f ? predict(drop, f) : drop.data.positive_rate_train as number;
      const pDrop = adjustForStore(pDropModel, st.hits, st.misses);
      const myClaims = params.claims.filter((c) => c.domain === l.domain);
      const stakeOf = (t: ClaimType) => myClaims.find((c) => c.claim_type === t)?.stake_usd ?? 0;
      const harmDrop = drop.shortfall_fraction.mean * price;
      const risks: Risk[] = [
        { claim: 'no_price_drop', p_model: pDropModel, p_fail: pDrop, harm_usd: harmDrop, stake_usd: stakeOf('no_price_drop'), expected_loss_usd: expectedLoss(pDrop, harmDrop, stakeOf('no_price_drop')), source: f ? 'model drop14' : 'base rate (under 3 prior days)' },
      ];
      if (myClaims.some((c) => c.claim_type === 'lowest_price')) {
        const others = live.filter((o) => o.product_id !== l.product_id).map((o) => o.series.get(day)!);
        const gmin = Math.min(...others);
        const isMin = price <= gmin + 0.01;
        const pm = isMin ? (f ? predict(lowest, f) : (lowest.data.positive_rate_train as number)) : 1;
        const p = isMin ? adjustForStore(pm, st.hits, st.misses) : 1;
        const harm = isMin ? lowest.shortfall_fraction.mean * price : price - gmin;
        risks.push({ claim: 'lowest_price', p_model: pm, p_fail: p, harm_usd: harm, stake_usd: stakeOf('lowest_price'), expected_loss_usd: expectedLoss(p, harm, stakeOf('lowest_price')), source: isMin ? 'model lowest7' : 'already undercut today' });
      }
      if (myClaims.some((c) => c.claim_type === 'genuine_sale')) {
        // Knowable at purchase: run the rule on prior data.
        const t = makeTerms({ claim_type: 'genuine_sale', product_id: l.product_id, domain: l.domain, group_key: params.group_key, purchase_price: price, purchase_day: day, stake_usd: stakeOf('genuine_sale') });
        const v = judge(t, { listing: l.series });
        const p = v.outcome === 'miss' ? 1 : 0;
        const harm = v.outcome === 'miss' ? (v.evidence_missing ? stakeOf('genuine_sale') : price - ((v.used as any).threshold ?? price)) : 0;
        risks.push({ claim: 'genuine_sale', p_model: p, p_fail: p, harm_usd: Math.max(0, harm), stake_usd: stakeOf('genuine_sale'), expected_loss_usd: expectedLoss(p, Math.max(0, harm), stakeOf('genuine_sale')), source: 'rule on prior 30 days' });
      }
      cands.push({ product_id: l.product_id, domain: l.domain, store: label(l.domain), price, hits: st.hits, misses: st.misses, risks, p_drop: pDrop });
    }
    const ranked = rank(cands, params.weight);
    const sh = shares(ranked, params.tau_usd);
    const orders = allocate(params.buyers_per_day, sh);
    if (!sample && day >= days[Math.min(days.length - 1, 14)]) sample = { day, ranking: ranked.map((r) => ({ ...r, domain: '' })) };

    // 3. Orders today create contracts for each staked claim.
    for (const r of ranked) {
      const n = orders.get(r.product_id) ?? 0;
      const st = state.get(r.product_id)!;
      st.cumOrders += n;
      if (n > 0) {
        for (const c of params.claims.filter((x) => x.domain === r.domain)) {
          const peers = listings.filter((x) => x.product_id !== r.product_id).map((x) => ({ product_id: x.product_id, domain: x.domain }));
          const terms = makeTerms({ claim_type: c.claim_type, product_id: r.product_id, domain: r.domain, group_key: params.group_key, purchase_price: r.price, purchase_day: day, stake_usd: c.stake_usd, peers });
          if (terms.judge_after_day > lastDay) {
            contracts.push({ id: `r${++seq}`, store: r.store, terms, orders: n, verdict: null });
            continue;
          }
          const rc: ReplayContract = { id: `r${++seq}`, store: r.store, terms, orders: n, verdict: null };
          contracts.push(rc);
          open.push(rc);
        }
      }
      timeline.push({
        day,
        store: r.store,
        price: r.price,
        share: sh.get(r.product_id)!,
        orders: n,
        rank: r.rank,
        accuracy: r.accuracy,
        p_drop: cands.find((c) => c.product_id === r.product_id)!.p_drop,
        expected_loss_usd: r.expected_loss_usd,
        effective_cost_usd: r.effective_cost_usd,
        payout_usd: paidToday.get(r.product_id) ?? 0,
        cum_payout_usd: st.cumPayout,
        cum_orders: st.cumOrders,
        hits: st.hits,
        misses: st.misses,
      });
    }
  }

  const firstWeek = new Set(days.slice(0, 7));
  const lastWeek = new Set(days.slice(-7));
  const avgShare = (store: string, set: Set<string>) => {
    const rows = timeline.filter((t) => t.store === store && set.has(t.day));
    return rows.length ? rows.reduce((a, b) => a + b.share, 0) / set.size : 0;
  };
  const totals = listings.map((l) => {
    const st = state.get(l.product_id)!;
    const store = label(l.domain);
    return { store, orders: st.cumOrders, payout_usd: Math.round(st.cumPayout * 100) / 100, hits: st.hits, misses: st.misses, accuracy: (st.hits + 2) / (st.hits + st.misses + 4), first_week_share: avgShare(store, firstWeek), last_week_share: avgShare(store, lastWeek) };
  });

  return {
    group_key: params.group_key,
    title: groupLabel(db, params.group_key, listings[0].product_id),
    disclaimer: 'Real Channel3 daily prices. Stakes are hypothetical: these stores have not actually staked any claim. Store names are anonymised.',
    days,
    stores: listings.map((l) => ({ store: label(l.domain), product_id: l.product_id, claims: params.claims.filter((c) => c.domain === l.domain).map((c) => ({ ...c, domain: label(c.domain) })) })),
    timeline,
    contracts: contracts.map((c) => ({ ...c, terms: { ...c.terms, domain: c.store, peers: c.terms.peers?.map((p) => ({ ...p, domain: label(p.domain) })) } })),
    sample_ranking: sample,
    totals,
  };
}

// Default scenario: every store stakes the same two claims, so the data alone
// decides who turns out to be wrong.
export function defaultClaims(listings: Listing[], stake = 10): StakedClaim[] {
  return listings.flatMap((l) => [
    { domain: l.domain, claim_type: 'lowest_price' as const, stake_usd: stake },
    { domain: l.domain, claim_type: 'no_price_drop' as const, stake_usd: stake },
  ]);
}
