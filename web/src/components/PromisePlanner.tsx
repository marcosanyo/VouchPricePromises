// Promise planner: a no-price-drop promise is a discount you pay only if you actually cut.
// Numbers: server/experiments/promise-vs-discount.json (real Channel3 prices, ordinary period);
// markdown and chance of cutting are the owner's inputs; the 20% gross margin is an assumption.
// The trust chart reads server/experiments/agent-wait-trust-v2-gemini.json, expected shape
// { results: { none|words|self_auto|vouch: { runs, wait, buy, buy_from_promising_store } } } (jobs/agent-wait-experiment.ts --trust); a missing file is shown as "not run yet".
import { useState } from 'react';
import { api, usd } from '../api';
import { useAsync } from '../useAsync';
import { useT } from '../i18n';
import { ErrorBox } from './ErrorBox';

interface Measured { window_days: number; listings: number; store_days: number; drop_rate: number; expected_refund_share_of_price: number }
interface Plan { data_days: { from: string; to: string }; measured: Measured[]; gross_margin_assumed: number }
interface Arm { runs: number; wait: number; buy: number; buy_from_promising_store: number }
interface Trust { model: string; results: { none: Arm; words: Arm; self_auto: Arm; vouch: Arm } }

const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const CHANCES = [0, 0.25, 0.5, 1];

export function PromisePlanner({ price }: { price: number }) {
  const t = useT();
  const plan = useAsync(() => api.get<Plan>('/api/experiments/promise-vs-discount'), []);
  const trust = useAsync(() => api.get<Trust>('/api/experiments/agent-wait-trust-v2-gemini'), []);
  const [k, setK] = useState(0.2);
  const [q, setQ] = useState(0.5);
  if (plan.error) return <ErrorBox error={plan.error} />;
  const m = plan.data?.measured.find((x) => x.window_days === 14);
  if (!plan.data || !m) return null;
  const gm = plan.data.gross_margin_assumed;
  const cutNow = k * price;
  const promise = q * k * price + (1 - q) * m.expected_refund_share_of_price * price;
  const scale = Math.max(cutNow, promise, 0.01);
  const bars = [
    { label: t('Cut the price now', '今すぐ値下げ'), cost: cutNow, kind: 'discount' },
    { label: t('Promise instead', '約束にする'), cost: promise, kind: 'promise' },
  ];
  const left = (c: number) => gm * price - c;
  // The trust experiment may not be run yet: only that 404 is shown as a note, other errors stay visible.
  const notRun = !!trust.error && /has not been run yet/.test(String((trust.error as any)?.message ?? trust.error));
  const arms = trust.data && [
    { label: t('No promise', '約束なし'), a: trust.data.results.none },
    { label: t("Store's words", '店の言葉だけ'), a: trust.data.results.words },
    { label: t("Store's auto-refund claim", '店の自動返金の主張'), a: trust.data.results.self_auto },
    { label: t('Verifiable promise (Vouch)', '確かめられる約束（Vouch）'), a: trust.data.results.vouch },
  ];
  return (
    <div className="card promise-cost" style={{ display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 700 }}>{t('Promise planner', '約束プランナー')} <span className="muted small">{usd(price)}</span></div>
      <div className="row" style={{ gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field" style={{ minWidth: 200 }}>
          {t('Planned markdown', '予定している値下げ幅')}: <b>{pct(k, 0)}</b>
          <input type="range" min={0} max={0.4} step={0.01} value={k} onChange={(e) => setK(Number(e.target.value))} />
        </label>
        <div className="field">
          {t('Chance you actually cut before the window ends', '期間内に実際に値下げする確率')}
          <div className="row" style={{ gap: 6 }}>
            {CHANCES.map((c) => (
              <button key={c} className={q === c ? 'primary' : ''} aria-pressed={q === c} onClick={() => setQ(c)}>{pct(c, 0)}</button>
            ))}
          </div>
        </div>
      </div>
      {bars.map((x) => (
        <div key={x.kind} className="pc-row" style={{ gridTemplateColumns: 'minmax(0,1.2fr) minmax(60px,2fr) minmax(0,1.3fr)' }}>
          <span className="small">{x.label}</span>
          <span className="pc-bar"><span className={`pc-fill ${x.kind}`} style={{ width: `${(x.cost / scale) * 100}%` }} /></span>
          <span className="small"><b>{usd(x.cost)}</b> {t('per unit', '1個あたり')} · {t('margin left', '残る利益')} <b>{usd(left(x.cost))}</b></span>
        </div>
      ))}
      <div className="muted tiny">{t(
        `Margin assumes a ${pct(gm, 0)} gross margin (an assumption). Promise cost = chance × markdown × price + (1 − chance) × ordinary-period expected refund.`,
        `利益は粗利 ${pct(gm, 0)} と仮定（仮定値）。約束の費用 = 確率 × 値下げ幅 × 価格 + (1 − 確率) × 通常期の返金の期待値。`,
      )}</div>
      <div className="small">{t(
        `In real Channel3 prices (ordinary period, no Black Friday), a store's own price fell within ${m.window_days} days on ${pct(m.drop_rate)} of days; the promise's expected refund was ${pct(m.expected_refund_share_of_price)} of the price.`,
        `Channel3 の実際の価格（通常期、ブラックフライデーなし）では、店自身の価格が ${m.window_days} 日以内に下がった日は ${pct(m.drop_rate)}。約束の返金の期待値は価格の ${pct(m.expected_refund_share_of_price)}。`,
      )} <span className="muted tiny">{plan.data.data_days.from} – {plan.data.data_days.to}, n = {m.store_days}</span></div>
      <div>
        <div className="small" style={{ fontWeight: 600 }}>{t('Share of runs where the shopping agent bought now', '買い物エージェントが今買った回の割合')}</div>
        {notRun && <div className="muted small">{t('Experiment not run yet', '実験はまだ実行していません')}</div>}
        {!notRun && <ErrorBox error={trust.error} />}
        {arms?.map((x) => (
          <div key={x.label} className="pc-row" style={{ gridTemplateColumns: 'minmax(0,1.2fr) minmax(60px,2fr) minmax(0,1fr)' }}>
            <span className="small">{x.label}</span>
            <span className="pc-bar"><span className="pc-fill promise" style={{ width: `${(x.a.buy / x.a.runs) * 100}%`, background: 'var(--accent)' }} /></span>
            <span className="small"><b>{pct(x.a.buy / x.a.runs, 0)}</b> <span className="muted tiny">n = {x.a.runs}</span></span>
          </div>
        ))}
      </div>
      <div style={{ fontWeight: 600 }}>{t('A promise is a discount you pay only if you actually cut.', '約束は、実際に値下げしたときだけ払う値引き。')}</div>
    </div>
  );
}
