// What a promise costs a store, measured on real Channel3 prices
// (server/src/jobs/price-match-cost.ts), next to a plain discount of the same size.
import { api } from '../api';
import { useAsync } from '../useAsync';
import { useT } from '../i18n';
import { ErrorBox } from './ErrorBox';

interface Cost {
  window_days: number;
  groups: number;
  data_days: { from: string; to: string };
  cheapest_store: { store_days: number; own_drop: { rate: number }; price_match: { rate: number }; capped: { cap: number; own_drop: number; price_match: number }[] };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function PromiseCost() {
  const t = useT();
  const r = useAsync(() => api.get<Cost>('/api/experiments/price-match-cost'), []);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return null;
  const c = r.data.cheapest_store;
  const ten = c.capped.find((x) => x.cap === 0.1)!;
  const rows = [
    { label: t('10% off every order', '全員に 10% 値引き'), v: 0.1, kind: 'discount' },
    { label: t(`price match, cap 10% (pays ${pct(c.price_match.rate)} of orders)`, `価格合わせ・上限10%（払うのは注文の ${pct(c.price_match.rate)}）`), v: ten.price_match, kind: 'promise' },
    { label: t(`no-drop promise, cap 10% (pays ${pct(c.own_drop.rate)} of orders)`, `値下がりの約束・上限10%（払うのは注文の ${pct(c.own_drop.rate)}）`), v: ten.own_drop, kind: 'promise' },
  ];
  return (
    <div className="promise-cost">
      <div className="small" style={{ fontWeight: 600 }}>{t('Cost to the store, as a share of the price (measured)', '店の費用（価格に対する割合、実測）')}</div>
      {rows.map((x) => (
        <div key={x.label} className="pc-row">
          <span className="pc-label small">{x.label}</span>
          <span className="pc-bar"><span className={`pc-fill ${x.kind}`} style={{ width: `${(x.v / 0.1) * 100}%` }} /></span>
          <b className="pc-v">{pct(x.v)}</b>
        </div>
      ))}
      <div className="muted tiny">
        {t(
          `Real Channel3 daily prices, ${r.data.groups} models sold at 2+ stores, ${c.store_days} store-days where the store was cheapest, ${r.data.window_days}-day window, ${r.data.data_days.from} to ${r.data.data_days.to}. Ordinary period: no Black Friday in the data. A store that plans a markdown inside the window pays in full, so these averages do not apply to it.`,
          `Channel3 の実際の日々の価格。2店以上で売られる ${r.data.groups} 型番、その日の最安だった ${c.store_days} 店日、期間 ${r.data.window_days} 日、${r.data.data_days.from}〜${r.data.data_days.to}。通常期でブラックフライデーを含まない。期間内に値下げを予定している店は全額払うので、この平均は当てはまらない。`,
        )}
      </div>
    </div>
  );
}
