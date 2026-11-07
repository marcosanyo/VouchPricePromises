// Round 3: the buyer app's two acts at scale. For each product sold at 2+
// stores with a recent price, the buyer agent decides (1) without Vouch: prices
// only, no drop estimates, no promises; (2) with Vouch: the store agents answer
// "cover a price drop and we buy today, or we wait" (round 1 and one push-back,
// exactly as in the buyer app), then the agent sees prices, Vouch's estimates
// and the promises. User: "minds the price dropping" (weight 5), cap above
// every price, autonomy full. Prices are the latest Channel3 daily prices in
// the database (no new Channel3 calls); nothing is bought and nothing is
// written except LLM usage.
//   node src/jobs/acts-experiment.ts [products=12] [samples=3]
// Output: server/experiments/acts.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from '../config.ts';
import { openDb, recordLlmCalls } from '../db.ts';
import { groupLabel } from '../labels.ts';
import { llmModelId } from '../llm.ts';
import { dropRisk, marketGroups } from '../market.ts';
import { addDays, round2 } from '../rules.ts';
import { storeLabel } from '../score.ts';
import { isMember, policyFor, promiseWindowDays, respond } from '../agents/merchant.ts';
import { agentChoice, baselineChoice, counterText, evaluate, rfqText, type Lane } from '../agents/shopper.ts';


const nProducts = Number(process.argv[2] ?? 12);
const samples = Number(process.argv[3] ?? 3);
const WEIGHT = 5;
const db = openDb(config().dbPath);
await recordLlmCalls(db, 'acts-experiment');

const today = new Date().toISOString().slice(0, 10);
const windowDays = promiseWindowDays(today);
const windowEnd = addDays(today, windowDays);
const since = addDays(today, -2);

const groups = [...marketGroups(db).entries()]
  .map(([k, ls]) => {
    const stores = ls
      .map((l) => ({ l, last: [...l.series.entries()].sort((a, b) => a[0].localeCompare(b[0])).at(-1)! }))
      .filter((x) => x.last[0] >= since)
      .sort((a, b) => a.last[1] - b.last[1])
      .slice(0, 5);
    return { k, stores };
  })
  .filter((g) => g.stores.length >= 2)
  .slice(0, nProducts);
if (groups.length === 0) throw new Error('No product has two stores with a recent price');

