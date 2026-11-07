// Live staked purchases on PayPal Sandbox, judged later on fresh Channel3 data.
// purchase(): real Channel3 price → frozen contract terms + hash → PayPal order.
// judgeDue(): fresh Channel3 history → rule verdict → PayPal partial refund.
import { randomUUID } from 'node:crypto';
import type { Channel3 } from './channel3.ts';
import type { DB } from './db.ts';
import { nowIso } from './db.ts';
import { UpstreamError } from './errors.ts';
import { buildGroups, loadListings } from './features.ts';
import { append } from './ledger.ts';
import { lastCallId, pricePoints, savePriceHistory, upsertProduct } from './repo.ts';
import { addDays, canJudge, judge, judgeEarly, makeTerms, RULE_VERSION, termsHash, type ClaimType, type Series, type Terms } from './rules.ts';
import { storeLabel } from './score.ts';
import { merchantTag, sellerSlot, SHARED_SLOT, type Sellers } from './sellers.ts';

export interface LiveDeps {
  db: DB;
  channel3: Channel3;
  sellers: Sellers;
}

// Days after judge_after_day to wait for Channel3 to publish the last daily
// price before the missing-evidence rule applies.
export const EVIDENCE_GRACE_DAYS = 2;

export const today = () => nowIso().slice(0, 10);

function series(db: DB, productId: string): Series {
  return new Map(pricePoints(db, productId).map((p) => [p.day, p.price]));
}

function monthSpend(db: DB, domain: string): number {
  const month = today().slice(0, 7);
  const open = db.prepare(`SELECT COALESCE(SUM(json_extract(terms_json,'$.stake_usd')),0) AS s FROM contracts WHERE mode='live' AND domain=? AND status='open'`).get(domain) as { s: number };
  const paid = db.prepare(`SELECT COALESCE(SUM(j.payout_usd),0) AS s FROM judgments j JOIN contracts c ON c.id=j.contract_id WHERE c.mode='live' AND c.domain=? AND substr(j.judged_at,1,7)=?`).get(domain, month) as { s: number };
  return open.s + paid.s;
}

export async function purchase(
  deps: LiveDeps,
  // full_difference: the stake is the price paid, so a no_price_drop promise refunds the whole difference.
  req: { product_id: string; claims: { claim_type: ClaimType; stake_usd: number; full_difference?: boolean }[] },
) {
  const { db, channel3, sellers } = deps;
  if (req.claims.length === 0) throw new Error('At least one staked claim is required');

  // 1. Current offer straight from Channel3 (kept as evidence).
  const product = await channel3.product(req.product_id);
  upsertProduct(db, product, null, lastCallId(db));
  const offers = product.offers ?? [];
  if (offers.length !== 1) throw new Error(`Product ${req.product_id} has ${offers.length} merchant offers; live contracts need a single-store listing`);
  const offer = offers[0];
  if (offer.price.currency !== 'USD') throw new Error(`Offer currency ${offer.price.currency} is not USD`);

  // 2. Fresh history so genuine_sale is judged on data up to today.
  const h = await channel3.history(req.product_id, 30);
  savePriceHistory(db, h, lastCallId(db));

  // 3. Budget check: the seller's monthly cap on open stakes plus payouts.
  const budget = db.prepare('SELECT monthly_budget_usd FROM seller_settings WHERE domain = ?').get(offer.domain) as { monthly_budget_usd: number } | undefined;
  const claims = req.claims.map((c) => (c.full_difference ? { claim_type: c.claim_type, stake_usd: offer.price.price } : c));
  const newStake = claims.reduce((s, c) => s + c.stake_usd, 0);
  if (budget && monthSpend(db, offer.domain) + newStake > budget.monthly_budget_usd) {
    throw new Error(`Monthly stake budget $${budget.monthly_budget_usd} for ${storeLabel(offer.domain)} would be exceeded`);
  }

  const groups = buildGroups(loadListings(db));
  const group = [...groups.entries()].find(([, ls]) => ls.some((l) => l.product_id === req.product_id));
  const peers = group ? group[1].filter((l) => l.product_id !== req.product_id).map((l) => ({ product_id: l.product_id, domain: l.domain })) : [];

  // 4. PayPal Sandbox order at the real price, paid to the store's own seller
  //    account. Fails loudly; no contract is written for an order that did not capture.
  const purchaseId = randomUUID();
  const slot = sellerSlot(db, offer.domain);
  const order = await sellers.client(slot).createAndCaptureCardOrder({
    requestId: `vouch-order-${purchaseId}`,
    amount: offer.price.price,
    description: `${product.title}`.slice(0, 120),
    customId: purchaseId,
    invoiceId: `vouch-${purchaseId}`,
  });
  const contracts = recordContracts(db, { purchaseId, product_id: req.product_id, domain: offer.domain, group_key: group?.[0] ?? null, price: offer.price.price, peers, claims, slot, order, availability: offer.availability });

  const judged = await judgeDue(deps, { contractIds: contracts.map((c) => c.id) });
  return { purchase_id: purchaseId, store: storeLabel(offer.domain), price: offer.price.price, paypal_seller: { slot, merchant: merchantTag(order.payeeMerchantId), shared: slot === SHARED_SLOT }, order, contracts: contracts.map((c) => ({ id: c.id, hash: c.hash, terms: c.terms })), judged };
}

