// Vouch HTTP API. Public responses are anonymised (no merchant domains or offer
// URLs). Upstream failures return 502 with the raw service error.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { basicAuth } from 'hono/basic-auth';
import { HTTPException } from 'hono/http-exception';
import { relative } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from './config.ts';
import { makeCtx } from './context.ts';
import { merchantTag, SHARED_SLOT } from './sellers.ts';

// Which seller's PayPal took the order (and pays any refund), shortened for screens.
const paypalSeller = (r: { paypal_seller_slot: number | null; paypal_merchant_id: string | null }) =>
  r.paypal_seller_slot === null ? null : { slot: r.paypal_seller_slot, merchant: merchantTag(r.paypal_merchant_id), shared: r.paypal_seller_slot === SHARED_SLOT };
import { nowIso } from './db.ts';
import { UpstreamError } from './errors.ts';
import { extractClaims, auditListings } from './extract.ts';
import { entries as ledgerEntries, verify as verifyLedger, append } from './ledger.ts';
import { DEMO_DAILY_LIMIT, demoRunsToday, falseClaimDemo } from './demo.ts';
import { judgeDue, judgeReplay, purchase, retryRefunds } from './live.ts';
import { approve, fastForwardWait, MANDATE_TTL_SECONDS, REPLAY_WINDOW_DAYS, SHOP_DAILY_LIMIT, shopRunsToday, startTask, taskView } from './agents/shopper.ts';
import { dropRisk, liveRecord, marketGroups, quote, rankGroup, setStandingClaim, standingClaims } from './market.ts';
import { POLICIES, policyFor, promiseWindowDays } from './agents/merchant.ts';
import { verifyPromise } from './verify-promise.ts';
import { MIN_DROP_CHANCE, scenarioCandidates } from './demo-scenario.ts';
import { sellerAccount } from './sellers.ts';
import { addDays } from './rules.ts';
import { loadModel, loadReplayModelFile } from './model.ts';
import { defaultClaims, groupListings, listGroups, runReplay } from './replay.ts';
import { CLAIM_LABELS, DEFAULTS, RULE_VERSION, sha256 } from './rules.ts';
import { ACCURACY_PRIOR, storeLabel } from './score.ts';
import { IMPLEMENTATION_STATUS } from './status.ts';
import { fakeSaleReport } from './insights.ts';
import { groupLabel } from './labels.ts';
import { predictionReport } from './predictions.ts';

const ctx = makeCtx();
const { db } = ctx;
const app = new Hono();
// Password login on the deployment (DEMO_PASSWORD): the browser asks once and sends it with
// every page and API call. The health check and PayPal's webhook stay open.
const demoPassword = config().demoPassword;
if (demoPassword) {
  const auth = basicAuth({ username: 'judge', password: demoPassword, realm: 'Vouch demo' });
  app.use('*', (c, next) => (c.req.path === '/api/health' || c.req.path === '/webhooks/paypal' ? next() : auth(c, next)));
}
app.use('/api/*', cors());

// ---------- anonymisation ----------
// Domains and offer URLs are dropped; product group keys (which spell the
// brand and model) become opaque ids and are resolved back on input.
const HIDDEN = new Set(['domain', 'url', 'offer_url']);
const FEATURED_GROUP = 'sony|wh1000xm5';
const pubGroup = (k: string) => 'g_' + sha256('vouch-group|' + k).slice(0, 10);
function resolveGroup(id: string): string {
  if (!id.startsWith('g_')) return id;
  for (const k of marketGroups(db).keys()) if (pubGroup(k) === id) return k;
  throw new HttpError(404, `Unknown product group ${id}`);
}
function anon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(anon);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (HIDDEN.has(k)) continue;
      out[k] = k === 'group_key' && typeof x === 'string' ? pubGroup(x) : anon(x);
    }
    return out;
  }
  return v;
}
const ok = (c: any, body: unknown, status = 200) => c.json(anon(body), status);

function domainForLabel(label: string): string {
  const rows = db.prepare('SELECT DISTINCT domain FROM offer_snapshots').all() as { domain: string }[];
  const hit = rows.filter((r) => storeLabel(r.domain) === label);
  if (hit.length !== 1) throw new HttpError(404, `Unknown store ${label}`);
  return hit[0].domain;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse(); // the password prompt (401 with WWW-Authenticate)
  if (err instanceof UpstreamError) {
    console.error('[upstream]', err.message);
    return c.json(err.toJSON(), 502);
  }
  if (err instanceof z.ZodError) return c.json({ error: 'invalid_request', issues: err.issues }, 400);
  const status = err instanceof HttpError ? err.status : 500;
  console.error('[error]', err);
  return c.json({ error: status === 500 ? 'internal_error' : 'bad_request', message: err.message, trace: err.stack?.split('\n').slice(0, 6) }, status as any);
});

const Claim = z.enum(['lowest_price', 'genuine_sale', 'no_price_drop', 'in_stock']);

// Routes that spend Gemini calls, Channel3 credits or Sandbox orders are capped per UTC
// day. The deployment is behind a password, so the caps only stop a runaway script; counted
// in memory (one Cloud Run instance), so a restart resets the count.
const DAILY_CAPS: Record<string, number> = {
  '/api/verify': 300,
  '/api/seller/extract-claims': 1000,
  '/api/seller/audit': 500,
  '/api/live/purchase': 500,
  '/api/live/judge': 500,
  '/api/live/retry-refunds': 500,
};
const capCounts = new Map<string, number>();
app.use('/api/*', async (c, next) => {
  const cap = c.req.method === 'POST' ? DAILY_CAPS[c.req.path] : undefined;
  if (cap !== undefined) {
    const key = `${nowIso().slice(0, 10)} ${c.req.path}`;
    const n = capCounts.get(key) ?? 0;
    if (n >= cap) throw new HttpError(429, `${c.req.path} ran ${n} times today (limit ${cap} per UTC day)`);
    capCounts.set(key, n + 1);
  }
  await next();
});

