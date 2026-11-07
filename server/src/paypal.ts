// PayPal REST client (Sandbox). Orders v2 for purchases, Payments v2 for
// partial refunds on the seller's own capture, and webhook signature checks.
// Vouch never holds funds: refunds go from the seller's capture to the buyer.
import { UpstreamError, readBody, withRetries } from './errors.ts';
import type { CallRecord } from './channel3.ts';

export interface Money {
  currency_code: 'USD';
  value: string;
}

export const usd = (amount: number): Money => ({ currency_code: 'USD', value: amount.toFixed(2) });

export interface CapturedOrder {
  orderId: string;
  status: string;
  captureId: string;
  captureStatus: string;
  amount: Money;
  payee: string | null;
  payeeMerchantId: string | null;
  paypalFee: Money | null;
  raw: unknown;
}

export interface RefundResult {
  refundId: string;
  status: string;
  raw: unknown;
}

// Sandbox test card (PayPal developer docs). Lets the demo buyer pay without a
// browser approval step; the transaction is still a real Sandbox capture.
export const SANDBOX_TEST_CARD = {
  number: '4032039317984658',
  expiry: '2030-12',
  security_code: '123',
  name: 'Vouch Demo Buyer',
};

export class PayPal {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly apiBase: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly onCall?: (rec: CallRecord) => void;

