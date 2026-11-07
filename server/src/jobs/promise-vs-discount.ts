// What a full-difference no-price-drop promise costs a store, against cutting
// the price now (concept §30). Two parts:
//  1. Measured: in the real Channel3 histories (ordinary period, no Black
//     Friday), how often a store's own price fell within 7 / 14 days of a day
//     it sold, by how much, and the expected refund as a share of the price.
//     Every store-day of every listing (outlier-filtered series) with the full
//     window in the data.
//  2. Assumed: a store that may cut its price by k% inside the window with
//     probability q (its own markdown plan). Cutting now costs k on every unit;
//     the promise costs q·k (or the ordinary-period rate when it does not cut).
//     Gross margin 20% is an assumption.
// Read-only. Run: node src/jobs/promise-vs-discount.ts
// Writes server/experiments/promise-vs-discount.json (seller console).
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { buildGroups, loadListings } from '../features.ts';
import { addDays } from '../rules.ts';

const db = new DatabaseSync(config().dbPath, { readOnly: true }) as any;
// Outlier-filtered series, the same ones price-match-cost.ts and the models use.
const listings = [...buildGroups(loadListings(db)).values()].flat();
const r4 = (x: number) => Math.round(x * 10000) / 10000;
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const quantile = (a: number[], q: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};

function measured(W: number) {
  const refunds: number[] = []; // refund / price for each store-day
  let listingsUsed = 0;
  for (const l of listings) {
    const days = [...l.series.keys()].sort();
    const last = days.at(-1);
    if (!last) continue;
    let used = false;
    for (const d of days) {
      if (addDays(d, W) > last) break; // need the full window in data
      const p = l.series.get(d)!;
      const later = days.filter((x) => x > d && x <= addDays(d, W)).map((x) => l.series.get(x)!);
      refunds.push(Math.max(0, p - Math.min(p, ...later)) / p);
      used = true;
    }
    if (used) listingsUsed++;
  }
  const hit = refunds.filter((x) => x > 0.0001);
  return {
    window_days: W,
    listings: listingsUsed,
    store_days: refunds.length,
    drop_rate: r4(hit.length / Math.max(1, refunds.length)),
    drop_size_when_it_happens: r4(mean(hit)),
    expected_refund_share_of_price: r4(mean(refunds)),
    p90_refund_share_of_price: r4(quantile(refunds, 0.9)),
  };
}

const m7 = measured(7);
const m14 = measured(14);
const MARGIN = 0.2;
const scenarios = [0.1, 0.2, 0.3].flatMap((k) =>
  [0, 0.25, 0.5, 1].map((q) => {
    const promise = q * k + (1 - q) * m14.expected_refund_share_of_price;
    return { markdown: k, chance_store_cuts: q, cut_now_cost: k, promise_expected_cost: r4(promise), margin_left_cut_now: r4(MARGIN - k), margin_left_promise: r4(MARGIN - promise) };
  }),
);

for (const m of [m7, m14]) {
  console.log(`\n${m.window_days}-day window: ${m.store_days} store-days, ${m.listings} listings`);
  console.log(`  own price fell: ${(m.drop_rate * 100).toFixed(1)}%; size when it fell ${(m.drop_size_when_it_happens * 100).toFixed(1)}%; expected refund ${(m.expected_refund_share_of_price * 100).toFixed(2)}% of price (p90 ${(m.p90_refund_share_of_price * 100).toFixed(1)}%)`);
}
console.log('\nmarkdown k, chance q -> cut now vs promise (share of price), margin left at 20%');
for (const s of scenarios) console.log(`  k ${s.markdown * 100}% q ${s.chance_store_cuts}: cut now ${(s.cut_now_cost * 100).toFixed(0)}% vs promise ${(s.promise_expected_cost * 100).toFixed(1)}% | margin ${(s.margin_left_cut_now * 100).toFixed(1)}% vs ${(s.margin_left_promise * 100).toFixed(1)}%`);

const days = db.prepare('SELECT MIN(day) a, MAX(day) b FROM price_points').get();
const dir = new URL('../../experiments/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
writeFileSync(
  dir + 'promise-vs-discount.json',
  JSON.stringify(
    {
      run_at: new Date().toISOString(),
      data_days: { from: days.a, to: days.b },
      note: 'Measured part: real Channel3 daily prices, ordinary period (no Black Friday in the data); the promise refunds the full difference of the store’s own later price. Scenario part: markdown size k and the chance q that the store cuts are assumptions; gross margin 20% is an assumption.',
      measured: [m7, m14],
      gross_margin_assumed: MARGIN,
      scenarios,
    },
    null,
    2,
  ) + '\n',
);
