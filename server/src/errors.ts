// Upstream failures are surfaced as-is: service, HTTP status, message, and any
// request id the service returned. Nothing here substitutes data.

export type Upstream = 'channel3' | 'paypal' | 'vertex_ai';

export class UpstreamError extends Error {
  readonly upstream: Upstream;
  readonly status: number | null;
  readonly body: unknown;
  readonly requestId: string | null;
  readonly endpoint: string;

  constructor(opts: {
    upstream: Upstream;
    endpoint: string;
    status: number | null;
    body: unknown;
    requestId?: string | null;
    message?: string;
  }) {
    const detail = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    super(opts.message ?? `${opts.upstream} ${opts.endpoint} failed: HTTP ${opts.status ?? 'n/a'} ${detail?.slice(0, 500)}`);
    this.name = 'UpstreamError';
    this.upstream = opts.upstream;
    this.status = opts.status;
    this.body = opts.body;
    this.requestId = opts.requestId ?? null;
    this.endpoint = opts.endpoint;
  }

  toJSON() {
    return {
      error: 'upstream_error',
      upstream: this.upstream,
      endpoint: this.endpoint,
      status: this.status,
      requestId: this.requestId,
      message: this.message,
      body: this.body,
    };
  }
}

export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Retries are explicit: a fixed count, only for 429/5xx/network errors, each
// attempt logged. The final failure is thrown unchanged.
export async function withRetries<T>(
  label: string,
  attempts: number,
  fn: () => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const status = err instanceof UpstreamError ? err.status : null;
      const retryable = status === null || status === 429 || status >= 500;
      if (!retryable || i === attempts) throw err;
      const waitMs = 1000 * 2 ** (i - 1);
      console.warn(`[retry] ${label} attempt ${i}/${attempts} failed (HTTP ${status ?? 'network'}); retrying in ${waitMs}ms`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw last;
}
