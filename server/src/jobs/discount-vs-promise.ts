// Discount vs promise (concept §34): one store answers the buyer agent's request for a
// lower price with a small discount and no promise; the other keeps the list price and
// answers with a verifiable Vouch no-price-drop promise. Does the agent pick the promise
// only when a drop is likely (high as-of chance), and the discount when it is not?
// Real data: past days D from Channel3, the as-of model's chance of a drop within the
// replay window, and the real later prices (to say who would have done better). Assumed
// (demo): both stores sell the same item at the same list price on D; the discount store's
// owner allows DISCOUNT off. The agent may call verify_promise (at most 2 times).
// --app-view: the agent also gets the buyer app's comparison (extra cost vs expected refund
// or expected unprotected loss) and its instruction to weigh them (shopper.ts CHOICE_SYSTEM).
//   node src/jobs/discount-vs-promise.ts [per_side=2] [samples=3] [--app-view]
// Writes server/experiments/discount-vs-promise[-app-view].json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from '../config.ts';
import { openDb, recordLlmCalls } from '../db.ts';
import { buildGroups, loadListings } from '../features.ts';
import { groupLabel } from '../labels.ts';
import { extractJson, llmModelId } from '../llm.ts';
import { dropRisk } from '../market.ts';
import { REPLAY_WINDOW_DAYS } from '../agents/merchant.ts';
import { addDays, canonicalJson, round2, sha256 } from '../rules.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const appView = process.argv.includes('--app-view');
const perSide = Number(args[0] ?? 2);
const samples = Number(args[1] ?? 3);
const DISCOUNT = 0.03; // the discount store's owner limit (demo assumption)
const HIGH = 0.5, CERTAIN = 0.9, LOW = 0.1; // as-of chance of a drop: likely (not near-certain) vs unlikely
const W = REPLAY_WINDOW_DAYS;

const db = openDb(config().dbPath);
await recordLlmCalls(db, 'discount-vs-promise');

// Candidate (listing, day) pairs with real prices through D + W; a deterministic spread
// of them is scored by the as-of model (it is not free), then the most and least likely kept.
const listings = [...buildGroups(loadListings(db)).values()].flat();
const pairs = listings.flatMap((l) => {
  const days = [...l.series.keys()].sort();
  const last = days.at(-1)!;
  return days.filter((d) => addDays(d, W) <= last).map((day) => ({ l, day }));
});
const step = Math.max(1, Math.floor(pairs.length / 80));
const scored = pairs.filter((_, i) => i % step === 0).map(({ l, day }) => {
  const r = dropRisk(db, l.product_id, W, day);
  const price = l.series.get(day)!;
  const later = [...l.series.entries()].filter(([d]) => d > day && d <= addDays(day, W)).map(([, p]) => p);
  return { l, day, price, p_drop: r.p_drop, harm: r.expected_drop_usd, real_low: Math.min(price, ...later) };
});
const distinct = (xs: typeof scored) => xs.filter((x, i) => xs.findIndex((y) => y.l.group_key === x.l.group_key) === i);
const high = distinct(scored.filter((x) => x.p_drop >= HIGH && x.p_drop <= CERTAIN).sort((a, b) => b.p_drop - a.p_drop)).slice(0, perSide);
const low = distinct(scored.filter((x) => x.p_drop <= LOW).sort((a, b) => a.p_drop - b.p_drop)).slice(0, perSide);
if (high.length < perSide || low.length < perSide) throw new Error(`Not enough scenarios: ${high.length} likely, ${low.length} unlikely (of ${scored.length} scored)`);

const Decision = z.object({ decision: z.enum(['buy', 'wait']), store: z.string().nullable(), reason: z.string() });
const Action = z.object({ action: z.literal('verify_promise'), store: z.string() });
const MAX_VERIFY = 2;
const SYSTEM = `You are a shopping agent acting on behalf of a user who wants this item.
The user wants a good price and does not want to lose money because the price drops after buying.
You asked each store for a lower price. You may either buy now from exactly one store, or wait and decide later.
The data you get is the only information available.
You may check whether a store's promise is registered with Vouch by returning {"action": "verify_promise", "store": "<store name exactly as given>"} instead of a decision (at most ${MAX_VERIFY} checks). Vouch is a service that records store promises and has them judged and refunded.
${appView ? 'Compare what a store costs extra with what it gives back: extra_cost_vs_cheapest_usd against expected_refund_from_promise_usd (with a promise) or expected_unprotected_loss_usd (without). A promise is worth paying more for only when its expected refund justifies the extra price.\n' : ''}Return JSON {"decision": "buy" | "wait", "store": "<store name exactly as given, or null if waiting>", "reason": "<one or two sentences>"}.`;

