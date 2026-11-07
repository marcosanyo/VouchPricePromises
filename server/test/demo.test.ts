// Early settlement and the false-claim demo's store pick. Prices are
// hand-written fixtures, never shown as market data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, judge, judgeEarly, makeTerms, type Series } from '../src/rules.ts';
import { pickTarget } from '../src/demo.ts';
import type { Listing } from '../src/features.ts';

const series = (start: string, prices: number[]): Series => new Map(prices.map((p, i) => [addDays(start, i), p]));
const lowest = (stake: number) =>
  makeTerms({ claim_type: 'lowest_price', product_id: 'p', domain: 'a.com', group_key: 'g', purchase_price: 100, purchase_day: '2026-10-10', stake_usd: stake, peers: [{ product_id: 'q', domain: 'b.com' }] });

test('early settlement: a peer cheaper by the full stake settles on purchase day', () => {
  const t = lowest(10);
  assert.equal(t.early_settlement, 'final_miss');
  const ev = { listing: series('2026-10-10', [100]), peers: new Map([['q', series('2026-10-09', [88, 88])]]) };
  const v = judgeEarly(t, ev);
  assert.equal(v?.outcome, 'miss');
  assert.equal(v?.payout_usd, 10);
  // Same payout as the verdict at the end of the window, whatever comes later.
  const later = { ...ev, peers: new Map([['q', series('2026-10-09', [88, 88, 70, 120, 120, 120, 120, 120, 120])]]) };
  assert.equal(judge(t, later).payout_usd, v?.payout_usd);
});

test('early settlement: waits while the shortfall is below the stake', () => {
  const ev = { listing: series('2026-10-10', [100]), peers: new Map([['q', series('2026-10-09', [95, 95])]]) };
  assert.equal(judgeEarly(lowest(10), ev), null);
  assert.equal(judgeEarly(lowest(5), ev)?.payout_usd, 5);
});

test('early settlement: waits when the cheapest price could still be filtered as a spike', () => {
  // 40 after 100 is a >50% drop on the newest day; tomorrow could make it a spike.
  const spiky = { listing: series('2026-10-10', [100]), peers: new Map([['q', series('2026-10-09', [100, 40])]]) };
  assert.equal(judgeEarly(lowest(10), spiky), null);
  // Once the next day is known and the drop held, it is final.
  const held = { listing: series('2026-10-10', [100]), peers: new Map([['q', series('2026-10-09', [100, 40, 40])]]) };
  assert.equal(judgeEarly(lowest(10), held)?.payout_usd, 10);
});

test('early settlement: never for contracts made without it', () => {
  const t = { ...lowest(10), early_settlement: undefined };
  const ev = { listing: series('2026-10-10', [100]), peers: new Map([['q', series('2026-10-09', [50, 50])]]) };
  assert.equal(judgeEarly(t, ev), null);
});

const listing = (id: string, domain: string, start: string, prices: number[]): Listing => ({ product_id: id, domain, group_key: 'g', category: null, series: series(start, prices) });

test('demo pick: lowest_price takes the store furthest above the cheapest peer, stake below the gap', () => {
  const groups = new Map([['g', [listing('a', 'a.com', '2026-10-20', [100, 100]), listing('b', 'b.com', '2026-10-20', [104, 104]), listing('c', 'c.com', '2026-10-20', [120, 120])]]]);
  const t = pickTarget(groups, 'lowest_price', '2026-10-21');
  assert.equal(t?.product_id, 'c');
  assert.equal(t?.gap_usd, 20);
  assert.equal(t?.stake_usd, 10);
  // Stale prices are not used.
  assert.equal(pickTarget(groups, 'lowest_price', '2026-10-22'), null);
});

test('demo pick: genuine_sale needs enough prior prices and a price above the sale threshold', () => {
  const flat = listing('a', 'a.com', '2026-10-01', Array(10).fill(50));
  const t = pickTarget(new Map([['g', [flat]]]), 'genuine_sale', '2026-10-10');
  assert.equal(t?.gap_usd, 5); // 50 vs threshold 45
  assert.equal(t?.stake_usd, 4);
  const real = listing('b', 'b.com', '2026-10-01', [...Array(9).fill(50), 40]);
  assert.equal(pickTarget(new Map([['g', [real]]]), 'genuine_sale', '2026-10-10'), null);
});

test('promise window runs to the day after Black Friday, never under 14 days', async () => {
  const { promiseWindowDays } = await import('../src/agents/merchant.ts');
  assert.equal(promiseWindowDays('2026-10-28'), 31); // to 2026-11-28
  assert.equal(promiseWindowDays('2026-11-20'), 14);
  assert.equal(promiseWindowDays('2026-12-05'), 14);
});
