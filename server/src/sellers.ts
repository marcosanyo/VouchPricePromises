// PayPal seller accounts (plan B). Each store can be paid through its own
// Sandbox Business account, so a refund comes out of that seller's balance
// and the store's track record follows its PayPal merchant id: a store that
// changes its site name keeps its record. Stores without their own account
// are paid through the shared account in slot 1.
import type { PayPalSeller } from './config.ts';
import { sellerVars } from './config.ts';
import type { DB } from './db.ts';
import { nowIso } from './db.ts';
import { append } from './ledger.ts';
import type { PayPal } from './paypal.ts';
import { storeLabel } from './score.ts';

export const SHARED_SLOT = 1;

export interface SellerAccount {
  domain: string;
  seller_slot: number;
  merchant_id: string;
}

export class Sellers {
  private readonly clients: Map<number, PayPal>;

  constructor(clients: Map<number, PayPal>) {
    this.clients = clients;
  }

  static from(sellers: PayPalSeller[], make: (s: PayPalSeller) => PayPal): Sellers {
    return new Sellers(new Map(sellers.map((s) => [s.slot, make(s)])));
  }

  slots(): number[] {
    return [...this.clients.keys()].sort();
  }

  client(slot: number | null): PayPal {
    const c = slot === null ? undefined : this.clients.get(slot);
    if (!c) {
      const names = slot === null ? 'a seller slot' : sellerVars(slot).join(' and ');
      throw new Error(`PayPal seller slot ${slot} is not configured: set ${names} (see .env.example)`);
    }
    return c;
  }
}

export function sellerAccount(db: DB, domain: string): SellerAccount | undefined {
  return db.prepare('SELECT domain, seller_slot, merchant_id FROM seller_accounts WHERE domain = ?').get(domain) as SellerAccount | undefined;
}

// The slot whose credentials take this store's orders.
export function sellerSlot(db: DB, domain: string): number {
  return sellerAccount(db, domain)?.seller_slot ?? SHARED_SLOT;
}

// Gives a store its own PayPal seller. The merchant id is read from PayPal.
export async function assignSeller(db: DB, sellers: Sellers, domain: string, slot: number): Promise<SellerAccount> {
  if (slot === SHARED_SLOT) throw new Error(`Slot ${SHARED_SLOT} is the shared account; assign a dedicated slot (${sellers.slots().filter((s) => s !== SHARED_SLOT).join(', ') || 'none configured'})`);
  const merchantId = await sellers.client(slot).merchantId();
  // One store per dedicated seller: assigning a taken slot moves it (a store
  // renamed to a new site keeps its PayPal account and so its record).
  const prev = db.prepare('SELECT domain FROM seller_accounts WHERE seller_slot = ? AND domain <> ?').get(slot, domain) as { domain: string } | undefined;
  if (prev) db.prepare('DELETE FROM seller_accounts WHERE domain = ?').run(prev.domain);
  db.prepare(
    `INSERT INTO seller_accounts (domain, seller_slot, merchant_id, assigned_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET seller_slot=excluded.seller_slot, merchant_id=excluded.merchant_id, assigned_at=excluded.assigned_at`,
  ).run(domain, slot, merchantId, nowIso());
  append(db, 'seller_account', storeLabel(domain), { store: storeLabel(domain), seller_slot: slot, merchant_id: merchantId, ...(prev ? { moved_from: storeLabel(prev.domain) } : {}) });
  return { domain, seller_slot: slot, merchant_id: merchantId };
}

// Short form for screens: enough to tell sellers apart, not the full id.
export const merchantTag = (id: string | null) => (id ? `…${id.slice(-4)}` : null);
