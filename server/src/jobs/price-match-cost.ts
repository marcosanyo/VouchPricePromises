// Empirical cost of a 14-day price match vs own-price protection, from the
// real Channel3 histories in the database (read-only). Groups are the same
// model at 2+ stores (outlier-filtered series); a store-day counts when the
// full 14-day window after it is in the data. Run: node src/jobs/price-match-cost.ts
// Writes server/experiments/price-match-cost.json (shown in the seller console and judge guide).
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { buildGroups, loadListings } from '../features.ts';
import { addDays } from '../rules.ts';

const db = new DatabaseSync(config().dbPath, { readOnly: true }) as any;
const groups = buildGroups(loadListings(db));
const W = 14;
type Row = { price: number; own: number; market: number; gapNow: number; cheapest: boolean };
const rows: Row[] = [];
let nGroups = 0;
for (const [, ls] of groups) {
  if (ls.length < 2) continue;
  nGroups++;
  const days = [...new Set(ls.flatMap((l) => [...l.series.keys()]))].sort();
  for (const d of days) {
    const end = addDays(d, W);
    if (!days.some((x) => x >= end)) continue; // need the full window in data
    const today = ls.map((l) => l.series.get(d)).filter((x): x is number => x !== undefined);
    if (today.length < 2) continue;
    const mkt = Math.min(...today);
    for (const l of ls) {
      const p = l.series.get(d);
      if (p === undefined) continue;
      const fut = (s: Map<string, number>) => [...s.entries()].filter(([x]) => x > d && x <= end).map(([, v]) => v);
      const ownMin = Math.min(p, ...fut(l.series));
      const peersMin = Math.min(...ls.filter((o) => o !== l).flatMap((o) => fut(o.series)), Infinity);
      rows.push({ price: p, own: p - ownMin, market: Math.max(0, p - Math.min(ownMin, peersMin)), gapNow: p - mkt, cheapest: p <= mkt + 0.01 });
    }
  }
}
const pct = (x: number) => (x * 100).toFixed(1) + '%';
function report(name: string, rs: Row[]) {
  const n = rs.length;
  const ownHit = rs.filter((r) => r.own > 0.01);
  const mktHit = rs.filter((r) => r.market > 0.01);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  const capped = (r: Row, k: 'own' | 'market', capFrac: number) => Math.min(r[k], r.price * capFrac);
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const out = {
    store_days: n,
    own_drop: { rate: r4(ownHit.length / n), size_when_hit: r4(mean(ownHit.map((r) => r.own / r.price))), expected_payout: r4(mean(rs.map((r) => r.own / r.price))) },
    price_match: { rate: r4(mktHit.length / n), size_when_hit: r4(mean(mktHit.map((r) => r.market / r.price))), expected_payout: r4(mean(rs.map((r) => r.market / r.price))) },
    capped: [0.03, 0.05, 0.1].map((c) => ({ cap: c, own_drop: r4(mean(rs.map((r) => capped(r, 'own', c) / r.price))), price_match: r4(mean(rs.map((r) => capped(r, 'market', c) / r.price))) })),
  };
  console.log(`\n== ${name}: n=${n} store-days`);
  console.log(`own-price drop within ${W}d: ${pct(out.own_drop.rate)}; size when it happens ${pct(out.own_drop.size_when_hit)} of price; expected payout ${pct(out.own_drop.expected_payout)}`);
  console.log(`market-low below price within ${W}d (price match): ${pct(out.price_match.rate)}; size ${pct(out.price_match.size_when_hit)}; expected payout ${pct(out.price_match.expected_payout)}`);
  for (const c of out.capped) console.log(`  cap ${pct(c.cap)} of price: own ${pct(c.own_drop)} vs price match ${pct(c.price_match)}`);
  return out;
}
console.log('groups with 2+ stores:', nGroups);
const cheapest = report('cheapest store on the day (the store that would offer price match)', rows.filter((r) => r.cheapest));
const all = report('all stores (includes ones already above the market low)', rows);
const days = db.prepare('SELECT MIN(day) a, MAX(day) b FROM price_points').get();
console.log('\ndata days', days);
const dir = new URL('../../experiments/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
writeFileSync(dir + 'price-match-cost.json', JSON.stringify({ run_at: new Date().toISOString(), window_days: W, groups: nGroups, data_days: { from: days.a, to: days.b }, note: 'Real Channel3 daily prices, ordinary period (no Black Friday in the data). A store that plans a markdown inside the window pays in full; these averages do not apply to it.', cheapest_store: cheapest, all_stores: all }, null, 2) + '\n');