const runs: any[] = [];
for (const g of groups) {
  const product = groupLabel(db, g.k, g.stores[0].l.product_id);
  const lanes: Lane[] = g.stores.map(({ l, last }) => {
    const store = storeLabel(l.domain);
    const r = dropRisk(db, l.product_id, windowDays);
    return { store, domain: l.domain, merchant: { id: store, name: store }, product_id: l.product_id, policy: policyFor(store), member: isMember(db, l.product_id), list_price: last[1], was_price: null, risk: { p_drop: r.p_drop, expected_drop_usd: r.expected_drop_usd, window_days: windowDays, method: r.method }, offers: [] };
  });
  const maxUsd = Math.ceil(Math.max(...lanes.map((l) => l.list_price!)) * 1.05);
  const base = { today, product, max_usd: maxUsd, autonomy: 'full' as const, risk_weight: WEIGHT };

  // Act 2 negotiation, once per product (the store agents' answers).
  const rfq = rfqText(product, windowEnd);
  for (const lane of lanes) lane.offers.push(evaluate(lane, await respond(db, { store: lane.store, policy: lane.policy, product_id: lane.product_id, list_price: lane.list_price!, was_price: null, round: 1, buyer_message: rfq, today }), WEIGHT));
  const lead = [...lanes].sort((a, b) => a.offers[0].effective_cost_usd - b.offers[0].effective_cost_usd)[0];
  const lo = lead.offers[0];
  const leadText = `$${lo.option.price.toFixed(2)}${lo.option.promise ? ` with a ${lo.option.promise.window_days}-day no-price-drop promise up to $${lo.option.promise.cap_usd}` : ' with no promise'} (weighted cost to the customer $${lo.effective_cost_usd.toFixed(2)})`;
  for (const lane of lanes.filter((l) => l !== lead && l.policy !== 'holdout')) {
    lane.offers.push(evaluate(lane, await respond(db, { store: lane.store, policy: lane.policy, product_id: lane.product_id, list_price: lane.list_price!, was_price: null, round: 2, buyer_message: counterText(leadText), current: lane.offers[0].option, today }), WEIGHT));
  }
  const finals = lanes.map((l) => {
    const o = l.offers.at(-1)!;
    const cap = o.option.promise?.cap_usd ?? 0;
    return { store: l.store, member: l.member, policy: l.policy, price: o.option.price, cap_usd: cap || null, p_drop: round2(l.risk!.p_drop), expected_drop_usd: round2(l.risk!.expected_drop_usd), covers: cap > 0 && cap >= l.risk!.expected_drop_usd, declined: !cap && l.policy !== 'holdout' };
  });

  for (let n = 0; n < samples; n++) {
    const a1 = await baselineChoice({ ...base, lanes });
    const a2 = await agentChoice({ ...base, lanes, allowed: (l) => l.offers.at(-1)!.option.price <= maxUsd });
    const pick = a2.decision === 'buy' ? finals.find((f) => f.store === a2.store)! : null;
    runs.push({ product, sample: n, act1: a1.decision, act1_store: a1.store, act2: a2.decision, act2_store: a2.store, act2_pick: pick, act2_reason: a2.reason, act1_reason: a1.reason });
    console.log(`[${runs.length}/${groups.length * samples}] ${product}: act1 ${a1.decision} → act2 ${a2.decision}${pick ? ` ${pick.store} (cap ${pick.cap_usd ?? '-'}, ${pick.covers ? 'covers' : 'short'})` : ''}`);
  }
  runs.filter((r) => r.product === product).forEach((r) => (r.offers = finals));
}

const n = runs.length;
const count = (f: (r: any) => boolean) => runs.filter(f).length;
const covered = (r: any) => r.offers.some((o: any) => o.covers);
const summary = {
  model: llmModelId(),
  run_at: new Date().toISOString(),
  design: { products: groups.length, samples, temperature: 1, today, window_end: windowEnd, user_preference: 'minds the price dropping (weight 5)', act1: 'prices only (no estimates, no promises)', act2: 'store agents answer "cover a drop or we wait" (round 1 + one push-back), agent sees prices, Vouch estimates and promises', prices: 'latest Channel3 daily prices in the database' },
  results: {
    runs: n,
    act1_wait: count((r) => r.act1 === 'wait'),
    act2_wait: count((r) => r.act2 === 'wait'),
    wait_to_buy: count((r) => r.act1 === 'wait' && r.act2 === 'buy'),
    wait_to_buy_with_covering_promise: count((r) => r.act1 === 'wait' && r.act2 === 'buy' && r.act2_pick?.covers),
    still_wait_no_covering_offer: count((r) => r.act1 === 'wait' && r.act2 === 'wait' && !covered(r)),
    still_wait_despite_covering_offer: count((r) => r.act1 === 'wait' && r.act2 === 'wait' && covered(r)),
    bought_member: count((r) => r.act2 === 'buy' && r.act2_pick?.member),
    bought_non_member: count((r) => r.act2 === 'buy' && !r.act2_pick?.member),
  },
  products: groups.map((g) => {
    const rs = runs.filter((r) => r.product === groupLabel(db, g.k, g.stores[0].l.product_id));
    return { product: rs[0].product, act1_wait: rs.filter((r) => r.act1 === 'wait').length, act2_buy: rs.filter((r) => r.act2 === 'buy').length, samples: rs.length, any_covering_offer: covered(rs[0]), offers: rs[0].offers };
  }),
  runs,
};
const dir = new URL('../../experiments/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
writeFileSync(dir + 'acts.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ model: summary.model, results: summary.results }, null, 1));
