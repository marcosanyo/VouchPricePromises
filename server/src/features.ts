// Features for the failure-probability models. One implementation serves both
// the training export (jobs/dataset.ts) and live/replay scoring, so the model
// always sees features computed the same way. Only data on or before `day` is
// used for features; labels look forward.
import type { DB } from './db.ts';
import { addDays, DEFAULTS, filterOutliers, type Series } from './rules.ts';

export const BLACK_FRIDAY = '2026-11-27';

export const FEATURE_NAMES = [
  'rel_mean',
  'rel_min',
  'rel_max',
  'cv',
  'change_rate',
  'days_since_change',
  'ret_7d',
  'n_prior',
  'log_price',
  'n_peers',
  'rel_group_min',
  'is_group_min',
  'days_to_black_friday',
] as const;

export type Features = Record<(typeof FEATURE_NAMES)[number], number>;

export interface Listing {
  product_id: string;
  domain: string;
  group_key: string | null;
  category: string | null;
  series: Series; // outlier-filtered
}

// A listing is attributable to one store only when Channel3 returned a single
// merchant offer for the canonical product; its history is then that store's.
export function loadListings(db: DB): Listing[] {
  const rows = db
    .prepare(
      `SELECT p.id, MIN(s.domain) AS domain, COUNT(DISTINCT s.domain) AS n_domains, m.group_key, p.category_path
       FROM products p
       JOIN offer_snapshots s ON s.product_id = p.id
       LEFT JOIN product_models m ON m.product_id = p.id
       WHERE s.currency = 'USD'
       GROUP BY p.id`,
    )
    .all() as { id: string; domain: string; n_domains: number; group_key: string | null; category_path: string | null }[];
  const pts = db.prepare('SELECT product_id, day, price FROM price_points ORDER BY product_id, day').all() as { product_id: string; day: string; price: number }[];
  const byId = new Map<string, Series>();
  for (const p of pts) {
    let s = byId.get(p.product_id);
    if (!s) byId.set(p.product_id, (s = new Map()));
    s.set(p.day, p.price);
  }
  return rows
    .filter((r) => r.n_domains === 1 && byId.has(r.id))
    .map((r) => ({
      product_id: r.id,
      domain: r.domain,
      group_key: r.group_key,
      category: r.category_path?.split('/')[0] ?? null,
      series: filterOutliers(byId.get(r.id)!).kept,
    }));
}

// Groups: same extracted model at two or more distinct stores. Per store, keep
// the listing with the most price history.
export function buildGroups(listings: Listing[]): Map<string, Listing[]> {
  const byKey = new Map<string, Map<string, Listing>>();
  for (const l of listings) {
    if (!l.group_key) continue;
    let m = byKey.get(l.group_key);
    if (!m) byKey.set(l.group_key, (m = new Map()));
    const cur = m.get(l.domain);
    if (!cur || l.series.size > cur.series.size) m.set(l.domain, l);
  }
  const out = new Map<string, Listing[]>();
  for (const [k, m] of byKey) {
    const kept = dropPriceOutliers([...m.values()]);
    if (kept.length >= 2) out.set(k, kept);
  }
  return out;
}

// Data-quality rule: a listing whose median price is more than
// GROUP_PRICE_TOLERANCE away from the group's median is most likely a
// different variant (size, kit, generation) that the model reading missed.
export const GROUP_PRICE_TOLERANCE = 0.4;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function dropPriceOutliers(ls: Listing[]): Listing[] {
  const meds = ls.map((l) => median([...l.series.values()]));
  const g = median(meds);
  return ls.filter((_, i) => Math.abs(meds[i] / g - 1) <= GROUP_PRICE_TOLERANCE);
}

function priorPoints(s: Series, day: string, lookback = 30): number[] {
  const from = addDays(day, -lookback);
  return [...s.entries()].filter(([d]) => d >= from && d <= day).sort((a, b) => a[0].localeCompare(b[0])).map(([, p]) => p);
}

export function features(l: Listing, day: string, peers: Listing[]): Features | null {
  const price = l.series.get(day);
  if (price === undefined) return null;
  const prior = priorPoints(l.series, day);
  if (prior.length < 3) return null;
  const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
  const sd = Math.sqrt(prior.reduce((a, b) => a + (b - mean) ** 2, 0) / prior.length);
  let changes = 0;
  let lastChange = prior.length - 1;
  for (let i = 1; i < prior.length; i++) if (Math.abs(prior[i] - prior[i - 1]) > DEFAULTS.price_epsilon) changes++;
  for (let i = prior.length - 1; i > 0; i--) {
    if (Math.abs(prior[i] - prior[i - 1]) > DEFAULTS.price_epsilon) {
      lastChange = prior.length - 1 - i;
      break;
    }
  }
  const week = l.series.get(addDays(day, -7));
  const peerPrices = peers.filter((p) => p.product_id !== l.product_id).map((p) => p.series.get(day)).filter((p): p is number => p !== undefined);
  const groupMin = peerPrices.length ? Math.min(...peerPrices) : price;
  const bf = (Date.parse(BLACK_FRIDAY) - Date.parse(day)) / 86_400_000;
  return {
    rel_mean: price / mean - 1,
    rel_min: price / Math.min(...prior) - 1,
    rel_max: price / Math.max(...prior) - 1,
    cv: mean > 0 ? sd / mean : 0,
    change_rate: changes / Math.max(1, prior.length - 1),
    days_since_change: Math.min(30, lastChange) / 30,
    ret_7d: week ? price / week - 1 : 0,
    n_prior: prior.length / 30,
    log_price: Math.log(price),
    n_peers: peerPrices.length,
    rel_group_min: price / groupMin - 1,
    is_group_min: peerPrices.length && price <= groupMin + DEFAULTS.price_epsilon ? 1 : 0,
    days_to_black_friday: bf / 30,
  };
}

// ---------- Labels (forward-looking; training only) ----------

export function labelDrop(l: Listing, day: string, window = 14): { y: number; magnitude: number } | null {
  const price = l.series.get(day)!;
  const fut = [...l.series.entries()].filter(([d]) => d > day && d <= addDays(day, window)).map(([, p]) => p);
  if (fut.length < Math.ceil(window * 0.7)) return null;
  const min = Math.min(...fut);
  const drop = min < price - DEFAULTS.price_epsilon;
  return { y: drop ? 1 : 0, magnitude: drop ? (price - min) / price : 0 };
}

// Lowest-price break: given the listing is the cheapest on `day`, does any
// compared store go below it within the window?
export function labelLowestBreak(l: Listing, day: string, peers: Listing[], window = 7): { y: number; magnitude: number } | null {
  const price = l.series.get(day)!;
  const others = peers.filter((p) => p.product_id !== l.product_id);
  let seen = 0;
  let min = Infinity;
  for (const p of others) {
    for (const [d, v] of p.series) {
      if (d > day && d <= addDays(day, window)) {
        seen++;
        min = Math.min(min, v);
      }
    }
  }
  if (seen < window) return null;
  const broke = min < price - DEFAULTS.price_epsilon;
  return { y: broke ? 1 : 0, magnitude: broke ? (price - min) / price : 0 };
}

// Train/test split by product group (or listing when ungrouped) so the test
// set never shares an item with training. Deterministic.
export function isTestUnit(key: string): boolean {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 4 === 0;
}
