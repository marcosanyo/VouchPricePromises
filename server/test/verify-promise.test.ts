// verifyPromise: found / not found / tampered checkout. Fixtures are hand-written rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merchantCheckout } from '../src/ap2/mandates.ts';
import { roleKey } from '../src/ap2/keys.ts';
import { migrate, openTestDb } from '../src/db.ts';
import { setStandingClaim } from '../src/market.ts';
import { storeLabel } from '../src/score.ts';
import { promiseTermsHash, verifyPromise } from '../src/verify-promise.ts';

const checkoutFor = async (db: ReturnType<typeof openTestDb>, windowEnd: string, hash: string) => {
  const store = storeLabel('shop.example');
  const m = { id: store.toLowerCase().replace(/\s+/g, '-'), name: store };
  const k = await roleKey(db, `merchant-${m.id}`);
  return (await merchantCheckout({ merchantKey: k.privateJwk, merchant: m, checkoutId: 'c1', item: { id: 'p1', title: 'X' }, priceUsd: 100, extensions: { vouch_promise: { claim_type: 'no_price_drop', window_end: windowEnd, terms_hash: hash } } })).checkoutJwt;
};

test('verifyPromise: not registered, registered, matching and tampered checkout', async () => {
  const db = openTestDb();
  migrate(db);
  assert.deepEqual(await verifyPromise(db, 'p1'), { store: null, found: false, note: 'No promise for this store is registered with Vouch.' });

  db.prepare("INSERT INTO offer_snapshots (product_id, domain, price, currency, availability, observed_at) VALUES ('p1', 'shop.example', 100, 'USD', 'InStock', '2026-10-01T00:00:00Z')").run();
  setStandingClaim(db, { product_id: 'p1', domain: 'shop.example', claim_type: 'no_price_drop', stake_usd: 100, active: true, window_kind: '14' });
  const r = await verifyPromise(db, 'p1');
  assert.ok(r.found && r.status === 'active' && /^[0-9a-f]{64}$/.test(r.terms_hash));
  const windowEnd = r.claim.replace('No price drop until ', '');
  assert.equal(r.terms_hash, promiseTermsHash('p1', windowEnd));

  const good = await verifyPromise(db, 'p1', await checkoutFor(db, windowEnd, r.terms_hash));
  assert.ok(good.found && good.checkout?.signature_valid && good.checkout.promise_in_checkout_matches_terms, JSON.stringify(good));

  const bad = await verifyPromise(db, 'p1', await checkoutFor(db, windowEnd, 'f'.repeat(64)));
  assert.ok(bad.found && bad.checkout?.signature_valid && !bad.checkout.promise_in_checkout_matches_terms);
  const short = await verifyPromise(db, 'p1', await checkoutFor(db, '2000-01-01', promiseTermsHash('p1', '2000-01-01')));
  assert.ok(short.found && !short.checkout?.promise_in_checkout_matches_terms);
});

test('verifyPromise as_of: the window starts on that day and runs the replay window', async () => {
  const db = openTestDb();
  migrate(db);
  db.prepare("INSERT INTO offer_snapshots (product_id, domain, price, currency, availability, observed_at) VALUES ('p1', 'shop.example', 100, 'USD', 'InStock', '2026-10-01T00:00:00Z')").run();
  setStandingClaim(db, { product_id: 'p1', domain: 'shop.example', claim_type: 'no_price_drop', stake_usd: 100, active: true, window_kind: 'bf' });
  const r = await verifyPromise(db, 'p1', undefined, '2026-10-08');
  assert.ok(r.found);
  assert.equal(r.claim, 'No price drop until 2026-10-22');
  assert.equal(r.terms_hash, promiseTermsHash('p1', '2026-10-22'));
});
