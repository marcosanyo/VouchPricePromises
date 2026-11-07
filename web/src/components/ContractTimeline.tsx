// Live contracts on a time axis: each bar runs from purchase to the day the
// claim can be judged; "today" is a vertical line. Judged contracts end in a
// status label (held / missed + refund). Status colours always come with text.
import { usd } from '../api';
import { INK, shortDay, STATUS } from '../viz';
import { useT } from '../i18n';

export interface LiveContract {
  id: string; store: string; claim_type: string; status: 'open' | 'hit' | 'miss';
  terms: { purchase_day: string; judge_after_day: string; stake_usd: number; purchase_price: number };
  payout_usd: number | null; paypal_refund_id: string | null;
  paypal_seller: { slot: number; merchant: string | null; shared: boolean } | null;
}

export type PayPalSellerRef = LiveContract['paypal_seller'];

// "PayPal seller …ABCD (own account)" / "(shared demo account)".
export function sellerText(s: PayPalSellerRef | undefined, t: ReturnType<typeof useT>): string {
  if (!s) return '—';
  return t(`PayPal seller ${s.merchant ?? '?'} (${s.shared ? 'shared demo account' : 'own account'})`, `PayPal の売り手 ${s.merchant ?? '?'}（${s.shared ? '共用のデモ用アカウント' : '店専用のアカウント'}）`);
}

const CLAIM_SHORT: Record<string, [string, string]> = { lowest_price: ['Lowest price', '最安値'], no_price_drop: ['No price drop', '値下がりしない'], genuine_sale: ['Genuine sale', '本物のセール'], in_stock: ['In stock', '在庫あり'] };
const dayNum = (d: string) => Date.parse(d + 'T00:00:00Z') / 86_400_000;

export function ContractTimeline({ contracts, today }: { contracts: LiveContract[]; today: string }) {
  const t = useT();
  if (contracts.length === 0) return <p className="muted">{t('No live contracts yet.', 'ライブの契約はまだない。')}</p>;
  const rows = [...contracts].sort((a, b) => a.terms.judge_after_day.localeCompare(b.terms.judge_after_day) || a.store.localeCompare(b.store));
  const start = Math.min(...rows.map((r) => dayNum(r.terms.purchase_day))) - 1;
  const end = Math.max(...rows.map((r) => dayNum(r.terms.judge_after_day)), dayNum(today)) + 2;
  const W = 1340, L = 330, R = 210, ROW = 30, T = 26;
  const H = T + rows.length * ROW + 24;
  const x = (d: number) => L + ((d - start) / (end - start)) * (W - L - R);
  const ticks: number[] = [];
  for (let d = Math.ceil(start); d <= end; d += 3) ticks.push(d);
  const iso = (d: number) => new Date(d * 86_400_000).toISOString().slice(0, 10);
  const open = rows.filter((r) => r.status === 'open').length;
  const next = rows.filter((r) => r.status === 'open').map((r) => r.terms.judge_after_day).sort()[0];
  const daysLeft = next ? Math.max(0, dayNum(next) - dayNum(today)) : null;

  return (
    <div>
      <div className="player-kpis" style={{ marginBottom: 12 }}>
        <div><div className="v">{rows.length}</div><div className="l">{t('live contracts on PayPal Sandbox', 'PayPal Sandbox のライブ契約')}</div></div>
        <div><div className="v">{open}</div><div className="l">{t('waiting for real prices to decide', '実際の価格による判定待ち')}</div></div>
        <div><div className="v">{daysLeft == null ? '—' : t(`${daysLeft} days`, `あと ${daysLeft} 日`)}</div><div className="l">{next ? t(`until the next verdict (${shortDay(next)})`, `次の判定まで（${shortDay(next)}）`) : t('all judged', 'すべて判定済み')}</div></div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Live contracts from purchase to verdict">
        {ticks.map((d) => (
          <g key={d}>
            <line x1={x(d)} x2={x(d)} y1={T - 6} y2={H - 6} stroke={INK.grid} />
            <text x={x(d)} y={14} textAnchor="middle" fontSize={11} fill={INK.muted}>{shortDay(iso(d))}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const y = T + i * ROW;
          const x0 = x(dayNum(r.terms.purchase_day));
          const x1 = x(dayNum(r.terms.judge_after_day));
          const color = r.status === 'hit' ? STATUS.good : r.status === 'miss' ? STATUS.critical : '#0070e0';
          return (
            <g key={r.id}>
              <text x={8} y={y + 18} fontSize={12} fill={INK.primary} fontWeight={600}>{r.store}</text>
              <text x={100} y={y + 18} fontSize={12} fill={INK.secondary}>{CLAIM_SHORT[r.claim_type] ? t(CLAIM_SHORT[r.claim_type][0], CLAIM_SHORT[r.claim_type][1]) : r.claim_type} · {t('up to', '上限')} {usd(r.terms.stake_usd)}</text>
              <rect x={x0} y={y + 7} width={Math.max(4, x1 - x0)} height={14} rx={4} fill={color} fillOpacity={r.status === 'open' ? 0.25 : 0.9} stroke={color} />
              <circle cx={x0} cy={y + 14} r={4} fill="#fff" stroke={color} strokeWidth={2} />
              <text x={Math.max(x1, x0 + 4) + 10} y={y + 18} fontSize={12} fontWeight={600} fill={r.status === 'open' ? INK.secondary : color}>
                {r.status === 'open' ? t(`judged after ${shortDay(r.terms.judge_after_day)}`, `${shortDay(r.terms.judge_after_day)} 以降に判定`) : r.status === 'hit' ? t('✓ held', '✓ 当たり') : t(`✕ missed · ${usd(r.payout_usd)} refunded${r.paypal_seller?.merchant ? ` by PayPal seller ${r.paypal_seller.merchant}` : ''}`, `✕ 外れ · ${usd(r.payout_usd)} を${r.paypal_seller?.merchant ? `売り手 ${r.paypal_seller.merchant} の PayPal から` : ''}返金`)}
              </text>
              <title>{`${r.id} · ${r.store} · ${r.claim_type} · bought ${r.terms.purchase_day} at ${usd(r.terms.purchase_price)}`}</title>
            </g>
          );
        })}
        <line x1={x(dayNum(today))} x2={x(dayNum(today))} y1={T - 6} y2={H - 16} stroke={INK.primary} strokeWidth={1.5} />
        <text x={x(dayNum(today))} y={H - 3} textAnchor="middle" fontSize={11} fontWeight={700} fill={INK.primary}>{t('today', '今日')}</text>
      </svg>
      <div className="race-legend small" style={{ marginTop: 6 }}>
        <span><span className="sw" style={{ background: '#0070e0', opacity: 0.4 }} />{t('Waiting for verdict', '判定待ち')}</span>
        <span><span className="sw" style={{ background: STATUS.good }} />{t('Claim held', '主張が当たった')}</span>
        <span><span className="sw" style={{ background: STATUS.critical }} />{t('Claim missed → automatic PayPal refund', '主張が外れた → PayPal で自動返金')}</span>
      </div>
    </div>
  );
}
