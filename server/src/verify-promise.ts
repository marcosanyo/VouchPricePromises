// Lets a buyer's agent verify a store's promise instead of reading its words:
// the registered terms, their hash, and (optionally) that a merchant-signed AP2
// checkout carries exactly those terms. Shared by the MCP server and the HTTP API.
import { decodeJwt } from 'jose';
import { roleKey } from './ap2/keys.ts';
import type { Check } from './ap2/mandates.ts';
import { verifyJwt } from './ap2/sdjwt.ts';
import type { DB } from './db.ts';
import { nowIso } from './db.ts';
import { promiseWindowDays, REPLAY_WINDOW_DAYS } from './agents/merchant.ts';
import { standingClaims } from './market.ts';
import { addDays, canonicalJson, RULE_VERSION, sha256 } from './rules.ts';
import { storeLabel } from './score.ts';

// The terms of a full-difference no-price-drop promise (cap = price paid).
export const promiseTerms = (product_id: string, window_end: string) =>
  ({ claim_type: 'no_price_drop', product_id, window_end, refund: 'full_difference', rule_version: RULE_VERSION }) as const;
export const promiseTermsHash = (product_id: string, window_end: string) => sha256(canonicalJson(promiseTerms(product_id, window_end)));

interface Registered {
  store: string;
  found: true;
  claim: string;
  refund: string;
  judged_by: string;
  refund_paid_by: string;
  terms_signed_by_store: boolean;
  terms_hash: string;
  status: 'active';
  rule_version: string;
  checkout?: { signature_valid: boolean; promise_in_checkout_matches_terms: boolean; checks: Check[] };
}

// DEMO ASSUMPTION (playground replays): under the conditions 'none', 'words' and
// 'fake' the featured store is treated as not registered with Vouch for that run,
// even if its owner published a promise for the 'vouch' condition.
export interface DemoRun { condition: 'none' | 'words' | 'fake' | 'vouch'; featured_product_id: string }
export const demoUnregistered = (demo: DemoRun | undefined, product_id: string) => !!demo && demo.condition !== 'vouch' && demo.featured_product_id === product_id;

export async function verifyPromise(db: DB, product_id: string, checkout_jwt?: string, as_of?: string, demo?: DemoRun): Promise<Registered | { store: null; found: false; note: string }> {
  if (demoUnregistered(demo, product_id)) return { store: null, found: false, note: 'No promise for this store is registered with Vouch.' };
  const claim = standingClaims(db, product_id).find((c) => c.claim_type === 'no_price_drop');
  if (!claim) return { store: null, found: false, note: 'No promise for this store is registered with Vouch.' };
  // The store is the listing's own domain (as the shopping agent sees it), not the
  // domain stored with the claim, so the name and the merchant key always match the checkout.
  const listing = db.prepare('SELECT MIN(domain) AS domain FROM offer_snapshots WHERE product_id = ?').get(product_id) as { domain: string | null } | undefined;
  if (!listing?.domain) throw new Error(`No listing ${product_id} in the database`);
  const store = storeLabel(listing.domain);
  // A replay of day D reads the promise as of D, and its window is the replay window.
  const today = as_of ?? nowIso().slice(0, 10);
  const window_end = addDays(today, as_of ? REPLAY_WINDOW_DAYS : claim.window_kind === '14' ? 14 : promiseWindowDays(today));
  const terms_hash = promiseTermsHash(product_id, window_end);
  const out: Registered = {
    store,
    found: true,
    claim: `No price drop until ${window_end}`,
    refund: 'the full difference',
    judged_by: 'fixed rules on the store\'s daily prices',
    refund_paid_by: 'PayPal, automatically, from the store\'s account',
    terms_signed_by_store: true, // the store published these terms itself in the seller console
    terms_hash,
    status: 'active',
    rule_version: RULE_VERSION,
  };
  if (!checkout_jwt) return out;

  // The merchant's signing key is the one Vouch holds for that store's AP2 merchant id.
  const key = await roleKey(db, `merchant-${store.toLowerCase().replace(/\s+/g, '-')}`);
  const checks: Check[] = [];
  let signature_valid = false;
  let carried: Record<string, any> | undefined;
  try {
    const payload = await verifyJwt(checkout_jwt, key.publicJwk);
    signature_valid = true;
    carried = payload.vouch_promise;
    checks.push({ name: 'merchant signature', ok: true, detail: 'the checkout was signed by the store\'s merchant key' });
  } catch (err) {
    decodeJwt(checkout_jwt); // malformed input throws as-is; a well-formed token with a bad signature is reported
    checks.push({ name: 'merchant signature', ok: false, detail: String(err instanceof Error ? err.message : err) });
  }
  if (!signature_valid) carried = decodeJwt(checkout_jwt).vouch_promise as Record<string, any> | undefined;
  checks.push({ name: 'promise in checkout', ok: !!carried, detail: carried ? 'the checkout extensions carry a vouch_promise' : 'no vouch_promise in the checkout extensions' });
  const claimed = carried?.terms_hash;
  const recomputed = carried?.window_end ? promiseTermsHash(product_id, carried.window_end) : null;
  checks.push({ name: 'terms hash recomputes', ok: !!claimed && claimed === recomputed, detail: 'the checkout\'s terms_hash equals the hash of its own terms' });
  checks.push({ name: 'terms hash equals registered', ok: !!claimed && claimed === terms_hash, detail: 'the checkout\'s terms_hash equals the hash of the terms registered with Vouch today' });
  return { ...out, terms_signed_by_store: signature_valid, checkout: { signature_valid, promise_in_checkout_matches_terms: signature_valid && checks.slice(1).every((c) => c.ok), checks } };
}
