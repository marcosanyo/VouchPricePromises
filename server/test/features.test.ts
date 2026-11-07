// Fixture-based tests for anonymised labels, the sale check's consistency
// rule, and pre-registered prediction resolution. Prices are test fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestDb, type DB } from '../src/db.ts';
import { addDays } from '../src/rules.ts';
import { productLabel } from '../src/labels.ts';
import { fakeSaleReport } from '../src/insights.ts';
import { registerBatch, resolveDue } from '../src/predictions.ts';

function addProduct(db: DB, id: string, domain: string, title: string, category: string, prices: number[], start: string, snapshot?: { price: number; was: number }) {
  db.prepare(`INSERT INTO products (id, title, raw_json, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)`).run(id, title, JSON.stringify({ category: { title: category } }), start, start);
  prices.forEach((p, i) => db.prepare(`INSERT INTO price_points (product_id, day, price, currency, fetched_at) VALUES (?, ?, ?, 'USD', ?)`).run(id, addDays(start, i), p, start));
  const last = addDays(start, prices.length - 1);
  const snap = snapshot ?? { price: prices.at(-1)!, was: 0 };
  db.prepare(`INSERT INTO offer_snapshots (product_id, domain, price, compare_at_price, currency, availability, observed_at) VALUES (?, ?, ?, ?, 'USD', 'InStock', ?)`).run(id, domain, snap.price, snap.was || null, last + 'T12:00:00Z');
}

test('product labels never contain the product title', () => {
  const db = openTestDb();
  addProduct(db, 'p1', 'shop.example', 'Acme SuperBlender 9000', 'Blenders', [50, 50, 50], '2026-10-01');
  const label = productLabel(db, 'p1');
  assert.match(label, /^Blenders · #[A-Z]\d{2}$/);
  assert.ok(!label.includes('Acme'));
  assert.equal(label, productLabel(db, 'p1'));
});

test('sale check: flat price with a "was" label is not genuine; mismatched snapshot is excluded', () => {
  const db = openTestDb();
  addProduct(db, 'flat', 'a.example', 'Item A', 'Mugs', Array(20).fill(40), '2026-10-01', { price: 40, was: 60 });
  addProduct(db, 'real', 'b.example', 'Item B', 'Mugs', [...Array(19).fill(50), 40], '2026-10-01', { price: 40, was: 50 });
  addProduct(db, 'mismatch', 'c.example', 'Item C', 'Mugs', Array(20).fill(40), '2026-10-01', { price: 25, was: 60 });
  const r = fakeSaleReport(db);
  const by = new Map(r.checks.map((c) => [c.product_id, c]));
  assert.equal(by.get('flat')!.verdict, 'not_genuine');
  assert.equal(by.get('flat')!.pattern, 'unchanged');
  assert.equal(by.get('flat')!.was_never_charged, true);
  assert.equal(by.get('real')!.verdict, 'genuine');
  assert.equal(by.get('mismatch')!.verdict, 'inconsistent');
  assert.equal(r.summary.judged, 2);
  assert.ok(by.get('flat')!.title.startsWith('Mugs · #'));
});

test('pre-registered predictions resolve only after the horizon, using later prices', () => {
  const db = openTestDb();
  addProduct(db, 'drops', 'a.example', 'Item A', 'Mugs', Array(10).fill(30), '2026-10-01');
  addProduct(db, 'flat', 'b.example', 'Item B', 'Mugs', Array(10).fill(30), '2026-10-01');
  for (const id of ['drops', 'flat']) db.prepare(`INSERT INTO tracking (product_id, status, created_at) VALUES (?, 'active', '2026-10-01')`).run(id);
  const batch = registerBatch(db);
  assert.equal(batch.count, 2);
  const asOf = '2026-10-10';
  assert.deepEqual(resolveDue(db, '2026-10-20'), { due: 0, resolved: 0 }); // horizon not reached
  for (let i = 1; i <= 14; i++) {
    db.prepare(`INSERT INTO price_points (product_id, day, price, currency, fetched_at) VALUES ('drops', ?, ?, 'USD', 'x')`).run(addDays(asOf, i), i >= 5 ? 25 : 30);
    db.prepare(`INSERT INTO price_points (product_id, day, price, currency, fetched_at) VALUES ('flat', ?, 30, 'USD', 'x')`).run(addDays(asOf, i));
  }
  assert.deepEqual(resolveDue(db, '2026-10-30'), { due: 2, resolved: 2 });
  const out = new Map((db.prepare('SELECT product_id, outcome FROM predictions').all() as { product_id: string; outcome: number }[]).map((r) => [r.product_id, r.outcome]));
  assert.equal(out.get('drops'), 1);
  assert.equal(out.get('flat'), 0);
});
