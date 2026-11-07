// Rule tests use small hand-written price series to pin down each rule's
// boundary. They are test fixtures, never shown as market data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, canonicalJson, filterOutliers, judge, makeTerms, termsHash, type Series } from '../src/rules.ts';
import { accuracy, adjustForStore, expectedLoss, rank, storeLabel } from '../src/score.ts';

const series = (start: string, prices: number[]): Series => new Map(prices.map((p, i) => [addDays(start, i), p]));

test('no_price_drop: miss pays the drop, capped at the stake', () => {
  const t = makeTerms({ claim_type: 'no_price_drop', product_id: 'p', domain: 'a.com', group_key: null, purchase_price: 100, purchase_day: '2026-10-01', stake_usd: 10 });
  assert.equal(t.judge_after_day, '2026-10-15');
  const s = series('2026-10-01', [100, 100, 100, 96, 96, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
  const v = judge(t, { listing: s });
  assert.equal(v.outcome, 'miss');
  assert.equal(v.payout_usd, 4);
  const big = judge(t, { listing: series('2026-10-01', [100, 70, 70, 70, 70, 70, 70, 70, 70, 70, 70, 70, 70, 70, 70]) });
  assert.equal(big.payout_usd, 10);
});

test('no_price_drop: hit when price stays at or above purchase', () => {
  const t = makeTerms({ claim_type: 'no_price_drop', product_id: 'p', domain: 'a.com', group_key: null, purchase_price: 100, purchase_day: '2026-10-01', stake_usd: 10 });
  const v = judge(t, { listing: series('2026-10-01', Array(15).fill(100)) });
  assert.equal(v.outcome, 'hit');
  assert.equal(v.payout_usd, 0);
});

test('missing evidence resolves for the buyer with the full stake', () => {
  const t = makeTerms({ claim_type: 'no_price_drop', product_id: 'p', domain: 'a.com', group_key: null, purchase_price: 100, purchase_day: '2026-10-01', stake_usd: 10 });
  const v = judge(t, { listing: series('2026-10-01', [100, 100, 100]) });
  assert.equal(v.outcome, 'miss');
  assert.equal(v.evidence_missing, true);
  assert.equal(v.payout_usd, 10);
});

test('single-day spikes are excluded and reported', () => {
  const f = filterOutliers(series('2026-10-01', [100, 100, 20, 100, 100]));
  assert.deepEqual(f.excluded, [{ day: '2026-10-03', price: 20 }]);
  const t = makeTerms({ claim_type: 'no_price_drop', product_id: 'p', domain: 'a.com', group_key: null, purchase_price: 100, purchase_day: '2026-10-01', stake_usd: 10, window_days: 4 });
  const v = judge(t, { listing: series('2026-10-01', [100, 100, 20, 100, 100]) });
  assert.equal(v.outcome, 'hit');
  assert.equal(v.excluded_outliers.length, 1);
  // A multi-day low is a real price, not a spike.
  assert.equal(filterOutliers(series('2026-10-01', [100, 40, 40, 100])).excluded.length, 0);
});

test('lowest_price: miss when a compared store is cheaper in the window', () => {
  const t = makeTerms({ claim_type: 'lowest_price', product_id: 'p', domain: 'a.com', group_key: 'g', purchase_price: 100, purchase_day: '2026-10-01', stake_usd: 10, peers: [{ product_id: 'q', domain: 'b.com' }] });
  const v = judge(t, { listing: series('2026-10-01', Array(8).fill(100)), peers: new Map([['q', series('2026-10-01', [105, 105, 97, 97, 105, 105, 105, 105])]]) });
  assert.equal(v.outcome, 'miss');
  assert.equal(v.payout_usd, 3);
  assert.throws(() => makeTerms({ claim_type: 'lowest_price', product_id: 'p', domain: 'a.com', group_key: 'g', purchase_price: 100, purchase_day: '2026-10-01', stake_usd: 10, peers: [] }));
});

test('genuine_sale: needs the configured discount below the prior mean', () => {
  const prior = series('2026-09-21', Array(10).fill(200));
  const ok = makeTerms({ claim_type: 'genuine_sale', product_id: 'p', domain: 'a.com', group_key: null, purchase_price: 179, purchase_day: '2026-10-01', stake_usd: 10 });
  assert.equal(judge(ok, { listing: prior }).outcome, 'hit');
  const fake = makeTerms({ claim_type: 'genuine_sale', product_id: 'p', domain: 'a.com', group_key: null, purchase_price: 195, purchase_day: '2026-10-01', stake_usd: 10 });
  const v = judge(fake, { listing: prior });
  assert.equal(v.outcome, 'miss');
  assert.equal(v.payout_usd, 10); // 195 - 180 = 15, capped at 10
});

test('in_stock uses the availability snapshot at purchase', () => {
  const t = makeTerms({ claim_type: 'in_stock', product_id: 'p', domain: 'a.com', group_key: null, purchase_price: 50, purchase_day: '2026-10-01', stake_usd: 5 });
  assert.equal(judge(t, { listing: new Map(), availabilityAtPurchase: 'InStock' }).outcome, 'hit');
  assert.equal(judge(t, { listing: new Map(), availabilityAtPurchase: 'OutOfStock' }).payout_usd, 5);
});

test('contract hash is independent of key order and changes with terms', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  const t = makeTerms({ claim_type: 'no_price_drop', product_id: 'p', domain: 'a.com', group_key: null, purchase_price: 100, purchase_day: '2026-10-01', stake_usd: 10 });
  assert.notEqual(termsHash(t), termsHash({ ...t, stake_usd: 11 }));
});

test('accuracy is smoothed; track record shifts P(fail)', () => {
  assert.equal(accuracy(0, 0), 0.5);
  assert.ok(accuracy(1, 0) < 0.7);
  assert.ok(Math.abs(adjustForStore(0.2, 0, 0) - 0.2) < 1e-9);
  assert.ok(adjustForStore(0.2, 0, 10) > 0.5);
  assert.ok(adjustForStore(0.2, 20, 0) < 0.1);
});

test('stake above harm does not improve rank', () => {
  assert.equal(expectedLoss(0.3, 10, 10), 0);
  assert.equal(expectedLoss(0.3, 10, 50), 0);
  const mk = (id: string, stake: number) => ({ product_id: id, domain: id, store: id, price: 100, hits: 0, misses: 0, risks: [{ claim: 'no_price_drop' as const, p_fail: 0.3, p_model: 0.3, harm_usd: 10, stake_usd: stake, expected_loss_usd: expectedLoss(0.3, 10, stake), source: 'test' }] });
  const r = rank([mk('a', 10), mk('b', 500)]);
  assert.equal(r[0].effective_cost_usd, r[1].effective_cost_usd);
});

test('store labels are stable and hide the domain', () => {
  assert.equal(storeLabel('example.com'), storeLabel('example.com'));
  assert.ok(!storeLabel('example.com').includes('example'));
  assert.match(storeLabel('example.com'), /^Demo store [A-Z]{2}\d{2}$/);
});
