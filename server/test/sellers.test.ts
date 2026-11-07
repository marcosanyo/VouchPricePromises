// Plan B: a store's live record follows its PayPal merchant id. Fixtures are
// hand-written rows, never shown as market data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openTestDb, type DB } from '../src/db.ts';
import { liveRecord } from '../src/market.ts';
import { Sellers, sellerSlot, SHARED_SLOT } from '../src/sellers.ts';

let n = 0;
function contract(db: DB, domain: string, status: 'hit' | 'miss' | 'open', slot: number | null, merchant: string | null, order: string | null = `O${n}`) {
  n += 1;
  db.prepare(
    `INSERT INTO contracts (id, created_at, mode, product_id, domain, claim_type, terms_json, hash, status, paypal_order_id, paypal_capture_id, paypal_seller_slot, paypal_merchant_id)
     VALUES (?, '2026-10-01T00:00:00Z', 'live', 'p', ?, 'no_price_drop', '{}', 'h', ?, ?, 'C', ?, ?)`,
  ).run(`c${n}`, domain, status, order, slot, merchant);
}
const assign = (db: DB, domain: string, slot: number, merchant: string) =>
  db.prepare(`INSERT OR REPLACE INTO seller_accounts (domain, seller_slot, merchant_id, assigned_at) VALUES (?, ?, ?, '2026-10-28T00:00:00Z')`).run(domain, slot, merchant);

test('renaming the site keeps the record of the PayPal seller', () => {
  const db = openTestDb();
  assign(db, 'old-name.com', 2, 'M2');
  contract(db, 'old-name.com', 'miss', 2, 'M2');
  contract(db, 'old-name.com', 'hit', 2, 'M2');
  // The store moves to a new site and keeps its PayPal account.
  db.prepare('DELETE FROM seller_accounts').run();
  assign(db, 'new-name.com', 2, 'M2');
  assert.deepEqual(liveRecord(db, 'new-name.com'), { hits: 1, misses: 1 });
});

test('switching PayPal accounts does not clear the site record', () => {
  const db = openTestDb();
  contract(db, 'a.com', 'miss', SHARED_SLOT, 'M1');
  assign(db, 'a.com', 3, 'M3');
  assert.deepEqual(liveRecord(db, 'a.com'), { hits: 0, misses: 1 });
});

test('stores on the shared account do not share records', () => {
  const db = openTestDb();
  contract(db, 'a.com', 'miss', SHARED_SLOT, 'M1');
  contract(db, 'b.com', 'hit', SHARED_SLOT, 'M1');
  assert.deepEqual(liveRecord(db, 'a.com'), { hits: 0, misses: 1 });
  assert.deepEqual(liveRecord(db, 'b.com'), { hits: 1, misses: 0 });
  assert.equal(sellerSlot(db, 'a.com'), SHARED_SLOT);
});

test('contracts bought before plan B get slot 1 and the recorded payee', () => {
  const db = openTestDb();
  db.prepare(`INSERT INTO api_calls (ts, upstream, method, endpoint, status, response_json) VALUES ('t', 'paypal', 'POST', '/v2/checkout/orders', 201, ?)`).run(
    JSON.stringify({ id: 'ORD1', purchase_units: [{ payee: { merchant_id: 'M1' } }] }),
  );
  contract(db, 'a.com', 'open', null, null, 'ORD1');
  migrate(db);
  assert.deepEqual({ ...(db.prepare('SELECT paypal_seller_slot AS s, paypal_merchant_id AS m FROM contracts').get() as object) }, { s: 1, m: 'M1' });
});

test('an unconfigured seller slot fails with the variable names', () => {
  const s = new Sellers(new Map());
  assert.throws(() => s.client(2), /PAYPAL_SELLER_2_CLIENT_ID and PAYPAL_SELLER_2_CLIENT_SECRET/);
});
