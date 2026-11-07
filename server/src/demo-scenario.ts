// Replay candidates for the main demo (#/demo), chosen from real data only: a
// product group, a past day D, and a store that on D is the lowest price (or
// within 1% of it) and whose real price then fell within the replay window, so
// fast-forwarding produces a refund. Stores that already published a standing
// no-price-drop promise come first; if none qualifies, the best store to
// publish on is suggested. To make the contrast of the playground visible, the
// model's as-of chance of a drop in the window should be at least MIN_DROP_CHANCE
// (an agent with no promise then has a reason to wait); those come first. Among them,
// days where a rival store with an agent would undercut the store after its owner's discount
// come first (concept §34: the promise has to beat a real discount, not a higher price).
// Pure selection: no LLM, no network.
import type { Listing } from './features.ts';
import { addDays, round2 } from './rules.ts';

export interface ScenarioCandidate {
  group_key: string;
  product_id: string;
  store: string;
  day: string; // D
  price: number;
  lowest_on_day: number;
  window_end: string;
  fell_to: { day: string; price: number };
  drop_usd: number;
  drop_pct: number;
  stores_on_day: number;
  has_published: boolean;
  drop_chance: number | null; // the model's as-of chance of a drop within the window (null when not computed)
  undercut_by_discount: boolean; // a rival with an agent would be cheaper than the store after its discount
}

export const MIN_DROP_CHANCE = 0.2;
export const NEAR_CERTAIN = 0.9;
// The model is evaluated only for the best-ranked candidates (it is not free).
const EVALUATED = 40;

export function scenarioCandidates(
  groups: Map<string, Listing[]>,
  o: { earliest_as_of: string | null; window_days: number; published: Set<string>; storeLabel: (domain: string) => string; limit?: number; dropChance?: (product_id: string, day: string) => number; discountOf?: (store: string) => number },
): { candidates: ScenarioCandidate[]; needs_publish: boolean; suggested: ScenarioCandidate | null } {
  const all: ScenarioCandidate[] = [];
  for (const [group_key, ls] of groups) {
    const days = [...new Set(ls.flatMap((l) => [...l.series.keys()]))].sort().filter((d) => !o.earliest_as_of || d >= o.earliest_as_of);
    for (const day of days) {
      const end = addDays(day, o.window_days);
      // The same stores the replay invites: a real price on D and prices through D + window.
      const live = ls.filter((l) => l.series.has(day) && [...l.series.keys()].some((x) => x >= end));
      if (live.length < 2) continue;
      const lowest = Math.min(...live.map((l) => l.series.get(day)!));
      for (const l of live) {
        const price = l.series.get(day)!;
        if (price > lowest * 1.01) continue;
        const after = [...l.series.entries()].filter(([x]) => x > day && x <= end);
        const low = after.reduce<[string, number] | null>((m, p) => (!m || p[1] < m[1] ? p : m), null);
        if (!low || low[1] >= price - 0.005) continue;
        const drop = round2(price - low[1]);
        const undercut = live.some((r) => r !== l && r.series.get(day)! * (1 - (o.discountOf?.(o.storeLabel(r.domain)) ?? 0) / 100) < price - 0.005);
        all.push({ group_key, product_id: l.product_id, store: o.storeLabel(l.domain), day, price, lowest_on_day: lowest, window_end: end, fell_to: { day: low[0], price: low[1] }, drop_usd: drop, drop_pct: round2((drop / price) * 100), stores_on_day: live.length, has_published: o.published.has(l.product_id), drop_chance: null, undercut_by_discount: undercut });
      }
    }
  }
  // Candidates with a visible contrast first (chance of a drop >= MIN_DROP_CHANCE), then days a rival's discount undercuts the store, then not near-certain drops, then the biggest real drop, then the higher chance of a drop (the day the promise matters most; stable as new days arrive), then the latest day.
  const rank = (a: ScenarioCandidate, b: ScenarioCandidate) => b.drop_usd - a.drop_usd || b.day.localeCompare(a.day);
  const limit = o.limit ?? 5;
  const pick = (list: ScenarioCandidate[]) => {
    const top = list.sort(rank).slice(0, EVALUATED);
    if (o.dropChance) for (const c of top) c.drop_chance = o.dropChance(c.product_id, c.day);
    const strong = (c: ScenarioCandidate) => (c.drop_chance ?? 1) >= MIN_DROP_CHANCE;
    // A near-certain drop (> NEAR_CERTAIN) reads as a giveaway, so those come after; then the biggest real drop.
    const open = (c: ScenarioCandidate) => (c.drop_chance ?? 1) <= NEAR_CERTAIN;
    return top.sort((a, b) => Number(strong(b)) - Number(strong(a)) || Number(b.undercut_by_discount) - Number(a.undercut_by_discount) || Number(open(b)) - Number(open(a)) || b.drop_usd - a.drop_usd || (b.drop_chance ?? 0) - (a.drop_chance ?? 0) || b.day.localeCompare(a.day));
  };
  const published = pick(all.filter((c) => c.has_published));
  if (published.length) return { candidates: published.slice(0, limit), needs_publish: false, suggested: null };
  return { candidates: [], needs_publish: true, suggested: pick(all)[0] ?? null };
}
