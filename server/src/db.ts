// Local store on node:sqlite. Cloud Run will swap this for Firestore/Cloud SQL;
// until then every table keeps the raw upstream payloads so judgments can be
// re-checked from the same data.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  upstream TEXT NOT NULL,
  method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_json TEXT,
  status INTEGER,
  response_json TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS api_calls_endpoint ON api_calls(upstream, endpoint);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  brand TEXT,
  category_slug TEXT,
  category_path TEXT,
  description TEXT,
  key_features_json TEXT,
  image_url TEXT,
  query TEXT,
  raw_json TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

-- Our own point observations of each merchant offer (fixed-point monitoring).
CREATE TABLE IF NOT EXISTS offer_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  price REAL NOT NULL,
  compare_at_price REAL,
  currency TEXT NOT NULL,
  availability TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  call_id INTEGER
);
CREATE INDEX IF NOT EXISTS offer_snapshots_pd ON offer_snapshots(product_id, domain, observed_at);

-- Daily points from Channel3 price-tracking history (per canonical product).
CREATE TABLE IF NOT EXISTS price_points (
  product_id TEXT NOT NULL,
  day TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  call_id INTEGER,
  PRIMARY KEY (product_id, day)
);

CREATE TABLE IF NOT EXISTS history_stats (
  product_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  current_price REAL, min_price REAL, max_price REAL, mean REAL, std_dev REAL,
  current_status TEXT,
  PRIMARY KEY (product_id, fetched_at)
);

CREATE TABLE IF NOT EXISTS tracking (
  product_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- LLM extraction of brand/model, used only to group listings of the same item.
CREATE TABLE IF NOT EXISTS product_models (
  product_id TEXT PRIMARY KEY,
  brand TEXT,
  model TEXT,
  variant TEXT,
  condition TEXT,
  group_key TEXT,
  llm_model TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL,              -- live | replay
  run_id TEXT,
  product_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  group_key TEXT,
  claim_type TEXT NOT NULL,
  terms_json TEXT NOT NULL,        -- frozen at order time
  hash TEXT NOT NULL,
  status TEXT NOT NULL,            -- open | hit | miss
  paypal_order_id TEXT,
  paypal_capture_id TEXT,
  paypal_seller_slot INTEGER,      -- whose credentials took the order (refunds use the same)
  paypal_merchant_id TEXT          -- payee of the capture; the store's record follows it
);
CREATE INDEX IF NOT EXISTS contracts_run ON contracts(mode, run_id);

CREATE TABLE IF NOT EXISTS judgments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  judged_at TEXT NOT NULL,
  outcome TEXT NOT NULL,           -- hit | miss
  reason TEXT NOT NULL,
  payout_usd REAL NOT NULL,
  rule_version TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  ok INTEGER NOT NULL,
  paypal_refund_id TEXT,
  paypal_status TEXT,
  response_json TEXT
);

CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- LLM usage (Vertex AI) for cost auditing.
CREATE TABLE IF NOT EXISTS llm_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  job TEXT,
  model TEXT NOT NULL,
  status INTEGER,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error TEXT
);

-- Stores with their own PayPal seller account (plan B). Stores not listed
-- are paid through the shared account in slot 1.
CREATE TABLE IF NOT EXISTS seller_accounts (
  domain TEXT PRIMARY KEY,
  seller_slot INTEGER NOT NULL,
  merchant_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seller_settings (
  domain TEXT PRIMARY KEY,
  monthly_budget_usd REAL NOT NULL,
  updated_at TEXT NOT NULL
);

-- Sellers' standing staked claims ("switches"): applied to every new order.
CREATE TABLE IF NOT EXISTS seller_claims (
  product_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  claim_type TEXT NOT NULL,
  stake_usd REAL NOT NULL,
  active INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  window_kind TEXT,
  PRIMARY KEY (product_id, claim_type)
);

-- AP2 demo signing keys (user / shopping agent / merchants / processor).
CREATE TABLE IF NOT EXISTS ap2_keys (
  kid TEXT PRIMARY KEY,
  private_jwk TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- A shopping task: the buyer's agent working on one cart item under the
-- user's AP2 open mandates, and what each agent did (the activity feed).
CREATE TABLE IF NOT EXISTS shop_tasks (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  group_key TEXT NOT NULL,
  autonomy TEXT NOT NULL,           -- ask | protected | full
  max_usd REAL NOT NULL,
  status TEXT NOT NULL,             -- running | needs_approval | waiting | bought | failed
  state_json TEXT NOT NULL          -- mandates, offers, decision, purchase
);
CREATE TABLE IF NOT EXISTS agent_events (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,              -- user | shopper | merchant:<store> | paypal | vouch | ap2
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);

CREATE TABLE IF NOT EXISTS paypal_events (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  verified INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
`;

export type DB = DatabaseSync;

let db: DatabaseSync | undefined;

export function openDb(path: string): DatabaseSync {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after the first live contracts. Contracts bought before plan B
// were all paid through slot 1; their merchant id is the payee in the recorded
// PayPal order response.
export function migrate(d: DatabaseSync) {
  const cols = new Set((d.prepare('PRAGMA table_info(contracts)').all() as { name: string }[]).map((c) => c.name));
  if (!cols.has('paypal_seller_slot')) d.exec('ALTER TABLE contracts ADD COLUMN paypal_seller_slot INTEGER');
  if (!cols.has('paypal_merchant_id')) d.exec('ALTER TABLE contracts ADD COLUMN paypal_merchant_id TEXT');
  d.exec(`UPDATE contracts SET paypal_seller_slot = 1,
      paypal_merchant_id = (SELECT json_extract(a.response_json, '$.purchase_units[0].payee.merchant_id') FROM api_calls a
        WHERE a.upstream = 'paypal' AND a.method = 'POST' AND a.endpoint = '/v2/checkout/orders' AND json_extract(a.response_json, '$.id') = contracts.paypal_order_id)
    WHERE mode = 'live' AND paypal_order_id IS NOT NULL AND paypal_seller_slot IS NULL`);
  d.exec('CREATE INDEX IF NOT EXISTS contracts_merchant ON contracts(paypal_merchant_id)');
  // Seller console (2026-10-28): a published no-price-drop promise runs either
  // until the day after Black Friday ('bf') or for 14 days ('14').
  const sc = new Set((d.prepare('PRAGMA table_info(seller_claims)').all() as { name: string }[]).map((c) => c.name));
  if (!sc.has('window_kind')) d.exec('ALTER TABLE seller_claims ADD COLUMN window_kind TEXT');
}

export function openTestDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  return d;
}

export const nowIso = () => new Date().toISOString();

// Records every LLM call into llm_calls (job = process role, e.g. 'server').
export async function recordLlmCalls(d: DatabaseSync, job: string) {
  const { setLlmRecorder } = await import('./llm.ts');
  const ins = d.prepare('INSERT INTO llm_calls (ts, job, model, status, duration_ms, input_tokens, output_tokens, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  setLlmRecorder((r) => ins.run(nowIso(), job, r.model, r.status, r.durationMs, r.inputTokens, r.outputTokens, r.error ?? null));
}
