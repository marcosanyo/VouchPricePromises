// One-click "false claim" demo for judges: make a store stake a claim that the
// data already contradicts, buy on PayPal Sandbox, judge it on fresh Channel3
// data, and refund from the store's own PayPal. The rules are the ordinary
// ones (rules.ts); the demo only picks a store where the claim is already
// wrong today. Only claims that can settle at purchase are offered:
// lowest_price (via early settlement) and genuine_sale (judged on the past).
import type { DB } from './db.ts';
import { buildGroups, loadListings, type Listing } from './features.ts';
import { append } from './ledger.ts';
import { groupLabel } from './labels.ts';
import { purchase, today, type LiveDeps } from './live.ts';
import { addDays, DEFAULTS, round2 } from './rules.ts';
import { storeLabel } from './score.ts';

export type DemoClaim = 'lowest_price' | 'genuine_sale';

// Sandbox orders and refunds pile up, so the button is capped per UTC day.
export const DEMO_DAILY_LIMIT = 100;
export const DEMO_MAX_STAKE_USD = 10;
// The stake is set below today's gap so that a small price move between the
// stored data and the fresh Channel3 fetch does not leave the contract open.
const STAKE_SHARE_OF_GAP = 0.8;
const MIN_GAP_USD = 1;

export interface DemoTarget {
  product_id: string;
  domain: string;
  group_key: string;
  price: number; // latest stored price
  gap_usd: number; // how far the claim is already wrong
  stake_usd: number;
  basis: Record<string, unknown>; // what the pick was based on (stored data)
}

const latest = (l: Listing) => [...l.series.entries()].sort((a, b) => a[0].localeCompare(b[0])).at(-1);

// Pure: picks the listing whose claim is wrong by the widest margin in the
// stored data. Listings without a price on or after `since` are skipped.
export function pickTarget(groups: Map<string, Listing[]>, claim: DemoClaim, since: string): DemoTarget | null {
  let best: DemoTarget | null = null;
  for (const [key, ls] of groups) {
    for (const l of ls) {
      const own = latest(l);
      if (!own || own[0] < since) continue;
      const [day, price] = own;
      let gap: number;
      let basis: Record<string, unknown>;
      if (claim === 'lowest_price') {
        const peers = ls.filter((p) => p !== l).map((p) => ({ p, last: latest(p) })).filter((x) => x.last && x.last[0] >= since);
        if (peers.length === 0) continue;
        const cheapest = peers.reduce((a, b) => (b.last![1] < a.last![1] ? b : a));
        gap = price - cheapest.last![1];
        basis = { own: { day, price }, cheapest_peer: { store: storeLabel(cheapest.p.domain), day: cheapest.last![0], price: cheapest.last![1] } };
      } else {
        const g = DEFAULTS.genuine_sale;
        const prior = [...l.series.entries()].filter(([d]) => d >= addDays(day, -g.lookback_days) && d < day).map(([, p]) => p);
        if (prior.length < g.min_points) continue;
        const mean = prior.reduce((s, p) => s + p, 0) / prior.length;
        const threshold = mean * (1 - g.min_discount_pct / 100);
        gap = price - threshold;
        basis = { own: { day, price }, prior_mean: round2(mean), threshold: round2(threshold), prior_points: prior.length };
      }
      if (gap < MIN_GAP_USD) continue;
      const stake = round2(Math.min(DEMO_MAX_STAKE_USD, Math.floor(gap * STAKE_SHARE_OF_GAP * 100) / 100));
      const cand = { product_id: l.product_id, domain: l.domain, group_key: key, price, gap_usd: round2(gap), stake_usd: stake, basis };
      // Prefer the largest stake (the clearest miss), then the cheaper order.
      if (!best || cand.stake_usd > best.stake_usd || (cand.stake_usd === best.stake_usd && cand.price < best.price)) best = cand;
    }
  }
  return best;
}

export function demoRunsToday(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ledger WHERE kind = 'demo' AND substr(ts, 1, 10) = ?`).get(today()) as { n: number }).n;
}

export async function falseClaimDemo(deps: LiveDeps, req: { claim_type: DemoClaim; group_key?: string }) {
  const { db } = deps;
  let groups = buildGroups(loadListings(db));
  if (req.group_key) {
    const g = groups.get(req.group_key);
    if (!g) throw new Error(`Unknown product group ${req.group_key}`);
    groups = new Map([[req.group_key, g]]);
  }
  const target = pickTarget(groups, req.claim_type, addDays(today(), -1));
  if (!target) {
    throw new Error(`No store's "${req.claim_type}" claim is already wrong by $${MIN_GAP_USD} or more in the stored prices of ${req.group_key ? 'this product' : 'any product'} (yesterday or today)`);
  }

  // Recorded before the purchase so failed attempts count toward the cap too.
  const demo = append(db, 'demo', target.product_id, { claim_type: req.claim_type, store: storeLabel(target.domain), stake_usd: target.stake_usd, picked_on: target.basis });
  const bought = await purchase(deps, { product_id: target.product_id, claims: [{ claim_type: req.claim_type, stake_usd: target.stake_usd }] });

  const contract = bought.contracts[0];
  const outcome = bought.judged.results.find((r) => r.contract_id === contract.id);
  const j = db.prepare('SELECT outcome, reason, payout_usd, evidence_json, judged_at FROM judgments WHERE contract_id = ?').get(contract.id) as
    | { outcome: string; reason: string; payout_usd: number; evidence_json: string; judged_at: string }
    | undefined;
  const ledger = (db.prepare('SELECT seq, kind, hash FROM ledger WHERE ref_id = ? OR ref_id = ? ORDER BY seq').all(contract.id, bought.purchase_id) as { seq: number; kind: string; hash: string }[]);
  const evidence = j ? JSON.parse(j.evidence_json) : null;
  const cheapest = evidence?.used?.cheapest;

  return {
    claim_type: req.claim_type,
    store: bought.store,
    product: groupLabel(db, target.group_key, target.product_id),
    group_key: target.group_key,
    product_ids: (groups.get(target.group_key) ?? []).map((l) => l.product_id),
    stake_usd: target.stake_usd,
    paid_usd: bought.price,
    picked_on: target.basis,
    paypal: { order_id: bought.order.orderId, capture_id: bought.order.captureId, seller: bought.paypal_seller },
    contract: { id: contract.id, hash: contract.hash, judge_after_day: contract.terms.judge_after_day },
    verdict: j
      ? {
          outcome: j.outcome,
          reason: j.reason,
          payout_usd: j.payout_usd,
          judged_at: j.judged_at,
          used: cheapest ? { ...evidence.used, cheapest: { ...cheapest, store: storeLabel(cheapest.domain) }, peers: undefined } : evidence.used,
        }
      : { outcome: 'open', reason: outcome?.reason ?? 'not judged' },
    refund: outcome?.refund ?? null,
    judge_errors: bought.judged.errors,
    ledger: { demo_entry: demo, entries: ledger },
  };
}
