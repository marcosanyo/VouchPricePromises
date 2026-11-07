// Replays of a past day D must see nothing after D: prices, drop estimates and
// track records used for decisions are identical whatever happens after D.
// Prices are test fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type DB } from '../src/db.ts';
import { addDays, round2 } from '../src/rules.ts';
import { dropRisk, liveRecord } from '../src/market.ts';
import { options } from '../src/agents/merchant.ts';
import { judge, makeTerms } from '../src/rules.ts';

const START = '2026-09-26';
const D = '2026-10-08';

function addListing(db: DB, id: string, domain: string, prices: number[]) {
  db.prepare(`INSERT INTO products (id, title, raw_json, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`).run(id, id, JSON.stringify({ category: { title: 'Mugs' } }), START, START);
  prices.forEach((p, i) => db.prepare(`INSERT INTO price_points (product_id, day, price, currency, fetched_at) VALUES (?, ?, ?, 'USD', ?)`).run(id, addDays(START, i), p, START));
  db.prepare(`INSERT INTO offer_snapshots (product_id, domain, price, compare_at_price, currency, availability, observed_at) VALUES (?, ?, ?, NULL, 'USD', 'InStock', ?)`).run(id, domain, prices.at(-1)!, addDays(START, prices.length - 1) + 'T12:00:00Z');
  db.prepare(`INSERT INTO product_models (product_id, brand, model, condition, group_key, llm_model, extracted_at, raw_json) VALUES (?, 'acme', 'mug', 'new', 'acme|mug', 'test', ?, '{}')`).run(id, START);
}

// 30 days of prices; `after` replaces everything after D.
function world(after: number[]) {
  const db = openTestDb();
  const days = 30;
  const dIndex = 12; // START + 12 = D
  const a = Array.from({ length: days }, (_, i) => (i <= dIndex ? 40 + (i % 3) : after[(i - dIndex - 1) % after.length]));
  const b = Array.from({ length: days }, (_, i) => (i <= dIndex ? 44 : after[(i - dIndex - 1) % after.length] + 4));
  addListing(db, 'a', 'a.example', a);
  addListing(db, 'b', 'b.example', b);
  return db;
}

test('replay inputs as of D do not change when prices after D change', () => {
  const calm = world([41]);
  const crash = world([20, 15, 10]);
  for (const days of [14, 30]) {
    assert.deepEqual(dropRisk(calm, 'a', days, D), dropRisk(crash, 'a', days, D));
  }
  const opt = (db: DB) => options(db, { product_id: 'a', store: 'Demo store AA10', policy: 'protector', list_price: 41, today: D, window_days: 14, as_of: D });
  assert.deepEqual(opt(calm), opt(crash));
  assert.deepEqual(liveRecord(calm, 'a.example', D), liveRecord(crash, 'a.example', D));
  // Without as_of the latest data is used, so the two worlds differ.
  assert.notDeepEqual(dropRisk(calm, 'a', 14), dropRisk(crash, 'a', 14));
});

import { loadReplayModel } from '../src/model.ts';
import { fastForwardWait } from '../src/agents/shopper.ts';

test('a replay verdict is the ordinary rule on the real prices after D', () => {
  const crash = world([20, 15, 10]);
  const price = (crash.prepare('SELECT price FROM price_points WHERE product_id = ? AND day = ?').get('a', D) as { price: number }).price;
  const terms = makeTerms({ claim_type: 'no_price_drop', product_id: 'a', domain: 'a.example', group_key: 'acme|mug', purchase_price: price, purchase_day: D, stake_usd: 10, window_days: 14 });
  const series = new Map((crash.prepare('SELECT day, price FROM price_points WHERE product_id = ?').all('a') as { day: string; price: number }[]).map((r) => [r.day, r.price]));
  const v = judge(terms, { listing: series });
  assert.equal(v.outcome, 'miss');
  assert.equal(v.payout_usd, 10); // the drop is larger than the cap
  const calm = world([price + 1]);
  const calmSeries = new Map((calm.prepare('SELECT day, price FROM price_points WHERE product_id = ?').all('a') as { day: string; price: number }[]).map((r) => [r.day, r.price]));
  assert.equal(judge(terms, { listing: calmSeries }).outcome, 'hit');
});

test('loadReplayModel selects causal as-of model for D >= 2026-10-14 and out-of-group model for earlier replay days', () => {
  const early = loadReplayModel('2026-10-06', 'sony|wh1000xm6');
  assert.equal(early.kind, 'out_of_group');
  assert.equal(typeof early.fold, 'number');
  assert.ok(early.n_train > 0);
  const temporal = loadReplayModel('2026-10-14', 'sony|wh1000xm6');
  assert.equal(temporal.kind, 'as_of');
  assert.equal(temporal.as_of_model, '2026-10-14');
  assert.equal(temporal.cutoff_day, '2026-09-30');
});

