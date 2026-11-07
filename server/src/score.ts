// Store accuracy (Bayesian-smoothed), claim trust, and agent ranking.
// Formulas match docs/vouch-project-plan.md "スコアと値付け".
import type { ClaimType } from './rules.ts';

// Beta prior: a new store starts at 0.5 and needs real hits to rise.
export const ACCURACY_PRIOR = { alpha: 2, beta: 2 } as const;

export function accuracy(hits: number, misses: number, prior = ACCURACY_PRIOR): number {
  return (hits + prior.alpha) / (hits + misses + prior.alpha + prior.beta);
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clampP = (p: number) => Math.min(1 - 1e-6, Math.max(1e-6, p));

// The model gives P(fail) for an average store. A store's track record shifts
// it on the log-odds scale by how its miss odds compare with the prior's.
export function adjustForStore(pModel: number, hits: number, misses: number): number {
  const acc = accuracy(hits, misses);
  const priorAcc = accuracy(0, 0);
  const shift = logit(clampP(1 - acc)) - logit(clampP(1 - priorAcc));
  return sigmoid(logit(clampP(pModel)) + shift);
}

// Expected loss to the buyer from relying on a claim: only the part of the
// harm the stake does not cover. Staking more than the harm buys nothing.
export function expectedLoss(pFail: number, harm: number, stake: number): number {
  return pFail * Math.max(0, harm - stake);
}

// What the seller should expect to pay per order for a staked claim.
export function expectedSellerCost(pFail: number, expectedShortfall: number, stake: number): number {
  return pFail * Math.min(stake, expectedShortfall);
}

export interface Risk {
  claim: ClaimType;
  p_fail: number; // after store adjustment
  p_model: number;
  harm_usd: number;
  stake_usd: number; // 0 when the store has not staked this claim
  expected_loss_usd: number;
  source: string; // where p_model came from
}

export interface Candidate {
  product_id: string;
  domain: string;
  store: string; // anonymised label for display
  price: number;
  hits: number;
  misses: number;
  risks: Risk[];
}

export interface Ranked extends Candidate {
  accuracy: number;
  expected_loss_usd: number;
  effective_cost_usd: number;
  rank: number;
  reasons: string[];
}

// effective cost = price + weight × Σ expected loss.  weight = how much the
// agent cares about unprotected risk (1 = dollar for dollar).
export function rank(cands: Candidate[], weight = 1): Ranked[] {
  const scored = cands.map((c) => {
    const el = c.risks.reduce((s, r) => s + r.expected_loss_usd, 0);
    return { ...c, accuracy: accuracy(c.hits, c.misses), expected_loss_usd: el, effective_cost_usd: c.price + weight * el, rank: 0, reasons: [] as string[] };
  });
  scored.sort((a, b) => a.effective_cost_usd - b.effective_cost_usd || a.price - b.price || a.product_id.localeCompare(b.product_id));
  const cheapest = Math.min(...scored.map((s) => s.price));
  scored.forEach((s, i) => {
    s.rank = i + 1;
    s.reasons.push(s.price === cheapest ? `Lowest listed price $${s.price.toFixed(2)}` : `Price $${s.price.toFixed(2)} (+$${(s.price - cheapest).toFixed(2)} vs cheapest)`);
    s.reasons.push(`Accuracy ${(s.accuracy * 100).toFixed(0)}% (${s.hits} hits, ${s.misses} misses)`);
    for (const r of s.risks) {
      const cover = r.stake_usd > 0 ? `staked $${r.stake_usd.toFixed(2)}` : 'not staked';
      s.reasons.push(`${r.claim}: P(fail) ${(r.p_fail * 100).toFixed(1)}%, harm $${r.harm_usd.toFixed(2)}, ${cover} → expected loss $${r.expected_loss_usd.toFixed(2)}`);
    }
    s.reasons.push(`Effective cost $${s.effective_cost_usd.toFixed(2)} = price + ${weight} × expected loss`);
  });
  return scored;
}

// Logit choice: buyers split across stores by effective cost. Deterministic;
// tau is the cost difference (in USD) that changes odds by a factor of e.
export function shares(ranked: Ranked[], tau: number): Map<string, number> {
  const m = Math.min(...ranked.map((r) => r.effective_cost_usd));
  const w = ranked.map((r) => Math.exp(-(r.effective_cost_usd - m) / tau));
  const total = w.reduce((a, b) => a + b, 0);
  return new Map(ranked.map((r, i) => [r.product_id, w[i] / total]));
}

// Stable anonymous label for a merchant domain (no real store names on screen).
// "Demo store" makes it obvious on every screen and in the video that this is
// not a real store's name (since 2026-10-28; earlier records say "Store XX00").
export function storeLabel(domain: string, salt = 'vouch'): string {
  let h = 2166136261;
  for (const ch of salt + domain) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const n = h >>> 0;
  return `Demo store ${letters[n % 24]}${letters[Math.floor(n / 24) % 24]}${(Math.floor(n / 576) % 90) + 10}`;
}
