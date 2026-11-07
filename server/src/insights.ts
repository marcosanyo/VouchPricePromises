// "Is the sale real?" across every single-store listing that advertised a
// discount (compare_at_price above price) when we observed it. Each listing is
// judged with the same genuine_sale rule a staked contract uses: the observed
// price must be at least min_discount_pct below the store's own mean price over
// the prior 30 days. Stores are anonymised; the "was" price may be a list
// price rather than the store's own earlier price, which the page says.
import type { DB } from './db.ts';
import { loadListings } from './features.ts';
import { DEFAULTS, judge, makeTerms, round2 } from './rules.ts';
import { storeLabel } from './score.ts';
import { productLabel } from './labels.ts';

// Max relative gap between the listed price and the daily-history price on the
// same day before a listing is excluded as inconsistent.
export const CONSISTENCY_TOLERANCE = 0.02;

export interface SaleCheck {
  product_id: string;
  store: string;
  title: string;
  category: string | null;
  observed_day: string;
  price: number;
  was_price: number;
  advertised_discount_pct: number;
  mean_30d: number | null;
  actual_discount_pct: number | null; // vs the store's own prior mean
  verdict: 'genuine' | 'not_genuine' | 'evidence_missing' | 'inconsistent';
  pattern: 'raised_first' | 'unchanged' | 'small_discount' | 'genuine' | null;
  max_30d: number | null; // highest daily price in the prior 30 days
  was_never_charged: boolean | null; // the "was" price is above every prior-30-day price
  hypothetical_refund_usd: number; // if a $stake genuine_sale claim had been staked
  reason: string;
  series: { day: string; price: number }[];
}

// Where the observed price sits against the store's own prior 30-day mean.
// UNCHANGED_BAND_PCT is the band treated as "same price as before".
export const UNCHANGED_BAND_PCT = 2;
function patternOf(actualPct: number): SaleCheck['pattern'] {
  if (actualPct >= DEFAULTS.genuine_sale.min_discount_pct) return 'genuine';
  if (actualPct < -UNCHANGED_BAND_PCT) return 'raised_first';
  if (actualPct < UNCHANGED_BAND_PCT) return 'unchanged';
  return 'small_discount';
}

