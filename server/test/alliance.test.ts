// Vouch membership never helps a store by itself: the buyer agent's facts
// carry only prices and promises, so a member and a non-member with the same
// offer look exactly the same to the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineView, factView } from '../src/agents/shopper.ts';

const offer = (store: string, cap: number | null) => ({
  store, policy: 'protector', product_id: 'p', list_price: 300, was_price: null, round: 1, message: '', unprotected_loss_usd: 1, effective_cost_usd: 301,
  option: { id: 'o', price: 300, discount_usd: 0, promise: cap === null ? null : { claim_type: 'no_price_drop', window_days: 14, cap_usd: cap }, cost_to_store_usd: 0, basis: '' },
});
const lane = (store: string, member: boolean, cap: number | null) => ({
  store, domain: `${store}.example`, merchant: { id: store, name: store }, product_id: 'p', policy: 'protector', member, list_price: 300, was_price: null,
  risk: { p_drop: 0.05, expected_drop_usd: 40, window_days: 14, method: 'test' }, offers: [offer(store, cap)],
});
const view = (lanes: any[]) => factView({ today: '2026-10-29', product: 'Item', max_usd: 400, autonomy: 'full', lanes, allowed: () => true });

test('membership is not among the facts the buyer agent sees', () => {
  const v = view([lane('A', true, 20), lane('B', false, 20)]);
  assert.ok(!JSON.stringify(v).toLowerCase().includes('member'));
  const [a, b] = v.stores.map(({ store: _s, ...rest }: any) => rest);
  assert.deepEqual(a, b); // same offer, same facts, member or not
});

test('a promise changes the facts; membership alone does not', () => {
  const withPromise = view([lane('A', false, 20)]).stores[0];
  const memberNoPromise = view([lane('A', true, null)]).stores[0];
  assert.notDeepEqual(withPromise.staked_claim, memberNoPromise.staked_claim);
  assert.equal(memberNoPromise.staked_claim, 'none');
});

test('act 1 (without Vouch) shows prices only: no drop estimates, no promises', () => {
  const v = baselineView({ today: '2026-10-29', product: 'Item', max_usd: 400, autonomy: 'full', lanes: [lane('A', true, 20), lane('B', false, null)] as any });
  const s = JSON.stringify(v);
  assert.ok(!s.includes('drop_estimate') && !s.includes('max_refund'));
  assert.deepEqual(v.stores.map((x) => x.staked_claim), ['none', 'none']);
});
