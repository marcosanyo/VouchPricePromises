// "Why the agent picks a store": each store's cost above the cheapest listing,
// split into the price gap and the expected loss the buyer is not protected
// against. Moving the stake slider for one store recomputes its expected loss
// with the same formula the server uses: P(fail) × max(0, harm − stake).
import { useEffect, useMemo, useState } from 'react';
import { api, enc, usd } from '../api';
import { useAsync } from '../useAsync';
import { colorMap, INK } from '../viz';
import { ErrorBox } from './ErrorBox';
import { useT } from '../i18n';

interface Risk { claim: string; p_fail: number; harm_usd: number; stake_usd: number; expected_loss_usd: number }
interface Row { product_id: string; store: string; price: number; risks: Risk[]; accuracy: number; hits: number; misses: number }

const ROW_H = 40;

export function AgentChoice({ groupKey, stores, initialStore }: { groupKey: string; stores: string[]; initialStore?: string }) {
  const t = useT();
  const ranking = useAsync(() => api.get<{ as_of_day: string; ranking: Row[] }>(`/api/groups/${enc(groupKey)}/ranking`), [groupKey]);
  const colors = useMemo(() => colorMap(stores), [stores]);
  const [store, setStore] = useState<string>();
  const [stake, setStake] = useState<number>(0);

  const rows = ranking.data?.ranking ?? [];
  useEffect(() => {
    // Start on the given store, else the cheapest: the one a stake would most likely make the pick.
    const start = rows.find((r) => r.store === initialStore) ?? [...rows].sort((a, b) => a.price - b.price)[0];
    if (start) {
      setStore(start.store);
      setStake(start.risks.find((r) => r.claim === 'no_price_drop')?.stake_usd ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ranking.data]);

  const sel = rows.find((r) => r.store === store);
  const harm = sel?.risks.find((r) => r.claim === 'no_price_drop')?.harm_usd ?? 0;
  const min = rows.length ? Math.min(...rows.map((r) => r.price)) : 0;
  const scored = rows
    .map((r) => {
      const risks = r.risks.map((k) => (r.store === store && k.claim === 'no_price_drop' ? { ...k, stake_usd: stake, expected_loss_usd: k.p_fail * Math.max(0, k.harm_usd - stake) } : k));
      const loss = risks.reduce((s, k) => s + k.expected_loss_usd, 0);
      return { ...r, gap: r.price - min, loss, total: r.price - min + loss };
    })
    .sort((a, b) => a.total - b.total || a.price - b.price);
  const maxTotal = Math.max(1, ...scored.slice(0, 6).map((r) => r.total));
  const shown = scored.slice(0, 6);
  const winner = shown[0];

  if (ranking.error) return <ErrorBox error={ranking.error} />;
  if (!ranking.data) return <div className="muted">{t("Loading today's ranking…", '今日の順位を読み込んでいます…')}</div>;

  return (
    <div className="choice">
      <div className="choice-ctrl">
        <label className="field">
          {t('Store', '店')}
          <select value={store} onChange={(e) => { const r = rows.find((x) => x.store === e.target.value); setStore(e.target.value); setStake(r?.risks.find((k) => k.claim === 'no_price_drop')?.stake_usd ?? 0); }}>
            {rows.map((r) => <option key={r.store} value={r.store}>{r.store} — {usd(r.price)}</option>)}
          </select>
        </label>
        <label className="field" style={{ flex: 1 }}>
          {t('Stake on “no price drop in 14 days”:', '「14日間値下がりしない」の保証額:')} <b style={{ color: INK.primary }}>{usd(stake)}</b>
          <input type="range" min={0} max={Math.max(100, Math.ceil(harm * 1.6))} step={1} value={stake} onChange={(e) => setStake(Number(e.target.value))} style={{ accentColor: 'var(--accent)' }} />
          <span className="muted small">{t(`Expected loss if it drops: ${usd(harm)}. Staking more than that changes nothing.`, `値下がりした場合の見込み損失: ${usd(harm)}。これを超えて保証しても何も変わらない。`)}</span>
        </label>
      </div>
      <div className="choice-bars" style={{ height: shown.length * ROW_H }}>
        {shown.map((r, i) => (
          <div key={r.store} className={`choice-row${r.store === store ? ' sel' : ''}`} style={{ transform: `translateY(${i * ROW_H}px)` }}>
            <div className="race-name">{i === 0 ? <span className="pick">{t("Agent's pick", 'エージェントの選択')}</span> : <span className="rank">#{i + 1}</span>}<span className="dot" style={{ background: colors.get(r.store) }} />{r.store}</div>
            <div className="choice-track">
              <div className="seg-gap" style={{ width: `${(r.gap / maxTotal) * 100}%` }} title={t(`Price above cheapest: ${usd(r.gap)}`, `最安との価格差: ${usd(r.gap)}`)} />
              <div className="seg-loss" style={{ width: `${(r.loss / maxTotal) * 100}%` }} title={t(`Unprotected expected loss: ${usd(r.loss)}`, `保護されない見込み損失: ${usd(r.loss)}`)} />
            </div>
            <div className="race-price"><b>+{usd(r.total)}</b></div>
          </div>
        ))}
      </div>
      <div className="race-legend small">
        <span><span className="sw" style={{ background: '#9aa4b2' }} />{t('Price above the cheapest listing', '最安の出品との価格差')}</span>
        <span><span className="sw" style={{ background: '#ec835a' }} />{t('Expected loss the buyer is not protected against', '買い手が守られていない見込み損失')}</span>
        <span className="muted">{t(`Real Channel3 prices as of ${ranking.data.as_of_day}. Stakes are hypothetical. No fees or ad spend enter the ranking.`, `${ranking.data.as_of_day} 時点の Channel3 の実際の価格。保証は仮定。手数料・広告費は順位に使っていない。`)}</span>
      </div>
      {winner && <p className="choice-say">{t.ja ? <><b>{winner.store}</b> が {usd(winner.price)} で選ばれる: 価格差 {usd(winner.gap)} ＋ 守られていないリスク {usd(winner.loss)}</> : <><b>{winner.store}</b> wins at {usd(winner.price)}: price gap {usd(winner.gap)} + unprotected risk {usd(winner.loss)}.</>}</p>}
    </div>
  );
}
