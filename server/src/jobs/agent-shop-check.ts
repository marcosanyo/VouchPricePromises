// Small check for the demo shop's headline product: with a "wait" option, does
// the agent buy from the store that promises no price drop until the day after
// Black Friday, from the store that offers a 2% discount with a small promise,
// or wait? Offers are the ones the demo shop's store agents made on 2026-10-28
// (concept.md §16.2/§16.4). Conditions: with and without Vouch's drop
// estimates. Gemini 3.8 Flash only; nothing is written except LLM usage.
//   node src/jobs/agent-shop-check.ts [samples=10]
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from '../config.ts';
import { openDb, recordLlmCalls } from '../db.ts';
import { extractJson, llmModelId } from '../llm.ts';
import { dropRisk } from '../market.ts';
import { addDays, round2 } from '../rules.ts';
import { BLACK_FRIDAY } from '../features.ts';
import { promiseWindowDays } from '../agents/merchant.ts';

const samples = Number(process.argv[2] ?? 10);
const db = openDb(config().dbPath);
await recordLlmCalls(db, 'agent-shop-check');
const today = new Date().toISOString().slice(0, 10);
const window = promiseWindowDays(today);
const end = addDays(today, window);

// Product ids of the two stores in the demo shop's headline item (anonymised labels in output).
const STORES = [
  { store: 'Demo store RF75', product_id: process.env.CHECK_RF75 ?? '', price: 293.99, cap: 5, note: '$6 off the list price $299.99' },
  { store: 'Demo store LK63', product_id: process.env.CHECK_LK63 ?? '', price: 298, cap: 60, note: 'list price' },
];
for (const s of STORES) if (!s.product_id) throw new Error('Set CHECK_RF75 and CHECK_LK63 to the product ids');

const Decision = z.object({ decision: z.enum(['buy', 'wait']), store: z.string().nullable(), reason: z.string() });
const SYSTEM = `You are a shopping agent acting on behalf of a user who wants this item.
The user wants a good price and does not want to lose money because the price drops after buying.
You may either buy now from exactly one store, or wait and decide later (for example, to see whether prices drop around Black Friday).
The data you get is the only information available.
Return JSON {"decision": "buy" | "wait", "store": "<store name exactly as given, or null if waiting>", "reason": "<one or two sentences>"}.`;

const runs: any[] = [];
for (const withRisk of [false, true]) {
  const stores = STORES.map((s) => {
    const r = dropRisk(db, s.product_id, window);
    return {
      store: s.store,
      price_usd: s.price,
      offer: s.note,
      ...(withRisk ? { chance_price_drops_before_window_end: `${Math.round(r.p_drop * 1000) / 10}%`, expected_drop_if_it_drops_usd: round2(r.expected_drop_usd) } : {}),
      staked_claim: { claim: `No price drop until ${end} (the day after Black Friday)`, max_refund_usd: s.cap, refund_rule: `If this store's price falls below the price paid before ${end}, the buyer is refunded the drop automatically through PayPal, up to the max refund.` },
    };
  });
  for (let n = 0; n < samples; n++) {
    const view = { today, black_friday: BLACK_FRIDAY, stores: n % 2 ? stores : [...stores].reverse() };
    const out = await extractJson(Decision, { system: SYSTEM, prompt: 'Item: Over-Ear Headphones · #P51\n' + JSON.stringify(view, null, 1), temperature: 1 });
    runs.push({ with_risk: withRisk, sample: n, decision: out.decision, store: out.store, reason: out.reason, stores });
    console.log(`${withRisk ? 'with estimates' : 'no estimates  '} ${n}: ${out.decision} ${out.store ?? ''}`);
  }
}
const tally = (w: boolean) => {
  const rs = runs.filter((r) => r.with_risk === w);
  return { n: rs.length, wait: rs.filter((r) => r.decision === 'wait').length, ...Object.fromEntries(STORES.map((s) => [s.store, rs.filter((r) => r.store === s.store).length])) };
};
const out = { model: llmModelId(), run_at: new Date().toISOString(), window_end: end, results: { no_estimates: tally(false), with_estimates: tally(true) }, runs };
const dir = new URL('../../experiments/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
writeFileSync(dir + 'agent-shop-check.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.results));
