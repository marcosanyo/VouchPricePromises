// API client. Errors keep the upstream service, HTTP status, message and
// request id so the UI can show them as they are (no fallback data).
export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { message: text };
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

export const api = {
  get: <T,>(p: string) => call<T>('GET', p),
  post: <T,>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}),
  put: <T,>(p: string, b: unknown) => call<T>('PUT', p, b),
};

export const enc = encodeURIComponent;
export const usd = (x: number | null | undefined) =>
  x == null ? '—' : `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const pct = (x: number | null | undefined, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);

export type ClaimType = 'lowest_price' | 'genuine_sale' | 'no_price_drop' | 'in_stock';
export const CLAIM_LABEL: Record<ClaimType, string> = {
  lowest_price: 'Lowest price (7 days)',
  genuine_sale: 'Genuine sale (≥10% below 30-day mean)',
  no_price_drop: 'No price drop (14 days)',
  in_stock: 'In stock at purchase',
};
