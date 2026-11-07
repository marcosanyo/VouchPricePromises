// The two small experiments behind "the promise beats a discount only where it should":
// what the buyer's agent picks (with and without Vouch's estimate), and what a store sells
// when a rival takes 3% off. Read-only views of server/experiments/*.json.
import { api } from '../api';
import { ErrorBox } from './ErrorBox';
import { useAsync } from '../useAsync';
import { useT } from '../i18n';

interface DvpSide { runs: number; promise: number; discount: number; wait: number }
interface Dvp { model: string; design: { window_days: number; discount: number }; results: { likely: DvpSide; unlikely: DvpSide } }
export function WhenPromiseWins() {
  const t = useT();
  const withView = useAsync(() => api.get<Dvp>('/api/experiments/discount-vs-promise-app-view'), []);
  const without = useAsync(() => api.get<Dvp>('/api/experiments/discount-vs-promise'), []);
  const err = withView.error ?? without.error;
  const a = withView.data;
  const b = without.data;
  const cell = (s: DvpSide) => {
    const win = s.promise >= s.discount ? 'promise' : 'discount';
    return <b className={win === 'promise' ? 'good-text' : ''}>{win === 'promise' ? t(`promise ${s.promise}/${s.runs}`, `約束 ${s.promise}/${s.runs}`) : t(`3% off ${s.discount}/${s.runs}`, `3%値下げ ${s.discount}/${s.runs}`)}</b>;
  };
  return (
    <div className="card demo-card">
      <b>{t('When does the promise win?', '約束が勝つのはいつ？')}</b>
      <ErrorBox error={err} />
      {a && b && (
        <>
          <table className="plain">
            <thead><tr><th></th><th>{t('Price likely to drop (68–89%)', '下がりそうな日（68〜89%）')}</th><th>{t('Unlikely (about 3%)', '下がらなそうな日（約3%）')}</th></tr></thead>
            <tbody>
              <tr><td>{t('Agent sees Vouch’s estimate', 'エージェントが Vouch の見積もりを見る')}</td><td>{cell(a.results.likely)}</td><td>{cell(a.results.unlikely)}</td></tr>
              <tr><td>{t('Without the estimate', '見積もりなし')}</td><td>{cell(b.results.likely)}</td><td>{cell(b.results.unlikely)}</td></tr>
            </tbody>
          </table>
          <div className="small muted">{t(
            `Agent: ${a.model}, ${a.design.window_days}-day window. Choice between the verified promise and a ${Math.round(a.design.discount * 100)}% discount, same list price, real days. With Vouch’s estimate the agent pays for the promise exactly when a drop is likely and takes the discount when it is not; without it, it takes the promise even when the drop is unlikely. Small sample; files: server/experiments/discount-vs-promise*.json.`,
            `エージェント: ${a.model}、${a.design.window_days}日間。同じ定価で、確認できる約束と${Math.round(a.design.discount * 100)}%値引きのどちらを選ぶか（実際の日）。Vouch の見積もりがあると、下がりそうな日だけ約束を選び、下がらなそうな日は値引きを選ぶ。見積もりがないと、下がらなそうな日にも約束を選ぶ。標本は小さい。ファイル: server/experiments/discount-vs-promise*.json。`,
          )}</div>
        </>
      )}
    </div>
  );
}

// "What should the store do?": recorded runs where a rival always takes 3% off and your store keeps
// its price, matches the discount, or gives the verified promise (server/src/jobs/store-strategy.ts).
// Revenue is after the refund on the real later prices. Read-only; every number is from the file.
interface SsCell { runs: number; won: number; rival: number; wait: number; revenue_share_of_list: number }
type SsBand = Record<'list' | 'match' | 'promise', SsCell>;
interface Ss { model: string; design: { window_days: number; rival_discount: number; samples_per_cell: number }; results: Record<'low' | 'mid' | 'high', SsBand>; scenarios: { band: string; p_drop: number }[] }
export function StoreStrategy() {
  const t = useT();
  const r = useAsync(() => api.get<Ss>('/api/experiments/store-strategy'), []);
  const d = r.data;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const range = (band: string) => {
    const ps = (d?.scenarios ?? []).filter((s) => s.band === band).map((s) => s.p_drop);
    return ps.length ? `${pct(Math.min(...ps))}–${pct(Math.max(...ps))}` : '';
  };
  const cell = (c: SsCell) => (
    <>
      <b className={c.won ? 'good-text' : ''}>{t(`sold ${c.won}/${c.runs}`, `売れた ${c.won}/${c.runs}`)}</b>
      <div className="small muted">{c.won ? t(`kept ${pct(c.revenue_share_of_list)} of list per buyer`, `買い手1人あたり定価の ${pct(c.revenue_share_of_list)}`) : c.wait ? t(`agent waited ${c.wait}`, `エージェントが待った ${c.wait}`) : t('rival sold', '競合が売った')}</div>
    </>
  );
  const rows: ['list' | 'match' | 'promise', string, string][] = [
    ['list', 'Keep the price, no promise', '定価のまま・約束なし'],
    ['match', 'Match the 3% discount', '3%値下げで合わせる'],
    ['promise', 'Keep the price + verified promise', '定価のまま＋確認できる約束'],
  ];
  return (
    <div className="card demo-card">
      <b>{t('What should your store do when a rival takes 3% off?', '競合が3%値下げするとき、あなたの店はどうする？')}</b>
      <ErrorBox error={r.error} />
      {d && (
        <>
          <table className="plain">
            <thead><tr><th></th>{(['low', 'mid', 'high'] as const).map((b) => <th key={b}>{t({ low: 'Drop unlikely', mid: 'Drop possible', high: 'Drop likely' }[b], { low: '下がらなそう', mid: '下がるかも', high: '下がりそう' }[b])} ({range(b)})</th>)}</tr></thead>
            <tbody>
              {rows.map(([k, en, ja]) => <tr key={k}><td>{t(en, ja)}</td>{(['low', 'mid', 'high'] as const).map((b) => <td key={b}>{cell(d.results[b][k])}</td>)}</tr>)}
            </tbody>
          </table>
          <div className="small muted">{t(
            `Agent: ${d.model}, the buyer app’s view, ${d.design.window_days}-day window, real past days and real later prices (revenue after the refund). Where a drop is possible, matching the discount does not sell: the agent waits. The promise sells and keeps most of the price. Where a drop is unlikely, the promise does not win. Assumed: same list price at both stores. Small sample (2 days per column, ${d.design.samples_per_cell} runs each); a buyer who waits may still buy later. File: server/experiments/store-strategy.json.`,
            `エージェント: ${d.model}、買い手アプリと同じ見え方、${d.design.window_days}日間、実際の過去の日とその後の実際の価格（売上は返金後）。下がるかもしれない日は、値下げで合わせても売れない（エージェントは待つ）。約束なら売れて、価格の大半が残る。下がらなそうな日は、約束は勝たない。仮定: 両店とも同じ定価。標本は小さい（各列2日、各${d.design.samples_per_cell}回）。待った買い手が後で買う可能性はある。ファイル: server/experiments/store-strategy.json。`,
          )}</div>
        </>
      )}
    </div>
  );
}

