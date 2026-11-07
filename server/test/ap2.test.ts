// AP2 mandates: built payloads match the official schemas, chains verify, and
// tampering or constraint violations are caught. Keys are generated per test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { closedMandates, merchantCheckout, openMandates, verifyCheckoutChain, verifyPaymentChain, checkoutReceipt, paymentReceipt, validate } from '../src/ap2/mandates.ts';
import { parse, splitChain } from '../src/ap2/sdjwt.ts';

async function key(kid: string) {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const priv: JWK = { ...(await exportJWK(privateKey)), kid, alg: 'ES256' };
  const { d: _d, ...pub } = priv;
  return { priv, pub };
}

async function flow(price: number, maxUsd = 320) {
  const [user, agent, merchant, processor] = await Promise.all([key('user'), key('agent'), key('m1'), key('pp')]);
  const m = { id: 'store-a', name: 'Store A' };
  const open = await openMandates({ userKey: user.priv, agentPublicKey: agent.pub, items: [{ id: 'p1', title: 'Headphones' }], merchants: [m, { id: 'store-b', name: 'Store B' }], maxUsd, ttlSeconds: 3600 });
  const co = await merchantCheckout({ merchantKey: merchant.priv, merchant: m, checkoutId: 'chk1', item: { id: 'p1', title: 'Headphones' }, priceUsd: price, extensions: { vouch_promise: { claim_type: 'no_price_drop', window_days: 14, cap_usd: 10 } } });
  const closed = await closedMandates({ agentKey: agent.priv, openCheckoutToken: open.openCheckoutToken, openPaymentToken: open.openPaymentToken, checkoutJwt: co.checkoutJwt, checkoutHash: co.checkoutHash, payee: m, amountUsd: price, instrument: { id: 'pp-sandbox-card', type: 'card' }, merchantAud: 'store-a', merchantNonce: 'n1', processorAud: 'paypal', processorNonce: 'n2' });
  return { user, merchant, processor, open, co, closed };
}

test('AP2: open and closed mandates match the official schemas and verify', async () => {
  const f = await flow(298);
  const vc = await verifyCheckoutChain({ chain: f.closed.checkoutChain, userPublicKey: f.user.pub, aud: 'store-a', nonce: 'n1', merchantPublicKey: f.merchant.pub, expectedCheckoutJwt: f.co.checkoutJwt });
  assert.ok(vc.ok, JSON.stringify(vc.checks));
  assert.equal(vc.checkout.vouch_promise.cap_usd, 10);
  const vp = await verifyPaymentChain({ chain: f.closed.paymentChain, userPublicKey: f.user.pub, aud: 'paypal', nonce: 'n2', openCheckoutReference: f.open.checkoutReference, expectedCheckoutHash: f.co.checkoutHash });
  assert.ok(vp.ok, JSON.stringify(vp.checks));
  const tokens = splitChain(f.closed.checkoutChain).map(parse);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[1].header.typ, 'kb+sd-jwt');
  const cr = await checkoutReceipt({ merchantKey: f.merchant.priv, iss: 'store-a', reference: vc.reference, orderId: 'ORDER1' });
  const pr = await paymentReceipt({ processorKey: f.processor.priv, iss: 'paypal', reference: vp.reference, paymentId: 'CAP1', pspConfirmationId: 'CAP1', networkConfirmationId: 'n/a' });
  assert.equal(cr.receipt.status, 'Success');
  assert.equal(pr.receipt.reference, vp.reference);
});

test('AP2: amount over the user cap fails the payment constraint', async () => {
  const f = await flow(350, 320);
  const vp = await verifyPaymentChain({ chain: f.closed.paymentChain, userPublicKey: f.user.pub, aud: 'paypal', nonce: 'n2', openCheckoutReference: f.open.checkoutReference, expectedCheckoutHash: f.co.checkoutHash });
  assert.equal(vp.ok, false);
  assert.equal(vp.checks.find((c) => c.name === 'payment.amount_range')?.ok, false);
});

test('AP2: a tampered chain or wrong key does not verify', async () => {
  const f = await flow(298);
  const other = await key('x');
  await assert.rejects(verifyCheckoutChain({ chain: f.closed.checkoutChain, userPublicKey: other.pub, aud: 'store-a', nonce: 'n1', merchantPublicKey: f.merchant.pub, expectedCheckoutJwt: f.co.checkoutJwt }));
  const [root, hop] = splitChain(f.closed.checkoutChain);
  const forged = root.replace(/~[^~]+~$/, '~') + '~' + hop; // drop a disclosure from the open mandate
  await assert.rejects(verifyCheckoutChain({ chain: forged, userPublicKey: f.user.pub, aud: 'store-a', nonce: 'n1', merchantPublicKey: f.merchant.pub, expectedCheckoutJwt: f.co.checkoutJwt }));
  await assert.rejects(verifyCheckoutChain({ chain: f.closed.checkoutChain, userPublicKey: f.user.pub, aud: 'store-b', nonce: 'n1', merchantPublicKey: f.merchant.pub, expectedCheckoutJwt: f.co.checkoutJwt }));
});

test('AP2: schema validation rejects a mandate with a constraint type outside the schema', () => {
  assert.throws(() => validate('open_checkout', { vct: 'mandate.checkout.open.1', cnf: {}, constraints: [{ type: 'vouch.price_protection' }] }));
});
