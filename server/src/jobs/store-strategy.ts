// Store strategy (concept §34): a rival store always takes DISCOUNT off the list price (no
// promise). What should "your" store do when the buyer agent asks for a lower price?
//   list    — keep the list price, no promise (negotiation off, no promise)
//   match   — match the rival's discount, no promise
//   promise — keep the list price and give a verifiable Vouch no-price-drop promise
// For each real past day D (drawn across low / mid / high as-of chances of a drop), the agent
// (the buyer app's view: extra cost vs expected refund / expected unprotected loss) buys from one
// store or waits. Your store's revenue per buyer uses the real later prices of that listing: a
// promise sale keeps the price minus the refund (the full difference to the lowest price in the
// window). Assumed (demo): both stores sell the same item at the same list price on D with the same
// forecast; DISCOUNT is the rival owner's setting. The agent may call verify_promise (at most 2).
//   node src/jobs/store-strategy.ts [per_band=2] [samples=2]
// Writes server/experiments/store-strategy.json.
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

const perBand = Number(process.argv[2] ?? 2);
const samples = Number(process.argv[3] ?? 2);
const DISCOUNT = 0.03;
const W = REPLAY_WINDOW_DAYS;
const BANDS = [
  { band: 'low', lo: 0, hi: 0.1 },
  { band: 'mid', lo: 0.2, hi: 0.5 },
  { band: 'high', lo: 0.5, hi: 0.9 },
] as const;
const STRATEGIES = ['list', 'match', 'promise'] as const;
type Strategy = (typeof STRATEGIES)[number];

const db = openDb(config().dbPath);
await recordLlmCalls(db, 'store-strategy');

const listings = [...buildGroups(loadListings(db)).values()].flat();
const pairs = listings.flatMap((l) => {
  const days = [...l.series.keys()].sort();
  const last = days.at(-1)!;
  return days.filter((d) => addDays(d, W) <= last).map((day) => ({ l, day }));
});
const step = Math.max(1, Math.floor(pairs.length / 120));
const scored = pairs.filter((_, i) => i % step === 0).map(({ l, day }) => {
  const r = dropRisk(db, l.product_id, W, day);
  const price = l.series.get(day)!;
  const later = [...l.series.entries()].filter(([d]) => d > day && d <= addDays(day, W)).map(([, p]) => p);
  return { l, day, price, p_drop: r.p_drop, harm: r.expected_drop_usd, real_low: Math.min(price, ...later) };
});
const scenarios = BANDS.flatMap(({ band, lo, hi }) => {
  const xs = scored.filter((x) => x.p_drop >= lo && x.p_drop <= hi).sort((a, b) => b.price - a.price);
  const picked = xs.filter((x, i) => xs.findIndex((y) => y.l.group_key === x.l.group_key) === i).slice(0, perBand);
  if (picked.length < perBand) throw new Error(`Not enough ${band} scenarios: ${picked.length} of ${perBand} (of ${scored.length} scored)`);
  return picked.map((s) => ({ ...s, band }));
});

const Decision = z.object({ decision: z.enum(['buy', 'wait']), store: z.string().nullable(), reason: z.string() });
const Action = z.object({ action: z.literal('verify_promise'), store: z.string() });
const MAX_VERIFY = 2;
// The buyer app's instruction (shopper.ts CHOICE_SYSTEM), as in discount-vs-promise.ts --app-view.
const SYSTEM = `You are a shopping agent acting on behalf of a user who wants this item.
The user wants a good price and does not want to lose money because the price drops after buying.
You asked each store for a lower price. You may either buy now from exactly one store, or wait and decide later.
The data you get is the only information available.
You may check whether a store's promise is registered with Vouch by returning {"action": "verify_promise", "store": "<store name exactly as given>"} instead of a decision (at most ${MAX_VERIFY} checks). Vouch is a service that records store promises and has them judged and refunded.
Compare what a store costs extra with what it gives back: extra_cost_vs_cheapest_usd against expected_refund_from_promise_usd (with a promise) or expected_unprotected_loss_usd (without). A promise is worth paying more for only when its expected refund justifies the extra price.
Return JSON {"decision": "buy" | "wait", "store": "<store name exactly as given, or null if waiting>", "reason": "<one or two sentences>"}.`;

