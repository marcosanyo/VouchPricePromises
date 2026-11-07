// Exports training rows for the ML models (ml/train.py) from Channel3 history.
//   drop14.csv   every (listing, day) with a full 14-day future window
//   drop7.csv    the same with a 7-day window (seller-agent simulation, docs/concept.md §27)
//   lowest7.csv  grouped listings that are the cheapest on `day`, 7-day window
import { writeFileSync, mkdirSync } from 'node:fs';
import { config } from '../config.ts';
import { openDb } from '../db.ts';
import { buildGroups, features, FEATURE_NAMES, isTestUnit, labelDrop, labelLowestBreak, loadListings } from '../features.ts';

const out = new URL('../../../data/ml/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const db = openDb(config().dbPath);
const listings = loadListings(db);
const groups = buildGroups(listings);
const groupOf = new Map<string, string>();
for (const [k, ls] of groups) for (const l of ls) groupOf.set(l.product_id, k);

const header = ['unit', 'product_id', 'day', 'split', ...FEATURE_NAMES, 'y', 'magnitude'].join(',');
const drop: string[] = [header];
const drop7: string[] = [header];
const lowest: string[] = [header];
for (const l of listings) {
  const g = groupOf.get(l.product_id);
  const peers = g ? groups.get(g)! : [];
  const unit = g ?? l.group_key ?? l.product_id;
  const split = isTestUnit(unit) ? 'test' : 'train';
  for (const day of [...l.series.keys()].sort()) {
    const f = features(l, day, peers);
    if (!f) continue;
    const row = (lab: { y: number; magnitude: number }) =>
      [JSON.stringify(unit), l.product_id, day, split, ...FEATURE_NAMES.map((n) => f[n].toFixed(6)), lab.y, lab.magnitude.toFixed(6)].join(',');
    const d = labelDrop(l, day);
    if (d) drop.push(row(d));
    const d7 = labelDrop(l, day, 7);
    if (d7) drop7.push(row(d7));
    if (peers.length && f.is_group_min === 1) {
      const lb = labelLowestBreak(l, day, peers);
      if (lb) lowest.push(row(lb));
    }
  }
}
writeFileSync(out + 'drop14.csv', drop.join('\n') + '\n');
writeFileSync(out + 'drop7.csv', drop7.join('\n') + '\n');
writeFileSync(out + 'lowest7.csv', lowest.join('\n') + '\n');
console.log(`listings=${listings.length} groups=${groups.size} drop14 rows=${drop.length - 1} drop7 rows=${drop7.length - 1} lowest7 rows=${lowest.length - 1}`);
