// Append-only ledger with a hash chain: each entry's hash covers its payload
// and the previous hash, so editing any past entry breaks verification.
import type { DB } from './db.ts';
import { nowIso } from './db.ts';
import { canonicalJson, sha256 } from './rules.ts';

export type LedgerKind = 'ap2' | 'demo' | 'contract' | 'order' | 'seller_account' | 'judgment' | 'refund' | 'refund_failed' | 'evidence_error' | 'webhook' | 'prediction_batch' | 'prediction_resolved';

const GENESIS = '0'.repeat(64);

export function append(db: DB, kind: LedgerKind, refId: string, payload: unknown): { seq: number; hash: string } {
  const prev = (db.prepare('SELECT hash FROM ledger ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined)?.hash ?? GENESIS;
  const ts = nowIso();
  const body = canonicalJson(payload);
  const hash = sha256(`${prev}|${ts}|${kind}|${refId}|${body}`);
  const r = db.prepare('INSERT INTO ledger (ts, kind, ref_id, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)').run(ts, kind, refId, body, prev, hash);
  return { seq: Number(r.lastInsertRowid), hash };
}

export function verify(db: DB): { ok: boolean; entries: number; broken_at: number | null } {
  const rows = db.prepare('SELECT seq, ts, kind, ref_id, payload_json, prev_hash, hash FROM ledger ORDER BY seq').all() as {
    seq: number; ts: string; kind: string; ref_id: string; payload_json: string; prev_hash: string; hash: string;
  }[];
  let prev = GENESIS;
  for (const r of rows) {
    const h = sha256(`${prev}|${r.ts}|${r.kind}|${r.ref_id}|${r.payload_json}`);
    if (r.prev_hash !== prev || r.hash !== h) return { ok: false, entries: rows.length, broken_at: r.seq };
    prev = r.hash;
  }
  return { ok: true, entries: rows.length, broken_at: null };
}

export function entries(db: DB, limit = 200) {
  return (db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT ?').all(limit) as any[]).map((r) => ({ ...r, payload: JSON.parse(r.payload_json), payload_json: undefined }));
}
