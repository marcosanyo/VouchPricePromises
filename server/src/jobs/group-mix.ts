// How mixed are the "same model" groups? Keyword pass over listing titles
// (no LLM), plus how often listing prices change at all. Read-only.
// Run: node src/jobs/group-mix.ts
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';
import { buildGroups, loadListings } from '../features.ts';
const db = new DatabaseSync(config().dbPath, { readOnly: true }) as any;
const groups = buildGroups(loadListings(db));
const title = db.prepare('SELECT title FROM products WHERE id = ?');
const RX: [string, RegExp][] = [
  ['renewed/refurb/used/open-box', /renew|refurb|pre-?owned|\bused\b|open[- ]box/i],
  ['bundle/kit/with accessory', /bundle|\bkit\b|\bwith\b|\+|combo|pack of|\d+-pack/i],
  ['size/capacity/color in title', /\b\d+\s?(gb|tb|oz|qt|quart|mm|inch|in\.)\b|\b(black|white|blue|red|green|silver|pink|gray|grey|beige|navy)\b/i],
];
let nGroups = 0, nListings = 0;
const hits = new Map<string, number>(), groupsWith = new Map<string, number>();
let mixedPrice = 0;
for (const [, ls] of groups) {
  if (ls.length < 2) continue;
  nGroups++;
  const ts = ls.map((l) => (title.get(l.product_id) as { title: string }).title);
  nListings += ts.length;
  for (const [k, rx] of RX) {
    const n = ts.filter((t) => rx.test(t)).length;
    hits.set(k, (hits.get(k) ?? 0) + n);
    if (n > 0 && n < ts.length) groupsWith.set(k, (groupsWith.get(k) ?? 0) + 1); // some but not all: mixed
  }
  const last = ls.map((l) => [...l.series.values()].at(-1)!);
  if (Math.max(...last) / Math.min(...last) > 1.5) mixedPrice++;
}
console.log({ nGroups, nListings });
for (const [k] of RX) console.log(k, 'listings:', hits.get(k), 'groups mixed:', groupsWith.get(k) ?? 0);
console.log('groups where the dearest current price is >1.5x the cheapest:', mixedPrice);
// Repricing frequency: share of listings whose price changed on >= 1/3 of days.
const all = loadListings(db);
const rates = all.filter((l) => l.series.size >= 14).map((l) => { const v = [...l.series.entries()].sort().map(([, p]) => p); let c = 0; for (let i = 1; i < v.length; i++) if (Math.abs(v[i] - v[i - 1]) > 0.01) c++; return c / (v.length - 1); });
const q = (f: number) => rates.filter((r) => r >= f).length;
console.log({ listings_14plus_days: rates.length, changed_on_1in3_days_or_more: q(1 / 3), changed_weekly_or_more: q(1 / 7), never_changed: rates.filter((r) => r === 0).length });