// ---------- meta ----------
app.get('/api/health', (c) => c.json({ ok: true, time: nowIso() }));

app.get('/api/status', (c) => {
  const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(DISTINCT product_id) FROM price_points) AS with_history,
      (SELECT COUNT(*) FROM price_points) AS price_points, (SELECT MIN(day) FROM price_points) AS first_day, (SELECT MAX(day) FROM price_points) AS last_day,
      (SELECT COUNT(*) FROM tracking WHERE status='active') AS tracked, (SELECT COUNT(*) FROM api_calls WHERE upstream='channel3') AS channel3_calls,
      (SELECT COUNT(*) FROM contracts WHERE mode='live') AS live_contracts, (SELECT COUNT(*) FROM refunds WHERE ok=1) AS refunds`).get();
  return ok(c, { implementation: IMPLEMENTATION_STATUS, data: counts, groups: marketGroups(db).size, llm_model: config().vertex.model });
});

app.get('/api/rules', (c) =>
  c.json({ rule_version: RULE_VERSION, claims: CLAIM_LABELS, defaults: DEFAULTS, accuracy_prior: ACCURACY_PRIOR, missing_evidence: 'Resolved in the buyer’s favour for the full stake; the fetch failure is recorded in the ledger.' }),
);

app.get('/api/verify-promise', async (c) => {
  const pid = c.req.query('product_id');
  if (!pid) throw new Error('product_id is required');
  return c.json(await verifyPromise(db, pid, c.req.query('checkout_jwt') || undefined));
});

// ---------- live provenance check ----------
// Re-fetches Channel3 history now for the listings behind a chart and compares
// it day by day with the prices on screen. Names stay hidden; the match count,
// time, and recorded API call ids show the data is real and current.
// A public group key (Buyer) stands for the listings of every store selling that item.
app.post('/api/verify', async (c) => {
  const b = z.object({ product_ids: z.array(z.string()).min(1).max(12).optional(), group_key: z.string().optional() })
    .refine((x) => !!x.product_ids !== !!x.group_key, 'Send product_ids or group_key').parse(await c.req.json());
  const ids = b.product_ids ?? (() => {
    const g = marketGroups(db).get(resolveGroup(b.group_key!));
    if (!g) throw new HttpError(404, `Unknown product group ${b.group_key}`);
    return g.map((l) => l.product_id).slice(0, 12);
  })();
  const stored = db.prepare('SELECT day, price FROM price_points WHERE product_id = ?');
  const results = [];
  for (const id of ids) {
    const before = new Map((stored.all(id) as { day: string; price: number }[]).map((r) => [r.day, r.price]));
    const live = await ctx.channel3.history(id, 30);
    const callId = (db.prepare('SELECT MAX(id) AS id FROM api_calls').get() as { id: number }).id;
    let compared = 0, matched = 0;
    const mismatches: { day: string; shown: number; channel3: number }[] = [];
    for (const p of live.history ?? []) {
      const day = p.timestamp.slice(0, 10);
      const shown = before.get(day);
      if (shown === undefined) continue;
      compared++;
      if (Math.abs(shown - p.price) < 0.005) matched++;
      else mismatches.push({ day, shown, channel3: p.price });
    }
    results.push({ product_id: id, compared, matched, mismatches, live_points: live.history?.length ?? 0, api_call_id: callId });
  }
  return ok(c, { checked_at: nowIso(), endpoint: 'GET https://api.trychannel3.com/v0/price-tracking/history/{id}', results });
});

// What the data behind every screen is: counts from this deployment's database (names never leave it).
app.get('/api/provenance', (c) => {
  const prices = db.prepare('SELECT COUNT(*) AS points, COUNT(DISTINCT product_id) AS listings, COUNT(DISTINCT day) AS days, MIN(day) AS first_day, MAX(day) AS last_day FROM price_points').get() as Record<string, number | string>;
  const stores = db.prepare('SELECT COUNT(DISTINCT domain) AS n FROM offer_snapshots').get() as { n: number };
  const calls = db.prepare(`SELECT COUNT(*) AS n FROM api_calls WHERE upstream = 'channel3'`).get() as { n: number };
  return ok(c, { ...prices, stores: stores.n, channel3_calls: calls.n });
});

// ---------- experiments ----------
// Recorded experiment results (server/experiments/*.json), by name.
const EXPERIMENTS: Record<string, string> = {
  'agent-choice': 'agent-experiment',
  'agent-wait': 'agent-wait-experiment',
  'agent-wait-norisk': 'agent-wait-experiment -- 10 3 --no-risk',
  'agent-shop-check': 'agent-shop-check',
  'price-match-cost': 'price-match-cost',
  'promise-vs-discount': 'promise-vs-discount',
  'agent-wait-trust': 'agent-wait-trust',
  'agent-wait-trust-v2-gemini': 'agent-wait-experiment -- 10 1 --trust',
  'agent-wait-trust-v2-gemini-fake_vouch': 'agent-wait-experiment -- 10 1 --trust',
  'discount-vs-promise': 'discount-vs-promise',
  'discount-vs-promise-app-view': 'discount-vs-promise -- --app-view',
  'store-strategy': 'store-strategy',
  acts: 'acts-experiment',
};
// Seller-agent simulation runs (src/jobs/seller-sim.ts), for the seller console.
app.get('/api/seller-sim', (c) => {
  const dir = new URL('../experiments/seller-sim/', import.meta.url);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    throw new HttpError(404, 'No seller-agent simulation has been run yet (npm -w server run seller-sim -- "#CODE")');
  }
  return ok(c, files.map((f) => {
    const d = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
    // What sets this run apart from the plain one (ablations, model thinking), for the run selector.
    const variant = [d.design.ablations?.no_chat && 'no_chat', d.design.ablations?.no_memo && 'no_memo', (d.design.llm_thinking ?? 'model default') === 'model default' && 'default_thinking'].filter(Boolean);
    // Runs from before the Most-Favored-Customer fix have no effective_min_price_usd on their days.
    const mfc = (d.conditions.e ?? Object.values(d.conditions)[0] as any)?.days?.some((x: any) => x.effective_min_price_usd != null) ?? false;
    return { file: f.replace(/\.json$/, ''), mfc, product: d.product_label, store: d.agent_store, goal: d.design.owner_goal ?? null, mix: d.design.mix ?? null, variant, conditions: Object.keys(d.conditions), totals: d.totals_by_condition };
  }));
});
app.get('/api/seller-sim/:file', (c) => {
  const f = c.req.param('file');
  if (!/^[A-Za-z0-9-]+$/.test(f)) throw new HttpError(400, `Bad simulation name ${f}`);
  let raw: string;
  try {
    raw = readFileSync(new URL(`../experiments/seller-sim/${f}.json`, import.meta.url), 'utf8');
  } catch {
    throw new HttpError(404, `Unknown simulation ${f}`);
  }
  return ok(c, JSON.parse(raw));
});

app.get('/api/experiments/:name', (c) => {
  const name = c.req.param('name');
  if (!(name in EXPERIMENTS)) throw new HttpError(404, `Unknown experiment ${name}`);
  let raw: string;
  try {
    raw = readFileSync(new URL(`../experiments/${name}.json`, import.meta.url), 'utf8');
  } catch {
    throw new HttpError(404, `Experiment ${name} has not been run yet (npm -w server run ${EXPERIMENTS[name]})`);
  }
  return ok(c, JSON.parse(raw));
});

// ---------- insights ----------
app.get('/api/insights/fake-sales', (c) => ok(c, fakeSaleReport(db, Number(c.req.query('stake') ?? 10))));

app.get('/api/predictions', (c) => ok(c, predictionReport(db)));

// ---------- models ----------
app.get('/api/models/:target', (c) => {
  const t = c.req.param('target');
  if (t === 'drop14-replay') {
    const rf = loadReplayModelFile();
    return c.json({
      target: rf.target,
      window_days: rf.horizon_days,
      features: rf.features,
      earliest_as_of: rf.earliest_as_of,
      latest_as_of: rf.latest_as_of,
      min_train_rows: rf.min_train_rows,
      by_as_of: Object.values(rf.by_as_of).map((x) => ({
        as_of: x.as_of,
        last_resolved_purchase_day: x.cutoff_day,
        n_train: x.n_train,
        n_units: x.units_train,
        base_rate: x.positive_rate_train ?? 0,
        eval_next_day: x.n_test
          ? {
              n: x.n_test,
              brier: x.metrics_test.brier ?? 0,
              brier_climatology: x.metrics_test.base_rate_brier ?? 0,
              auc: x.metrics_test.auc ?? null,
            }
          : null,
      })),
      out_of_group: {
        method: '5-fold GroupKFold by product group',
        n_folds: rf.out_of_group.n_folds,
        n_rows: rf.out_of_group.n_rows,
        n_units: rf.out_of_group.n_units,
        brier: rf.out_of_group.metrics_oof.brier ?? 0,
        brier_climatology: rf.out_of_group.metrics_oof.base_rate_brier ?? 0,
        auc: rf.out_of_group.metrics_oof.auc ?? null,
        reliability: rf.out_of_group.reliability_oof,
      },
    });
  }
  if (t !== 'drop14' && t !== 'lowest7') throw new HttpError(404, 'Unknown model');
  const { mean, scale, ...m } = loadModel(t);
  return c.json(m);
});

// ---------- groups, ranking, replay ----------
app.get('/api/groups', (c) => ok(c, listGroups(db).map((g) => ({ ...g, featured: g.group_key === FEATURED_GROUP }))));

app.get('/api/groups/:key/ranking', (c) => ok(c, rankGroup(db, resolveGroup(c.req.param('key')), Number(c.req.query('weight') ?? 1))));

app.get('/api/groups/:key', (c) => {
  const key = resolveGroup(c.req.param('key'));
  const ls = groupListings(db, key);
  return ok(c, {
    group_key: key,
    title: groupLabel(db, key, ls[0].product_id),
    listings: ls.map((l) => ({ product_id: l.product_id, store: storeLabel(l.domain), series: [...l.series.entries()].sort().map(([day, price]) => ({ day, price })) })),
  });
});

const ReplayReq = z.object({
  group_key: z.string(),
  claims: z.array(z.object({ store: z.string(), claim_type: z.enum(['lowest_price', 'genuine_sale', 'no_price_drop']), stake_usd: z.number().positive().max(1000) })).optional(),
  default_stake_usd: z.number().positive().max(1000).optional(),
  buyers_per_day: z.number().int().min(1).max(1000).default(10),
  weight: z.number().min(0).max(10).default(1),
  tau_usd: z.number().positive().max(1000).default(5),
});

app.post('/api/replay', async (c) => {
  const req = ReplayReq.parse(await c.req.json());
  req.group_key = resolveGroup(req.group_key);
  const listings = groupListings(db, req.group_key);
  const claims = req.claims ? req.claims.map((x) => ({ domain: domainForLabel(x.store), claim_type: x.claim_type, stake_usd: x.stake_usd })) : defaultClaims(listings, req.default_stake_usd ?? 10);
  return ok(c, runReplay(db, { group_key: req.group_key, claims, buyers_per_day: req.buyers_per_day, weight: req.weight, tau_usd: req.tau_usd }));
});

// ---------- seller console ----------
app.get('/api/seller/stores', (c) => {
  const groups = marketGroups(db);
  const rows: { store: string; product_id: string; group_key: string; title: string }[] = [];
  for (const [k, ls] of groups) for (const l of ls) rows.push({ store: storeLabel(l.domain), product_id: l.product_id, group_key: k, title: groupLabel(db, k, ls[0].product_id) });
  const claims = standingClaims(db);
  return ok(c, rows.map((r) => ({ ...r, claims: claims.filter((x) => x.product_id === r.product_id).map(({ claim_type, stake_usd }) => ({ claim_type, stake_usd })) })));
});

app.post('/api/seller/quote', async (c) => {
  const b = z.object({ product_id: z.string(), claim_type: Claim, stake_usd: z.number().positive().max(1000) }).parse(await c.req.json());
  return ok(c, quote(db, b.product_id, b.claim_type, b.stake_usd));
});

app.put('/api/seller/claims', async (c) => {
  const b = z.object({ product_id: z.string(), claim_type: Claim, stake_usd: z.number().positive().max(1000), active: z.boolean(), window_kind: z.enum(['bf', '14']).optional() }).parse(await c.req.json());
  const d = db.prepare(`SELECT DISTINCT domain FROM offer_snapshots WHERE product_id = ?`).all(b.product_id) as { domain: string }[];
  if (d.length !== 1) throw new HttpError(400, `Product ${b.product_id} is not a single-store listing`);
  setStandingClaim(db, { ...b, domain: d[0].domain });
  return ok(c, { ok: true, claims: standingClaims(db, b.product_id) });
});

app.put('/api/seller/budget', async (c) => {
  const b = z.object({ store: z.string(), monthly_budget_usd: z.number().min(0).max(100000) }).parse(await c.req.json());
  db.prepare(`INSERT OR REPLACE INTO seller_settings (domain, monthly_budget_usd, updated_at) VALUES (?, ?, ?)`).run(domainForLabel(b.store), b.monthly_budget_usd, nowIso());
  return ok(c, { ok: true });
});

app.get('/api/seller/:store/summary', (c) => {
  const domain = domainForLabel(c.req.param('store'));
  const budget = db.prepare('SELECT monthly_budget_usd FROM seller_settings WHERE domain = ?').get(domain) as { monthly_budget_usd: number } | undefined;
  const contracts = db.prepare(`SELECT c.id, c.claim_type, c.status, c.created_at, json_extract(c.terms_json,'$.stake_usd') AS stake_usd, json_extract(c.terms_json,'$.purchase_price') AS price, j.reason, j.payout_usd
     FROM contracts c LEFT JOIN judgments j ON j.contract_id = c.id WHERE c.mode='live' AND c.domain = ? ORDER BY c.created_at DESC`).all(domain);
  return ok(c, { store: c.req.param('store'), monthly_budget_usd: budget?.monthly_budget_usd ?? null, contracts });
});

// One listing seen by its seller: today's price against the other stores,
// what attaching a no-price-drop promise would cost (model, per window), the
// published promise, demand seen in the demo shop and the experiments, and
// what this seller owes or has refunded. Numbers come from the model, the
// rules and recorded runs only.
const readExperiment = (name: string) => {
  try {
    return JSON.parse(readFileSync(new URL(`../experiments/${name}`, import.meta.url), 'utf8'));
  } catch {
    return null;
  }
};
app.get('/api/seller/listing/:product_id', (c) => {
  const pid = c.req.param('product_id');
  const groups = marketGroups(db);
  const entry = [...groups.entries()].find(([, ls]) => ls.some((l) => l.product_id === pid));
  if (!entry) throw new HttpError(404, `Listing ${pid} is not in a multi-store product group`);
  const [key, ls] = entry;
  const me = ls.find((l) => l.product_id === pid)!;
  const last = (l: (typeof ls)[number]) => [...l.series.entries()].sort((a, b) => a[0].localeCompare(b[0])).at(-1)!;
  const today = nowIso().slice(0, 10);
  const bfDays = promiseWindowDays(today);
  const windows = ([['bf', bfDays], ['14', 14]] as const).map(([kind, days]) => ({ kind, days, end_day: addDays(today, days), ...dropRisk(db, pid, days) }));
  const published = standingClaims(db, pid).find((x) => x.claim_type === 'no_price_drop') ?? null;
  // Demo-shop runs for this product: did agents wait, buy here, or buy elsewhere?
  const tasks = (db.prepare(`SELECT status, state_json FROM shop_tasks WHERE group_key = ?`).all(key) as { status: string; state_json: string }[]).map((r) => ({ status: r.status, state: JSON.parse(r.state_json) }));
  const myLabel = storeLabel(me.domain);
  const shop = {
    runs: tasks.length,
    waited: tasks.filter((x) => x.state.decision?.wait).length,
    bought_here: tasks.filter((x) => x.state.decision && !x.state.decision.wait && x.state.decision.store === myLabel).length,
    bought_elsewhere: tasks.filter((x) => x.state.decision && !x.state.decision.wait && x.state.decision.store !== myLabel).length,
  };
  const wait = readExperiment('agent-wait-norisk.json');
  const contracts = db
    .prepare(`SELECT c.id, c.claim_type, c.status, c.created_at, c.paypal_seller_slot AS slot, c.paypal_merchant_id AS merchant, json_extract(c.terms_json,'$.stake_usd') AS stake_usd,
        json_extract(c.terms_json,'$.purchase_price') AS price, json_extract(c.terms_json,'$.judge_after_day') AS judge_after_day, j.payout_usd, f.paypal_refund_id
      FROM contracts c LEFT JOIN judgments j ON j.contract_id = c.id LEFT JOIN refunds f ON f.contract_id = c.id AND f.ok = 1
      WHERE c.mode = 'live' AND c.domain = ? ORDER BY c.created_at DESC`)
    .all(me.domain) as any[];
  // Orders on this listing (live and replay purchases), with the judgment and the PayPal refund.
  const orders = db
    .prepare(`SELECT c.id, c.mode, c.created_at, json_extract(c.terms_json,'$.purchase_day') AS purchase_day, json_extract(c.terms_json,'$.purchase_price') AS paid, json_extract(c.terms_json,'$.window_days') AS window_days,
        json_extract(c.terms_json,'$.judge_after_day') AS judge_after_day, c.status, j.payout_usd, f.paypal_refund_id, f.attempted_at AS refunded_at
      FROM contracts c LEFT JOIN judgments j ON j.contract_id = c.id LEFT JOIN refunds f ON f.contract_id = c.id AND f.ok = 1
      WHERE c.product_id = ? AND c.claim_type = 'no_price_drop' ORDER BY c.created_at DESC`)
    .all(pid) as any[];
  const acct = sellerAccount(db, me.domain);
  const budget = db.prepare('SELECT monthly_budget_usd FROM seller_settings WHERE domain = ?').get(me.domain) as { monthly_budget_usd: number } | undefined;
  const month = today.slice(0, 7);
  return ok(c, {
    store: myLabel,
    product_id: pid,
    group_key: key,
    title: groupLabel(db, key, ls[0].product_id),
    price: last(me)[1],
    as_of_day: last(me)[0],
    // Other stores' latest prices, with the same drop estimate per window, so
    // the console can rank everyone as the seller moves the promise.
    peers: ls
      .filter((l) => l !== me)
      .map((l) => ({
        store: storeLabel(l.domain),
        price: last(l)[1],
        day: last(l)[0],
        risk: Object.fromEntries(windows.map((w) => [w.kind, (({ p_drop, expected_drop_usd }) => ({ p_drop, expected_drop_usd }))(dropRisk(db, l.product_id, w.days))])),
        published_cap_usd: standingClaims(db, l.product_id).find((x) => x.claim_type === 'no_price_drop')?.stake_usd ?? null,
      }))
      .sort((a, b) => a.price - b.price),
    windows,
    published: published ? { stake_usd: published.stake_usd, window_kind: published.window_kind ?? 'bf' } : null,
    demand: {
      shop,
      experiment: wait ? { model: wait.model, products: wait.design.products, no_promise: wait.results.none, promise_covers_drop: wait.results.cover } : null,
    },
    record: liveRecord(db, me.domain),
    paypal_seller: acct ? { slot: acct.seller_slot, merchant: merchantTag(acct.merchant_id), shared: false } : { slot: SHARED_SLOT, merchant: null, shared: true },
    budget: {
      monthly_usd: budget?.monthly_budget_usd ?? null,
      open_stakes_usd: contracts.filter((x) => x.status === 'open').reduce((s, x) => s + (x.stake_usd ?? 0), 0),
      refunded_this_month_usd: contracts.filter((x) => x.status === 'miss' && String(x.created_at).slice(0, 7) === month).reduce((s, x) => s + (x.payout_usd ?? 0), 0),
    },
    contracts: contracts.map((x) => ({ ...x, merchant: merchantTag(x.merchant) })),
    orders,
  });
});

app.post('/api/seller/extract-claims', async (c) => {
  const b = z.object({ text: z.string().min(1).max(6000) }).parse(await c.req.json());
  return c.json(await extractClaims(b.text));
});

app.post('/api/seller/audit', async (c) => {
  const b = z.object({ group_key: z.string(), images: z.boolean().default(false) }).parse(await c.req.json());
  const ls = groupListings(db, resolveGroup(b.group_key));
  const p = db.prepare('SELECT title, key_features_json, image_url FROM products WHERE id = ?');
  const listings = ls.map((l) => {
    const r = p.get(l.product_id) as { title: string; key_features_json: string; image_url: string | null };
    return { id: l.product_id, store: storeLabel(l.domain), title: r.title, key_features: JSON.parse(r.key_features_json ?? '[]'), image_url: r.image_url };
  });
  return ok(c, await auditListings(listings, b.images));
});

// ---------- live purchases (PayPal Sandbox) ----------
app.post('/api/live/purchase', async (c) => {
  const b = z.object({ product_id: z.string(), claims: z.array(z.object({ claim_type: Claim, stake_usd: z.number().positive().max(1000) })).optional() }).parse(await c.req.json());
  const claims = b.claims ?? standingClaims(db, b.product_id).map(({ claim_type, stake_usd }) => ({ claim_type, stake_usd, full_difference: claim_type === 'no_price_drop' }));
  return ok(c, await purchase(ctx, { product_id: b.product_id, claims }));
});

// ---------- demo shop: the buyer's agent at work ----------
// Catalog of the fictional demo shop: products sold by three or more stores
// with recent Channel3 prices. Names are anonymised like everywhere else.
app.get('/api/shop/catalog', (c) => {
  // "Recent" is relative to the latest price day in the data, not the wall clock: the Cloud Run
  // image carries a snapshot that ages.
  const last = (db.prepare('SELECT MAX(day) AS d FROM price_points').get() as { d: string }).d;
  const since = addDays(last, -2);
  // The #/demo item stays in the catalog even with two stores, so the replay can open on it.
  const demoGroup = demoScenarios().candidates[0]?.group_key;
  const items = [];
  for (const [k, ls] of marketGroups(db)) {
    const recent = ls.map((l) => [...l.series.entries()].sort((a, b) => a[0].localeCompare(b[0])).at(-1)!).filter(([d]) => d >= since).map(([, p]) => p);
    if (recent.length < (k === demoGroup ? 2 : 3)) continue;
    // Each store's latest price, for the buyer's spending-cap bar.
    const prices = ls
      .map((l) => {
        const label = storeLabel(l.domain);
        // Only a store that published a promise answers with one (concept §34); other agent stores discount.
        const canPromise = standingClaims(db, l.product_id).some((x) => x.claim_type === 'no_price_drop');
        return { store: label, can_promise: canPromise, last: [...l.series.entries()].sort((a, b) => a[0].localeCompare(b[0])).at(-1)! };
      })
      .filter((x) => x.last[0] >= since)
      .map((x) => ({ store: x.store, price: x.last[1], can_promise: x.can_promise }))
      .sort((a, b) => a.price - b.price);
    items.push({ group_key: k, title: groupLabel(db, k, ls[0].product_id), stores: recent.length, from_usd: Math.min(...recent), to_usd: Math.max(...recent), featured: k === FEATURED_GROUP, prices });
  }
  items.sort((a, b) => Number(b.featured) - Number(a.featured) || b.stores - a.stores);
  return ok(c, { items, runs_today: shopRunsToday(db), daily_limit: SHOP_DAILY_LIMIT, mandate_ttl_hours: MANDATE_TTL_SECONDS / 3600 });
});

app.post('/api/shop/tasks', async (c) => {
  const b = z.object({ group_key: z.string(), autonomy: z.enum(['ask', 'protected', 'full']), max_usd: z.number().positive().max(5000), risk_weight: z.number().min(0).max(20), buyer_note: z.string().max(300).optional(), as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), demo_condition: z.enum(['none', 'words', 'fake', 'vouch']).optional(), featured_product_id: z.string().optional() }).parse(await c.req.json());
  const runs = shopRunsToday(db);
  if (runs >= SHOP_DAILY_LIMIT) throw new HttpError(429, `The shopping agent ran ${runs} times today (limit ${SHOP_DAILY_LIMIT} per UTC day; each run can place a real Sandbox order)`);
  return ok(c, await startTask(ctx, { ...b, group_key: resolveGroup(b.group_key) }));
});

// Days a past replay can start on for this item: at least two stores have a
// real price on D and through D + window, so the real later prices can judge
// a promise. For each, the stores' prices on D and whether each store's price
// later fell below it within the window (computed from the same data). The
// default day is chosen because something happens, and the screen says so:
// the latest day after which the cheapest store's real price fell and its demo
// policy can make promises; else any such store; else the latest usable day.
type ReplayDay = { day: string; window_end: string; stores: { store: string; price: number; can_promise: boolean; has_published: boolean; dropped_to: { day: string; price: number } | null }[] };
// Every item's default replay day. It walks all groups and days (seconds), so like the demo
// scenarios it is kept until the published promises or the latest price day change.
let summaryCache: { key: string; items: { group_key: string; default_day: string | null; default_reason: string | null; default_has_published: boolean }[] } | undefined;
function replaySummaryItems() {
  demoScenarios();
  if (summaryCache?.key !== demoCache!.key) {
    const items = [...marketGroups(db).keys()].map((k) => ({ group_key: k, ...replayDays(k) })).filter((x) => x.days.length).map(({ group_key, default_day, default_reason, default_has_published }) => ({ group_key, default_day, default_reason, default_has_published }));
    summaryCache = { key: demoCache!.key, items };
  }
  return summaryCache.items;
}

// The #/demo scenarios (pure selection on real data, no LLM). The model is not free, so the
// result is kept until the published promises or the latest price day change.
let demoCache: { key: string; r: ReturnType<typeof scenarioCandidates> } | undefined;
function demoScenarios() {
  const published = new Set(standingClaims(db).filter((x) => x.claim_type === 'no_price_drop').map((x) => x.product_id));
  const last = (db.prepare('SELECT MAX(day) AS d FROM price_points').get() as { d: string }).d;
  const key = `${last}|${[...published].sort().join(',')}`;
  if (demoCache?.key !== key) {
    demoCache = { key, r: scenarioCandidates(marketGroups(db), { earliest_as_of: loadReplayModelFile().earliest_as_of, window_days: REPLAY_WINDOW_DAYS, published, storeLabel, dropChance: (product_id, day) => dropRisk(db, product_id, REPLAY_WINDOW_DAYS, day).p_drop, discountOf: (store) => POLICIES[policyFor(store)].max_discount_pct }) };
  }
  return demoCache.r;
}

// A day where the promise has to beat a rival's discount, not just be the cheapest: the store
// published its promise, a rival's discounted price undercuts it, the as-of chance of a drop is
// at least MIN_DROP_CHANCE, and its real price then fell (the #/demo scenario for this item).
function promiseBeatsDiscountDay(key: string) {
  return demoScenarios().candidates.find((c) => c.group_key === key && c.has_published && c.undercut_by_discount && (c.drop_chance ?? 0) >= MIN_DROP_CHANCE) ?? null;
}

function replayDays(key: string): { days: ReplayDay[]; default_day: string | null; default_reason: string | null; default_has_published: boolean } {
  const ls = marketGroups(db).get(key);
  if (!ls) throw new HttpError(404, `Unknown product group ${key}`);
  const allDays = [...new Set(ls.flatMap((l) => [...l.series.keys()]))].sort();
  const days: ReplayDay[] = [];
  for (const d of allDays) {
    const end = addDays(d, REPLAY_WINDOW_DAYS);
    const stores = ls
      .filter((l) => l.series.has(d) && [...l.series.keys()].some((x) => x >= end))
      .map((l) => {
        const price = l.series.get(d)!;
        const after = [...l.series.entries()].filter(([x]) => x > d && x <= end).sort((a, b) => a[0].localeCompare(b[0]));
        const low = after.reduce<[string, number] | null>((m, p) => (!m || p[1] < m[1] ? p : m), null);
        const label = storeLabel(l.domain);
        const hasPub = standingClaims(db, l.product_id).some((x) => x.claim_type === 'no_price_drop');
        return { store: label, price, can_promise: hasPub, has_published: hasPub, dropped_to: low && low[1] < price - 0.005 ? { day: low[0], price: low[1] } : null };
      })
      .sort((a, b) => a.price - b.price);
    if (stores.length >= 2) days.push({ day: d, window_end: end, stores });
  }
  const cheapestPub = days.filter((x) => x.stores[0].dropped_to && x.stores[0].has_published);
  const cheapest = days.filter((x) => x.stores[0].dropped_to && x.stores[0].can_promise);
  const any = days.filter((x) => x.stores.some((s) => s.dropped_to && s.can_promise));
  const beats = promiseBeatsDiscountDay(key);
  const def = (beats && days.find((x) => x.day === beats.day)) ?? cheapestPub.at(-1) ?? cheapest.at(-1) ?? any.at(-1) ?? days.at(-1) ?? null;
  const reason = !def ? null : beats?.day === def.day ? 'promise_beats_discount' : cheapest.includes(def) ? 'cheapest' : any.includes(def) ? 'some_store' : 'latest';
  return { days, default_day: def?.day ?? null, default_reason: reason, default_has_published: beats?.day === def?.day || !!def?.stores[0]?.has_published };
}

app.get('/api/shop/replay-summary', (c) => {
  const earliest = loadReplayModelFile().earliest_as_of;
  const items = replaySummaryItems();
  return ok(c, { window_days: REPLAY_WINDOW_DAYS, earliest_as_of: earliest, featured_group: demoScenarios().candidates[0] ? pubGroup(demoScenarios().candidates[0].group_key) : null, items });
});

app.get('/api/shop/replay-days/:key', (c) => ok(c, { window_days: REPLAY_WINDOW_DAYS, earliest_as_of: loadReplayModelFile().earliest_as_of, ...replayDays(resolveGroup(c.req.param('key'))) }));

// Fast-forward a replay task: if bought, the rules on the real prices after D;
// if the agent waited, the 14-day real prices across all stores and comparison.
app.post('/api/shop/tasks/:id/fast-forward', async (c) => {
  const id = c.req.param('id');
  const task = taskView(db, id) as any;
  if (!task.state?.as_of) throw new HttpError(400, 'Only replays of a past day can be fast-forwarded; live purchases wait for their real verdict day');
  if (task.status === 'waiting' || task.state?.decision?.wait) {
    return ok(c, fastForwardWait(db, id));
  }
  const cid = task.state.purchase?.contracts?.[0]?.id;
  // Bought without a promise (playground): nothing to judge, no refund; show what the real prices did.
  if (!cid && task.status === 'bought' && task.state.purchase) return ok(c, { ...fastForwardWait(db, id), kind: 'unprotected' as const, paid_usd: task.state.purchase.price, store: task.state.purchase.store });
  if (!cid) throw new HttpError(400, 'This replay bought nothing with a promise to judge');
  return ok(c, { kind: 'bought', ...(await judgeReplay(ctx, cid)) });
});

// Read-only: the verdict and refund of a replay task whose contract is already judged.
// Same payload as fast-forward's 'bought' result; never judges and never calls PayPal.
app.get('/api/shop/tasks/:id/verdict', (c) => {
  const id = c.req.param('id');
  const cid = (taskView(db, id) as any).state?.purchase?.contracts?.[0]?.id;
  if (!cid) throw new HttpError(404, 'This task bought nothing with a promise to judge');
  const r = db.prepare(`SELECT * FROM contracts WHERE id = ? AND mode = 'replay-live'`).get(cid) as any;
  const j = r && (db.prepare('SELECT outcome, reason, payout_usd FROM judgments WHERE contract_id = ?').get(cid) as { outcome: string; reason: string; payout_usd: number } | undefined);
  if (!r || !j) throw new HttpError(404, 'This task is not judged yet; fast-forward judges it');
  const terms = JSON.parse(r.terms_json);
  const points = db.prepare('SELECT day, price FROM price_points WHERE product_id = ? AND day >= ? AND day <= ? ORDER BY day').all(terms.product_id, terms.purchase_day, terms.judge_after_day);
  const f = db.prepare('SELECT ok, paypal_refund_id, amount_usd, response_json FROM refunds WHERE contract_id = ? ORDER BY id DESC').get(cid) as any;
  return ok(c, { contract_id: cid, paid_usd: terms.purchase_price, cap_usd: terms.stake_usd, purchase_day: terms.purchase_day, judge_after_day: terms.judge_after_day, points, verdict: j, refund: f ? { ok: !!f.ok, paypal_refund_id: f.paypal_refund_id, amount_usd: f.amount_usd, error: f.ok ? undefined : JSON.parse(f.response_json) } : null, paypal_seller_slot: r.paypal_seller_slot });
});

app.get('/api/shop/tasks/:id', (c) => ok(c, taskView(db, c.req.param('id'))));

// The promise behind a purchase, watched day by day: Channel3 prices since the
// purchase against the price paid. The verdict itself comes from the rules on
// judge_after_day (daily job); before that the status is "open, so far held".
app.get('/api/shop/tasks/:id/promise', (c) => {
  const task = taskView(db, c.req.param('id')) as any;
  const cid = task.state?.purchase?.contracts?.[0]?.id;
  if (!cid) throw new HttpError(404, 'This task bought nothing with a promise');
  const row = db.prepare('SELECT status, product_id, terms_json FROM contracts WHERE id = ?').get(cid) as { status: string; product_id: string; terms_json: string };
  const terms = JSON.parse(row.terms_json);
  const points = db.prepare('SELECT day, price FROM price_points WHERE product_id = ? AND day >= ? ORDER BY day').all(row.product_id, terms.purchase_day) as { day: string; price: number }[];
  const j = db.prepare('SELECT outcome, reason, payout_usd FROM judgments WHERE contract_id = ?').get(cid) as any;
  const f = db.prepare('SELECT paypal_refund_id, amount_usd FROM refunds WHERE contract_id = ? AND ok = 1').get(cid) as any;
  return ok(c, { contract_id: cid, status: row.status, paid_usd: terms.purchase_price, cap_usd: terms.stake_usd, purchase_day: terms.purchase_day, judge_after_day: terms.judge_after_day, points, lowest_since_purchase: points.length ? Math.min(...points.map((p) => p.price)) : null, judgment: j ?? null, refund: f ?? null });
});
app.post('/api/shop/tasks/:id/approve', async (c) => {
  await approve(ctx, c.req.param('id'));
  return ok(c, { ok: true });
});

// Replay candidates for the main demo screen (#/demo), from real prices only.
app.get('/api/demo/scenario', (c) => {
  const r = demoScenarios();
  const withTitle = (x: (typeof r.candidates)[number]) => ({ ...x, title: groupLabel(db, x.group_key, x.product_id) });
  return ok(c, { window_days: REPLAY_WINDOW_DAYS, earliest_as_of: loadReplayModelFile().earliest_as_of, candidates: r.candidates.map(withTitle), needs_publish: r.needs_publish, suggested: r.suggested ? withTitle(r.suggested) : null });
});

// One click for judges: a store makes a claim the data already contradicts,
// the order is paid on Sandbox, judged, and refunded from that store's PayPal.
app.get('/api/demo/false-claim', (c) => c.json({ runs_today: demoRunsToday(db), daily_limit: DEMO_DAILY_LIMIT }));
app.post('/api/demo/false-claim', async (c) => {
  const b = z.object({ claim_type: z.enum(['lowest_price', 'genuine_sale']), group_key: z.string().optional() }).parse(await c.req.json());
  const runs = demoRunsToday(db);
  if (runs >= DEMO_DAILY_LIMIT) throw new HttpError(429, `The demo ran ${runs} times today (limit ${DEMO_DAILY_LIMIT} per UTC day)`);
  return ok(c, await falseClaimDemo(ctx, { claim_type: b.claim_type, group_key: b.group_key ? resolveGroup(b.group_key) : undefined }));
});

app.post('/api/live/judge', async (c) => ok(c, await judgeDue(ctx)));
app.post('/api/live/retry-refunds', async (c) => ok(c, await retryRefunds(ctx)));

// ---------- ledger ----------
app.get('/api/ledger', (c) => {
  const contracts = db.prepare(`SELECT c.id, c.created_at, c.mode, c.run_id AS purchase_id, c.product_id, c.claim_type, c.status, c.hash, c.terms_json, c.paypal_order_id, c.paypal_capture_id, c.paypal_seller_slot, c.paypal_merchant_id,
      j.outcome, j.reason, j.payout_usd, j.judged_at, j.evidence_json, f.paypal_refund_id, f.ok AS refund_ok, f.paypal_status AS refund_status, d.domain
    FROM contracts c LEFT JOIN judgments j ON j.contract_id = c.id LEFT JOIN refunds f ON f.contract_id = c.id AND f.ok = 1 LEFT JOIN (SELECT DISTINCT product_id, domain FROM offer_snapshots) d ON d.product_id = c.product_id
    WHERE c.mode = 'live' ORDER BY c.created_at DESC`).all() as any[];
  return ok(c, {
    verification: verifyLedger(db),
    contracts: contracts.map((r) => {
      const terms = JSON.parse(r.terms_json);
      return { ...r, store: storeLabel(r.domain), terms: { ...terms, store: storeLabel(terms.domain), peers: terms.peers?.map((p: any) => ({ product_id: p.product_id, store: storeLabel(p.domain) })) }, evidence: r.evidence_json ? JSON.parse(r.evidence_json) : null, terms_json: undefined, evidence_json: undefined, paypal_seller: paypalSeller(r), paypal_seller_slot: undefined, paypal_merchant_id: undefined };
    }),
    entries: ledgerEntries(db, Number(c.req.query('limit') ?? 200)),
  });
});

app.get('/api/ledger/verify', (c) => c.json(verifyLedger(db)));

// ---------- PayPal webhook ----------
app.post('/webhooks/paypal', async (c) => {
  const webhookId = config().paypal.webhookId;
  if (!webhookId) return c.json({ error: 'PAYPAL_WEBHOOK_ID is not configured' }, 503);
  const event = await c.req.json();
  const headers = Object.fromEntries([...c.req.raw.headers.entries()]);
  const verified = await ctx.sellers.client(SHARED_SLOT).verifyWebhook({ webhookId, headers, event });
  db.prepare('INSERT OR IGNORE INTO paypal_events (id, received_at, event_type, verified, payload_json) VALUES (?, ?, ?, ?, ?)').run(event.id, nowIso(), event.event_type, verified ? 1 : 0, JSON.stringify(event));
  if (!verified) return c.json({ error: 'signature verification failed' }, 400);
  append(db, 'webhook', event.id, { event_type: event.event_type, resource_id: event.resource?.id, status: event.resource?.status });
  return c.json({ ok: true });
});

// ---------- static web build ----------
const webRoot = relative(process.cwd(), new URL('../../web/dist', import.meta.url).pathname) || '.';
// The page itself is never cached, so a browser refresh picks up a new build; the
// hashed files under /assets/ may be.
app.use('/*', async (c, next) => {
  await next();
  if (!c.req.path.startsWith('/assets/')) c.header('Cache-Control', 'no-cache');
});
app.use('/*', serveStatic({ root: webRoot }));
app.get('/*', serveStatic({ root: webRoot, path: 'index.html' }));

const port = config().port;
serve({ fetch: app.fetch, port }, () => {
  console.log(`Vouch API on http://localhost:${port}`);
  // Warm the replay caches so the first visitor does not wait for them (a failure is logged, not hidden).
  setTimeout(() => { try { replaySummaryItems(); } catch (err) { console.error('[warm-up]', err); } }, 0);
});

export { app };
