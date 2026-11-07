// AP2 mandates and receipts (spec v0.2). Every payload is validated against the
// official JSON Schemas in ./schemas before it is signed and after it is
// verified; constraint checks follow the spec's evaluation rules for the
// constraint types Vouch uses. Deterministic code only: no LLM here.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { JWK } from 'jose';
import { createRoot, leafReference, present, sha256b64url, signJwt, tokenSdHash, verifyChain, verifyJwt, type SdRules } from './sdjwt.ts';

const SCHEMA_DIR = new URL('./schemas/', import.meta.url).pathname;
const BASE = 'https://ap2-protocol.org/schemas/';

function loadSchemas() {
  const ajv = new (Ajv2020 as any)({ strict: false, allErrors: true });
  (addFormats as any)(ajv);
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : f.endsWith('.json') ? [join(dir, f)] : []));
  for (const file of walk(SCHEMA_DIR)) {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    // receipt_status.json declares $id ".../receipt-status.json" but the receipt
    // schemas reference it as "types/receipt_status.json"; register it under both.
    if (file.endsWith('receipt_status.json')) ajv.addSchema({ ...s, $id: BASE + 'types/receipt_status.json' });
    ajv.addSchema(s);
  }
  return ajv;
}
let ajv: any;
const IDS = {
  open_checkout: BASE + 'open_checkout_mandate',
  checkout: BASE + 'checkout_mandate.json',
  open_payment: BASE + 'payment_mandate_open.json',
  payment: BASE + 'payment_mandate.json',
  checkout_receipt: BASE + 'checkout_receipt.json',
  payment_receipt: BASE + 'payment_receipt.json',
  checkout_object: BASE + 'types/checkout.json',
} as const;
export type SchemaName = keyof typeof IDS;

export function validate(name: SchemaName, payload: unknown): void {
  ajv ??= loadSchemas();
  const v = ajv.getSchema(IDS[name]);
  if (!v) throw new Error(`AP2 schema ${name} not loaded`);
  if (!v(payload)) throw new Error(`AP2 ${name} does not match the official schema: ${ajv.errorsText(v.errors)}`);
}

// Selective-disclosure annotations from the schemas.
const SD: Record<'open_checkout' | 'checkout' | 'open_payment' | 'payment', SdRules> = {
  open_checkout: { arrays: ['allowed', 'acceptable_items'] },
  checkout: { fields: ['checkout_jwt'] },
  open_payment: { arrays: ['allowed'] },
  payment: {},
};

export interface Merchant {
  id: string;
  name: string;
  website?: string;
}
export const cents = (usd: number) => Math.round(usd * 100);
const now = () => Math.floor(Date.now() / 1000);

// ---------- Trusted Surface: open mandates signed by the user ----------
export async function openMandates(o: {
  userKey: JWK;
  agentPublicKey: JWK;
  items: { id: string; title: string }[];
  merchants: Merchant[];
  maxUsd: number;
  ttlSeconds: number;
}) {
  const iat = now();
  const openCheckout = {
    vct: 'mandate.checkout.open.1',
    constraints: [
      { type: 'checkout.line_items', items: [{ id: 'line_1', acceptable_items: o.items, quantity: 1 }] },
      { type: 'checkout.allowed_merchants', allowed: o.merchants },
    ],
    cnf: { jwk: o.agentPublicKey },
    iat,
    exp: iat + o.ttlSeconds,
  };
  validate('open_checkout', openCheckout);
  const openCheckoutToken = await createRoot(openCheckout, SD.open_checkout, o.userKey);
  const checkoutReference = tokenSdHash(openCheckoutToken);
  const openPayment = {
    vct: 'mandate.payment.open.1',
    constraints: [
      { type: 'payment.amount_range', currency: 'USD', min: 0, max: cents(o.maxUsd) },
      { type: 'payment.allowed_payees', allowed: o.merchants },
      { type: 'payment.reference', conditional_transaction_id: checkoutReference },
    ],
    cnf: { jwk: o.agentPublicKey },
    iat,
    exp: iat + o.ttlSeconds,
  };
  validate('open_payment', openPayment);
  const openPaymentToken = await createRoot(openPayment, SD.open_payment, o.userKey);
  return { openCheckout, openPayment, openCheckoutToken, openPaymentToken, checkoutReference };
}

