// Anonymous product labels for public screens and the demo video: the
// Channel3 category plus a stable code, e.g. "Single-Serve Coffee Makers · #K7".
// Store names are hidden by storeLabel(); product names are hidden too, because
// product + price + date is enough to find the store. Agents (MCP) still search
// by real product names; only what is displayed is anonymised.
import type { DB } from './db.ts';

function code(key: string): string {
  let h = 2166136261;
  for (const ch of 'item' + key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const n = h >>> 0;
  return `#${letters[n % 24]}${(Math.floor(n / 24) % 90) + 10}`;
}

export function categoryOf(db: DB, productId: string): string {
  const r = db.prepare(`SELECT json_extract(raw_json, '$.category.title') AS t FROM products WHERE id = ?`).get(productId) as { t: string | null } | undefined;
  return r?.t ?? 'Product';
}

export function productLabel(db: DB, productId: string): string {
  return `${categoryOf(db, productId)} · ${code(productId)}`;
}

// A group (same model at several stores) shares one label.
export function groupLabel(db: DB, groupKey: string, anyProductId: string): string {
  return `${categoryOf(db, anyProductId)} · ${code(groupKey)}`;
}