// Freezes the terms of each staked claim on a captured order, writes the
// contracts and their ledger entries. Shared by direct purchases and by
// purchases made by the shopping agent under AP2 mandates.
export function recordContracts(
  db: DB,
  o: {
    purchaseId: string;
    product_id: string;
    domain: string;
    group_key: string | null;
    price: number;
    peers: { product_id: string; domain: string }[];
    claims: { claim_type: ClaimType; stake_usd: number; window_days?: number }[];
    slot: number;
    order: { orderId: string; captureId: string; payeeMerchantId: string | null; status: string; amount: unknown; paypalFee: unknown };
    availability: string;
    ledgerExtra?: Record<string, unknown>;
    // Replays of a past day D: the purchase day is D and the contract is
    // 'replay-live', so live track records, the daily judge and the live
    // ledger list (all mode = 'live') never include it.
    mode?: 'live' | 'replay-live';
    purchaseDay?: string;
  },
) {
  const day = o.purchaseDay ?? today();
  const mode = o.mode ?? 'live';
  const contracts = o.claims.map((c) => {
    const terms = makeTerms({ claim_type: c.claim_type, product_id: o.product_id, domain: o.domain, group_key: o.group_key, purchase_price: o.price, purchase_day: day, stake_usd: c.stake_usd, peers: o.peers, window_days: c.window_days });
    return { id: `c_${randomUUID().slice(0, 12)}`, terms, hash: termsHash(terms) };
  });
  const ins = db.prepare(
    `INSERT INTO contracts (id, created_at, mode, run_id, product_id, domain, group_key, claim_type, terms_json, hash, status, paypal_order_id, paypal_capture_id, paypal_seller_slot, paypal_merchant_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
  );
  for (const c of contracts) {
    ins.run(c.id, nowIso(), mode, o.purchaseId, o.product_id, o.domain, c.terms.group_key, c.terms.claim_type, JSON.stringify(c.terms), c.hash, o.order.orderId, o.order.captureId, o.slot, o.order.payeeMerchantId);
    append(db, 'contract', c.id, { mode, purchase_id: o.purchaseId, hash: c.hash, terms: { ...c.terms, domain: storeLabel(c.terms.domain), peers: c.terms.peers?.map((p) => ({ ...p, domain: storeLabel(p.domain) })) } });
  }
  append(db, 'order', o.purchaseId, { paypal_order_id: o.order.orderId, paypal_capture_id: o.order.captureId, paypal_seller_slot: o.slot, paypal_merchant_id: o.order.payeeMerchantId, status: o.order.status, amount: o.order.amount, paypal_fee: o.order.paypalFee, contracts: contracts.map((c) => c.id), availability_at_purchase: o.availability, ...o.ledgerExtra });
  // Availability at purchase is evidence for in_stock.
  db.prepare(`UPDATE contracts SET terms_json = json_set(terms_json, '$.availability_snapshot', ?) WHERE run_id = ?`).run(o.availability, o.purchaseId);
  return contracts;
}

export interface JudgeOutcome {
  contract_id: string;
  status: 'open' | 'hit' | 'miss';
  reason: string;
  payout_usd?: number;
  refund?: { ok: boolean; paypal_refund_id?: string; error?: unknown };
}

export async function judgeDue(deps: LiveDeps, opts: { contractIds?: string[]; asOf?: string } = {}): Promise<{ results: JudgeOutcome[]; errors: unknown[] }> {
  const { db, channel3, sellers } = deps;
  const day = opts.asOf ?? today();
  const rows = (db.prepare(`SELECT * FROM contracts WHERE mode='live' AND status='open' ORDER BY created_at`).all() as any[]).filter(
    (r) => !opts.contractIds || opts.contractIds.includes(r.id),
  );
  const results: JudgeOutcome[] = [];
  const errors: unknown[] = [];
  const refreshed = new Set<string>();
  const fetchErr = new Map<string, unknown>();

  for (const r of rows) {
    const terms = JSON.parse(r.terms_json) as Terms & { availability_snapshot?: 'InStock' | 'OutOfStock' };
    // Before the window ends, only a final miss can settle (rules.ts judgeEarly).
    const early = day < terms.judge_after_day;
    if (early && !terms.early_settlement) {
      results.push({ contract_id: r.id, status: 'open', reason: `Window ends ${terms.judge_after_day}` });
      continue;
    }
    // Refresh Channel3 history for the listing and its compared stores.
    const ids = [terms.product_id, ...(terms.peers ?? []).map((p) => p.product_id)];
    if (terms.claim_type !== 'in_stock' && terms.window_days > 0) {
      for (const id of ids) {
        if (refreshed.has(id)) continue;
        refreshed.add(id);
        try {
          const h = await channel3.history(id, 30);
          savePriceHistory(db, h, lastCallId(db));
        } catch (err) {
          fetchErr.set(id, err instanceof UpstreamError ? err.toJSON() : String(err));
          append(db, 'evidence_error', r.id, { product_id: id, error: fetchErr.get(id) });
          errors.push({ contract_id: r.id, product_id: id, error: fetchErr.get(id) });
        }
      }
    }
    const listing = series(db, terms.product_id);
    const latest = [...listing.keys()].sort().at(-1) ?? '';
    const pastGrace = day > addDays(terms.judge_after_day, EVIDENCE_GRACE_DAYS);
    if (!early && terms.window_days > 0 && !canJudge(terms, latest) && !pastGrace) {
      results.push({ contract_id: r.id, status: 'open', reason: `Waiting for Channel3 daily price of ${terms.judge_after_day} (latest ${latest || 'none'})` });
      continue;
    }
    const peers = new Map((terms.peers ?? []).map((p) => [p.product_id, series(db, p.product_id)]));
    const ev = { listing, peers, availabilityAtPurchase: terms.availability_snapshot ?? null };
    const v = early ? judgeEarly(terms, ev) : judge(terms, ev);
    if (!v) {
      results.push({ contract_id: r.id, status: 'open', reason: `Window ends ${terms.judge_after_day}; no compared store is yet cheaper by the full stake` });
      continue;
    }
    const evidence = { ...v, channel3_fetch_errors: Object.fromEntries([...fetchErr].filter(([id]) => ids.includes(id))) };
    db.prepare(`INSERT INTO judgments (contract_id, judged_at, outcome, reason, payout_usd, rule_version, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      r.id, nowIso(), v.outcome, v.reason, v.payout_usd, RULE_VERSION, JSON.stringify(evidence),
    );
    db.prepare(`UPDATE contracts SET status = ? WHERE id = ?`).run(v.outcome, r.id);
    append(db, 'judgment', r.id, { outcome: v.outcome, reason: v.reason, payout_usd: v.payout_usd, evidence_missing: v.evidence_missing, contract_hash: r.hash });
    const out: JudgeOutcome = { contract_id: r.id, status: v.outcome, reason: v.reason, payout_usd: v.payout_usd };

    if (v.outcome === 'miss') {
      out.refund = await refundMiss(deps, r, v);
      if (!out.refund.ok) errors.push({ contract_id: r.id, refund_error: out.refund.error });
    }
    results.push(out);
  }
  return { results, errors };
}

