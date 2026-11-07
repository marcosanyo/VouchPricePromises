// Merchant agents: one per store. Each answers a buyer agent's request with an
// offer and may improve it once when the buyer agent pushes back.
//
// What is real and what is assumed:
// - Prices, "was" prices and price histories are Channel3 data for that store.
// - Price negotiation is an OWNER SETTING (seller console: "off / up to X% off").
//   Two kinds of store AI result (concept §34):
//   * a store that published a standing Vouch promise: negotiation OFF, promise
//     ON. Asked for a lower price, its AI declines and answers with the promise
//     (list price + the promise PayPal enforces);
//   * any other store with an agent: negotiation ON with a small FIXED discount
//     (DEMO_DISCOUNT_PCT, a DEMO ASSUMPTION fixed by code, never chosen by the
//     LLM) and NO promise. Its AI only words the reply.
//   A 'holdout' store has no agent: list price.
// - The seller console's daily operation (jobs/seller-sim.ts) sets prices
//   separately and is untouched by this.
// - What a promise costs the store is computed in code from the price-drop model.
// The LLM (Gemini) only chooses among the options computed here and words the
// reply; it cannot invent a price or a promise.
import { z } from 'zod';
import type { DB } from '../db.ts';
import { extractJson } from '../llm.ts';
import { dropRisk, standingClaims } from '../market.ts';
import { addDays, daysBetween, round2 } from '../rules.ts';
import { BLACK_FRIDAY } from '../features.ts';

export type Policy = 'protector' | 'discounter' | 'holdout';

// DEMO ASSUMPTION: the discount an agent store's owner allows when the buyer asks for a lower
// price. Fixed by code so the comparison with the verifiable promise is controlled.
export const DEMO_DISCOUNT_PCT = 3;

// price_negotiation / max_discount_pct: the owner's setting for the store's AI (DEMO ASSUMPTION).
export const POLICIES: Record<Policy, { plan: string; price_negotiation: boolean; max_discount_pct: number }> = {
  protector: { plan: 'No markdowns planned for the next month. Prefers to win on trust rather than price.', price_negotiation: true, max_discount_pct: DEMO_DISCOUNT_PCT },
  discounter: { plan: 'Plans to cut this price about 10% for Black Friday. Competes on price.', price_negotiation: true, max_discount_pct: DEMO_DISCOUNT_PCT },
  holdout: { plan: 'Keeps list price; does not negotiate or make promises.', price_negotiation: false, max_discount_pct: 0 },
};

// The owner's bounds the store's AI works within, as enforced by options()/respond().
// The AI never sets a price or a promise itself. A store with a published promise has price
// negotiation off (the promise is its answer); max_promise_days is that published promise's period.
export interface OwnerLimits { price_negotiation: boolean; max_discount_pct: number; can_promise: boolean; max_promise_days: number | null }
export function ownerLimits(policy: Policy, option?: Option): OwnerLimits {
  const published = !!option?.id.endsWith('-pub');
  const p = POLICIES[policy];
  const negotiates = p.price_negotiation && !published;
  return { price_negotiation: negotiates, max_discount_pct: negotiates ? p.max_discount_pct : 0, can_promise: published, max_promise_days: published ? option!.promise!.window_days : null };
}

