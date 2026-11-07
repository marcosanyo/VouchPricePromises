// Collection job (local now; Cloud Run Job later).
//   node src/jobs/collect.ts search      search every target query, save offers
//   node src/jobs/collect.ts history     fetch 30-day history for every product
//   node src/jobs/collect.ts track       start Channel3 price tracking for every product
//   node src/jobs/collect.ts snapshot    re-read current offers of tracked products
//   node src/jobs/collect.ts all         search + history + track
//   node src/jobs/collect.ts predict     register a hashed batch of 14-day drop predictions for tracked listings
//   node src/jobs/collect.ts daily       snapshot tracked offers (per-store prices), refresh their history, judge due live contracts
// Failures stop the job with the raw upstream error.
import { makeCtx, type Ctx } from '../context.ts';
import { lastCallId, savePriceHistory, upsertProduct } from '../repo.ts';
import { nowIso } from '../db.ts';
import { TARGET_QUERIES } from './targets.ts';
import { buildGroups, loadListings } from '../features.ts';
import { judgeDue } from '../live.ts';
import { UpstreamError } from '../errors.ts';
import { registerBatch, resolveDue } from '../predictions.ts';

const PAGES_PER_QUERY = Number(process.env.COLLECT_PAGES ?? 1);

async function search(ctx: Ctx) {
  for (const q of TARGET_QUERIES) {
    let token: string | undefined;
    for (let page = 0; page < PAGES_PER_QUERY; page++) {
      const res = await ctx.channel3.search({ query: q, limit: 30, page_token: token });
      const callId = lastCallId(ctx.db);
      for (const p of res.products) upsertProduct(ctx.db, p, q, callId);
      console.log(`[search] ${q} p${page}: ${res.products.length} products`);
      if (!res.next_page_token) break;
      token = res.next_page_token;
    }
  }
}

async function history(ctx: Ctx, force: boolean) {
  const today = nowIso().slice(0, 10);
  const ids = ctx.db
    .prepare(
      `SELECT p.id FROM products p
       WHERE ? OR NOT EXISTS (SELECT 1 FROM history_stats h WHERE h.product_id = p.id AND substr(h.fetched_at,1,10) = ?)`,
    )
    .all(force ? 1 : 0, today) as { id: string }[];
  let n = 0;
  for (const { id } of ids) {
    const h = await ctx.channel3.history(id, 30);
    savePriceHistory(ctx.db, h, lastCallId(ctx.db));
    n++;
    if (n % 25 === 0) console.log(`[history] ${n}/${ids.length}`);
  }
  console.log(`[history] fetched ${n} products`);
}

// Tracks the listings that belong to a multi-store group (the ones replays,
// rankings, and live contracts use). `--all` tracks every product.
async function track(ctx: Ctx, all: boolean) {
  const grouped = new Set([...buildGroups(loadListings(ctx.db)).values()].flat().map((l) => l.product_id));
  const ids = (ctx.db
    .prepare(`SELECT id FROM products WHERE id NOT IN (SELECT product_id FROM tracking WHERE status = 'active')`)
    .all() as { id: string }[]).filter((r) => all || grouped.has(r.id));
  for (const { id } of ids) {
    const sub = await ctx.channel3.startTracking(id);
    ctx.db
      .prepare('INSERT OR REPLACE INTO tracking (product_id, status, created_at) VALUES (?, ?, ?)')
      .run(id, sub.subscription_status, sub.created_at);
  }
  console.log(`[track] started ${ids.length} subscriptions`);
}

// Errors are collected per product so one failure does not stop the rest (or
// the judging that follows); they are printed and the job exits non-zero.
const failures: unknown[] = [];

// A product Channel3 no longer has (404) is marked 'gone' and not fetched again.
function markGone(ctx: Ctx, id: string, err: UpstreamError) {
  ctx.db.prepare(`UPDATE tracking SET status = 'gone' WHERE product_id = ?`).run(id);
  console.log(`[gone] ${id}: ${JSON.stringify(err.body)}`);
}

async function eachTracked(ctx: Ctx, label: string, fn: (id: string) => Promise<void>) {
  const ids = ctx.db.prepare(`SELECT product_id AS id FROM tracking WHERE status = 'active'`).all() as { id: string }[];
  let ok = 0;
  for (const { id } of ids) {
    try {
      await fn(id);
      ok++;
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 404) markGone(ctx, id, err);
      else failures.push({ step: label, product_id: id, error: err instanceof UpstreamError ? err.toJSON() : String(err) });
    }
  }
  console.log(`[${label}] ${ok}/${ids.length} tracked listings`);
}

async function snapshot(ctx: Ctx) {
  await eachTracked(ctx, 'snapshot', async (id) => {
    const p = await ctx.channel3.product(id);
    upsertProduct(ctx.db, p, null, lastCallId(ctx.db));
  });
}

const cmd = process.argv[2] ?? 'all';
const ctx = makeCtx();
const force = process.argv.includes('--force');
if (cmd === 'search' || cmd === 'all') await search(ctx);
if (cmd === 'history' || cmd === 'all') await history(ctx, force);
if (cmd === 'track' || cmd === 'all') await track(ctx, process.argv.includes('--all'));
if (cmd === 'snapshot') await snapshot(ctx);
if (cmd === 'daily') {
  // Our own per-store observation: Channel3 history has no merchant, the
  // current offers do. One /v1/products call per tracked listing.
  await snapshot(ctx);
  await eachTracked(ctx, 'history', async (id) => savePriceHistory(ctx.db, await ctx.channel3.history(id, 30), lastCallId(ctx.db)));
  const r = await judgeDue(ctx);
  for (const x of r.results) console.log(`[judge] ${x.contract_id} ${x.status}: ${x.reason}${x.refund ? ` refund=${JSON.stringify(x.refund)}` : ''}`);
  failures.push(...r.errors);
  const pr = resolveDue(ctx.db);
  console.log(`[predictions] ${pr.resolved} of ${pr.due} past-horizon predictions resolved`);
}
if (cmd === 'predict') console.log('[predict]', registerBatch(ctx.db));
if (failures.length) {
  console.error('[failures]', JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
// Channel3 calls by endpoint kind (product ids stripped), today and in total.
const kind = `CASE WHEN endpoint LIKE '/v1/products/%' THEN '/v1/products' WHEN endpoint LIKE '/v0/price-tracking/history/%' THEN '/v0/price-tracking/history' ELSE endpoint END`;
const calls = ctx.db
  .prepare(`SELECT ${kind} AS endpoint, SUM(substr(ts,1,10) = ?) AS today, COUNT(*) AS total FROM api_calls WHERE upstream='channel3' GROUP BY 1 ORDER BY total DESC`)
  .all(nowIso().slice(0, 10));
console.table(calls);