// ---------- Merchant: signed checkout (UCP Checkout object) ----------
export async function merchantCheckout(o: {
  merchantKey: JWK;
  merchant: Merchant;
  checkoutId: string;
  item: { id: string; title: string };
  priceUsd: number;
  extensions?: Record<string, unknown>; // e.g. the Vouch promise; UCP Checkout allows additional properties
}) {
  const amount = cents(o.priceUsd);
  const iat = now();
  const checkout = {
    id: o.checkoutId,
    merchant: o.merchant,
    line_items: [{ id: 'li_1', item: { id: o.item.id, title: o.item.title, price: amount }, quantity: 1, totals: [{ type: 'subtotal', amount }, { type: 'total', amount }] }],
    status: 'ready_for_complete',
    currency: 'USD',
    totals: [{ type: 'subtotal', amount }, { type: 'total', amount }],
    links: [{ type: 'terms_of_service', url: 'https://vouch.example/demo-terms' }],
    ...o.extensions,
  };
  validate('checkout_object', checkout);
  const jwt = await signJwt({ ...checkout, iat, exp: iat + 3600 }, o.merchantKey);
  return { checkout, checkoutJwt: jwt, checkoutHash: sha256b64url(jwt) };
}

// ---------- Shopping Agent: closed mandates presented on the open ones ----------
export async function closedMandates(o: {
  agentKey: JWK;
  openCheckoutToken: string;
  openPaymentToken: string;
  checkoutJwt: string;
  checkoutHash: string;
  payee: Merchant;
  amountUsd: number;
  instrument: { id: string; type: string; description?: string };
  merchantAud: string;
  merchantNonce: string;
  processorAud: string;
  processorNonce: string;
}) {
  const iat = now();
  const checkoutMandate = { vct: 'mandate.checkout.1', checkout_jwt: o.checkoutJwt, checkout_hash: o.checkoutHash, iat };
  validate('checkout', checkoutMandate);
  const paymentMandate = {
    vct: 'mandate.payment.1',
    transaction_id: o.checkoutHash,
    payee: o.payee,
    payment_amount: { amount: cents(o.amountUsd), currency: 'USD' },
    payment_instrument: o.instrument,
    iat,
  };
  validate('payment', paymentMandate);
  const checkoutChain = await present(o.openCheckoutToken, checkoutMandate, SD.checkout, o.agentKey, o.merchantAud, o.merchantNonce);
  const paymentChain = await present(o.openPaymentToken, paymentMandate, SD.payment, o.agentKey, o.processorAud, o.processorNonce);
  return { checkoutMandate, paymentMandate, checkoutChain, paymentChain };
}

// ---------- Verification (merchant and processor roles) ----------
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function verifyCheckoutChain(o: { chain: string; userPublicKey: JWK; aud: string; nonce: string; merchantPublicKey: JWK; expectedCheckoutJwt: string }) {
  const hops = await verifyChain(o.chain, o.userPublicKey, { aud: o.aud, nonce: o.nonce });
  if (hops.length !== 2) throw new Error(`Checkout chain must be open + closed, got ${hops.length} tokens`);
  const [open, closed] = hops.map((h) => h.mandate);
  validate('open_checkout', open);
  validate('checkout', closed);
  const checks: Check[] = [];
  checks.push({ name: 'signatures', ok: true, detail: 'user-signed open mandate; agent-signed closed mandate (key from cnf)' });
  checks.push({ name: 'checkout_hash', ok: closed.checkout_hash === sha256b64url(closed.checkout_jwt), detail: 'hash of the merchant-signed checkout_jwt' });
  checks.push({ name: 'merchant checkout', ok: closed.checkout_jwt === o.expectedCheckoutJwt, detail: 'the checkout the merchant signed for this order' });
  const checkout = await verifyJwt(closed.checkout_jwt, o.merchantPublicKey);
  checks.push(...checkoutConstraints(open, checkout));
  if (open.exp && open.exp < now()) checks.push({ name: 'expiry', ok: false, detail: 'open checkout mandate expired' });
  return { checks, ok: checks.every((c) => c.ok), checkout, closed, reference: leafReference(o.chain) };
}