// Refund a missed contract from the seller that took the order: their balance
// pays. A failure is recorded and returned as it is (no retry here).
async function refundMiss(deps: LiveDeps, r: any, v: { payout_usd: number; reason: string }, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; paypal_refund_id?: string; error?: unknown }> {
  const { db, sellers } = deps;
  try {
    const ref = await sellers.client(r.paypal_seller_slot).refundCapture({
      captureId: r.paypal_capture_id,
      amount: v.payout_usd,
      requestId: `vouch-refund-${r.id}`,
      note: `Vouch staked claim missed: ${v.reason}`,
      invoiceId: `vouch-refund-${r.id}`,
    });
    db.prepare(`INSERT INTO refunds (contract_id, attempted_at, amount_usd, ok, paypal_refund_id, paypal_status, response_json) VALUES (?, ?, ?, 1, ?, ?, ?)`).run(
      r.id, nowIso(), v.payout_usd, ref.refundId, ref.status, JSON.stringify(ref.raw),
    );
    append(db, 'refund', r.id, { paypal_refund_id: ref.refundId, status: ref.status, amount_usd: v.payout_usd, capture_id: r.paypal_capture_id, paypal_seller_slot: r.paypal_seller_slot, paypal_merchant_id: r.paypal_merchant_id, ...extra });
    return { ok: true, paypal_refund_id: ref.refundId };
  } catch (err) {
    const e = err instanceof UpstreamError ? err.toJSON() : String(err);
    db.prepare(`INSERT INTO refunds (contract_id, attempted_at, amount_usd, ok, response_json) VALUES (?, ?, ?, 0, ?)`).run(r.id, nowIso(), v.payout_usd, JSON.stringify(e));
    append(db, 'refund_failed', r.id, { error: e, amount_usd: v.payout_usd, ...extra });
    return { ok: false, error: e };
  }
}