  constructor(opts: { apiBase: string; clientId: string; clientSecret: string; onCall?: (rec: CallRecord) => void }) {
    this.apiBase = opts.apiBase;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.onCall = opts.onCall;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await readBody(res)) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) {
      throw new UpstreamError({ upstream: 'paypal', endpoint: 'POST /v1/oauth2/token', status: res.status, body, requestId: res.headers.get('paypal-debug-id') });
    }
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 0) * 1000 };
    return body.access_token;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, requestId?: string): Promise<T> {
    return withRetries(`paypal ${method} ${path}`, 3, async () => {
      const started = Date.now();
      const headers: Record<string, string> = {
        authorization: `Bearer ${await this.accessToken()}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      };
      // Idempotency: the same PayPal-Request-Id never creates a second order/refund.
      if (requestId) headers['paypal-request-id'] = requestId;
      let res: Response;
      try {
        res = await fetch(this.apiBase + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        this.onCall?.({ endpoint: path, method, request: body ?? null, status: null, response: String(err), durationMs: Date.now() - started });
        throw new UpstreamError({ upstream: 'paypal', endpoint: `${method} ${path}`, status: null, body: String(err) });
      }
      const parsed = await readBody(res);
      this.onCall?.({ endpoint: path, method, request: redactCard(body), status: res.status, response: parsed, durationMs: Date.now() - started });
      if (!res.ok) {
        throw new UpstreamError({
          upstream: 'paypal',
          endpoint: `${method} ${path}`,
          status: res.status,
          body: parsed,
          requestId: res.headers.get('paypal-debug-id'),
        });
      }
      return parsed as T;
    });
  }

  // Creates and captures an order in one call with the Sandbox test card.
  async createAndCaptureCardOrder(opts: {
    requestId: string;
    amount: number;
    description: string;
    customId: string;
    invoiceId: string;
  }): Promise<CapturedOrder> {
    const raw = await this.request<any>(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: opts.customId,
            custom_id: opts.customId,
            invoice_id: opts.invoiceId,
            description: opts.description.slice(0, 127),
            amount: usd(opts.amount),
          },
        ],
        payment_source: { card: SANDBOX_TEST_CARD },
      },
      opts.requestId,
    );
    return parseCapturedOrder(raw);
  }

  // Buyer-approval flow (PayPal button). Returns the approval link.
  async createOrder(opts: { requestId: string; amount: number; description: string; customId: string; invoiceId: string; returnUrl: string; cancelUrl: string }) {
    const raw = await this.request<any>(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          { reference_id: opts.customId, custom_id: opts.customId, invoice_id: opts.invoiceId, description: opts.description.slice(0, 127), amount: usd(opts.amount) },
        ],
        payment_source: {
          paypal: { experience_context: { return_url: opts.returnUrl, cancel_url: opts.cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } },
        },
      },
      opts.requestId,
    );
    const approve = (raw.links as { rel: string; href: string }[]).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
    return { orderId: raw.id as string, status: raw.status as string, approveUrl: approve?.href ?? null, raw };
  }

  // Buyer side of an order the merchant created: attach the Sandbox test card
  // as the payment source (the credential the user's wallet provides).
  async confirmCardPaymentSource(orderId: string, requestId: string): Promise<{ status: string; raw: unknown }> {
    const raw = await this.request<any>('POST', `/v2/checkout/orders/${orderId}/confirm-payment-source`, { payment_source: { card: SANDBOX_TEST_CARD } }, requestId);
    return { status: raw.status as string, raw };
  }

  async getOrder(orderId: string): Promise<any> {
    return this.request<any>('GET', `/v2/checkout/orders/${orderId}`);
  }

  async captureOrder(orderId: string, requestId: string): Promise<CapturedOrder> {
    const raw = await this.request<any>('POST', `/v2/checkout/orders/${orderId}/capture`, {}, requestId);
    return parseCapturedOrder(raw);
  }

  async refundCapture(opts: { captureId: string; amount: number; requestId: string; note: string; invoiceId: string }): Promise<RefundResult> {
    const raw = await this.request<any>(
      'POST',
      `/v2/payments/captures/${opts.captureId}/refund`,
      { amount: usd(opts.amount), note_to_payer: opts.note.slice(0, 255), invoice_id: opts.invoiceId },
      opts.requestId,
    );
    return { refundId: raw.id, status: raw.status, raw };
  }

  // Merchant id of the account behind these credentials: PayPal fills in the
  // payee of a new order. The order is never approved or captured and expires.
  async merchantId(): Promise<string> {
    const created = await this.request<any>('POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ amount: usd(1), description: 'Vouch: merchant id lookup (never captured)' }] });
    const order = await this.request<any>('GET', `/v2/checkout/orders/${created.id}`);
    const id = order.purchase_units?.[0]?.payee?.merchant_id;
    if (!id) throw new UpstreamError({ upstream: 'paypal', endpoint: `GET /v2/checkout/orders/${created.id}`, status: 200, body: order, message: 'PayPal order has no payee merchant_id' });
    return id;
  }

  getCapture(captureId: string) {
    return this.request<any>('GET', `/v2/payments/captures/${captureId}`);
  }

  async verifyWebhook(opts: { webhookId: string; headers: Record<string, string | undefined>; event: unknown }): Promise<boolean> {
    const h = (k: string) => opts.headers[k] ?? opts.headers[k.toLowerCase()];
    const raw = await this.request<{ verification_status: string }>('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: opts.webhookId,
      webhook_event: opts.event,
    });
    return raw.verification_status === 'SUCCESS';
  }
}

export function parseCapturedOrder(raw: any): CapturedOrder {
  const cap = raw.purchase_units?.[0]?.payments?.captures?.[0];
  if (!cap) {
    throw new UpstreamError({ upstream: 'paypal', endpoint: 'order capture', status: 200, body: raw, message: `PayPal order ${raw.id} has no capture (status ${raw.status})` });
  }
  return {
    orderId: raw.id,
    status: raw.status,
    captureId: cap.id,
    captureStatus: cap.status,
    amount: cap.amount,
    payee: raw.purchase_units?.[0]?.payee?.email_address ?? null,
    payeeMerchantId: raw.purchase_units?.[0]?.payee?.merchant_id ?? null,
    paypalFee: cap.seller_receivable_breakdown?.paypal_fee ?? null,
    raw,
  };
}

function redactCard(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body ?? null;
  const s = JSON.stringify(body);
  return JSON.parse(s.replace(/"number":"\d+"/g, '"number":"****"').replace(/"security_code":"\d+"/g, '"security_code":"***"'));
}
