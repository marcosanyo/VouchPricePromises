// The buyer agent's fact view: what Gemini sees before choosing buy or wait.
// Fixture offers only; no LLM call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factView } from '../src/agents/shopper.ts';

const lane = (store: string, price: number, discount: number, cap: number | null) =>
  ({
    store,
    list_price: price + discount,
    was_price: null,
    fake_sale: null,
    risk: { p_drop: 0.032, expected_drop_usd: 59.68, window_days: 31, method: 'test' },
    offers: [{ message: 'ok', option: { id: 'o', price, discount_usd: discount, promise: cap ? { claim_type: 'no_price_drop', window_days: 31, cap_usd: cap } : null, cost_to_store_usd: 0, basis: '' }, unprotected_loss_usd: 0, effective_cost_usd: price }],
  }) as any;

test('fact view labels the estimate as an approximation and marks stores the mandate rules out', () => {
  const lanes = [lane('Store A', 293.99, 6, null), lane('Store B', 298, 0, 60)];
  const protectedOnly = (l: any) => l.offers.at(-1).option.price <= 300 && !!l.offers.at(-1).option.promise;
  const v = factView({ today: '2026-10-28', product: 'Item', max_usd: 300, autonomy: 'protected', lanes, allowed: protectedOnly });
  assert.equal(v.black_friday, '2026-11-27');
  assert.equal(v.user_limits.only_stores_with_a_promise, true);
  const [a, b] = v.stores as any[];
  assert.equal(a.allowed_by_user_limits, false);
  assert.equal(a.staked_claim, 'none');
  assert.equal(a.offer, undefined); // no discount wording: the price is the listed price
  assert.equal(a.store_says, 'ok');
  assert.equal(b.allowed_by_user_limits, true);
  assert.equal(b.staked_claim.max_refund_usd, undefined);
  assert.match(b.staked_claim.refund_rule, /whole difference/);
  assert.equal(b.staked_claim.expected_refund_from_promise_usd, 1.91); // 3.2% x 59.68
  assert.equal(a.expected_unprotected_loss_usd, 1.91);
  assert.equal(b.vouch_rank, 1);
  assert.equal(b.extra_cost_vs_cheapest_allowed_usd, 0);
  assert.equal(a.vouch_rank, undefined); // not allowed: no rank
  assert.match(b.staked_claim.claim, /until 2026-11-28/);
  assert.match(b.vouch_drop_estimate.note, /not seen a Black Friday/);
  assert.equal(b.vouch_drop_estimate.chance_price_drops_before_window_end, '3.2%');
});