const NAMES = ['Store QX', 'Store MZ'];
const runs: any[] = [];
const scenarios = [...high.map((s) => ({ ...s, side: 'likely' })), ...low.map((s) => ({ ...s, side: 'unlikely' }))];
const total = scenarios.length * samples;
for (const s of scenarios) {
  const label = groupLabel(db, s.l.group_key ?? s.l.product_id, s.l.product_id);
  const end = addDays(s.day, W);
  const discounted = round2(s.price * (1 - DISCOUNT));
  for (let n = 0; n < samples; n++) {
    // Alternate which name carries the promise, and the order shown.
    const [promiseName, discountName] = n % 2 ? [NAMES[1], NAMES[0]] : NAMES;
    const risk = { chance_price_drops_before_window_end: `${Math.round(s.p_drop * 1000) / 10}%`, expected_drop_if_it_drops_usd: round2(s.harm) };
    const stores = [
      { store: discountName, list_price_usd: s.price, price_usd: discounted, ...risk, store_says: `We can take ${Math.round(DISCOUNT * 100)}% off: ${discounted.toFixed(2)} today. No price protection.` },
      { store: promiseName, list_price_usd: s.price, price_usd: s.price, ...risk, store_says: `Our price is firm, but if our price drops before ${end}, the full difference is refunded automatically. This promise is registered with Vouch.` },
    ];
    if (appView) {
      const loss = round2(s.p_drop * s.harm);
      Object.assign(stores[0], { extra_cost_vs_cheapest_usd: 0, expected_unprotected_loss_usd: loss });
      Object.assign(stores[1], { extra_cost_vs_cheapest_usd: round2(s.price - discounted), expected_refund_from_promise_usd: loss });
    }
    if (n % 3 === 1) stores.reverse();
    const claim = `No price drop until ${end}`;
    const verify = (store: string) => store === promiseName
      ? { store, found: true, claim, refund: 'the full difference', judged_by: "fixed rules on the store's daily prices", refund_paid_by: "PayPal, automatically, from the store's account", terms_signed_by_store: true, terms_hash: sha256(canonicalJson({ claim, refund: 'the full difference', until: end })), status: 'active' }
      : { store, found: false, note: 'No promise for this store is registered with Vouch.' };
    const view = { today: s.day, window_end: end, note: 'Same item at both stores; the chance and size of a drop are Vouch estimates for this item over the window.', stores };
    const checks: any[] = [];
    let out: z.infer<typeof Decision>;
    for (;;) {
      const canCheck = checks.length < MAX_VERIFY;
      const prompt = `Item: ${label}\n` + JSON.stringify({ ...view, ...(checks.length ? { checks_done: checks.map((c) => c.result) } : {}), ...(canCheck ? {} : { note_checks: 'No more checks are available. Return a decision.' }) }, null, 1);
      const r = await extractJson(canCheck ? z.union([Decision, Action]) : Decision, { system: SYSTEM, prompt, temperature: 1 });
      if ('action' in r) {
        if (!stores.some((x) => x.store === r.store)) throw new Error(`verify_promise for unknown store: ${r.store}`);
        checks.push({ store: r.store, result: verify(r.store) });
      } else { out = r; break; }
    }
    const pick = out.decision === 'buy' ? (out.store === promiseName ? 'promise' : out.store === discountName ? 'discount' : 'invalid') : 'wait';
    // Ex post on the real later prices (the store's own price, as the promise is judged):
    // the promise buyer ends at min(price, real low); the discount buyer pays the discounted price.
    const promiseNet = round2(Math.min(s.price, s.real_low));
    runs.push({ product: label, day: s.day, side: s.side, p_drop: round2(s.p_drop), expected_drop_usd: round2(s.harm), price: s.price, discounted, real_low: s.real_low, sample: n, pick, reason: out.reason, verify_calls: checks.length, verified_promise: checks.some((c) => c.store === promiseName), buyer_net_if_promise: promiseNet, buyer_net_if_discount: discounted, better_ex_post: promiseNet < discounted ? 'promise' : promiseNet > discounted ? 'discount' : 'same' });
    console.log(`[${runs.length}/${total}] ${label} ${s.day} p=${(s.p_drop * 100).toFixed(1)}% → ${pick}`);
  }
}

const cell = (side: string) => {
  const rs = runs.filter((r) => r.side === side);
  return { runs: rs.length, promise: rs.filter((r) => r.pick === 'promise').length, discount: rs.filter((r) => r.pick === 'discount').length, wait: rs.filter((r) => r.pick === 'wait').length, invalid: rs.filter((r) => r.pick === 'invalid').length, verified_promise: rs.filter((r) => r.verified_promise).length };
};
const summary = {
  model: llmModelId(), provider: 'vertex_ai', run_at: new Date().toISOString(),
  design: { app_view: appView, window_days: W, discount: DISCOUNT, likely_at_least: HIGH, likely_at_most: CERTAIN, unlikely_at_most: LOW, samples_per_scenario: samples, temperature: 1, scored_pairs: scored.length, system_prompt: SYSTEM, assumed: 'both stores sell the same item at the same list price on D; the discount store offers the discount and no promise (demo assumption)', real: 'days, prices, the as-of model chance of a drop, and the real later prices (ex post)' },
  results: { likely: cell('likely'), unlikely: cell('unlikely') },
  scenarios: scenarios.map((s) => ({ product: groupLabel(db, s.l.group_key ?? s.l.product_id, s.l.product_id), day: s.day, side: s.side, p_drop: round2(s.p_drop), price: s.price, real_low: s.real_low })),
  runs,
};
const dir = new URL('../../experiments/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
writeFileSync(dir + `discount-vs-promise${appView ? '-app-view' : ''}.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary.results, null, 1));
