// Demo scenario selection on a small hand-written fixture (prices are test data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Listing } from '../src/features.ts';
import { scenarioCandidates } from '../src/demo-scenario.ts';
import { addDays } from '../src/rules.ts';

const START = '2026-10-01';
const series = (f: (i: number) => number, n = 30) => new Map(Array.from({ length: n }, (_, i) => [addDays(START, i), f(i)] as [string, number]));
const listing = (id: string, s: Map<string, number>): Listing => ({ product_id: id, domain: `${id}.example`, group_key: 'acme|mug', category: null, series: s });
const o = (published: string[], earliest: string | null = null) => ({ earliest_as_of: earliest, window_days: 14, published: new Set(published), storeLabel: (d: string) => d.split('.')[0].toUpperCase() });

// a: 50 until day 9, then 40. b: 50.3 flat (within 1% of a). c: 60 flat.
const groups = new Map([['acme|mug', [listing('a', series((i) => (i < 10 ? 50 : 40))), listing('b', series(() => 50.3)), listing('c', series(() => 60))]]]);

test('only stores at or near the lowest price whose price later fell qualify', () => {
  const r = scenarioCandidates(groups, o(['a']));
  assert.equal(r.needs_publish, false);
  assert.ok(r.candidates.length > 0);
  for (const c of r.candidates) {
    assert.equal(c.product_id, 'a'); // b and c never fall
    assert.ok(c.price <= c.lowest_on_day * 1.01 && c.fell_to.price < c.price && c.fell_to.day > c.day && c.fell_to.day <= c.window_end);
    assert.equal(c.drop_usd, 10);
  }
});

test('without a published promise the best store to publish on is suggested', () => {
  const r = scenarioCandidates(groups, o([]));
  assert.ok(r.needs_publish && r.candidates.length === 0);
  assert.equal(r.suggested?.product_id, 'a');
});

test('earliest_as_of is respected and no qualifying store reports none', () => {
  const late = scenarioCandidates(groups, o(['a'], '2026-10-15'));
  assert.ok(late.candidates.every((c) => c.day >= '2026-10-15'));
  assert.equal(scenarioCandidates(new Map([['acme|mug', [listing('b', series(() => 50)), listing('c', series(() => 60))]]]), o([])).suggested, null);
});

test('candidates whose as-of drop chance is at least 20% come first, and the chance is returned', () => {
  const two = new Map([['acme|mug', [listing('a', series((i) => (i < 10 ? 50 : 40))), listing('c', series(() => 60))]]]);
  const chance = (_id: string, day: string) => (day >= '2026-10-05' ? 0.35 : 0.05);
  const r = scenarioCandidates(two, { ...o(['a']), dropChance: chance });
  assert.ok(r.candidates.length > 0 && r.candidates[0].drop_chance === 0.35);
  const strong = r.candidates.filter((c) => (c.drop_chance ?? 0) >= 0.2).length;
  assert.ok(r.candidates.slice(0, strong).every((c) => (c.drop_chance ?? 0) >= 0.2)); // strong ones are ahead of weak ones
  assert.equal(scenarioCandidates(two, o(['a'])).candidates[0].drop_chance, null); // not computed without a model
});
