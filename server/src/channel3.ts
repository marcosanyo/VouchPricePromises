// Channel3 REST client. Search and product details are /v1; price tracking is
// /v0. Every call is logged through `onCall` so the ledger keeps the raw
// evidence and we can count credit usage.
import { UpstreamError, readBody, withRetries } from './errors.ts';

export interface Price {
  price: number;
  currency: string;
  compare_at_price?: number | null;
}

export interface Offer {
  url: string;
  domain: string;
  price: Price;
  availability: 'InStock' | 'OutOfStock';
  max_commission_rate?: number;
}

export interface Product {
  id: string;
  title: string;
  description?: string | null;
  brands?: { id: string; name: string }[];
  images?: { url: string; is_main_image?: boolean; shot_type?: string | null }[];
  category?: { slug: string; title: string; path?: { slug: string; title: string }[] } | null;
  key_features?: string[] | null;
  offers?: Offer[];
}

export interface PriceHistory {
  canonical_product_id: string;
  product_title?: string | null;
  history?: { price: number; currency: string; timestamp: string }[];
  statistics?: {
    current_price: number;
    min_price: number;
    max_price: number;
    mean: number;
    std_dev: number;
    currency: string;
    current_status: 'low' | 'typical' | 'high';
  } | null;
}

export interface Subscription {
  canonical_product_id: string;
  created_at: string;
  subscription_status: 'active' | 'cancelled';
}

export interface CallRecord {
  endpoint: string;
  method: string;
  request: unknown;
  status: number | null;
  response: unknown;
  durationMs: number;
}

export class Channel3 {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly onCall?: (rec: CallRecord) => void;

  constructor(opts: { apiKey: string; baseUrl: string; onCall?: (rec: CallRecord) => void }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl;
    this.onCall = opts.onCall;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return withRetries(`channel3 ${method} ${path}`, 3, async () => {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(this.baseUrl + path, {
          method,
          headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        this.onCall?.({ endpoint: path, method, request: body ?? null, status: null, response: String(err), durationMs: Date.now() - started });
        throw new UpstreamError({ upstream: 'channel3', endpoint: `${method} ${path}`, status: null, body: String(err) });
      }
      const parsed = await readBody(res);
      this.onCall?.({ endpoint: path, method, request: body ?? null, status: res.status, response: parsed, durationMs: Date.now() - started });
      if (!res.ok) {
        throw new UpstreamError({
          upstream: 'channel3',
          endpoint: `${method} ${path}`,
          status: res.status,
          body: parsed,
          requestId: res.headers.get('x-amzn-requestid'),
        });
      }
      return parsed as T;
    });
  }

  search(params: { query: string; limit?: number; page_token?: string; filters?: Record<string, unknown> }) {
    return this.request<{ products: Product[]; next_page_token?: string | null }>('POST', '/v1/search', params);
  }

  product(id: string) {
    return this.request<Product>('GET', `/v1/products/${encodeURIComponent(id)}`);
  }

  history(id: string, days = 30) {
    return this.request<PriceHistory>('GET', `/v0/price-tracking/history/${encodeURIComponent(id)}?days=${days}`);
  }

  startTracking(id: string) {
    return this.request<Subscription>('POST', '/v0/price-tracking/start', { canonical_product_id: id });
  }

  async subscriptions(): Promise<Subscription[]> {
    const out: Subscription[] = [];
    let cursor: string | null = null;
    do {
      const q: string = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
      const page: { items: Subscription[]; next_cursor: string | null } = await this.request('GET', `/v0/price-tracking/subscriptions${q}`);
      out.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }
}
