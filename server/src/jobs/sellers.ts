// PayPal seller accounts (plan B).
//   node src/jobs/sellers.ts list                    configured slots, their merchant ids, assigned stores
//   node src/jobs/sellers.ts assign <store> <slot>   give a store (domain or "Store XX0") its own seller
//   node src/jobs/sellers.ts verify [slot...]        $1.00 Sandbox order + $0.50 refund on each slot
// verify touches no contract; it shows that the order and the refund go
// through each seller's own account.
import { randomUUID } from 'node:crypto';
import { makeCtx } from '../context.ts';
import { storeLabel } from '../score.ts';
import { assignSeller, SHARED_SLOT } from '../sellers.ts';

const ctx = makeCtx();
const [cmd = 'list', ...args] = process.argv.slice(2);

function resolveStore(arg: string): string {
  const domains = (ctx.db.prepare('SELECT DISTINCT domain FROM offer_snapshots').all() as { domain: string }[]).map((r) => r.domain);
  const hit = domains.find((d) => d === arg || storeLabel(d) === arg);
  if (!hit) throw new Error(`Unknown store ${arg} (pass a domain or its label, e.g. "Demo store LK63")`);
  return hit;
}

if (cmd === 'list') {
  const assigned = ctx.db.prepare('SELECT domain, seller_slot, merchant_id, assigned_at FROM seller_accounts').all() as any[];
  for (const slot of ctx.sellers.slots()) {
    const merchant = await ctx.sellers.client(slot).merchantId();
    const stores = slot === SHARED_SLOT ? ['(every store without its own seller)'] : assigned.filter((a) => a.seller_slot === slot).map((a) => `${storeLabel(a.domain)} (${a.domain})`);
    console.log(`slot ${slot}  merchant ${merchant}  stores: ${stores.join(', ') || '(none)'}`);
    for (const a of assigned.filter((x) => x.seller_slot === slot && x.merchant_id !== merchant)) {
      console.log(`  ! ${a.domain} was assigned merchant ${a.merchant_id}; the credentials now belong to ${merchant}. Re-run assign.`);
    }
  }
} else if (cmd === 'assign') {
  const [store, slot] = args;
  if (!store || !slot) throw new Error('Usage: sellers.ts assign <store> <slot>');
  const a = await assignSeller(ctx.db, ctx.sellers, resolveStore(store), Number(slot));
  console.log(`${storeLabel(a.domain)} → slot ${a.seller_slot} (merchant ${a.merchant_id})`);
} else if (cmd === 'verify') {
  const slots = args.length ? args.map(Number) : ctx.sellers.slots();
  for (const slot of slots) {
    const pp = ctx.sellers.client(slot);
    const id = randomUUID();
    const order = await pp.createAndCaptureCardOrder({ requestId: `vouch-verify-${id}`, amount: 1, description: 'Vouch seller check', customId: `verify-${id}`, invoiceId: `vouch-verify-${id}` });
    const refund = await pp.refundCapture({ captureId: order.captureId, amount: 0.5, requestId: `vouch-verify-refund-${id}`, note: 'Vouch seller check: partial refund', invoiceId: `vouch-verify-refund-${id}` });
    console.log(`slot ${slot}  merchant ${order.payeeMerchantId}  payee ${order.payee}  order ${order.orderId} ${order.status}  capture ${order.captureId}  refund ${refund.refundId} ${refund.status}`);
  }
} else {
  throw new Error(`Unknown command ${cmd} (list | assign | verify)`);
}
