// Claim contracts and their judging rules. Pure functions: the same terms and
// the same price data always give the same verdict and payout. No AI here.
import { createHash } from 'node:crypto';

export const RULE_VERSION = 'vouch-rules-v1';

export type ClaimType = 'lowest_price' | 'genuine_sale' | 'no_price_drop' | 'in_stock';

export const CLAIM_LABELS: Record<ClaimType, string> = {
  lowest_price: 'Lowest price',
  genuine_sale: 'Genuine sale',
  no_price_drop: 'No price drop',
  in_stock: 'In stock',
};

// Default windows and thresholds. They are contract parameters, frozen into
// every contract and shown next to the claim.
export const DEFAULTS = {
  lowest_price: { window_days: 7 },
  no_price_drop: { window_days: 14 },
  genuine_sale: { window_days: 0, lookback_days: 30, min_discount_pct: 10, min_points: 7 },
  in_stock: { window_days: 0 },
  price_epsilon: 0.01,
  // Spike filter: a single day that differs from both neighbours by more than
  // this fraction (same direction) is treated as a data error and excluded.
  outlier_jump: 0.5,
} as const;

export interface Peer {
  product_id: string;
  domain: string;
}

export interface Terms {
  rule_version: string;
  claim_type: ClaimType;
  product_id: string;
  domain: string;
  group_key: string | null;
  purchase_price: number;
  currency: 'USD';
  purchase_day: string; // YYYY-MM-DD (UTC)
  stake_usd: number; // maximum partial refund for this claim
  window_days: number;
  judge_after_day: string; // verdict uses data up to and including this day
  lookback_days?: number;
  min_discount_pct?: number;
  peers?: Peer[]; // stores compared for lowest_price, frozen at order time
  missing_evidence: 'buyer_favor_full_stake';
  outlier_rule: 'single_day_spike';
  // lowest_price: settle before the window ends once a compared store is
  // cheaper by at least the stake (the payout is capped, so no later price
  // can change the verdict). Absent on contracts made before 2026-10-28.
  early_settlement?: 'final_miss';
}

export function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

export function makeTerms(t: {
  claim_type: ClaimType;
  product_id: string;
  domain: string;
  group_key: string | null;
  purchase_price: number;
  purchase_day: string;
  stake_usd: number;
  peers?: Peer[];
  window_days?: number;
  min_discount_pct?: number;
}): Terms {
  if (!(t.stake_usd > 0)) throw new Error('stake_usd must be positive');
  if (!(t.purchase_price > 0)) throw new Error('purchase_price must be positive');
  if (t.claim_type === 'lowest_price' && !(t.peers && t.peers.length > 0)) {
    throw new Error('lowest_price needs at least one comparison store');
  }
  const window_days = t.window_days ?? DEFAULTS[t.claim_type].window_days;
  const terms: Terms = {
    rule_version: RULE_VERSION,
    claim_type: t.claim_type,
    product_id: t.product_id,
    domain: t.domain,
    group_key: t.group_key,
    purchase_price: round2(t.purchase_price),
    currency: 'USD',
    purchase_day: t.purchase_day,
    stake_usd: round2(t.stake_usd),
    window_days,
    judge_after_day: addDays(t.purchase_day, window_days),
    missing_evidence: 'buyer_favor_full_stake',
    outlier_rule: 'single_day_spike',
  };
  if (t.claim_type === 'genuine_sale') {
    terms.lookback_days = DEFAULTS.genuine_sale.lookback_days;
    terms.min_discount_pct = t.min_discount_pct ?? DEFAULTS.genuine_sale.min_discount_pct;
  }
  if (t.claim_type === 'lowest_price') {
    terms.peers = [...t.peers!].sort((a, b) => a.product_id.localeCompare(b.product_id));
    terms.early_settlement = 'final_miss';
  }
  return terms;
}

