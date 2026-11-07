// Wires config, store, and upstream clients. Every upstream call is recorded.
import { config } from './config.ts';
import { openDb, recordLlmCalls, type DB } from './db.ts';
import { Channel3 } from './channel3.ts';
import { PayPal } from './paypal.ts';
import { recordCall } from './repo.ts';
import { Sellers } from './sellers.ts';

export interface Ctx {
  db: DB;
  channel3: Channel3;
  sellers: Sellers; // one PayPal client per seller account
}

export function makeCtx(): Ctx {
  const cfg = config();
  const db = openDb(cfg.dbPath);
  void recordLlmCalls(db, process.argv[1]?.split('/').pop() ?? 'server');
  const channel3 = new Channel3({
    apiKey: cfg.channel3.apiKey,
    baseUrl: cfg.channel3.baseUrl,
    onCall: (rec) => recordCall(db, 'channel3', rec),
  });
  const sellers = Sellers.from(cfg.paypal.sellers, (s) =>
    new PayPal({
      apiBase: cfg.paypal.apiBase,
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      onCall: (rec) => recordCall(db, 'paypal', rec),
    }),
  );
  return { db, channel3, sellers };
}
