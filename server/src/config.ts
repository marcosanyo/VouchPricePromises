// Environment loading. Every required variable must be present; the process
// stops at startup with the variable name otherwise (docs/NO_FALLBACK_POLICY.md).
// Providers are chosen explicitly and never switched on error.

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  }
  return v.trim();
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
}

function oneOf<T extends string>(name: string, allowed: readonly T[]): T {
  const v = required(name);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`${name}=${v} is not one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

// One Sandbox Business account per seller (plan B). Slot 1 is the original
// account (PAYPAL_CLIENT_*); slots 2.. are PAYPAL_SELLER_<n>_CLIENT_*.
export interface PayPalSeller {
  slot: number;
  clientId: string;
  clientSecret: string;
}

export const SELLER_SLOTS = [1, 2, 3] as const;

export function sellerVars(slot: number): [string, string] {
  return slot === 1 ? ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'] : [`PAYPAL_SELLER_${slot}_CLIENT_ID`, `PAYPAL_SELLER_${slot}_CLIENT_SECRET`];
}

// Slot 1 is required. Other slots are loaded when both variables are set; a
// half-set slot stops startup, and using an unset slot fails with its names.
function sellers(): PayPalSeller[] {
  return SELLER_SLOTS.flatMap((slot) => {
    const [id, secret] = sellerVars(slot);
    if (slot !== 1 && optional(id) === undefined && optional(secret) === undefined) return [];
    return [{ slot, clientId: required(id), clientSecret: required(secret) }];
  });
}

export interface Config {
  port: number;
  dbPath: string;
  vertex: { project: string; location: string; model: string };
  paypal: { apiBase: string; sellers: PayPalSeller[]; webhookId?: string };
  channel3: { apiKey: string; baseUrl: string };
  demoPassword?: string;
}

let cached: Config | undefined;

export function config(): Config {
  if (cached) return cached;
  cached = {
    port: Number(required('PORT')),
    dbPath: optional('VOUCH_DB_PATH') ?? new URL('../../data/vouch.db', import.meta.url).pathname,
    vertex: {
      project: required('GOOGLE_CLOUD_PROJECT'),
      location: required('GOOGLE_CLOUD_LOCATION'),
      model: required('GEMINI_MODEL_ID'),
    },
    paypal: {
      apiBase: required('PAYPAL_API_BASE'),
      sellers: sellers(),
      // Needed only by the webhook route; that route answers 503 with this
      // variable's name when it is unset.
      webhookId: optional('PAYPAL_WEBHOOK_ID'),
    },
    channel3: { apiKey: required('CHANNEL3_API_KEY'), baseUrl: 'https://api.trychannel3.com' },
    // Set on Cloud Run (the deployment is for judges only); unset locally, where nothing asks for it.
    demoPassword: optional('DEMO_PASSWORD'),
  };
  return cached;
}