// Canonical JSON (sorted keys) so the hash does not depend on key order.
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonicalJson((v as any)[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const termsHash = (t: Terms) => sha256(canonicalJson(t));

export const round2 = (x: number) => Math.round(x * 100) / 100;

// ---------------- Evidence ----------------

export type Series = Map<string, number>; // day -> price

export interface Evidence {
  listing: Series;
  peers?: Map<string, Series>; // product_id -> series
  availabilityAtPurchase?: 'InStock' | 'OutOfStock' | null;
}

// Removes single-day spikes; returns the kept series and the excluded points.
export function filterOutliers(s: Series): { kept: Series; excluded: { day: string; price: number }[] } {
  const days = [...s.keys()].sort();
  const kept: Series = new Map();
  const excluded: { day: string; price: number }[] = [];
  for (let i = 0; i < days.length; i++) {
    const p = s.get(days[i])!;
    const prev = i > 0 && daysBetween(days[i - 1], days[i]) === 1 ? s.get(days[i - 1]) : undefined;
    const next = i < days.length - 1 && daysBetween(days[i], days[i + 1]) === 1 ? s.get(days[i + 1]) : undefined;
    if (prev !== undefined && next !== undefined) {
      const up = p > prev * (1 + DEFAULTS.outlier_jump) && p > next * (1 + DEFAULTS.outlier_jump);
      const down = p < prev * (1 - DEFAULTS.outlier_jump) && p < next * (1 - DEFAULTS.outlier_jump);
      if (up || down) {
        excluded.push({ day: days[i], price: p });
        continue;
      }
    }
    kept.set(days[i], p);
  }
  return { kept, excluded };
}

function slice(s: Series, from: string, to: string): [string, number][] {
  return [...s.entries()].filter(([d]) => d >= from && d <= to).sort((a, b) => a[0].localeCompare(b[0]));
}

export interface Verdict {
  outcome: 'hit' | 'miss';
  reason: string;
  payout_usd: number;
  evidence_missing: boolean;
  used: Record<string, unknown>; // the exact data points the rule looked at
  excluded_outliers: { product_id: string; day: string; price: number }[];
}

function missVerdict(terms: Terms, shortfall: number, reason: string, used: Record<string, unknown>, excluded: Verdict['excluded_outliers']): Verdict {
  const payout = Math.max(0.01, round2(Math.min(terms.stake_usd, shortfall)));
  return { outcome: 'miss', reason, payout_usd: payout, evidence_missing: false, used, excluded_outliers: excluded };
}

function missingVerdict(terms: Terms, reason: string, used: Record<string, unknown>): Verdict {
  return { outcome: 'miss', reason: `Evidence missing: ${reason}. Contract rule: buyer favour, full stake.`, payout_usd: terms.stake_usd, evidence_missing: true, used, excluded_outliers: [] };
}

export function canJudge(terms: Terms, latestDataDay: string): boolean {
  return latestDataDay >= terms.judge_after_day;
}

export function judge(terms: Terms, ev: Evidence): Verdict {
  const eps = DEFAULTS.price_epsilon;
  const P = terms.purchase_price;
  const { kept, excluded } = filterOutliers(ev.listing);
  const excludedTagged = excluded.map((e) => ({ product_id: terms.product_id, ...e }));

  switch (terms.claim_type) {
    case 'no_price_drop': {
      const pts = slice(kept, addDays(terms.purchase_day, 1), terms.judge_after_day);
      const need = Math.ceil(terms.window_days / 2);
      if (pts.length < need) return missingVerdict(terms, `${pts.length} of ${terms.window_days} daily prices available (need ${need})`, { points: pts });
      const [minDay, minPrice] = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
      if (minPrice < P - eps) {
        return missVerdict(terms, P - minPrice, `Price fell to $${minPrice.toFixed(2)} on ${minDay} (paid $${P.toFixed(2)})`, { points: pts }, excludedTagged);
      }
      return { outcome: 'hit', reason: `No price below $${P.toFixed(2)} in ${pts.length} daily prices`, payout_usd: 0, evidence_missing: false, used: { points: pts }, excluded_outliers: excludedTagged };
    }

    case 'lowest_price': {
      let best: { product_id: string; domain: string; day: string; price: number } | null = null;
      const used: Record<string, [string, number][]> = {};
      const allExcluded = [...excludedTagged];
      let peersWithData = 0;
      for (const peer of terms.peers ?? []) {
        const raw = ev.peers?.get(peer.product_id);
        if (!raw) continue;
        const f = filterOutliers(raw);
        allExcluded.push(...f.excluded.map((e) => ({ product_id: peer.product_id, ...e })));
        const pts = slice(f.kept, terms.purchase_day, terms.judge_after_day);
        if (pts.length === 0) continue;
        peersWithData++;
        used[peer.product_id] = pts;
        for (const [day, price] of pts) if (!best || price < best.price) best = { ...peer, day, price };
      }
      if (peersWithData === 0) return missingVerdict(terms, 'no comparison store has prices in the window', used);
      if (best && best.price < P - eps) {
        return missVerdict(terms, P - best.price, `Another store sold it for $${best.price.toFixed(2)} on ${best.day} (paid $${P.toFixed(2)})`, { peers: used, cheapest: best }, allExcluded);
      }
      return { outcome: 'hit', reason: `No compared store was below $${P.toFixed(2)} (${peersWithData} stores)`, payout_usd: 0, evidence_missing: false, used: { peers: used }, excluded_outliers: allExcluded };
    }

    case 'genuine_sale': {
      const lookback = terms.lookback_days ?? DEFAULTS.genuine_sale.lookback_days;
      const pts = slice(kept, addDays(terms.purchase_day, -lookback), addDays(terms.purchase_day, -1));
      if (pts.length < DEFAULTS.genuine_sale.min_points) {
        return missingVerdict(terms, `${pts.length} prior daily prices (need ${DEFAULTS.genuine_sale.min_points})`, { points: pts });
      }
      const mean = pts.reduce((s, [, p]) => s + p, 0) / pts.length;
      const pct = terms.min_discount_pct ?? DEFAULTS.genuine_sale.min_discount_pct;
      const threshold = mean * (1 - pct / 100);
      const used = { points: pts, mean_prior: round2(mean), threshold: round2(threshold), min_discount_pct: pct };
      if (P > threshold + eps) {
        const actualPct = ((mean - P) / mean) * 100;
        const rel = actualPct >= 0 ? `${actualPct.toFixed(1)}% below` : `${(-actualPct).toFixed(1)}% above`;
        return missVerdict(terms, P - threshold, `Paid $${P.toFixed(2)} is ${rel} the ${pts.length}-day mean $${mean.toFixed(2)} (contract requires ${pct}% below)`, used, excludedTagged);
      }
      return { outcome: 'hit', reason: `Paid $${P.toFixed(2)} is at least ${pct}% below the prior mean $${mean.toFixed(2)}`, payout_usd: 0, evidence_missing: false, used, excluded_outliers: excludedTagged };
    }

    case 'in_stock': {
      const a = ev.availabilityAtPurchase;
      if (a === undefined || a === null) return missingVerdict(terms, 'no availability snapshot at purchase', {});
      if (a === 'OutOfStock') return missVerdict(terms, terms.stake_usd, 'Channel3 listed the offer as OutOfStock at purchase', { availability: a }, []);
      return { outcome: 'hit', reason: 'Channel3 listed the offer as InStock at purchase', payout_usd: 0, evidence_missing: false, used: { availability: a }, excluded_outliers: [] };
    }
  }
}

// Early settlement (lowest_price with early_settlement): a miss whose payout
// already equals the stake is final, because later prices can only make the
// shortfall larger. The cheapest point must also be safe from the spike
// filter: either its next day is known, or it is not a >50% drop from the
// day before. Returns null while the verdict could still change.
export function judgeEarly(terms: Terms, ev: Evidence): Verdict | null {
  if (terms.claim_type !== 'lowest_price' || terms.early_settlement !== 'final_miss') return null;
  const v = judge(terms, ev);
  if (v.outcome !== 'miss' || v.evidence_missing || v.payout_usd < terms.stake_usd) return null;
  const c = v.used.cheapest as { product_id: string; day: string; price: number };
  const s = ev.peers?.get(c.product_id);
  if (!s) return null;
  const next = s.get(addDays(c.day, 1));
  const prev = s.get(addDays(c.day, -1));
  const spikeProof = next !== undefined || prev === undefined || c.price >= prev * (1 - DEFAULTS.outlier_jump);
  return spikeProof ? { ...v, reason: `${v.reason}; settled early: the stake is already owed in full` } : null;
}