export async function verifyPaymentChain(o: { chain: string; userPublicKey: JWK; aud: string; nonce: string; openCheckoutReference: string; expectedCheckoutHash: string }) {
  const hops = await verifyChain(o.chain, o.userPublicKey, { aud: o.aud, nonce: o.nonce });
  if (hops.length !== 2) throw new Error(`Payment chain must be open + closed, got ${hops.length} tokens`);
  const [open, closed] = hops.map((h) => h.mandate);
  validate('open_payment', open);
  validate('payment', closed);
  const checks: Check[] = [{ name: 'signatures', ok: true, detail: 'user-signed open mandate; agent-signed closed mandate (key from cnf)' }];
  checks.push({ name: 'transaction_id', ok: closed.transaction_id === o.expectedCheckoutHash, detail: 'bound to the checkout hash' });
  checks.push(...paymentConstraints(open, closed, o.openCheckoutReference));
  if (open.exp && open.exp < now()) checks.push({ name: 'expiry', ok: false, detail: 'open payment mandate expired' });
  return { checks, ok: checks.every((c) => c.ok), closed, reference: leafReference(o.chain) };
}

// Spec: checkout.line_items (single requirement, any acceptable item, quantity)
// and checkout.allowed_merchants (merchant present in revealed allowed list).
export function checkoutConstraints(open: any, checkout: any): Check[] {
  const out: Check[] = [];
  for (const c of open.constraints ?? []) {
    if (c.type === 'checkout.line_items') {
      const need = c.items.reduce((s: number, r: any) => s + r.quantity, 0);
      const have = checkout.line_items.reduce((s: number, li: any) => s + li.quantity, 0);
      const okItems = checkout.line_items.every((li: any) => c.items.some((r: any) => r.acceptable_items.some((a: any) => a.id === li.item.id)));
      out.push({ name: 'checkout.line_items', ok: okItems && need === have, detail: okItems ? `${have} of ${need} matching items` : 'item not in acceptable_items' });
    } else if (c.type === 'checkout.allowed_merchants') {
      const ok = c.allowed.length > 0 && c.allowed.some((m: any) => m.id === checkout.merchant?.id);
      out.push({ name: 'checkout.allowed_merchants', ok, detail: ok ? `${checkout.merchant.name} is allowed` : 'merchant not in allowed list' });
    } else out.push({ name: c.type, ok: false, detail: 'unsupported constraint type' });
  }
  return out;
}

export function paymentConstraints(open: any, closed: any, openCheckoutReference: string): Check[] {
  const out: Check[] = [];
  for (const c of open.constraints ?? []) {
    if (c.type === 'payment.amount_range') {
      const a = closed.payment_amount;
      const ok = a.currency === c.currency && a.amount <= c.max && (c.min === undefined || a.amount >= c.min);
      out.push({ name: 'payment.amount_range', ok, detail: `${(a.amount / 100).toFixed(2)} ${a.currency} within max ${(c.max / 100).toFixed(2)}` });
    } else if (c.type === 'payment.allowed_payees') {
      const ok = c.allowed.some((m: any) => m.id === closed.payee.id);
      out.push({ name: 'payment.allowed_payees', ok, detail: ok ? `${closed.payee.name} is allowed` : 'payee not in allowed list' });
    } else if (c.type === 'payment.reference') {
      out.push({ name: 'payment.reference', ok: c.conditional_transaction_id === openCheckoutReference, detail: 'bound to the open checkout mandate' });
    } else out.push({ name: c.type, ok: false, detail: 'unsupported constraint type' });
  }
  return out;
}

// ---------- Receipts ----------
export async function checkoutReceipt(o: { merchantKey: JWK; iss: string; reference: string; orderId: string }) {
  const r = { status: 'Success', iss: o.iss, iat: now(), reference: o.reference, order_id: o.orderId };
  validate('checkout_receipt', r);
  return { receipt: r, jwt: await signJwt(r, o.merchantKey) };
}

export async function paymentReceipt(o: { processorKey: JWK; iss: string; reference: string; paymentId: string; pspConfirmationId: string; networkConfirmationId: string }) {
  const r = { status: 'Success', iss: o.iss, iat: now(), reference: o.reference, payment_id: o.paymentId, psp_confirmation_id: o.pspConfirmationId, network_confirmation_id: o.networkConfirmationId };
  validate('payment_receipt', r);
  return { receipt: r, jwt: await signJwt(r, o.processorKey) };
}
