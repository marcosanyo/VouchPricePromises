// Does an AI shopping agent pick a store differently when that store stakes a
// claim? For each product sold at 3+ stores, the second-cheapest store gets a
// hypothetical "no price drop in 14 days" stake at three levels (none, $10,
// enough to cover the expected drop). Gemini chooses a store under two
// conditions:
//   ranked: sees Vouch's ranking (effective cost and reasons)
//   facts:  sees only prices, failure probabilities, stakes and refund rules,
//           in shuffled order, with no ranking or effective cost
// The "facts" condition tests whether the agent itself values the stake rather
// than just following Vouch's formula. Stakes are hypothetical; nothing is
// written to the database. Products and stores are anonymised in the prompts.
//   node src/jobs/agent-experiment.ts [products=12] [samples=3]
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from '../config.ts';
import { openDb, recordLlmCalls } from '../db.ts';
import { groupLabel } from '../labels.ts';
import { extractJson, llmModelId } from '../llm.ts';
import { marketGroups, rankGroup, type StandingClaim } from '../market.ts';
import { round2 } from '../rules.ts';


const nProducts = Number(process.argv[2] ?? 12);
const samples = Number(process.argv[3] ?? 3);
const db = openDb(config().dbPath);
await recordLlmCalls(db, 'agent-experiment');

const Choice = z.object({ store: z.string(), reason: z.string() });

const SYSTEM = `You are a shopping agent buying one item on behalf of a user.
The user wants a good price and does not want to lose money after buying.
Choose exactly one store. The data you get is the only information available.
Return JSON {"store": "<store name exactly as given>", "reason": "<one or two sentences>"}.`;

type Level = 'none' | 'low' | 'cover';
const LEVELS: Level[] = ['none', 'low', 'cover'];

function shuffle<T>(xs: T[], seed: number): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const groups = [...marketGroups(db).entries()]
  .map(([k, ls]) => ({ k, ls, ranking: rankGroup(db, k, 1, []) }))
  .filter((g) => g.ranking.ranking.length >= 3)
  .map((g) => {
    const byPrice = [...g.ranking.ranking].sort((a, b) => a.price - b.price);
    return { ...g, cheapest: byPrice[0], target: byPrice[1] };
  })
  // A plausible contest: the target is within 15% of the cheapest price.
  .filter((g) => g.target.price <= g.cheapest.price * 1.15 && g.target.price > g.cheapest.price)
  .slice(0, nProducts);

if (groups.length === 0) throw new Error('No product has a second-cheapest store within 15% of the cheapest');

const runs: any[] = [];
for (const g of groups) {
  const label = groupLabel(db, g.k, g.ls[0].product_id);
  const targetDomain = g.ls.find((l) => l.product_id === g.target.product_id)!.domain;
  const harm = g.target.risks.find((r) => r.claim === 'no_price_drop')?.harm_usd ?? 0;
  for (const level of LEVELS) {
    const stake = level === 'none' ? 0 : level === 'low' ? 10 : Math.ceil(harm);
    const claims: StandingClaim[] = stake ? [{ product_id: g.target.product_id, domain: targetDomain, claim_type: 'no_price_drop', stake_usd: stake }] : [];
    const ranked = rankGroup(db, g.k, 1, claims).ranking;
    const facts = ranked.map((r) => {
      const drop = r.risks.find((x) => x.claim === 'no_price_drop')!;
      return {
        store: r.store,
        price_usd: r.price,
        chance_price_drops_within_14_days: `${Math.round(drop.p_fail * 1000) / 10}%`,
        expected_drop_if_it_drops_usd: round2(drop.harm_usd),
        claims_track_record: `${r.hits} held, ${r.misses} missed`,
        staked_claim: drop.stake_usd > 0
          ? { claim: 'No price drop within 14 days of purchase', max_refund_usd: drop.stake_usd, refund_rule: "If this store's price falls below the price paid within 14 days, the buyer is refunded the drop automatically through PayPal, up to the max refund." }
          : 'none',
      };
    });
    const rankedView = ranked.map((r) => ({ rank: r.rank, store: r.store, price_usd: r.price, effective_cost_usd: round2(r.effective_cost_usd), reasons: r.reasons }));
    for (const condition of ['ranked', 'facts'] as const) {
      for (let s = 0; s < samples; s++) {
        const view = condition === 'ranked' ? { ranking_by_vouch: rankedView } : { stores: shuffle(facts, s * 7919 + LEVELS.indexOf(level) * 131 + g.k.length) };
        const prompt = `Item: ${label}\n` + JSON.stringify(view, null, 1);
        const out = await extractJson(Choice, { system: SYSTEM, prompt, temperature: 1 });
        const valid = ranked.some((r) => r.store === out.store);
        runs.push({ product: label, level, stake_usd: stake, condition, sample: s, pick: out.store, picked_target: out.store === g.target.store, picked_cheapest: out.store === g.cheapest.store, valid, reason: out.reason, target: g.target.store, cheapest: g.cheapest.store, price_gap_usd: round2(g.target.price - g.cheapest.price), expected_drop_usd: round2(harm) });
        console.log(`[${runs.length}/${groups.length * LEVELS.length * 2 * samples}] ${label} ${level} ${condition} → ${out.store}${out.store === g.target.store ? ' (target)' : ''}`);
      }
    }
  }
  console.log(` ${label}`);
}

const cell = (cond: string, level: Level) => {
  const rs = runs.filter((r) => r.condition === cond && r.level === level && r.valid);
  return { n: rs.length, picked_target: rs.filter((r) => r.picked_target).length, rate: rs.length ? round2(rs.filter((r) => r.picked_target).length / rs.length) : null };
};
const summary = {
  model: llmModelId(),
  run_at: new Date().toISOString(),
  design: { products: groups.length, levels: { none: 'no stake', low: '$10', cover: 'stake = expected drop (rounded up)' }, conditions: { ranked: "agent sees Vouch's ranking", facts: 'agent sees only prices, probabilities, stakes and refund rules (shuffled, no ranking)' }, samples_per_cell: samples, temperature: 1, target: 'second-cheapest store (within 15% of the cheapest)' },
  invalid_picks: runs.filter((r) => !r.valid).length,
  results: Object.fromEntries((['ranked', 'facts'] as const).map((c) => [c, Object.fromEntries(LEVELS.map((l) => [l, cell(c, l)]))])),
  products: groups.map((g) => ({ product: groupLabel(db, g.k, g.ls[0].product_id), stores: g.ranking.ranking.length, price_gap_usd: round2(g.target.price - g.cheapest.price), cheapest_price_usd: g.cheapest.price })),
  runs,
};
const dir = new URL('../../experiments/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
writeFileSync(dir + 'agent-choice.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ model: summary.model, invalid: summary.invalid_picks, results: summary.results }, null, 1));