export function fakeSaleReport(db: DB, stake = 10) {
  const listings = new Map(loadListings(db).map((l) => [l.product_id, l]));
  const rows = db
    .prepare(
      `SELECT s.product_id, s.price, s.compare_at_price, substr(s.observed_at, 1, 10) AS day,
              COALESCE(m.brand || ' ' || m.model, p.title) AS title, p.category_path
       FROM offer_snapshots s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN product_models m ON m.product_id = s.product_id
       WHERE s.compare_at_price > s.price AND s.currency = 'USD'
         AND s.observed_at = (SELECT MAX(observed_at) FROM offer_snapshots x WHERE x.product_id = s.product_id)`,
    )
    .all() as { product_id: string; price: number; compare_at_price: number; day: string; title: string; category_path: string | null }[];

  const checks: SaleCheck[] = [];
  for (const r of rows) {
    const l = listings.get(r.product_id);
    if (!l) continue; // not attributable to a single store
    // The discount label and the daily history must describe the same price:
    // otherwise the label may belong to another variant or pack size.
    const histPrice = l.series.get(r.day);
    if (histPrice === undefined || Math.abs(r.price / histPrice - 1) > CONSISTENCY_TOLERANCE) {
      checks.push({
        product_id: r.product_id, store: storeLabel(l.domain), title: productLabel(db, r.product_id), category: r.category_path?.split('/')[0] ?? null, observed_day: r.day,
        price: r.price, was_price: r.compare_at_price, advertised_discount_pct: round2((1 - r.price / r.compare_at_price) * 100), mean_30d: null, actual_discount_pct: null,
        verdict: 'inconsistent', pattern: null, max_30d: null, was_never_charged: null, hypothetical_refund_usd: 0,
        reason: histPrice === undefined ? `No daily price for ${r.day}` : `Listed price $${r.price.toFixed(2)} differs from the daily history ($${histPrice.toFixed(2)}) on ${r.day}`,
        series: [...l.series.entries()].filter(([d]) => d <= r.day).sort().map(([day, price]) => ({ day, price })),
      });
      continue;
    }
    const terms = makeTerms({ claim_type: 'genuine_sale', product_id: r.product_id, domain: l.domain, group_key: l.group_key, purchase_price: r.price, purchase_day: r.day, stake_usd: stake });
    const v = judge(terms, { listing: l.series });
    const mean = (v.used as any).mean_prior as number | undefined;
    const priorPts = ((v.used as any).points ?? []) as [string, number][];
    const max30 = priorPts.length ? Math.max(...priorPts.map(([, p]) => p)) : null;
    checks.push({
      product_id: r.product_id,
      store: storeLabel(l.domain),
      title: productLabel(db, r.product_id),
      category: r.category_path?.split('/')[0] ?? null,
      observed_day: r.day,
      price: r.price,
      was_price: r.compare_at_price,
      advertised_discount_pct: round2((1 - r.price / r.compare_at_price) * 100),
      mean_30d: mean ?? null,
      actual_discount_pct: mean ? round2((1 - r.price / mean) * 100) : null,
      verdict: v.evidence_missing ? 'evidence_missing' : v.outcome === 'hit' ? 'genuine' : 'not_genuine',
      pattern: v.evidence_missing ? null : patternOf(mean ? (1 - r.price / mean) * 100 : 0),
      max_30d: max30,
      was_never_charged: v.evidence_missing || max30 == null ? null : r.compare_at_price > max30 + DEFAULTS.price_epsilon,
      hypothetical_refund_usd: v.evidence_missing ? 0 : v.payout_usd,
      reason: v.reason,
      series: [...l.series.entries()].filter(([d]) => d <= r.day).sort().map(([day, price]) => ({ day, price })),
    });
  }
  const judged = checks.filter((c) => c.verdict === 'genuine' || c.verdict === 'not_genuine');
  const notGenuine = judged.filter((c) => c.verdict === 'not_genuine');
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
  };
  const byCategory = new Map<string, { judged: number; not_genuine: number }>();
  for (const c of judged) {
    const k = c.category ?? 'other';
    const e = byCategory.get(k) ?? { judged: 0, not_genuine: 0 };
    e.judged++;
    if (c.verdict === 'not_genuine') e.not_genuine++;
    byCategory.set(k, e);
  }
  return {
    rule: { min_discount_pct: DEFAULTS.genuine_sale.min_discount_pct, lookback_days: DEFAULTS.genuine_sale.lookback_days, min_points: DEFAULTS.genuine_sale.min_points, stake_usd: stake },
    observed_days: [...new Set(checks.map((c) => c.observed_day))].sort(),
    summary: {
      listings_with_discount_label: checks.length,
      judged: judged.length,
      not_genuine: notGenuine.length,
      evidence_missing: checks.filter((c) => c.verdict === 'evidence_missing').length,
      inconsistent: checks.filter((c) => c.verdict === 'inconsistent').length,
      median_advertised_discount_pct: median(judged.map((c) => c.advertised_discount_pct)),
      median_actual_discount_pct: median(judged.map((c) => c.actual_discount_pct!)),
      patterns: {
        raised_first: judged.filter((c) => c.pattern === 'raised_first').length,
        unchanged: judged.filter((c) => c.pattern === 'unchanged').length,
        small_discount: judged.filter((c) => c.pattern === 'small_discount').length,
        genuine: judged.filter((c) => c.pattern === 'genuine').length,
      },
      unchanged_band_pct: UNCHANGED_BAND_PCT,
      // EU-style check: the reference price should be one the store charged in the prior 30 days.
      was_never_charged: judged.filter((c) => c.was_never_charged).length,
      hypothetical_refunds_usd: round2(judged.reduce((s, c) => s + c.hypothetical_refund_usd, 0)),
    },
    by_category: [...byCategory.entries()].map(([category, e]) => ({ category, ...e })).sort((a, b) => b.judged - a.judged),
    checks: checks.sort((a, b) => (b.advertised_discount_pct - (b.actual_discount_pct ?? 0)) - (a.advertised_discount_pct - (a.actual_discount_pct ?? 0))),
    caveats: [
      'The "was" price is what the listing showed; it may be a list price rather than the store\'s own earlier price.',
      `The ${DEFAULTS.genuine_sale.min_discount_pct}% threshold is a Vouch contract parameter, not a legal standard.`,
      'Prices are Channel3 daily history; stores are anonymised and have not staked anything.',
      `Listings whose listed price differs from the daily history on the same day by more than ${CONSISTENCY_TOLERANCE * 100}% are excluded as inconsistent.`,
    ],
  };
}