const NAMES = ['Store QX', 'Store MZ'];
const runs: any[] = [];
const total = scenarios.length * STRATEGIES.length * samples;
for (const s of scenarios) {
  const label = groupLabel(db, s.l.group_key ?? s.l.product_id, s.l.product_id);
  const end = addDays(s.day, W);
  const cut = round2(s.price * (1 - DISCOUNT));
  const loss = round2(s.p_drop * s.harm);
  const refund = round2(s.price - s.real_low);
  for (const strategy of STRATEGIES) {
    for (let n = 0; n < samples; n++) {
      const [yours, rival] = n % 2 ? [NAMES[1], NAMES[0]] : NAMES;
      const yourPrice = strategy === 'match' ? cut : s.price;
      const cheapest = Math.min(cut, yourPrice);
      const risk = { chance_price_drops_before_window_end: `${Math.round(s.p_drop * 1000) / 10}%`, expected_drop_if_it_drops_usd: round2(s.harm) };
      const stores: any[] = [
        { store: rival, list_price_usd: s.price, price_usd: cut, ...risk, store_says: `We can take ${Math.round(DISCOUNT * 100)}% off: ${cut.toFixed(2)} today. No price protection.`, extra_cost_vs_cheapest_usd: round2(cut - cheapest), expected_unprotected_loss_usd: loss },
        strategy === 'promise'
          ? { store: yours, list_price_usd: s.price, price_usd: s.price, ...risk, store_says: `Our price is firm, but if our price drops before ${end}, the full difference is refunded automatically. This promise is registered with Vouch.`, extra_cost_vs_cheapest_usd: round2(s.price - cheapest), expected_refund_from_promise_usd: loss }
          : strategy === 'match'
            ? { store: yours, list_price_usd: s.price, price_usd: cut, ...risk, store_says: `We can match that: ${cut.toFixed(2)} today. No price protection.`, extra_cost_vs_cheapest_usd: 0, expected_unprotected_loss_usd: loss }
            : { store: yours, list_price_usd: s.price, price_usd: s.price, ...risk, store_says: `Our price is $${s.price.toFixed(2)}.`, extra_cost_vs_cheapest_usd: round2(s.price - cheapest), expected_unprotected_loss_usd: loss },
      ];
      if (n % 2 === 1) stores.reverse();
      const claim = `No price drop until ${end}`;
      const verify = (store: string) => strategy === 'promise' && store === yours
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
      const pick = out.decision === 'buy' ? (out.store === yours ? 'yours' : out.store === rival ? 'rival' : 'invalid') : 'wait';
      // Your store's revenue from this buyer (0 when it did not sell), after any refund.
      const revenue = pick !== 'yours' ? 0 : strategy === 'promise' ? round2(s.price - refund) : yourPrice;
      runs.push({ product: label, day: s.day, band: s.band, p_drop: round2(s.p_drop), price: s.price, real_low: s.real_low, strategy, sample: n, pick, revenue, reason: out.reason, verify_calls: checks.length });
      console.log(`[${runs.length}/${total}] ${s.band} ${label} ${s.day} p=${(s.p_drop * 100).toFixed(1)}% ${strategy} → ${pick} $${revenue}`);
    }
  }
}

const cell = (band: string, strategy: Strategy) => {
  const rs = runs.filter((r) => r.band === band && r.strategy === strategy);
  const won = rs.filter((r) => r.pick === 'yours');
  const listSum = rs.reduce((a, r) => a + r.price, 0);
  return {
    runs: rs.length, won: won.length, rival: rs.filter((r) => r.pick === 'rival').length, wait: rs.filter((r) => r.pick === 'wait').length,
    revenue_usd: round2(won.reduce((a, r) => a + r.revenue, 0)),
    revenue_share_of_list: round2(won.reduce((a, r) => a + r.revenue, 0) / listSum), // per buyer, as a share of the list price
  };
};
const summary = {
  model: llmModelId(), provider: 'vertex_ai', run_at: new Date().toISOString(),
  design: { window_days: W, rival_discount: DISCOUNT, bands: BANDS, samples_per_cell: samples, temperature: 1, scored_pairs: scored.length, system_prompt: SYSTEM, assumed: 'both stores sell the same item at the same list price on D with the same forecast; the rival always offers the discount, no promise (demo assumption)', real: 'days, prices, the as-of model chance of a drop, and the real later prices of your listing (refund on a promise sale)' },
  results: Object.fromEntries(BANDS.map(({ band }) => [band, Object.fromEntries(STRATEGIES.map((st) => [st, cell(band, st)]))])),
  scenarios: scenarios.map((s) => ({ product: groupLabel(db, s.l.group_key ?? s.l.product_id, s.l.product_id), day: s.day, band: s.band, p_drop: round2(s.p_drop), price: s.price, real_low: s.real_low })),
  runs,
};
const dir = new URL('../../experiments/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
writeFileSync(dir + 'store-strategy.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary.results, null, 1));
