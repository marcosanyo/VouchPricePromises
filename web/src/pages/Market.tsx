import { useEffect, useMemo, useState } from 'react';
import { api, enc, pct, usd } from '../api';
import { AgentChoice } from '../components/AgentChoice';
import { ErrorBox } from '../components/ErrorBox';
import { ReplayPlayer, type ReplayResult } from '../components/ReplayPlayer';
import { useAsync } from '../useAsync';
import { useT } from '../i18n';
import { VerifyBadge } from '../components/VerifyBadge';
import { FalseClaimDemo } from '../components/FalseClaimDemo';

interface Group { group_key: string; title: string; stores: number; days: number; min_price: number; max_price: number; held_out: boolean; featured: boolean }
type ReplayClaim = 'lowest_price' | 'no_price_drop' | 'genuine_sale';
type ClaimRow = { store: string; claim_type: ReplayClaim; stake_usd: number };
const REPLAY_CLAIMS: ReplayClaim[] = ['lowest_price', 'no_price_drop', 'genuine_sale'];
const SHORT: Record<ReplayClaim, [string, string]> = { lowest_price: ['Lowest price', '最安値'], no_price_drop: ['No drop 14d', '14日値下がりなし'], genuine_sale: ['Genuine sale', '本物のセール'] };


export function Market() {
  const t = useT();
  const groups = useAsync(() => api.get<Group[]>('/api/groups'), []);
  const [groupKey, setGroupKey] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('group') ?? '');
  useEffect(() => {
    if (!groupKey && groups.data) setGroupKey(groups.data.find((g) => g.featured)?.group_key ?? groups.data[0]?.group_key ?? '');
  }, [groups.data, groupKey]);
  const [buyers, setBuyers] = useState(10);
  const [weight, setWeight] = useState(1);
  const [tau, setTau] = useState(5);
  const [stake, setStake] = useState(10);
  const [claims, setClaims] = useState<ClaimRow[] | null>(null); // null = default scenario
  const [result, setResult] = useState<ReplayResult>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  const run = async (override?: ClaimRow[] | null) => {
    setBusy(true);
    setError(undefined);
    try {
      const c = override === undefined ? claims : override;
      const r = await api.post<ReplayResult>('/api/replay', { group_key: groupKey, buyers_per_day: buyers, weight, tau_usd: tau, default_stake_usd: stake, ...(c ? { claims: c } : {}) });
      setResult(r);
      if (!c) setClaims(r.stores.flatMap((s) => s.claims.map((x) => ({ store: s.store, claim_type: x.claim_type as ReplayClaim, stake_usd: x.stake_usd }))));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!groupKey) return;
    setClaims(null);
    setResult(undefined);
    run(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey]);

  const has = (store: string, t: ReplayClaim) => claims?.some((c) => c.store === store && c.claim_type === t) ?? false;
  const toggle = (store: string, t: ReplayClaim) => {
    const cur = claims ?? [];
    setClaims(has(store, t) ? cur.filter((c) => !(c.store === store && c.claim_type === t)) : [...cur, { store, claim_type: t, stake_usd: stake }]);
  };
  // "Make this store say lowest price": only this store claims it, then replay.
  const forceLowest = (store: string) => {
    const next = [...(claims ?? []).filter((c) => c.claim_type !== 'lowest_price'), { store, claim_type: 'lowest_price' as const, stake_usd: stake }];
    setClaims(next);
    run(next);
  };

  const group = groups.data?.find((g) => g.group_key === groupKey);
  const totals = useMemo(() => result?.totals.slice().sort((a, b) => b.last_week_share - a.last_week_share), [result]);
  const stores = useMemo(() => result?.stores.map((s) => s.store) ?? [], [result]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Honest stores win the agent’s purchases', '正直な店が、エージェントの購入を勝ち取る')}</h1>
          <p className="lead">{t('30 days of real prices for one product at several stores. Every store stakes the same claims; the data decides who was wrong.', '1つの商品を売る複数の店の、30日分の実際の価格。どの店も同じ主張に保証を付け、誰が間違っていたかはデータが決める。')}</p>
        </div>
        <label className="field">
          {t('Product', '商品')}
          <select value={groupKey} onChange={(e) => setGroupKey(e.target.value)} style={{ minWidth: 300 }}>
            {groups.data?.map((g) => (
              <option key={g.group_key} value={g.group_key}>{g.title} · {t(`${g.stores} stores`, `${g.stores} 店`)}{g.held_out ? t(' · not in training', ' · 学習に未使用') : ''}</option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBox error={groups.error ?? error} />

      <div className="card">
        {result ? <ReplayPlayer result={result} /> : <div className="muted">{busy ? t('Replaying real price history…', '実際の価格履歴を再生しています…') : ''}</div>}
        {result && <div style={{ marginTop: 12 }}><VerifyBadge productIds={result.stores.map((s) => s.product_id)} /></div>}
      </div>

      {groupKey && (
        <div className="card">
          <h2>{t('Try it: catch a false claim, get refunded', '試す: 嘘の主張を暴いて、返金を受ける')}</h2>
          <FalseClaimDemo groupKey={groupKey} />
        </div>
      )}

      {result && (
        <>
          <div className="card">
            <h2>{t('Why the agent picks a store today', '今日、エージェントがその店を選ぶ理由')}</h2>
            <AgentChoice groupKey={groupKey} stores={stores} />
          </div>

          <details className="card">
            <summary><b>{t('Change the scenario', '条件を変える')}</b> <span className="muted small">{t('who stakes what, how buyers choose — then replay', 'どの店が何を保証するか、買い手の選び方を変えて再生')}</span></summary>
            <div className="row" style={{ marginTop: 12 }}>
              <label className="field">{t('Buyers / day', '1日の買い手の数')}<input type="number" min={1} max={1000} value={buyers} onChange={(e) => setBuyers(Number(e.target.value))} /></label>
              <label className="field" title={t('How much the agent weighs unprotected expected loss against price', '守られていない見込み損失を、価格に対してどれだけ重く見るか')}>{t('Risk weight', 'リスクの重み')}<input type="number" step={0.5} min={0} max={10} value={weight} onChange={(e) => setWeight(Number(e.target.value))} /></label>
              <label className="field" title={t('Cost difference (USD) that changes choice odds by a factor of e', '選ばれやすさを e 倍変えるコストの差（ドル）')}>{t('Choice sensitivity τ ($)', '選択の感度 τ（$）')}<input type="number" min={0.5} step={0.5} value={tau} onChange={(e) => setTau(Number(e.target.value))} /></label>
              <label className="field">{t('Stake per claim ($)', '主張ごとの保証額（$）')}<input type="number" min={1} value={stake} onChange={(e) => setStake(Number(e.target.value))} /></label>
              <button className="primary" disabled={busy} onClick={() => run()}>{busy ? t('Replaying…', '再生中…') : t('Replay', '再生')}</button>
              <button disabled={busy} onClick={() => { setClaims(null); run(null); }}>{t('Reset', '元に戻す')}</button>
            </div>
            {result && (
              <table className="plain" style={{ marginTop: 12 }}>
                <thead>
                  <tr><th>{t('Store', '店')}</th>{REPLAY_CLAIMS.map((c) => <th key={c}>{t(SHORT[c][0], SHORT[c][1])}</th>)}<th>{t('Purchases', '購入')}</th><th>{t('Refunds', '返金')}</th><th>{t('Accuracy', '正確さ')}</th><th>{t('Share: week 1 → last', '割合: 最初の週 → 最後の週')}</th><th></th></tr>
                </thead>
                <tbody>
                  {totals?.map((row) => (
                    <tr key={row.store}>
                      <td><strong>{row.store}</strong></td>
                      {REPLAY_CLAIMS.map((c) => <td key={c}><input type="checkbox" checked={has(row.store, c)} onChange={() => toggle(row.store, c)} /></td>)}
                      <td>{row.orders}</td><td>{usd(row.payout_usd)}</td><td>{pct(row.accuracy, 0)}</td>
                      <td>{pct(row.first_week_share, 0)} → <b>{pct(row.last_week_share, 0)}</b></td>
                      <td><button className="link" onClick={() => forceLowest(row.store)}>{t('Only this store claims “lowest price”', 'この店だけが「最安値」と主張')}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {group && <p className="muted small">{t(`Price range ${usd(group.min_price)}–${usd(group.max_price)}.`, `価格の範囲 ${usd(group.min_price)}〜${usd(group.max_price)}。`)} {t(result?.disclaimer ?? '', '価格は Channel3 の実際の日次価格。保証は仮定で、これらの店は実際には保証していない。店名は匿名化。')}</p>}
          </details>


          {result.sample_ranking && (
            <details className="card">
              <summary><b>{t(`The agent's reasons on ${result.sample_ranking.day}`, `${result.sample_ranking.day} のエージェントの判断理由`)}</b></summary>
              <table className="plain" style={{ marginTop: 12 }}>
                <thead><tr><th>#</th><th>{t('Store', '店')}</th><th>{t('Price', '価格')}</th><th>{t('Effective cost', '実質コスト')}</th><th>{t('Reasons', '理由')}</th></tr></thead>
                <tbody>
                  {result.sample_ranking.ranking.map((r: any) => (
                    <tr key={r.product_id}>
                      <td>{r.rank}</td><td><strong>{r.store}</strong></td><td>{usd(r.price)}</td><td>{usd(r.effective_cost_usd)}</td>
                      <td><ul className="small" style={{ margin: 0, paddingLeft: 16 }}>{r.reasons.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small"><a href={`/api/groups/${enc(result.group_key)}`} target="_blank">{t('Raw price series (JSON)', '価格の生データ（JSON）')}</a></p>
            </details>
          )}
        </>
      )}
    </div>
  );
}
