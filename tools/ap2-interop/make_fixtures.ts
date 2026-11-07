// Writes one Vouch purchase's AP2 chains and public keys to fixtures.json, for
// verify_with_sdk.py. Fresh demo keys; nothing is sent anywhere.
// Run from the repo root: node tools/ap2-interop/make_fixtures.ts
import { writeFileSync } from 'node:fs';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { closedMandates, merchantCheckout, openMandates } from '../../server/src/ap2/mandates.ts';

async function key(kid: string) {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const priv: JWK = { ...(await exportJWK(privateKey)), kid, alg: 'ES256' };
  const { d: _d, ...pub } = priv;
  return { priv, pub };
}
const [user, agent, merchant] = await Promise.all([key('user-demo'), key('shopping-agent'), key('merchant-store-a')]);
const m = { id: 'store-a', name: 'Store A' };
const open = await openMandates({ userKey: user.priv, agentPublicKey: agent.pub, items: [{ id: 'p1', title: 'Headphones' }], merchants: [m], maxUsd: 320, ttlSeconds: 3600 });
const co = await merchantCheckout({ merchantKey: merchant.priv, merchant: m, checkoutId: 'chk1', item: { id: 'p1', title: 'Headphones' }, priceUsd: 298, extensions: { vouch_promise: { claim_type: 'no_price_drop', window_days: 31, cap_usd: 20 } } });
const closed = await closedMandates({ agentKey: agent.priv, openCheckoutToken: open.openCheckoutToken, openPaymentToken: open.openPaymentToken, checkoutJwt: co.checkoutJwt, checkoutHash: co.checkoutHash, payee: m, amountUsd: 298, instrument: { id: 'paypal-sandbox-card', type: 'card' }, merchantAud: 'store-a', merchantNonce: 'nonce-m', processorAud: 'paypal', processorNonce: 'nonce-p' });
const out = new URL('./fixtures.json', import.meta.url).pathname;
writeFileSync(out, JSON.stringify({ user_public_jwk: user.pub, checkout_chain: closed.checkoutChain, payment_chain: closed.paymentChain, checkout_jwt: co.checkoutJwt, checkout_hash: co.checkoutHash, open_checkout_reference: open.checkoutReference }, null, 2));
console.log(`wrote ${out}`);
