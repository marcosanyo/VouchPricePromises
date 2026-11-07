// Writes and reads over the local store. Kept free of business rules.
import type { DB } from './db.ts';
import { nowIso } from './db.ts';
import type { CallRecord, PriceHistory, Product } from './channel3.ts';

export function recordCall(db: DB, upstream: string, rec: CallRecord): number {
  const r = db
    .prepare(
      `INSERT INTO api_calls (ts, upstream, method, endpoint, request_json, status, response_json, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nowIso(),
      upstream,
      rec.method,
      rec.endpoint,
      JSON.stringify(rec.request),
      rec.status,
      JSON.stringify(rec.response),
      rec.durationMs,
    );
  return Number(r.lastInsertRowid);
}

export function lastCallId(db: DB): number | null {
  const row = db.prepare('SELECT MAX(id) AS id FROM api_calls').get() as { id: number | null };
  return row.id;
}

export function upsertProduct(db: DB, p: Product, query: string | null, callId: number | null) {
  const ts = nowIso();
  const main = p.images?.find((i) => i.is_main_image) ?? p.images?.[0];
  db.prepare(
    `INSERT INTO products (id, title, brand, category_slug, category_path, description, key_features_json, image_url, query, raw_json, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, brand=excluded.brand, category_slug=excluded.category_slug,
       category_path=excluded.category_path, description=excluded.description, key_features_json=excluded.key_features_json,
       image_url=excluded.image_url, raw_json=excluded.raw_json, last_seen=excluded.last_seen,
       query=COALESCE(products.query, excluded.query)`,
  ).run(
    p.id,
    p.title,
    p.brands?.[0]?.name ?? null,
    p.category?.slug ?? null,
    p.category?.path?.map((c) => c.slug).join('/') ?? null,
    p.description ?? null,
    JSON.stringify(p.key_features ?? []),
    main?.url ?? null,
    query,
    JSON.stringify(p),
    ts,
    ts,
  );
  const ins = db.prepare(
    `INSERT INTO offer_snapshots (product_id, domain, price, compare_at_price, currency, availability, observed_at, call_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const o of p.offers ?? []) {
    ins.run(p.id, o.domain, o.price.price, o.price.compare_at_price ?? null, o.price.currency, o.availability, ts, callId);
  }
}

export function savePriceHistory(db: DB, h: PriceHistory, callId: number | null) {
  const ts = nowIso();
  const ins = db.prepare(
    `INSERT INTO price_points (product_id, day, price, currency, fetched_at, call_id) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id, day) DO UPDATE SET price=excluded.price, currency=excluded.currency,
       fetched_at=excluded.fetched_at, call_id=excluded.call_id`,
  );
  for (const pt of h.history ?? []) {
    ins.run(h.canonical_product_id, pt.timestamp.slice(0, 10), pt.price, pt.currency, ts, callId);
  }
  const s = h.statistics;
  if (s) {
    db.prepare(
      `INSERT OR REPLACE INTO history_stats (product_id, fetched_at, current_price, min_price, max_price, mean, std_dev, current_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(h.canonical_product_id, ts, s.current_price, s.min_price, s.max_price, s.mean, s.std_dev, s.current_status);
  }
}

export interface PricePoint {
  day: string;
  price: number;
}

export function pricePoints(db: DB, productId: string): PricePoint[] {
  return db
    .prepare('SELECT day, price FROM price_points WHERE product_id = ? ORDER BY day')
    .all(productId) as unknown as PricePoint[];
}

export interface LatestOffer {
  product_id: string;
  domain: string;
  price: number;
  compare_at_price: number | null;
  currency: string;
  availability: string;
  observed_at: string;
}

export function latestOffers(db: DB, productId: string): LatestOffer[] {
  return db
    .prepare(
      `SELECT s.product_id, s.domain, s.price, s.compare_at_price, s.currency, s.availability, s.observed_at
       FROM offer_snapshots s
       WHERE s.product_id = ? AND s.observed_at = (SELECT MAX(observed_at) FROM offer_snapshots WHERE product_id = s.product_id)
       ORDER BY s.price`,
    )
    .all(productId) as unknown as LatestOffer[];
}