test('fastForwardWait evaluates real prices after D for all lanes and computes promised offer net cost', () => {
  const crash = world([30, 28, 35]);
  const state = {
    product: 'Mugs · #M1',
    item_title: 'Mugs · #M1',
    risk_weight: 5,
    as_of: D,
    lanes: [
      {
        store: 'Store A',
        domain: 'a.example',
        merchant: { id: 'store-a', name: 'Store A' },
        product_id: 'a',
        policy: 'protector',
        list_price: 40,
        offers: [{ store: 'Store A', round: 1, message: 'ok', effective_cost_usd: 40, unprotected_loss_usd: 0, option: { id: 'a-1', price: 40, discount_usd: 0, promise: { claim_type: 'no_price_drop', window_days: 14, cap_usd: 10 }, cost_to_store_usd: 1, basis: 'test' } }],
      },
      {
        store: 'Store B',
        domain: 'b.example',
        merchant: { id: 'store-b', name: 'Store B' },
        product_id: 'b',
        policy: 'holdout',
        list_price: 44,
        offers: [{ store: 'Store B', round: 1, message: 'ok', effective_cost_usd: 44, unprotected_loss_usd: 2, option: { id: 'b-1', price: 44, discount_usd: 0, promise: null, cost_to_store_usd: 0, basis: 'test' } }],
      },
    ],
    decision: { wait: true, summary: 'Wait for lower price.', by: 'agent', vouch_ranking: [] },
  };
  crash.prepare('INSERT INTO shop_tasks (id, created_at, group_key, autonomy, max_usd, status, state_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run('t_wait1', D, 'acme|mug', 'full', 45, 'waiting', JSON.stringify(state));
  const ff = fastForwardWait(crash, 't_wait1');
  assert.equal(ff.kind, 'waited');
  assert.equal(ff.as_of, D);
  assert.equal(ff.best_if_waited?.store, 'Store A');
  assert.equal(ff.best_if_waited?.price, 28);
  assert.equal(ff.best_promised_on_day?.store, 'Store A');
  assert.equal(ff.best_promised_on_day?.payout_usd, 10);
  assert.equal(ff.best_promised_on_day?.net_paid_usd, 30);
});


import { DEMO_DISCOUNT_PCT, ownerLimits, POLICIES, scriptedOffer, type Policy } from '../src/agents/merchant.ts';
import { startTask } from '../src/agents/shopper.ts';
import { setStandingClaim } from '../src/market.ts';
import { migrate } from '../src/db.ts';
import { verifyPromise } from '../src/verify-promise.ts';

test('store AI options: published promise has no discount; agent store gives 3% off, no promise; holdout has the list price only', () => {
  const db = world([41]);
  const base = { product_id: 'a', store: 'Demo store AA10', list_price: 41, today: D, window_days: 14, as_of: D };
  for (const policy of ['protector', 'discounter'] as const) {
    const opts = options(db, { ...base, policy });
    assert.deepEqual(opts.map((o) => o.price), [round2(41 * 0.97)], policy);
    assert.ok(opts.every((o) => o.promise === null), policy);
    assert.equal(opts[0].discount_usd, round2(41 - round2(41 * 0.97)));
    assert.equal(POLICIES[policy].max_discount_pct, DEMO_DISCOUNT_PCT);
  }
  const hold = options(db, { ...base, policy: 'holdout' });
  assert.ok(hold.length === 1 && hold[0].price === 41 && hold[0].promise === null && hold[0].discount_usd === 0);
  for (const policy of Object.keys(POLICIES) as Policy[]) {
    setStandingClaim(db, { product_id: 'a', domain: 'a.example', claim_type: 'no_price_drop', stake_usd: 41, active: true, window_kind: '14' });
    const pub = options(db, { ...base, policy });
    assert.ok(pub.length === 1 && pub[0].price === 41 && pub[0].discount_usd === 0 && pub[0].promise?.window_days === 14 && pub[0].promise.cap_usd === 41 && pub[0].id.endsWith('-pub'), policy);
    assert.deepEqual(ownerLimits(policy, pub[0]), { price_negotiation: false, max_discount_pct: 0, can_promise: true, max_promise_days: 14 });
  }
});

test('demo_condition is rejected without as_of, and without a featured store', async () => {
  const ctx = { db: world([41]) } as any;
  const base = { group_key: 'acme|mug', autonomy: 'full' as const, max_usd: 100, risk_weight: 5 };
  await assert.rejects(startTask(ctx, { ...base, demo_condition: 'words', featured_product_id: 'a' }), /as_of/);
  await assert.rejects(startTask(ctx, { ...base, as_of: D, demo_condition: 'words' }), /featured_product_id/);
});

test('vouch condition needs the featured store to have published its promise', async () => {
  const db = world([41]);
  await assert.rejects(startTask({ db } as any, { group_key: 'acme|mug', autonomy: 'full', max_usd: 100, risk_weight: 5, as_of: D, demo_condition: 'vouch', featured_product_id: 'a' }), /seller console/);
});

test('scripted offers keep the list price and carry no enforceable promise', () => {
  for (const condition of ['none', 'words', 'fake'] as const) {
    const o = scriptedOffer({ condition, store: 'S', policy: 'protector', product_id: 'a', list_price: 129, window_end: '2026-10-22' });
    assert.equal(o.option.price, 129);
    assert.equal(o.option.promise, null);
    assert.equal(/registered with Vouch/.test(o.message), condition === 'fake');
    assert.equal(/2026-10-22/.test(o.message), condition !== 'none');
  }
});

test('verify_promise finds nothing for the featured store under none/words/fake, even when its promise is published', async () => {
  const db = world([41]);
  migrate(db);
  setStandingClaim(db, { product_id: 'a', domain: 'a.example', claim_type: 'no_price_drop', stake_usd: 41, active: true, window_kind: '14' });
  assert.equal((await verifyPromise(db, 'a', undefined, D)).found, true);
  for (const condition of ['none', 'words', 'fake'] as const) {
    assert.equal((await verifyPromise(db, 'a', undefined, D, { condition, featured_product_id: 'a' })).found, false, condition);
    assert.equal((await verifyPromise(db, 'a', undefined, D, { condition, featured_product_id: 'b' })).found, true); // other stores are unaffected
  }
  assert.equal((await verifyPromise(db, 'a', undefined, D, { condition: 'vouch', featured_product_id: 'a' })).found, true);
});
