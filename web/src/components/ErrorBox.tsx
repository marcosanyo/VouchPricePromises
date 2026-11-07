import { ApiError } from '../api';
import { Icon } from './Icon';

// Shows upstream failures as they are (zero-fallback policy): a badge with the
// service and HTTP status on top, the message, and the raw response collapsed
// below. Accepts an ApiError from our API, or a recorded upstream error object
// (task events, refund attempts) with upstream / status / message / body.
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const api = error instanceof ApiError ? error : null;
  const b: any = api ? api.body : typeof error === 'object' ? error : { message: String(error) };
  const upstream: string | undefined = b?.upstream;
  const status: number | null | undefined = b?.status ?? (api && !upstream ? api.status : undefined);
  const message: string = api ? api.message : b?.message ?? 'Error';
  const raw = b?.body ?? (api ? api.body : b);
  return (
    <div className="error" role="alert">
      <div className="error-badges">
        <span className="ebadge"><Icon name="alert" size={14} /> {upstream ?? (api ? 'Vouch API' : 'error')}</span>
        {status != null && <span className="ebadge">HTTP {status}</span>}
        {b?.endpoint && <span className="ebadge mono">{b.endpoint}</span>}
        {b?.requestId && <span className="ebadge mono">id {b.requestId}</span>}
      </div>
      <div className="mono small">{message}</div>
      {(raw || b?.trace) && (
        <details>
          <summary className="small">Raw response</summary>
          {b?.trace && <pre className="mono small">{b.trace.join('\n')}</pre>}
          {raw && <pre className="mono small">{JSON.stringify(raw, null, 2)}</pre>}
        </details>
      )}
    </div>
  );
}
