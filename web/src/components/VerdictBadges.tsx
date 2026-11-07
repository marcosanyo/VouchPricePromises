// When real prices answer: live contracts by verdict day, and the batch of
// pre-registered price-drop predictions. Pending until the day passes; the
// badges fill in from the ledger and predictions APIs as the daily job judges.
import { api, usd } from '../api';
import { useAsync } from '../useAsync';
import { useT } from '../i18n';
import { shortDay } from '../viz';

interface Contract { status: 'open' | 'hit' | 'miss'; claim_type: string; payout_usd: number | null; terms: { judge_after_day: string } }
interface Batch { batch_id: string; n: number; expected: number; resolved: number; dropped: number | null; horizon_end: string }

const CLAIM: Record<string, [string, string]> = { lowest_price: ['lowest price', '最安値'], no_price_drop: ['no price drop', '値下がりしない'], genuine_sale: ['genuine sale', '本物のセール'], in_stock: ['in stock', '在庫あり'] };

export function VerdictBadges() {
  const t = useT();
  const ledger = useAsync(() => api.get<{ contracts: Contract[] }>('/api/ledger?limit=1'), []);
  const preds = useAsync(() => api.get<Batch[]>('/api/predictions'), []);
  const today = new Date().toISOString().slice(0, 10);
  const byDay = new Map<string, Contract[]>();
  for (const c of ledger.data?.contracts ?? []) {
    if (c.terms.judge_after_day < today && c.status !== 'open') continue; // already shown as settled elsewhere
    byDay.set(c.terms.judge_after_day, [...(byDay.get(c.terms.judge_after_day) ?? []), c]);
  }
  const days = [...byDay.keys()].sort();
  const batch = preds.data?.[0];
  if (!days.length && !batch) return null;
  return (
    <div className="verdicts">
      <div className="small" style={{ fontWeight: 600 }}>{t('When real prices answer', '実際の価格が答えを出す日')}</div>
      <div className="verdict-row">
        {days.map((d) => {
          const cs = byDay.get(d)!;
          const open = cs.filter((c) => c.status === 'open').length;
          const missed = cs.filter((c) => c.status === 'miss');
          const kinds = [...new Set(cs.map((c) => c.claim_type))].map((k) => t(...(CLAIM[k] ?? [k, k]))).join(' · ');
          const state = open ? 'pending' : missed.length ? 'miss' : 'hit';
          return (
            <div key={d} className={`verdict ${state}`}>
              <div className="verdict-day">{shortDay(d)}</div>
              <div className="small">{t(`${cs.length} live contract${cs.length === 1 ? '' : 's'}`, `ライブ契約 ${cs.length} 件`)} · {kinds}</div>
              <div className="small verdict-state">
                {state === 'pending'
                  ? t('pending', '判定待ち')
                  : state === 'miss'
                    ? t(`${missed.length} missed · ${usd(missed.reduce((s, c) => s + (c.payout_usd ?? 0), 0))} refunded`, `${missed.length} 件外れ · ${usd(missed.reduce((s, c) => s + (c.payout_usd ?? 0), 0))} 返金`)
                    : t('all held', 'すべて当たり')}
              </div>
            </div>
          );
        })}
        {batch && (
          <div className={`verdict ${batch.resolved < batch.n ? 'pending' : 'hit'}`}>
            <div className="verdict-day">{shortDay(batch.horizon_end)}</div>
            <div className="small">{t(`${batch.n} pre-registered predictions · expected drops ${batch.expected.toFixed(1)}`, `事前登録の予測 ${batch.n} 件 · 値下がりの見込み ${batch.expected.toFixed(1)} 件`)}</div>
            <div className="small verdict-state">
              {batch.resolved === 0 ? t('pending', '答え待ち') : t(`${batch.dropped ?? 0} of ${batch.resolved} dropped`, `${batch.resolved} 件中 ${batch.dropped ?? 0} 件が値下がり`)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
