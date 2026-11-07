// Animated replay: one day per tick. Left, a ranked "race" of the agent's
// purchase share per store (rows slide when the order changes); a refund
// floats up from a store on the day one of its claims misses. Right, share
// over time up to the playhead, with a crosshair tooltip.
import { useEffect, useMemo, useRef, useState } from 'react';
import { usd } from '../api';
import { colorMap, INK, shortDay, STATUS } from '../viz';
import { tReason, useT } from '../i18n';

export interface ReplayResult {
  group_key: string;
  title: string;
  disclaimer: string;
  days: string[];
  stores: { store: string; product_id: string; claims: { claim_type: string; stake_usd: number }[] }[];
  timeline: {
    day: string; store: string; price: number; share: number; orders: number; rank: number; accuracy: number; p_drop: number;
    expected_loss_usd: number; effective_cost_usd: number; payout_usd: number; cum_payout_usd: number; cum_orders: number; hits: number; misses: number;
  }[];
  contracts: { id: string; store: string; orders: number; terms: any; verdict: any }[];
  totals: { store: string; orders: number; payout_usd: number; hits: number; misses: number; accuracy: number; first_week_share: number; last_week_share: number }[];
  sample_ranking: { day: string; ranking: any[] } | null;
}

const ROW_H = 46;
const CLAIM_SHORT: Record<string, [string, string]> = { lowest_price: ['Lowest price', '最安値'], no_price_drop: ['No price drop', '値下がりしない'], genuine_sale: ['Genuine sale', '本物のセール'] };

interface Missed { store: string; claim: string; orders: number; refund: number; reason: string }

