// Seeds live contracts: picks tracked single-store listings the drop model
// rates most likely to drop within 14 days (one per item group), turns on
// hypothetical staked claims for them, and buys each once on PayPal Sandbox.
//   node src/jobs/live-batch.ts [count=8] [--dry-run]
import { makeCtx } from '../context.ts';
import { buildGroups, loadListings } from '../features.ts';
import { purchase } from '../live.ts';
import { quote, setStandingClaim } from '../market.ts';

const count = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 8);
const dry = process.argv.includes('--dry-run');
const ctx = makeCtx();
const tracked = new Set((ctx.db.prepare(`SELECT product_id FROM tracking WHERE status='active'`).all() as { product_id: string }[]).map((r) => r.product_id));
const bought = new Set((ctx.db.prepare(`SELECT DISTINCT product_id FROM contracts WHERE mode='live'`).all() as { product_id: string }[]).map((r) => r.product_id));
const groupOf = new Map<string, string>();
for (const [k, ls] of buildGroups(loadListings(ctx.db))) for (const l of ls) groupOf.set(l.product_id, k);

const candidates = loadListings(ctx.db)
  .filter((l) => tracked.has(l.product_id) && !bought.has(l.product_id))
  .map((l) => ({ l, q: quote(ctx.db, l.product_id, 'no_price_drop', 10) }))
  .filter((c) => c.q.p_fail != null && c.q.price <= 1500)
  .sort((a, b) => b.q.p_fail! - a.q.p_fail!);

const usedGroups = new Set<string>();
const picks: typeof candidates = [];
for (const c of candidates) {
  const g = groupOf.get(c.l.product_id) ?? c.l.product_id;
  if (usedGroups.has(g)) continue;
  usedGroups.add(g);
  picks.push(c);
  if (picks.length >= count) break;
}

for (const { l, q } of picks) {
  // Stake covers the expected shortfall, capped at $50.
  const stake = Math.min(50, Math.max(5, Math.ceil(q.expected_shortfall_usd ?? 10)));
  const claims: { claim_type: 'no_price_drop' | 'lowest_price'; stake_usd: number }[] = [{ claim_type: 'no_price_drop', stake_usd: stake }];
  const lq = groupOf.has(l.product_id) ? quote(ctx.db, l.product_id, 'lowest_price', stake) : null;
  if (lq && lq.p_fail != null && lq.p_fail < 1) claims.push({ claim_type: 'lowest_price', stake_usd: stake });
  console.log(`${q.store} ${q.price} P(drop)=${(q.p_fail! * 100).toFixed(1)}% stake=$${stake} claims=${claims.map((c) => c.claim_type).join('+')}`);
  if (dry) continue;
  let r;
  try {
    r = await purchase(ctx, { product_id: l.product_id, claims });
  } catch (err) {
    // A listing that no longer meets the purchase preconditions (e.g. Channel3
    // now shows two merchants) is skipped and reported; upstream errors stop the job.
    if (err instanceof Error && err.message.includes('live contracts need a single-store listing')) {
      console.log(`  skipped: ${err.message}`);
      continue;
    }
    throw err;
  }
  for (const c of claims) setStandingClaim(ctx.db, { product_id: l.product_id, domain: l.domain, claim_type: c.claim_type, stake_usd: c.stake_usd, active: true });
  console.log(`  bought: order ${r.order.orderId} contracts ${r.contracts.map((c) => `${c.id}(${c.terms.claim_type}→${c.terms.judge_after_day})`).join(', ')}`);
}
