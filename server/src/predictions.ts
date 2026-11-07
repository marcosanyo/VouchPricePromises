// Pre-registered predictions: P(price drops within 14 days) for every tracked
// single-store listing, frozen and hashed into the ledger today, then scored
// against prices that did not exist when the prediction was made. This is the
// out-of-time test of whether the probabilities are honest.
import { randomUUID } from 'node:crypto';
import type { DB } from './db.ts';
import { nowIso } from './db.ts';
import { features, labelDrop, loadListings, buildGroups, type Listing } from './features.ts';
import { append } from './ledger.ts';
import { loadModel, predict } from './model.ts';
import { addDays, canonicalJson, filterOutliers, sha256, type Series } from './rules.ts';
import { storeLabel } from './score.ts';

export const HORIZON_DAYS = 14;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS predictions (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  product_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  as_of_day TEXT NOT NULL,
  price REAL NOT NULL,
  p_drop REAL NOT NULL,
  model_trained_at TEXT NOT NULL,
  horizon_end_day TEXT NOT NULL,
  hash TEXT NOT NULL,
  outcome INTEGER,            -- 1 dropped, 0 did not, NULL unresolved
  resolved_at TEXT,
  evidence_json TEXT
);
CREATE INDEX IF NOT EXISTS predictions_batch ON predictions(batch_id);
`;

export function ensurePredictionTables(db: DB) {
  db.exec(SCHEMA);
}

function seriesOf(db: DB, productId: string): Series {
  const rows = db.prepare('SELECT day, price FROM price_points WHERE product_id = ? ORDER BY day').all(productId) as { day: string; price: number }[];
  return filterOutliers(new Map(rows.map((r) => [r.day, r.price]))).kept;
}

export function registerBatch(db: DB) {
  ensurePredictionTables(db);
  const model = loadModel('drop14');
  const tracked = new Set((db.prepare(`SELECT product_id FROM tracking WHERE status = 'active'`).all() as { product_id: string }[]).map((r) => r.product_id));
  const listings = loadListings(db).filter((l) => tracked.has(l.product_id));
  const groups = buildGroups(loadListings(db));
  const peersOf = (l: Listing) => [...groups.values()].find((g) => g.some((x) => x.product_id === l.product_id)) ?? [];

  const batchId = `pb_${randomUUID().slice(0, 8)}`;
  const createdAt = nowIso();
  const rows = [];
  for (const l of listings) {
    const day = [...l.series.keys()].sort().at(-1);
    if (!day) continue;
    const f = features(l, day, peersOf(l));
    if (!f) continue; // under 3 prior days: no prediction rather than a guess
    const body = { product_id: l.product_id, as_of_day: day, price: l.series.get(day)!, p_drop: Math.round(predict(model, f) * 1e6) / 1e6, model_trained_at: model.trained_at, horizon_end_day: addDays(day, HORIZON_DAYS) };
    rows.push({ id: `pr_${randomUUID().slice(0, 12)}`, domain: l.domain, hash: sha256(canonicalJson(body)), ...body });
  }
  if (rows.length === 0) throw new Error('No tracked single-store listing has enough history to predict');
  const ins = db.prepare(
    `INSERT INTO predictions (id, batch_id, created_at, product_id, domain, as_of_day, price, p_drop, model_trained_at, horizon_end_day, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) ins.run(r.id, batchId, createdAt, r.product_id, r.domain, r.as_of_day, r.price, r.p_drop, r.model_trained_at, r.horizon_end_day, r.hash);
  // One ledger entry commits to the whole batch: the hash of all row hashes in id order.
  const batchHash = sha256(rows.map((r) => r.hash).sort().join('|'));
  append(db, 'prediction_batch', batchId, { count: rows.length, batch_hash: batchHash, model: 'drop14', model_trained_at: model.trained_at, horizon_days: HORIZON_DAYS, expected_drops: Math.round(rows.reduce((s, r) => s + r.p_drop, 0) * 100) / 100 });
  return { batch_id: batchId, count: rows.length, batch_hash: batchHash };
}