export function ReplayPlayer({ result }: { result: ReplayResult }) {
  const t = useT();
  const stores = useMemo(() => result.stores.map((s) => s.store), [result]);
  const colors = useMemo(() => colorMap(stores), [stores]);
  const days = result.days;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setI(0);
    setPlaying(true);
  }, [result]);

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setTimeout(() => {
      if (i >= days.length - 1) setPlaying(false);
      else setI(i + 1);
    }, 900 / speed);
    return () => window.clearTimeout(timer.current);
  }, [playing, i, speed, days.length]);

  const day = days[i];
  const rows = result.timeline.filter((t) => t.day === day);
  const byStore = new Map(rows.map((r) => [r.store, r]));
  // Stores with no price today keep their last known numbers, greyed.
  const last = (s: string) => [...result.timeline].reverse().find((t) => t.store === s && t.day <= day);
  const ordered = [...stores].sort((a, b) => (byStore.get(b)?.share ?? -1) - (byStore.get(a)?.share ?? -1) || a.localeCompare(b));

  const missedToday: Missed[] = useMemo(() => {
    const m = new Map<string, Missed>();
    for (const c of result.contracts) {
      const v = c.verdict;
      if (!v || v.judged_day !== day || v.outcome !== 'miss') continue;
      const k = c.store + c.terms.claim_type;
      const e = m.get(k) ?? { store: c.store, claim: c.terms.claim_type, orders: 0, refund: 0, reason: v.reason };
      e.orders += c.orders;
      e.refund += v.payout_usd * c.orders;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.refund - a.refund);
  }, [result, day]);

  const totalRefund = rows.reduce((s, r) => s + r.cum_payout_usd, 0);
  const totalOrders = rows.reduce((s, r) => s + r.cum_orders, 0);
  const totalMisses = stores.reduce((s, st) => s + (last(st)?.misses ?? 0), 0);

  return (
    <div className="player">
      <div className="player-bar">
        <button className="primary play" onClick={() => (i >= days.length - 1 ? (setI(0), setPlaying(true)) : setPlaying(!playing))} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : i >= days.length - 1 ? '↺' : '▶'}
        </button>
        <div className="player-day">
          <div className="big">{shortDay(day)}</div>
          <div className="muted small">{t(`day ${i + 1} of ${days.length}`, `${days.length} 日中 ${i + 1} 日目`)}</div>
        </div>
        <input className="scrub" type="range" min={0} max={days.length - 1} value={i} onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} aria-label="Replay day" />
        <div className="seg" role="group" aria-label="Speed">
          {[1, 2, 4].map((s) => <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>{s}×</button>)}
        </div>
      </div>

      <div className="player-kpis">
        <div><div className="v">{usd(totalRefund)}</div><div className="l">{t('refunded to buyers automatically', '買い手へ自動で返金')}</div></div>
        <div><div className="v">{totalOrders.toLocaleString()}</div><div className="l">{t('agent purchases', 'エージェントによる購入')}</div></div>
        <div><div className="v">{totalMisses.toLocaleString()}</div><div className="l">{t('claims missed (per order)', '外れた主張（注文ごと）')}</div></div>
      </div>

      <div className="player-main">
        <div className="race" style={{ height: stores.length * ROW_H }}>
          {stores.map((s) => {
            const r = byStore.get(s);
            const l = r ?? last(s);
            const rank = ordered.indexOf(s);
            const paid = missedToday.filter((m) => m.store === s).reduce((a, m) => a + m.refund, 0);
            return (
              <div key={s} className={`race-row${r ? '' : ' idle'}${paid > 0 ? ' hit' : ''}`} style={{ transform: `translateY(${rank * ROW_H}px)` }}>
                <div className="race-name"><span className="dot" style={{ background: colors.get(s) }} />{s}</div>
                <div className="race-track">
                  <div className="race-fill" style={{ width: `${(r?.share ?? 0) * 100}%`, background: colors.get(s) }} />
                  <span className="race-pct">{r ? `${Math.round(r.share * 100)}%` : t('no price', '価格なし')}</span>
                </div>
                <div className="race-price">{l ? usd(l.price) : '—'}</div>
                <div className="race-acc" title={`Accuracy ${(l?.accuracy ?? 0.5) * 100}% (${l?.hits ?? 0} held, ${l?.misses ?? 0} missed)`}>
                  <div className="meter"><span style={{ width: `${(l?.accuracy ?? 0.5) * 100}%`, background: (l?.accuracy ?? 0.5) >= 0.7 ? STATUS.good : (l?.accuracy ?? 0.5) >= 0.45 ? STATUS.warning : STATUS.critical }} /></div>
                  <span className="small">{Math.round((l?.accuracy ?? 0.5) * 100)}%</span>
                </div>
                {paid > 0 && <span key={day} className="refund-float">−{usd(paid)}</span>}
              </div>
            );
          })}
        </div>
        <ShareChart result={result} stores={stores} colors={colors} upto={i} />
      </div>
      <div className="race-legend muted small">
        <span>{t("Bar: share of the agent's purchases today", '棒: その日にエージェントが買った割合')}</span><span>{t('Price: real Channel3 price that day', '価格: その日の Channel3 の実際の価格')}</span><span>{t('Meter: store accuracy (claims held)', 'メーター: 店の正確さ（主張が当たった割合）')}</span>
      </div>

      <div className="ticker" aria-live="polite">
        {missedToday.length === 0 ? (
          <span className="muted">{t(`No claim missed on ${shortDay(day)}.`, `${shortDay(day)} に外れた主張はない。`)}</span>
        ) : (
          missedToday.map((m) => (
            <div key={m.store + m.claim} className="tick">
              <span className="chip chip-bad" style={{ marginLeft: 0 }}>{t('✕ missed', '✕ 外れ')}</span>
              <b style={{ color: INK.primary }}>{m.store}</b> · {CLAIM_SHORT[m.claim] ? t(CLAIM_SHORT[m.claim][0], CLAIM_SHORT[m.claim][1]) : m.claim}: {tReason(m.reason, t.ja)} → {t.ja ? <>{m.orders} 人の買い手に <b>{usd(m.refund)}</b> を返金</> : <><b>{usd(m.refund)}</b> refunded to {m.orders} buyer{m.orders === 1 ? '' : 's'}</>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ShareChart({ result, stores, colors, upto }: { result: ReplayResult; stores: string[]; colors: Map<string, string>; upto: number }) {
  const t = useT();
  const W = 520, H = 300, L = 40, R = 12, T = 12, B = 28;
  const days = result.days;
  const x = (i: number) => L + (i / Math.max(1, days.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const [hover, setHover] = useState<number | null>(null);
  const series = stores.map((s) => ({
    s,
    pts: days.map((d, i) => ({ i, v: result.timeline.find((t) => t.day === d && t.store === s)?.share })).filter((p) => p.i <= upto && p.v !== undefined) as { i: number; v: number }[],
  }));
  const hi = hover ?? upto;
  const hoverRows = result.timeline.filter((t) => t.day === days[hi]).sort((a, b) => b.share - a.share);
  return (
    <div className="share-chart">
      <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{t('Share of purchases over time', '買われた割合の推移')}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Share of purchases per store over time"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const idx = Math.round(((px - L) / (W - L - R)) * (days.length - 1));
          setHover(Math.max(0, Math.min(upto, idx)));
        }}
        onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 0 ? INK.axis : INK.grid} strokeWidth={1} />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" fill={INK.muted} fontSize={11}>{t * 100}%</text>
          </g>
        ))}
        {days.map((d, i) => ((i % 7 === 0 && days.length - 1 - i >= 4) || i === days.length - 1 ? <text key={d} x={x(i)} y={H - 8} textAnchor="middle" fill={INK.muted} fontSize={11}>{shortDay(d)}</text> : null))}
        {series.map(({ s, pts }) => (
          <polyline key={s} fill="none" stroke={colors.get(s)} strokeWidth={2} strokeLinejoin="round" points={pts.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')} />
        ))}
        <line x1={x(hi)} x2={x(hi)} y1={T} y2={H - B} stroke={INK.secondary} strokeWidth={1} />
        {series.map(({ s, pts }) => {
          const p = pts.find((q) => q.i === hi);
          return p ? <circle key={s} cx={x(p.i)} cy={y(p.v)} r={4} fill={colors.get(s)} stroke="#fff" strokeWidth={2} /> : null;
        })}
      </svg>
      {hover !== null && (
        <div className="tooltip">
          <div className="small" style={{ fontWeight: 600 }}>{shortDay(days[hi])}</div>
          {hoverRows.map((r) => (
            <div key={r.store} className="small"><span className="dot" style={{ background: colors.get(r.store) }} />{r.store} <b>{Math.round(r.share * 100)}%</b> · {usd(r.price)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
