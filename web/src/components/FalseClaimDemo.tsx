// One click for judges: a store stakes a claim the data already contradicts,
// the order is paid on PayPal Sandbox, judged on fresh Channel3 data, and the
// refund comes from that store's PayPal. Errors are shown as they are.
import { useState } from 'react';
import { api, usd } from '../api';
import { useAsync } from '../useAsync';
import { useT } from '../i18n';
import { ErrorBox } from './ErrorBox';

type DemoClaim = 'lowest_price' | 'genuine_sale';
interface Result {
  claim_type: DemoClaim;
  store: string;
  product: string;
  stake_usd: number;
  paid_usd: number;
  paypal: { order_id: string; capture_id: string; seller: { slot: number; merchant: string | null; shared: boolean } };
  contract: { id: string; hash: string; judge_after_day: string };
  verdict: { outcome: string; reason: string; payout_usd?: number; used?: any };
  refund: { ok: boolean; paypal_refund_id?: string; error?: unknown } | null;
  ledger: { demo_entry: { seq: number; hash: string }; entries: { seq: number; kind: string; hash: string }[] };
}

const short = (h: string) => `${h.slice(0, 12)}…`;

export function FalseClaimDemo({ groupKey }: { groupKey: string }) {
  const t = useT();
  const [claim, setClaim] = useState<DemoClaim>('lowest_price');
  const [r, setR] = useState<Result>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  const runs = useAsync(() => api.get<{ runs_today: number; daily_limit: number }>('/api/demo/false-claim'), [n]);
  const left = runs.data ? runs.data.daily_limit - runs.data.runs_today : null;

  const go = async () => {
    setBusy(true);
    setError(undefined);
    setR(undefined);
    try {
      setR(await api.post<Result>('/api/demo/false-claim', { claim_type: claim, group_key: groupKey }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setN((x) => x + 1);
    }
  };

  const used = r?.verdict.used;
  return (
    <div className="demo-claim">
      <div className="verify">
        <select value={claim} onChange={(e) => setClaim(e.target.value as DemoClaim)} disabled={busy}>
          <option value="lowest_price">{t('“Lowest price”', '「最安値」')}</option>
          <option value="genuine_sale">{t('“Genuine sale”', '「本物のセール」')}</option>
        </select>
        <button className="primary" disabled={busy || left === 0} onClick={go}>
          {busy ? t('Buying on PayPal Sandbox, judging…', 'PayPal Sandbox で購入し、判定中…') : t('Make a store say it — and catch it', 'この主張を店に言わせて、嘘を暴く')}
        </button>
        {left != null && <span className="muted small">{t(`${left} of ${runs.data!.daily_limit} runs left today (Sandbox)`, `今日はあと ${left} 回（上限 ${runs.data!.daily_limit} 回、Sandbox）`)}</span>}
      </div>
      <p className="muted small">
        {t(
          'Picks the store whose claim today’s Channel3 prices already contradict, pays for the item on PayPal Sandbox with that claim staked, then judges it by the ordinary contract rules.',
          '今日の Channel3 の価格で主張がすでに崩れている店を選び、その主張に保証を付けて PayPal Sandbox で購入し、通常の契約ルールで判定します。',
        )}
      </p>
      <ErrorBox error={error ?? runs.error} />
      {r && (
        <div className="demo-result">
          <div>
            <b>{r.store}</b> · {r.product} · {t('paid', '支払い')} {usd(r.paid_usd)} · {t('stake', '保証')} {usd(r.stake_usd)}
            <span className="muted small"> · PayPal {t('order', '注文')} <span className="mono">{r.paypal.order_id}</span> · {t('seller', '売り手')} {r.paypal.seller.slot} <span className="mono">{r.paypal.seller.merchant}</span>{r.paypal.seller.shared ? t(' (shared)', '（共用）') : ''}</span>
          </div>
          {used?.cheapest && (
            <div>{t('Evidence', '根拠')}: <b>{used.cheapest.store}</b> {usd(used.cheapest.price)} ({used.cheapest.day}) {t('vs paid', '対 支払い')} {usd(r.paid_usd)}</div>
          )}
          {used?.mean_prior != null && (
            <div>{t('Evidence', '根拠')}: {t(`${used.points.length}-day mean`, `${used.points.length} 日の平均`)} {usd(used.mean_prior)} → {t('sale needs ≤', 'セールなら')} {usd(used.threshold)}{t('', ' 以下')} · {t('paid', '支払い')} {usd(r.paid_usd)}</div>
          )}
          <div>
            <span className={`chip ${r.verdict.outcome === 'miss' ? 'chip-bad' : r.verdict.outcome === 'hit' ? 'chip-good' : 'chip-warn'}`}>{r.verdict.outcome}</span>{' '}
            {r.verdict.reason}
          </div>
          {r.refund?.ok && (
            <div>
              <span className="chip chip-good">{t(`Refunded ${usd(r.verdict.payout_usd)}`, `${usd(r.verdict.payout_usd)} を返金`)}</span>{' '}
              PayPal {t('refund', '返金')} <span className="mono">{r.refund.paypal_refund_id}</span> {t(`from seller ${r.paypal.seller.slot}’s PayPal`, `（売り手 ${r.paypal.seller.slot} の PayPal から）`)}
            </div>
          )}
          {r.refund && !r.refund.ok && (
            <div className="error" role="alert">
              <div className="error-title">{t('PayPal refund failed', 'PayPal の返金に失敗')}</div>
              <pre className="mono small">{JSON.stringify(r.refund.error, null, 2)}</pre>
            </div>
          )}
          {r.verdict.outcome === 'open' && <div className="muted small">{t(`Fresh data no longer contradicts the claim by the full stake; the contract stays open until ${r.contract.judge_after_day}.`, `取り直したデータでは保証額いっぱいの外れになっていないため、契約は ${r.contract.judge_after_day} まで判定待ちです。`)}</div>}
          <div className="muted small mono">
            {t('contract', '契約')} {r.contract.id} · hash {short(r.contract.hash)} · {t('ledger', '台帳')} {r.ledger.entries.map((e) => `#${e.seq} ${e.kind} ${short(e.hash)}`).join(' · ')}{' '}
            <a href="#/ledger">{t('open ledger', '台帳を開く')}</a>
          </div>
        </div>
      )}
    </div>
  );
}