// Resolves predictions whose horizon has passed, with the same label rule used
// for training (a drop below the as-of price within 14 days; at least 70% of
// the days must have a price, otherwise the prediction stays unresolved).
export function resolveDue(db: DB, today = nowIso().slice(0, 10)) {
  ensurePredictionTables(db);
  const due = db.prepare(`SELECT * FROM predictions WHERE outcome IS NULL AND horizon_end_day < ?`).all(today) as any[];
  let resolved = 0;
  const upd = db.prepare(`UPDATE predictions SET outcome = ?, resolved_at = ?, evidence_json = ? WHERE id = ?`);
  for (const p of due) {
    const series = seriesOf(db, p.product_id);
    const listing: Listing = { product_id: p.product_id, domain: p.domain, group_key: null, category: null, series: new Map([...series, [p.as_of_day, p.price]]) };
    const lab = labelDrop(listing, p.as_of_day, HORIZON_DAYS);
    if (!lab) continue;
    const window = [...series.entries()].filter(([d]) => d > p.as_of_day && d <= p.horizon_end_day);
    upd.run(lab.y, nowIso(), JSON.stringify({ window, magnitude: lab.magnitude }), p.id);
    resolved++;
  }
  if (resolved) append(db, 'prediction_resolved', today, { resolved });
  return { due: due.length, resolved };
}

export function predictionReport(db: DB) {
  ensurePredictionTables(db);
  const batches = db.prepare(`SELECT batch_id, MIN(created_at) AS created_at, COUNT(*) AS n, MIN(as_of_day) AS as_of_from, MAX(as_of_day) AS as_of_to, MAX(horizon_end_day) AS horizon_end, SUM(p_drop) AS expected, SUM(outcome IS NOT NULL) AS resolved, SUM(outcome) AS dropped FROM predictions GROUP BY batch_id ORDER BY created_at`).all() as any[];
  const ledger = db.prepare(`SELECT ref_id, hash, payload_json FROM ledger WHERE kind = 'prediction_batch'`).all() as { ref_id: string; hash: string; payload_json: string }[];
  const byBatch = new Map(ledger.map((l) => [l.ref_id, { ledger_hash: l.hash, ...JSON.parse(l.payload_json) }]));
  return batches.map((b) => {
    const rows = db.prepare(`SELECT id, product_id, domain, as_of_day, price, p_drop, model_trained_at, horizon_end_day, outcome FROM predictions WHERE batch_id = ? ORDER BY p_drop DESC`).all(b.batch_id) as any[];
    const done = rows.filter((r) => r.outcome != null);
    const bins = Array.from({ length: 10 }, (_, i) => ({ lo: i / 10, hi: (i + 1) / 10, n: 0, resolved: 0, dropped: 0, mean_p: 0 }));
    for (const r of rows) {
      const bin = bins[Math.min(9, Math.floor(r.p_drop * 10))];
      bin.n++;
      bin.mean_p += r.p_drop;
      if (r.outcome != null) {
        bin.resolved++;
        bin.dropped += r.outcome;
      }
    }
    for (const bin of bins) bin.mean_p = bin.n ? bin.mean_p / bin.n : 0;
    // The baseline is fixed before the answers: always predicting the training set's drop rate
    // (the model that made the batch; its trained_at is stored on every prediction).
    const m = loadModel('drop14');
    const base = m.trained_at === rows[0]?.model_trained_at ? (m.data.positive_rate_train as number) : null;
    return {
      ...b,
      ledger: byBatch.get(b.batch_id) ?? null,
      brier: done.length ? done.reduce((s, r) => s + (r.p_drop - r.outcome) ** 2, 0) / done.length : null,
      base_rate: base,
      base_rate_brier: done.length && base != null ? done.reduce((s, r) => s + (base - r.outcome) ** 2, 0) / done.length : null,
      auc: auc(done.map((r) => [r.p_drop, r.outcome])),
      bins,
      predictions: rows.map(({ model_trained_at: _, ...r }) => ({ ...r, store: storeLabel(r.domain) })),
    };
  });
}

// Rank AUC (ties count half); null until both outcomes are present.
function auc(xs: [number, number][]): number | null {
  const pos = xs.filter((x) => x[1] === 1).map((x) => x[0]);
  const neg = xs.filter((x) => x[1] === 0).map((x) => x[0]);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const q of neg) wins += p > q ? 1 : p === q ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}