// "Fast-forward" for a replay of day D: the unchanged rules applied to the
// real Channel3 daily prices from D+1 to the end of the window, which are
// already in the data. A miss is refunded from the store's PayPal seller.
// Only 'replay-live' contracts; live contracts wait for their real day.
export async function judgeReplay(deps: LiveDeps, contractId: string) {
  const { db } = deps;
  const r = db.prepare(`SELECT * FROM contracts WHERE id = ? AND mode = 'replay-live'`).get(contractId) as any;
  if (!r) throw new Error(`Contract ${contractId} is not a replay contract`);
  const terms = JSON.parse(r.terms_json) as Terms;
  const listing = series(db, terms.product_id);
  const points = [...listing.entries()].filter(([d]) => d >= terms.purchase_day && d <= terms.judge_after_day).sort((a, b) => a[0].localeCompare(b[0])).map(([day, price]) => ({ day, price }));
  if (r.status === 'open') {
    const latest = [...listing.keys()].sort().at(-1) ?? '';
    if (!canJudge(terms, latest)) throw new Error(`Channel3 prices for ${terms.product_id} end on ${latest}; the replay window ends ${terms.judge_after_day}`);
    const peers = new Map((terms.peers ?? []).map((p) => [p.product_id, series(db, p.product_id)]));
    const v = judge(terms, { listing, peers });
    db.prepare(`INSERT INTO judgments (contract_id, judged_at, outcome, reason, payout_usd, rule_version, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(r.id, nowIso(), v.outcome, v.reason, v.payout_usd, RULE_VERSION, JSON.stringify(v));
    db.prepare(`UPDATE contracts SET status = ? WHERE id = ?`).run(v.outcome, r.id);
    append(db, 'judgment', r.id, { mode: 'replay-live', replay_of: terms.purchase_day, outcome: v.outcome, reason: v.reason, payout_usd: v.payout_usd, contract_hash: r.hash });
    if (v.outcome === 'miss') await refundMiss(deps, r, v, { mode: 'replay-live', replay_of: terms.purchase_day });
  }
  const j = db.prepare('SELECT outcome, reason, payout_usd FROM judgments WHERE contract_id = ?').get(r.id) as { outcome: string; reason: string; payout_usd: number };
  const f = db.prepare('SELECT ok, paypal_refund_id, amount_usd, response_json FROM refunds WHERE contract_id = ? ORDER BY id DESC').get(r.id) as any;
  return {
    contract_id: r.id,
    paid_usd: terms.purchase_price,
    cap_usd: terms.stake_usd,
    purchase_day: terms.purchase_day,
    judge_after_day: terms.judge_after_day,
    points,
    verdict: j,
    refund: f ? { ok: !!f.ok, paypal_refund_id: f.paypal_refund_id, amount_usd: f.amount_usd, error: f.ok ? undefined : JSON.parse(f.response_json) } : null,
    paypal_seller_slot: r.paypal_seller_slot,
  };
}

// Retries failed refunds for missed contracts (explicit, operator-triggered).
export async function retryRefunds(deps: LiveDeps) {
  const rows = deps.db
    .prepare(
      `SELECT c.*, j.payout_usd, j.reason FROM contracts c JOIN judgments j ON j.contract_id = c.id
       WHERE c.status = 'miss' AND NOT EXISTS (SELECT 1 FROM refunds f WHERE f.contract_id = c.id AND f.ok = 1)`,
    )
    .all() as any[];
  const out = [];
  for (const r of rows) {
    const ref = await deps.sellers.client(r.paypal_seller_slot).refundCapture({ captureId: r.paypal_capture_id, amount: r.payout_usd, requestId: `vouch-refund-${r.id}`, note: `Vouch staked claim missed: ${r.reason}`, invoiceId: `vouch-refund-${r.id}` });
    deps.db.prepare(`INSERT INTO refunds (contract_id, attempted_at, amount_usd, ok, paypal_refund_id, paypal_status, response_json) VALUES (?, ?, ?, 1, ?, ?, ?)`).run(r.id, nowIso(), r.payout_usd, ref.refundId, ref.status, JSON.stringify(ref.raw));
    append(deps.db, 'refund', r.id, { paypal_refund_id: ref.refundId, status: ref.status, amount_usd: r.payout_usd, capture_id: r.paypal_capture_id, paypal_seller_slot: r.paypal_seller_slot, paypal_merchant_id: r.paypal_merchant_id, retry: true });
    out.push({ contract_id: r.id, paypal_refund_id: ref.refundId });
  }
  return out;
}
