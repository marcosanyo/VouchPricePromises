// Reads brand/model from every listing with the LLM so the same item can be
// grouped across stores. Only rows without an extraction are sent.
import { config } from '../config.ts';
import { openDb } from '../db.ts';
import { extractModels } from '../extract.ts';

const db = openDb(config().dbPath);
const n = await extractModels(db);
const stats = db.prepare(`SELECT COUNT(*) AS n, COUNT(group_key) AS grouped, COUNT(DISTINCT group_key) AS keys FROM product_models`).get();
console.log(`[models] extracted ${n}; totals`, stats);