// Demo assumption: each store's policy, stable per store label.
export function policyFor(store: string): Policy {
  let h = 2166136261;
  // Hash the pre-2026-10-28 label form so each store keeps its policy.
  for (const ch of 'policy|' + store.replace(/^Demo store /, 'Store ')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (['protector', 'discounter', 'holdout'] as const)[(h >>> 0) % 3];
}

// Vouch member: a store that published a standing promise for this listing in
// the seller console, so every order carries it and PayPal enforces it. Other
// stores' agents may still make a one-off promise when a buyer agent asks (or
// decline, which itself says something). Membership is shown to people but
// never enters the buyer agent's facts or Vouch's ranking: only the promise does.
export function isMember(db: DB, product_id: string): boolean {
  return standingClaims(db, product_id).some((c) => c.claim_type === 'no_price_drop');
}

// A store with a store agent, i.e. a Vouch member in the buyer app: one that
// published a standing promise in the seller console, or (demo assumption) one
// whose demo policy has an agent. A 'holdout' store keeps its list price and
// has no agent, so the buyer agent cannot negotiate with it.
export function hasStoreAgent(db: DB, product_id: string, policy: Policy): boolean {
  return isMember(db, product_id) || policy !== 'holdout';
}

// Promises run until the day after Black Friday, or 14 days once that is
// closer than 14 days away (or past).
export function promiseWindowDays(today: string): number {
  return Math.max(14, daysBetween(today, addDays(BLACK_FRIDAY, 1)));
}

// Replays run every promise this many days, so the real prices after D can judge it.
export const REPLAY_WINDOW_DAYS = 14;

export interface NoDropPromise {
  claim_type: 'no_price_drop';
  window_days: number;
  cap_usd: number; // = the price paid: the promise refunds the full difference (a drop never exceeds the price)
}

export interface Option {
  id: string;
  price: number;
  discount_usd: number;
  promise: NoDropPromise | null;
  cost_to_store_usd: number; // discount + expected promise payout
  basis: string; // where the cost comes from
}

export interface Offer {
  store: string;
  policy: Policy;
  product_id: string;
  list_price: number; // Channel3, now
  was_price: number | null; // Channel3 compare_at_price, if the store shows one
  option: Option;
  message: string;
  round: 1 | 2;
}

// Deterministic option set for one store (see the header): a published promise is
// answered with that promise at the list price; an agent store without one gives the owner's
// fixed discount, no promise; a holdout store, the list price.
export function options(db: DB, o: { product_id: string; store: string; policy: Policy; list_price: number; today: string; window_days?: number; as_of?: string }): Option[] {
  const p = POLICIES[o.policy];
  const price = o.list_price;
  // A promise the seller published in the seller console applies to every
  // order of this listing: the store's agent can add to it, never drop it, and
  // (negotiation off) gives no discount.
  const published = standingClaims(db, o.product_id).find((c) => c.claim_type === 'no_price_drop');
  if (published) {
    const pubWindow = o.window_days ?? (published.window_kind === '14' ? 14 : promiseWindowDays(o.today)); // replays fix 14 days so the verdict is in the data
    const pubRisk = dropRisk(db, o.product_id, pubWindow, o.as_of);
    const expected = round2(pubRisk.p_drop * pubRisk.expected_drop_usd);
    return [{ id: `p${price}-pub`, price, discount_usd: 0, promise: { claim_type: 'no_price_drop', window_days: pubWindow, cap_usd: price }, cost_to_store_usd: expected, basis: `published by the seller in the seller console; model (${pubRisk.method}): P(drop) ${(pubRisk.p_drop * 100).toFixed(1)}%, expected payout $${expected.toFixed(2)}` }];
  }
  // Negotiation on: asked for its best offer, the store gives the owner's discount (a fixed
  // rule, so every run of the demo compares the promise with the same discount).
  if (p.price_negotiation) {
    const cut = round2(price * (1 - p.max_discount_pct / 100));
    const off = round2(price - cut);
    return [{ id: `p${cut}-disc`, price: cut, discount_usd: off, promise: null, cost_to_store_usd: off, basis: `owner's setting: ${p.max_discount_pct}% off the list price when asked (fixed in code, demo assumption); no promise` }];
  }
  return [{ id: `p${price}`, price, discount_usd: 0, promise: null, cost_to_store_usd: 0, basis: 'list price, no promise' }];
}

// A store that is not a Vouch member has no store agent: no negotiation, no
// promise. Its offer is just the listed price.
export function listingOffer(o: { store: string; policy: Policy; product_id: string; list_price: number; was_price: number | null }): Offer {
  const option: Option = { id: `p${o.list_price}`, price: o.list_price, discount_usd: 0, promise: null, cost_to_store_usd: 0, basis: 'list price' };
  return { store: o.store, policy: o.policy, product_id: o.product_id, list_price: o.list_price, was_price: o.was_price, option, message: `Our price is $${o.list_price.toFixed(2)}.`, round: 1 };
}

const Reply = z.object({ option_id: z.string(), message: z.string().max(300) });

const SYSTEM = `You are the sales agent of an online store, answering an AI shopping agent that buys on behalf of a person.
You may only offer one of the options listed; you cannot invent prices or promises, and you cannot give a discount larger than the one in the options (the owner's limit). If the only option has the list price and the shopping agent asks for a lower price, decline politely: the owner has turned price negotiation off. If that option carries a promise ("no price drop until the end of the window: if your price falls below what the buyer paid, the whole difference is refunded automatically through PayPal, no limit"), point to it as your answer; it is enforced by rules on real price data.
If you offer a discount, you make no promise and cannot add one.
If you give no discount and no promise, the shopping agent may wait (for example for Black Friday) and you sell nothing today.
Choose the option that best balances winning the sale against your cost, given your private plan. Reply to the shopping agent in one sentence of at most 20 words, in English; never promise a price cut. Do not reveal your private plan.
Return JSON: {"option_id": "...", "message": "..."}`;

// DEMO ASSUMPTION (playground, replays only): the featured store's offer under a
// condition that has no store AI call. 'none' says only the price, 'words' adds a
// refund claim nobody enforces, 'fake' also claims a Vouch registration that
// verify_promise does not find. The price is the listed price in every case.
export type DemoCondition = 'none' | 'words' | 'fake' | 'vouch';
export function scriptedOffer(o: { condition: 'none' | 'words' | 'fake'; store: string; policy: Policy; product_id: string; list_price: number; window_end: string }): Offer {
  const price = `$${o.list_price.toFixed(2)}`;
  const message = o.condition === 'none' ? `Our price is ${price}.` : o.condition === 'words' ? `If our price drops before ${o.window_end}, we'll refund you the difference.` : `If our price drops before ${o.window_end}, the difference is refunded automatically. This promise is registered with Vouch.`;
  const option: Option = { id: `p${o.list_price}`, price: o.list_price, discount_usd: 0, promise: null, cost_to_store_usd: 0, basis: `demo condition "${o.condition}": list price, no enforced promise` };
  return { store: o.store, policy: o.policy, product_id: o.product_id, list_price: o.list_price, was_price: null, option, message, round: 1 };
}

export async function respond(db: DB, o: { store: string; policy: Policy; product_id: string; list_price: number; was_price: number | null; round: 1 | 2; buyer_message: string; current?: Option; today: string; window_days?: number; as_of?: string }): Promise<Offer> {
  const opts = options(db, o);
  // Round 2 can only improve the offer: no higher price, and a promise at least as long.
  const allowed = o.current ? opts.filter((x) => x.price <= o.current!.price && (x.promise?.window_days ?? 0) >= (o.current!.promise?.window_days ?? 0)) : opts;
  // A holdout store has no agent. With a single option the store's AI still writes the reply
  // (e.g. declining a discount and pointing to its promise); the option itself is fixed by code.
  const published = opts.some((x) => x.id.endsWith('-pub'));
  if ((o.policy === 'holdout' && !published) || allowed.length === 0) {
    const option = o.current ?? opts[0];
    return { store: o.store, policy: o.policy, product_id: o.product_id, list_price: o.list_price, was_price: o.was_price, option, message: o.current ? 'Our price stays as offered.' : `Our price is $${option.price.toFixed(2)}.`, round: o.round };
  }
  const r = await extractJson(Reply, {
    system: SYSTEM,
    temperature: 0.3,
    prompt: JSON.stringify({
      store: o.store,
      your_private_plan: published ? 'The owner turned price negotiation off. The store competes on its verifiable promise, not on price.' : POLICIES[o.policy].plan,
      owner_limits: ownerLimits(o.policy, opts[0]),
      list_price_usd: o.list_price,
      round: o.round,
      your_current_offer: o.current ?? null,
      shopping_agent_says: o.buyer_message,
      options: allowed.map((x) => ({ id: x.id, price_usd: x.price, promise: x.promise, your_expected_cost_usd: x.cost_to_store_usd, cost_basis: x.basis })),
    }),
  });
  const option = allowed.find((x) => x.id === r.option_id);
  if (!option) throw new Error(`Merchant agent for ${o.store} chose an option that was not offered: ${r.option_id}`);
  return { store: o.store, policy: o.policy, product_id: o.product_id, list_price: o.list_price, was_price: o.was_price, option, message: r.message, round: o.round };
}
