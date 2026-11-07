// Database snapshot for sharing between sessions through git.
//   node src/jobs/snapshot.ts            write data/snapshot/vouch.db (one file, WAL folded in)
//   node src/jobs/snapshot.ts restore    copy the snapshot to data/vouch.db (refuses to overwrite; --force)
// Only one place writes the live database (the local Mac: daily job, purchases).
// Other sessions restore the snapshot and treat it as read-only.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.ts';

const live = config().dbPath;
const snap = new URL('../../../data/snapshot/vouch.db', import.meta.url).pathname;
const cmd = process.argv[2] ?? 'save';

if (cmd === 'save') {
  if (!existsSync(live)) throw new Error(`No live database at ${live}`);
  mkdirSync(dirname(snap), { recursive: true });
  rmSync(snap, { force: true });
  const db = new DatabaseSync(live);
  db.exec('PRAGMA busy_timeout = 10000');
  // VACUUM INTO writes a consistent, compacted copy including WAL contents.
  db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
  const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM price_points) AS price_points,
    (SELECT MAX(day) FROM price_points) AS last_day, (SELECT COUNT(*) FROM contracts) AS contracts, (SELECT COUNT(*) FROM ledger) AS ledger`).get();
  db.close();
  console.log(`[snapshot] ${snap} ${(statSync(snap).size / 1e6).toFixed(1)} MB`, counts);
} else if (cmd === 'restore') {
  if (!existsSync(snap)) throw new Error(`No snapshot at ${snap} (git pull first)`);
  if (existsSync(live) && !process.argv.includes('--force')) {
    throw new Error(`${live} already exists. It may hold newer data than the snapshot; pass --force to overwrite it.`);
  }
  mkdirSync(dirname(live), { recursive: true });
  for (const ext of ['-wal', '-shm']) rmSync(live + ext, { force: true });
  copyFileSync(snap, live);
  console.log(`[snapshot] restored ${snap} → ${live}`);
} else {
  throw new Error(`Unknown command ${cmd} (save | restore)`);
}
