// Seller's AI agent simulation on real past Channel3 prices (docs/concept.md §27).
// Shows: (1) owner's policy mandate + code-enforced safety valves, (2) 15-day
// price/promise/sales/refunds SVG chart for condition e, (3) interactive day
// panel (morning decision, 6 buyer negotiations, nightly strategy memo), and
// (4) five-seller profit comparison + buyer regret check.
import { useEffect, useMemo, useState } from 'react';
import { api, usd } from '../api';
import { useT } from '../i18n';
import { useAsync } from '../useAsync';
import { shortDay } from '../viz';
import { ErrorBox } from './ErrorBox';
import { Icon } from './Icon';

const DEFAULT_GOAL_EN = 'Maximise profit after refunds over the coming weeks.';

interface SimTotals {
  sales: number;
  buyers_total: number;
  conversion_rate: number;
  revenue_usd: number;
  refunds_usd: number;
  refunded_sales: number;
  profit_usd: number;
  profit_at_10pct_margin_usd?: number;
  profit_at_20pct_margin_usd?: number;
  profit_at_30pct_margin_usd?: number;
}

interface SimSummary {
  file: string;
  variant?: string[];
  product: string;
  store: string;
  goal: string | null;
  mix: string | null;
  conditions: string[];
  totals: Record<string, SimTotals>;
  mfc?: boolean;
}

interface SimRivalToday {
  store: string;
  real_price_usd: number;
  p_drop?: number;
  expected_drop_usd?: number;
}

interface SimBuyer {
  buyer_id: number;
  message: string;
  agent_offer: {
    price_usd: number;
    cap_usd: number;
    personal: boolean;
    clamped?: boolean;
    reply?: string;
  };
  choice: 'agent' | 'other_store' | 'wait';
  chosen_store: string | null;
  price_paid_usd: number | null;
  cap_usd?: number | null;
  reason: string;
}

interface SimDay {
  day: string;
  is_sale_day: boolean;
  real_price_usd: number;
  unit_cost_usd?: number;
  floor_usd?: number;
  ceiling_usd?: number;
  market_min_real_usd: number;
  other_stores_today: SimRivalToday[];
  price: number;
  cap: number;
  effective_min_price_usd?: number;
  listing_reasoning?: string;
  buyers: SimBuyer[];
  sales_count: number;
  revenue_usd: number;
  refunds_known_today_usd: number;
  memo: string | null;
  memo_after_day: string | null;
}

interface SimSale {
  sale_id?: string;
  sale_day: string;
  buyer_id: number;
  price_paid_usd: number;
  cap_usd: number;
  final_refund_usd: number;
}

interface SimConditionRun {
  condition: string;
  totals: SimTotals;
  sales: SimSale[];
  days: SimDay[];
}

interface SimRun {
  model: string;
  run_at: string;
  product_label: string;
  agent_store: string;
  other_stores: string[];
  design: {
    seed?: number;
    mix?: string;
    from_day: string;
    last_sale_day: string;
    last_judge_day: string;
    sale_days: number;
    promise_window_days: number;
    buyers_per_day: number;
    owner_goal?: string;
    promise_rule?: string;
    bounds: {
      floor_rule: string;
      ceiling_rule: string;
      cap_rule: string;
      floor_ratio?: number;
      ceiling_ratio?: number;
    };
    unit_cost_rule: string;
  };
  totals_by_condition: Record<string, SimTotals>;
  conditions: Record<string, SimConditionRun>;
}

const signedUsd = (x: number) => `${x > 0.005 ? '+' : x < -0.005 ? '−' : ''}${usd(Math.abs(x))}`;

function goalShortLabel(goal: string | null | undefined, t: (en: string, ja: string) => string): string {
  const g = (goal ?? DEFAULT_GOAL_EN).trim();
  if (!g || g === DEFAULT_GOAL_EN || /maximise profit|maximize profit/i.test(g)) {
    return t('profit', '利益重視');
  }
  if (/clear stock|inventory|volume|move stock|sell through/i.test(g)) {
    return t('clear stock', '在庫消化');
  }
  if (/avoid refund|minimise refund|minimize refund|no refund|low refund/i.test(g)) {
    return t('avoid refunds', '返金回避');
  }
  return g.length > 26 ? `${g.slice(0, 24)}…` : g;
}

function goalDisplay(goal: string | null | undefined, t: (en: string, ja: string) => string): string {
  const g = (goal ?? DEFAULT_GOAL_EN).trim() || DEFAULT_GOAL_EN;
  if (g === DEFAULT_GOAL_EN) {
    return t(DEFAULT_GOAL_EN, '今後数週間の、返金後の利益を最大化する。');
  }
  if (/clear stock|move inventory|volume/i.test(g)) {
    return t(g, `在庫消化を優先: ${g}`);
  }
  if (/avoid refund|minimise refund|minimize refund/i.test(g)) {
    return t(g, `返金抑制を優先: ${g}`);
  }
  return g;
}

function mixLabel(mix: string | null | undefined, t: (en: string, ja: string) => string): string {
  if (mix === 'patient') return t('patient buyers', '待てる買い手');
  if (mix === 'urgent') return t('urgent buyers', '急ぐ買い手');
  return mix ?? '';
}

export function SellerAgentSim({ onSwitchToLive }: { onSwitchToLive?: () => void } = {}) {
  const t = useT();
  const list = useAsync(() => api.get<SimSummary[]>('/api/seller-sim'), []);
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    if (!list.data?.length) return;
    if (!file || !list.data.some((r) => r.file === file)) {
      // Open on a fair-rule (MFC) run when there is one, else on the first run.
      setFile((list.data.find((r) => r.file.endsWith('-full-fair')) ?? list.data.find((r) => r.file.endsWith('-fair')) ?? list.data[0]).file);
    }
  }, [list.data, file]);

  const run = useAsync(
    () => (file ? api.get<SimRun>(`/api/seller-sim/${encodeURIComponent(file)}`) : Promise.resolve(null)),
    [file],
  );

  const d = run.data;
  const eCond = d?.conditions?.e ?? (d ? Object.values(d.conditions)[0] : undefined);
  const days = eCond?.days ?? [];
  // The owner's safety valves as this run used them (older runs lack bounds: 90% / 110% / 10%).
  const b = d?.design.bounds;
  const floorPct = Math.round((b?.floor_ratio ?? 0.9) * 100);
  const ceilingPct = Math.round((b?.ceiling_ratio ?? 1.1) * 100);
  const ceilingFromFirstDay = /first day/.test(b?.ceiling_rule ?? '');
  // Full-difference promise (concept §29): the whole drop is refunded, so cap = price paid and no dollar cap is shown.
  const fullPromise = d?.design.promise_rule?.startsWith('full') ?? false;
  const capPct = Number(/(\d+(?:\.\d+)?)% of price/.exec(b?.cap_rule ?? '')?.[1] ?? 10);

  // Default day selection: the sale day with the most sales.
  const bestDayStr = useMemo(() => {
    if (!days.length) return null;
    const saleDays = days.filter((x) => x.is_sale_day);
    const pool = saleDays.length ? saleDays : days;
    return pool.reduce((best, cur) => (cur.sales_count > best.sales_count ? cur : best), pool[0]).day;
  }, [days]);

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [hoverDay, setHoverDay] = useState<string | null>(null);

  useEffect(() => {
    setSelectedDay(bestDayStr);
    setHoverDay(null);
  }, [bestDayStr, file]);

  const activeDayStr = hoverDay ?? selectedDay ?? bestDayStr;
  const selIdx = Math.max(0, days.findIndex((x) => x.day === (selectedDay ?? bestDayStr)));
  const selDay = days[selIdx] ?? null;
  const prevDay = selIdx > 0 ? days[selIdx - 1] : null;
  const nextDay = selIdx >= 0 && selIdx < days.length - 1 ? days[selIdx + 1] : null;

  // Runs that share the same product + store with distinct owner_goal presets.
  const presetRuns = useMemo(() => {
    if (!list.data || !d) return [];
    const sameStore = list.data.filter((r) => r.product === d.product_label && r.store === d.agent_store);
    const byGoal = new Map<string, SimSummary>();
    for (const r of sameStore) {
      const g = (r.goal ?? DEFAULT_GOAL_EN).trim();
      const existing = byGoal.get(g);
      if (!existing || (r.mix === d.design.mix && existing.mix !== d.design.mix)) {
        byGoal.set(g, r);
      }
    }
    return byGoal.size > 1 ? [...byGoal.values()] : [];
  }, [list.data, d]);

  // Buyer regret check for condition e:
  // Average of (price paid − refund − lowest price at any store in the next 7 days)
  // for buyers who bought from the agent vs buyers who bought from rivals.
  const buyerCheck = useMemo(() => {
    if (!eCond || !d) return null;
    const winDays = d.design.promise_window_days ?? 7;
    const saleRefundMap = new Map<string, number>();
    for (const s of eCond.sales) {
      saleRefundMap.set(`${s.sale_day}:${s.buyer_id}`, s.final_refund_usd);
    }
    const agentDiffs: number[] = [];
    const rivalDiffs: number[] = [];
    for (let i = 0; i < eCond.days.length; i++) {
      const dayObj = eCond.days[i];
      if (!dayObj.is_sale_day) continue;
      const futureSlice = eCond.days.slice(i + 1, i + 1 + winDays);
      if (!futureSlice.length) continue;
      const lowestNext7 = Math.min(
        ...futureSlice.map((fd) =>
          Math.min(fd.effective_min_price_usd ?? fd.price, ...fd.other_stores_today.map((o) => o.real_price_usd)),
        ),
      );
      for (const b of dayObj.buyers) {
        if (b.choice === 'agent' && b.price_paid_usd != null) {
          const refund = saleRefundMap.get(`${dayObj.day}:${b.buyer_id}`) ?? 0;
          agentDiffs.push(b.price_paid_usd - refund - lowestNext7);
        } else if (b.choice === 'other_store' && b.price_paid_usd != null) {
          rivalDiffs.push(b.price_paid_usd - lowestNext7);
        }
      }
    }
    const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    return {
      agentAvg: avg(agentDiffs),
      agentCount: agentDiffs.length,
      rivalAvg: avg(rivalDiffs),
      rivalCount: rivalDiffs.length,
    };
  }, [eCond, d]);

  // Sale lookup by day:buyer_id so buyer cards can also surface any later refund.
  const saleByBuyer = useMemo(() => {
    const m = new Map<string, SimSale>();
    for (const s of eCond?.sales ?? []) m.set(`${s.sale_day}:${s.buyer_id}`, s);
    return m;
  }, [eCond]);

  return (
    <section className="card sim-shell" aria-label={t('Your store’s AI agent', 'あなたの店の AI エージェント')}>
      {/* Header */}
      <div className="sim-head">
        <div className="sim-title-row">
          <span className="seller-badge sim-bot-badge"><Icon name="bot" size={24} /></span>
          <div>
            <div className="sim-title-wrap">
              <h1>{t('Your store’s AI agent', 'あなたの店の AI エージェント')}</h1>
              <span className="badge info"><Icon name="clock" size={13} /> {t('Simulation on real past prices', '過去の実際の価格でのシミュレーション')}</span>
            </div>
            {list.data && list.data.length > 0 && (
              <div className="sim-run-picker">
                <select
                  value={file ?? ''}
                  onChange={(e) => setFile(e.target.value)}
                  aria-label={t('Select simulation run (product · store · goal)', 'シミュレーションを選択（商品・店・方針）')}
                >
                  {list.data.map((r) => {
                    const variant = (r.variant ?? []).map((v) => (v === 'no_chat' ? t('without buyer chats', '買い手との交渉なし') : v === 'no_memo' ? t('without nightly memo', '戦略メモなし') : t('default thinking', '推論 既定'))).join(', ');
                    const rule = r.file.includes('-full') ? t('full difference', '差額全額') : r.file.endsWith('-fair-wide') ? t('fair rule, wide valves', '公平なルール・安全弁広め') : r.file.endsWith('-fair') ? t('fair rule (MFC)', '公平なルール（最恵待遇）') : r.mfc === false ? t('⚠ before the loophole fix', '⚠ 抜け穴を塞ぐ前') : '';
                    const extra = `${rule ? ` · ${rule}` : ''}${r.mix ? ` · ${mixLabel(r.mix, t)}` : ''}${variant ? ` · ${variant}` : ''}`;
                    return (
                      <option key={r.file} value={r.file}>
                        {r.product} · {r.store} · {goalShortLabel(r.goal, t)}{extra}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}
          </div>
        </div>
        {d && eCond && (
          <div className="sim-head-kpis">
            <div className="sim-hkpi good">
              <span className="tiny">{t('AI agent profit (20% margin)', 'AI エージェントの利益（粗利20%）')}</span>
              <b>{usd(eCond.totals.profit_at_20pct_margin_usd ?? eCond.totals.profit_usd)}</b>
            </div>
            <div className="sim-hkpi">
              <span className="tiny">{t('Orders won', '獲得した注文')}</span>
              <b>{eCond.totals.sales}<span className="muted small">/{eCond.totals.buyers_total}</span></b>
            </div>
            <div className="sim-hkpi">
              <span className="tiny">{t('Refunds paid', '支払った返金')}</span>
              <b>{usd(eCond.totals.refunds_usd)}</b>
            </div>
          </div>
        )}
      </div>

      <ErrorBox error={list.error ?? run.error} />
      {(list.loading || run.loading) && !d && (
        <div className="sim-loading muted small"><span className="spin" /> {t('Loading simulation…', 'シミュレーションを読み込み中…')}</div>
      )}

      {d && eCond && (
        <>
          {/* 1. Mandate (policy) card */}
          <div className="sim-mandate">
            <div className="sim-mandate-top">
              <div className="sim-mandate-goal">
                <div className="sim-eyebrow">
                  <Icon name="megaphone" size={14} /> {t('1. Owner’s policy given to the agent', '1. 店主がエージェントに与えた方針')}
                </div>
                <blockquote className="sim-goal-quote">
                  “{goalDisplay(d.design.owner_goal, t)}”
                </blockquote>
              </div>
              {presetRuns.length > 1 && (
                <div className="sim-goal-presets" role="group" aria-label={t('Switch policy preset', '方針プリセットを切り替え')}>
                  <span className="tiny muted">{t('Switch owner policy:', '方針を切り替え:')}</span>
                  <div className="seg">
                    {presetRuns.map((r) => (
                      <button
                        key={r.file}
                        className={r.file === file ? 'on' : ''}
                        onClick={() => setFile(r.file)}
                      >
                        {goalShortLabel(r.goal, t)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="sim-valves">
              <span className="sim-valves-label small">
                <Icon name="lock" size={14} /> <b>{t('Safety valves enforced by code', 'コードが強制する安全弁')}</b>
              </span>
              <div className="lockchips">
                <span className="lockchip"><Icon name="lock" size={13} /> {t(`Floor: ${floorPct}% of day’s real price`, `下限: その日の実価格の ${floorPct}%`)}</span>
                <span className="lockchip"><Icon name="lock" size={13} /> {ceilingFromFirstDay ? t(`Ceiling: ${ceilingPct}% of the higher of day 1’s and the day’s real price`, `上限: 初日とその日の実価格の高いほうの ${ceilingPct}%`) : t(`Ceiling: ${ceilingPct}% of day’s real price`, `上限: その日の実価格の ${ceilingPct}%`)}</span>
                <span className="lockchip"><Icon name="lock" size={13} /> {fullPromise ? t('Promise: full difference', '約束: 差額を全額') : t(`Promise cap ≤ ${capPct}% of price`, `約束の上限 ≤ 価格の ${capPct}%`)}</span>
                <span className="lockchip"><Icon name="lock" size={13} /> {t(`${d.design.promise_window_days}-day window`, `${d.design.promise_window_days}日間の期間`)}</span>
              </div>
              <div className="muted small">
                {t(
                  'The AI cannot cross these; verdicts and refunds are fixed rules, not AI.',
                  'AI はこの線を越えられない。判定と返金は AI ではなく決まったルール。',
                )}
              </div>
            </div>
          </div>

          {/* 1b. What this replay shows */}
          <div className="sim-replay-card">
            <b className="small">{t('What this replay shows', 'この再現で見えたこと')}</b>
            <p className="small">
              {t(
                'A promise is judged on the lowest price the store actually sold at (listed or personal) over the next 7 days, so a secret discount to one buyer refunds the earlier buyers.',
                '約束は、その後7日間に店が実際に売った最安の値段（公開価格でも個別の値段でも）で判定される。だから1人にこっそり値引きすると、先に買った人に返金が出る。',
              )}
            </p>
            <span className="tiny muted">{t('1 product, 1 simulated run; demand and margin are assumptions', '1商品・1回のシミュレーション。需要と粗利は仮定')}</span>
            {onSwitchToLive && (
              <button type="button" className="link tiny" onClick={onSwitchToLive}>
                {t('Publish a live promise for #/buy →', '実物出品（#/buy 連携）タブへ移動 →')}
              </button>
            )}
          </div>

          {/* 1c. 15-day profit by seller type */}
          <SimProfitChart totals={d.totals_by_condition} />

          {/* 2. 15-day hero chart */}
          <SimHeroChart
            key={file ?? 'chart'}
            days={days}
            buyersPerDay={d.design.buyers_per_day}
            fullPromise={fullPromise}
            selectedDay={selectedDay ?? bestDayStr}
            activeDay={activeDayStr}
            bestDay={bestDayStr}
            onSelectDay={(day) => setSelectedDay(day)}
            onHoverDay={(day) => setHoverDay(day)}
          />

          {/* 3. Day panel for the selected day */}
          {selDay && (
            <div className="sim-day-panel">
              <div className="sim-day-header">
                <div className="sim-day-title">
                  <span className="sim-day-pill">{shortDay(selDay.day)}</span>
                  <h2>
                    {selDay.is_sale_day
                      ? t(`Day ${selIdx + 1} of ${d.design.sale_days}: morning price, 6 buyer chats & nightly memo`, `${d.design.sale_days}日間の ${selIdx + 1}日目: 朝の値付け・6人の交渉・夜の戦略メモ`)
                      : t(`${shortDay(selDay.day)} — Judging only (7-day promise tail)`, `${shortDay(selDay.day)} — 判定のみ（約束の7日間の追跡期間）`)}
                  </h2>
                </div>
                <div className="sim-day-nav">
                  <button
                    disabled={!prevDay}
                    onClick={() => prevDay && setSelectedDay(prevDay.day)}
                    aria-label={t('Previous day', '前の日')}
                  >
                    ← {prevDay ? shortDay(prevDay.day) : t('Prev', '前日')}
                  </button>
                  <button
                    disabled={!nextDay}
                    onClick={() => nextDay && setSelectedDay(nextDay.day)}
                    aria-label={t('Next day', '次の日')}
                  >
                    {nextDay ? shortDay(nextDay.day) : t('Next', '翌日')} →
                  </button>
                </div>
              </div>

              {/* Morning decision */}
              <div className="sim-morning">
                <div className="sim-morning-metrics">
                  <div className="sim-m-stat primary">
                    <span className="tiny">{t('Agent’s morning price', 'エージェントの朝の価格')}</span>
                    <b>{usd(selDay.price)}</b>
                    <span className="tiny muted">
                      {t(`Real price ${usd(selDay.real_price_usd)}`, `実価格 ${usd(selDay.real_price_usd)}`)}
                    </span>
                  </div>
                  <div className="sim-m-stat good">
                    <span className="tiny">{fullPromise ? t('7-day no-drop promise', '7日間の値下がり約束') : t('7-day no-drop promise cap', '7日間の値下がり約束の上限')}</span>
                    <b><Icon name="shield" size={16} /> {selDay.cap > 0 ? (fullPromise ? t('Full difference', '差額を全額返金') : usd(selDay.cap)) : t('None ($0)', 'なし ($0)')}</b>
                    <span className="tiny muted">
                      {selDay.cap > 0
                        ? fullPromise
                          ? t('Any later drop is refunded in full', 'あとで下がったら全額返金')
                          : t(`Protected down to ${usd(selDay.price - selDay.cap)}`, `${usd(selDay.price - selDay.cap)} まで保護`)
                        : t('No refund promise today', 'この日は約束なし')}
                    </span>
                  </div>
                  <div className="sim-m-stat">
                    <span className="tiny">{t('Cheapest rival today', 'その日の最安競合店')}</span>
                    <b>{usd(Math.min(...selDay.other_stores_today.map((o) => o.real_price_usd)))}</b>
                    <span className="tiny muted">
                      {selDay.other_stores_today[0]?.store ?? ''}
                    </span>
                  </div>
                  {selDay.refunds_known_today_usd > 0 && (
                    <div className="sim-m-stat bad">
                      <span className="tiny">{t('Automatic refunds triggered today', 'この日に発動した自動返金')}</span>
                      <b><Icon name="coin" size={16} /> −{usd(selDay.refunds_known_today_usd)}</b>
                      <span className="tiny">
                        {t('Paid on prior 7-day promises', '直前7日間の約束に対する返金')}
                      </span>
                    </div>
                  )}
                </div>
                {selDay.listing_reasoning && (
                  <div className="sim-morning-quote">
                    <span className="sim-bot-icon"><Icon name="bot" size={18} /></span>
                    <div>
                      <div className="who">{t('Why the agent set this price & promise', 'この価格と約束にした理由（エージェントの判断）')}</div>
                      <blockquote>“{selDay.listing_reasoning}”</blockquote>
                    </div>
                  </div>
                )}
              </div>

              {/* Six buyer cards in a grid */}
              {selDay.buyers.length > 0 ? (
                <div className="sim-buyers-grid">
                  {selDay.buyers.map((b) => {
                    const sale = saleByBuyer.get(`${selDay.day}:${b.buyer_id}`);
                    const outcomeClass = b.choice === 'agent' ? 'won' : b.choice === 'wait' ? 'waited' : 'lost';
                    return (
                      <div key={b.buyer_id} className={`sim-buyer-card ${outcomeClass}`}>
                        {/* Step 1: Buyer message */}
                        <div className="sim-b-step msg">
                          <div className="sim-b-head">
                            <span className="who">{t(`Buyer #${b.buyer_id}`, `買い手 #${b.buyer_id}`)}</span>
                          </div>
                          <p className="sim-b-quote">“{b.message}”</p>
                        </div>

                        <div className="sim-b-arrow" aria-hidden="true">↓</div>

                        {/* Step 2: Agent's reply & offer */}
                        <div className="sim-b-step reply">
                          <div className="sim-b-head">
                            <span className="sim-b-agent-tag">
                              <Icon name="bot" size={13} /> <b>{usd(b.agent_offer.price_usd)}</b>
                              <span className="muted">·</span>
                              <Icon name="shield" size={12} /> {fullPromise ? (b.agent_offer.cap_usd > 0 ? t('full difference', '差額全額') : t('none', 'なし')) : usd(b.agent_offer.cap_usd)}
                            </span>
                            {b.agent_offer.personal && (
                              <span className="badge info"><Icon name="tag" size={11} /> {t('personal offer', '個別オファー')}</span>
                            )}
                          </div>
                          {b.agent_offer.reply && (
                            <p className="sim-b-reply-text">“{b.agent_offer.reply}”</p>
                          )}
                        </div>

                        <div className="sim-b-arrow" aria-hidden="true">↓</div>

                        {/* Step 3: Outcome */}
                        <div className={`sim-b-outcome ${outcomeClass}`}>
                          {b.choice === 'agent' && (
                            <>
                              <Icon name="check" size={16} />
                              <b>{t('Won', '獲得')} +{usd(b.price_paid_usd)}</b>
                              {sale && sale.final_refund_usd > 0 && (
                                <span className="badge bad" title={t('Automatic refund paid when price dropped within 7 days', '7日以内の値下がりで自動返金')}>
                                  <Icon name="coin" size={11} /> −{usd(sale.final_refund_usd)}
                                </span>
                              )}
                            </>
                          )}
                          {b.choice === 'other_store' && (
                            <>
                              <Icon name="store" size={16} />
                              <span>{t(`Lost to ${b.chosen_store}`, `${b.chosen_store} に敗北`)} ({usd(b.price_paid_usd)})</span>
                            </>
                          )}
                          {b.choice === 'wait' && (
                            <>
                              <Icon name="hourglass" size={16} />
                              <span>{t('Waited', '見送り（待つ）')}</span>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="sim-tail-note small muted">
                  <Icon name="clock" size={15} />{' '}
                  {t(
                    'Judging-only day (no new buyers): the agent still sets its daily price while promises from the last 7 sale days are judged on real prices.',
                    '判定のみの日（新規の買い手なし）: 直前7日間の販売の約束が判定される間も、エージェントは毎日の価格を決める。',
                  )}
                </div>
              )}

              {/* Nightly strategy memo */}
              {(selDay.memo ?? selDay.memo_after_day) && (
                <div key={`memo-${selDay.day}`} className="sim-memo-card">
                  <div className="sim-memo-head">
                    <div className="sim-memo-title">
                      <Icon name="receipt" size={16} />
                      <b>{t(`Nightly strategy memo (after ${shortDay(selDay.day)})`, `夜の戦略メモ（${shortDay(selDay.day)} の終了後に更新）`)}</b>
                      {prevDay && prevDay.memo !== selDay.memo && (
                        <span className="badge info">{t('rewritten tonight', '今夜書き直し')}</span>
                      )}
                    </div>
                    <div className="sim-day-nav">
                      <button
                        disabled={!prevDay}
                        onClick={() => prevDay && setSelectedDay(prevDay.day)}
                      >
                        ← {t('Prev night', '前夜')}
                      </button>
                      <button
                        disabled={!nextDay}
                        onClick={() => nextDay && setSelectedDay(nextDay.day)}
                      >
                        {t('Next night', '翌夜')} →
                      </button>
                    </div>
                  </div>
                  <p className="sim-memo-body">{selDay.memo ?? selDay.memo_after_day}</p>
                </div>
              )}
            </div>
          )}

          {/* 4. Results box: Check: same buyers, five sellers */}
          <div className="sim-results-box">
            <div className="sim-results-head">
              <h2><Icon name="shieldCheck" size={18} /> {t('Check: same buyers, five sellers', '検証: 同じ買い手に、5通りの売り手')}</h2>
              <span className="small muted">{t('Profit at 20% gross margin after all 7-day promise refunds', '7日間の約束の返金を差し引いた後の利益（粗利率20%）')}</span>
            </div>

            <div className="sim-cond-bars">
              {(['a', 'b', 'c', 'd', 'e'] as const)
                .filter((c) => c in d.totals_by_condition)
                .map((c) => {
                  const tot = d.totals_by_condition[c];
                  const profit = tot.profit_at_20pct_margin_usd ?? tot.profit_usd;
                  const allProfits = Object.values(d.totals_by_condition).map(
                    (x) => x.profit_at_20pct_margin_usd ?? x.profit_usd,
                  );
                  const maxP = Math.max(1, ...allProfits);
                  const pctWidth = Math.max(0, Math.min(100, (profit / maxP) * 100));
                  const labels: Record<string, [string, string]> = {
                    a: ['real price, no promise', '実際の値段・約束なし'],
                    b: ['real price + formula promise', '実際の値段＋式の約束'],
                    c: ['rule-based seller', '数式の売り手'],
                    d: ['AI sets promise only', '約束だけ AI'],
                    e: ['AI agent', 'AI エージェント'],
                  };
                  const isHero = c === 'e';
                  return (
                    <div key={c} className={`sim-cond-row${isHero ? ' hero-cond' : ''}`}>
                      <div className="sim-cond-label">
                        <span className="sim-cond-code">({c})</span>
                        <span>{t(...labels[c])}</span>
                      </div>
                      <div className="sim-cond-track">
                        <span
                          className={`sim-cond-fill${isHero ? ' hero-fill' : ''}`}
                          style={{ width: `${pctWidth}%` }}
                        />
                      </div>
                      <div className="sim-cond-stats">
                        <b className="sim-cond-profit">{usd(profit)}</b>
                        <span className="small muted">
                          {t(`${tot.sales} sold`, `販売 ${tot.sales}`)} · {t(`refunds ${usd(tot.refunds_usd)}`, `返金 ${usd(tot.refunds_usd)}`)}
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>

            {buyerCheck && (
              <div className="sim-buyer-view">
                <div className="small" style={{ fontWeight: 700 }}>
                  {t(
                    'Buyer view (in condition e): average of (price paid − refund − lowest price at any store in the next 7 days)',
                    '買い手から見た結果（条件 e）: （支払額 − 返金 − その後7日間の全店最安値）の平均',
                  )}
                </div>
                <div className="sim-bv-grid">
                  <div className="sim-bv-card good">
                    <div className="sim-bv-top">
                      <Icon name="shieldCheck" size={18} />
                      <span>{t(`Bought from AI agent (${buyerCheck.agentCount} orders)`, `AI エージェントから購入（${buyerCheck.agentCount}件）`)}</span>
                    </div>
                    <b className="sim-bv-val">
                      {buyerCheck.agentAvg != null ? signedUsd(buyerCheck.agentAvg) : '—'}
                    </b>
                    <span className="tiny muted">
                      {t(
                        'After automatic refunds, buyers paid no more than (and on average beat) the lowest price at any store over the next 7 days.',
                        '自動返金の後、買い手の実質負担はその後7日間のどの店の最安値も上回らなかった（平均で最安値を下回った）。',
                      )}
                    </span>
                  </div>
                  <div className="sim-bv-card warn">
                    <div className="sim-bv-top">
                      <Icon name="store" size={18} />
                      <span>{t(`Bought from rivals without a promise (${buyerCheck.rivalCount} orders)`, `約束なしの競合店から購入（${buyerCheck.rivalCount}件）`)}</span>
                    </div>
                    <b className="sim-bv-val">
                      {buyerCheck.rivalAvg != null ? signedUsd(buyerCheck.rivalAvg) : '—'}
                    </b>
                    <span className="tiny muted">
                      {t(
                        'Without a price-drop promise, buyers who bought before a markdown absorbed the drop above the 7-day market low.',
                        '値下がりの約束がないため、値下げ前に買った買い手は7日間の市場最安値より高く払った分をそのまま被った。',
                      )}
                    </span>
                  </div>
                </div>
              </div>
            )}

            <div className="muted tiny">
              {t(
                'Demand is simulated (buyers follow fixed rules); 20% margin is an assumption; one product, one run.',
                '需要はシミュレーション（買い手は決まった式）、粗利20%は仮定、1商品・1回の結果。',
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------- Profit by seller type (15 days, 20% margin) ----------------

function SimProfitChart({ totals }: { totals: Record<string, SimTotals> }) {
  const t = useT();
  const labels: Record<string, [string, string]> = {
    a: ['No promise', '約束なし'],
    b: ['Formula promise', '式で決めた約束'],
    c: ['Rule seller (1¢ under cheapest)', '数式の売り手（最安より1セント安く）'],
    e: ['AI agent', 'AI エージェント'],
  };
  const rows = (['a', 'b', 'c', 'e'] as const).filter((c) => c in totals).map((c) => ({ c, tot: totals[c], profit: totals[c].profit_at_20pct_margin_usd ?? totals[c].profit_usd }));
  if (!rows.length) return null;
  const maxP = Math.max(1, ...rows.map((r) => r.profit));
  return (
    <div className="sim-profit-chart" role="img" aria-label={t('15-day profit at 20% margin by seller type', '売り手のタイプ別・15日間の利益（粗利20%）')}>
      <b className="small">{t('15-day profit by seller (20% margin)', '売り手のタイプ別・15日間の利益（粗利20%）')}</b>
      {rows.map(({ c, tot, profit }) => (
        <div key={c} className={`sim-pc-row${c === 'e' ? ' hero' : ''}`}>
          <span className="sim-pc-label">{t(...labels[c])}</span>
          <span className="sim-pc-track"><span className="sim-pc-fill" style={{ width: `${Math.max(0, Math.min(100, (profit / maxP) * 100))}%`, display: 'block' }} /></span>
          <span className="sim-pc-val"><b>{usd(profit)}</b> <span className="muted tiny">· {t(`${tot.sales} sold`, `販売 ${tot.sales}`)}</span></span>
        </div>
      ))}
    </div>
  );
}

// ---------------- 2. 15-day hero SVG chart ----------------

function SimHeroChart({
  days,
  buyersPerDay,
  fullPromise,
  selectedDay,
  activeDay,
  bestDay,
  onSelectDay,
  onHoverDay,
}: {
  days: SimDay[];
  buyersPerDay: number;
  fullPromise: boolean;
  selectedDay: string | null;
  activeDay: string | null;
  bestDay: string | null;
  onSelectDay: (day: string) => void;
  onHoverDay: (day: string | null) => void;
}) {
  const t = useT();
  if (!days.length) return null;

  const W = 880;
  const H = 290;
  const PAD_L = 46;
  const PAD_R = 18;
  const PRICE_TOP = 24;
  const PRICE_BOT = 182;
  const BAR_TOP = 204;
  const BAR_BOT = 258;
  const plotW = W - PAD_L - PAD_R;
  const stepX = days.length > 1 ? plotW / (days.length - 1) : plotW;
  const x = (i: number) => PAD_L + i * stepX;

  const rivals = days.map((d) => Math.min(...d.other_stores_today.map((o) => o.real_price_usd)));
  const allPriceVals = days.flatMap((d, i) => [
    d.price,
    d.is_sale_day && !fullPromise ? d.price - d.cap : d.price,
    d.real_price_usd,
    rivals[i],
  ]);
  const minP = Math.floor(Math.min(...allPriceVals) - 4);
  const maxP = Math.ceil(Math.max(...allPriceVals) + 4);
  const yPrice = (v: number) =>
    PRICE_TOP + (1 - (v - minP) / Math.max(1, maxP - minP)) * (PRICE_BOT - PRICE_TOP);

  const ticks = [minP, Math.round((minP + maxP) / 2), maxP];

  // Lines: agent price, real price, cheapest rival
  const agentPts = days.map((d, i) => `${x(i).toFixed(1)},${yPrice(d.price).toFixed(1)}`).join(' ');
  const realPts = days.map((d, i) => `${x(i).toFixed(1)},${yPrice(d.real_price_usd).toFixed(1)}`).join(' ');
  const rivalPts = days.map((_, i) => `${x(i).toFixed(1)},${yPrice(rivals[i]).toFixed(1)}`).join(' ');

  // Translucent promise cap band on sale days (from price down to price - cap)
  const saleIndices = days.map((d, i) => (d.is_sale_day ? i : -1)).filter((i) => i >= 0);
  const bandPath =
    !fullPromise && saleIndices.length > 1
      ? [
          `M ${saleIndices.map((i) => `${x(i).toFixed(1)} ${yPrice(days[i].price).toFixed(1)}`).join(' L ')}`,
          `L ${[...saleIndices]
            .reverse()
            .map((i) => `${x(i).toFixed(1)} ${yPrice(days[i].price - days[i].cap).toFixed(1)}`)
            .join(' L ')}`,
          'Z',
        ].join(' ')
      : '';
  const capBottomPts = fullPromise ? '' : saleIndices
    .map((i) => `${x(i).toFixed(1)},${yPrice(days[i].price - days[i].cap).toFixed(1)}`)
    .join(' ');

  // Shaded tail days (is_sale_day === false)
  const firstTailIdx = days.findIndex((d) => !d.is_sale_day);
  const tailStartX = firstTailIdx > 0 ? (x(firstTailIdx - 1) + x(firstTailIdx)) / 2 : null;

  const maxRefund = Math.max(1, ...days.map((d) => d.refunds_known_today_usd));
  const barMaxH = BAR_BOT - BAR_TOP;
  const colW = Math.max(10, Math.min(28, stepX * 0.68));

  const refundDay = days.find((d) => d.refunds_known_today_usd > 0)?.day ?? null;

  return (
    <div className="sim-chart-wrap">
      <div className="sim-chart-top">
        <div className="sim-eyebrow">
          <Icon name="shield" size={14} />{' '}
          {t(
            '2. 15-day run on real past prices — click any day to inspect its 6 buyer chats & nightly memo',
            '2. 過去の実価格での15日間 — 日をクリックすると6人の交渉と夜のメモを表示',
          )}
        </div>
        <div className="sim-quick-days">
          {bestDay && (
            <button
              className={`sim-qchip${selectedDay === bestDay ? ' on' : ''}`}
              onClick={() => onSelectDay(bestDay)}
            >
              <Icon name="check" size={13} /> {t(`Most sales (${shortDay(bestDay)})`, `最多販売の日 (${shortDay(bestDay)})`)}
            </button>
          )}
          {refundDay && (
            <button
              className={`sim-qchip refund${selectedDay === refundDay ? ' on' : ''}`}
              onClick={() => onSelectDay(refundDay)}
            >
              <Icon name="coin" size={13} /> {t(`Price drop & refund (${shortDay(refundDay)})`, `値下げと返金の日 (${shortDay(refundDay)})`)}
            </button>
          )}
        </div>
      </div>

      <svg
        className="sim-hero-svg"
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={t(
          '15-day chart of the AI seller agent price, 7-day promise band, store real price, cheapest rival, daily sales, and refunds',
          'AIエージェントの価格・7日間の約束の幅・実際の価格・最安競合・販売数・返金の推移グラフ',
        )}
        onMouseLeave={() => onHoverDay(null)}
      >
        {/* Shaded tail region (is_sale_day === false) */}
        {tailStartX != null && (
          <g>
            <rect
              x={tailStartX}
              y={PRICE_TOP - 8}
              width={W - PAD_R - tailStartX + 6}
              height={BAR_BOT - PRICE_TOP + 14}
              rx={6}
              className="sim-tail-shade"
            />
            <line
              x1={tailStartX}
              x2={tailStartX}
              y1={PRICE_TOP - 8}
              y2={BAR_BOT + 6}
              className="sim-tail-divider"
            />
            <text
              x={(tailStartX + W - PAD_R) / 2}
              y={PRICE_TOP + 8}
              textAnchor="middle"
              className="sim-svg-label tail-label"
            >
              {t('judging only', '判定のみ')}
            </text>
          </g>
        )}

        {/* Horizontal price grid lines */}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD_L} x2={W - PAD_R} y1={yPrice(v)} y2={yPrice(v)} className="sim-grid-line" />
            <text x={PAD_L - 6} y={yPrice(v) + 4} textAnchor="end" className="sim-svg-axis">
              ${v}
            </text>
          </g>
        ))}

        {/* Divider & baseline for sales/refunds strip */}
        <line x1={PAD_L} x2={W - PAD_R} y1={BAR_BOT} y2={BAR_BOT} className="sim-grid-line" />
        <text x={PAD_L - 6} y={BAR_BOT - 2} textAnchor="end" className="sim-svg-axis">
          {t('sales', '販売')}
        </text>

        {/* Active / selected day highlight column */}
        {days.map((d, i) => {
          const isSel = d.day === selectedDay;
          const isHov = d.day === activeDay;
          if (!isSel && !isHov) return null;
          return (
            <rect
              key={`hl-${d.day}`}
              x={x(i) - stepX / 2}
              y={PRICE_TOP - 8}
              width={stepX}
              height={BAR_BOT - PRICE_TOP + 14}
              rx={6}
              className={isSel ? 'sim-day-col-sel' : 'sim-day-col-hov'}
            />
          );
        })}

        {/* Promise cap translucent band on sale days */}
        {bandPath && <path d={bandPath} className="sim-cap-band" />}
        {capBottomPts && <polyline points={capBottomPts} fill="none" className="sim-cap-floor-line" />}
        {/* Full-difference runs: no cap band; a ring marks each day whose listing carries the promise */}
        {fullPromise &&
          saleIndices
            .filter((i) => days[i].cap > 0)
            .map((i) => (
              <circle key={`pr-${i}`} cx={x(i)} cy={yPrice(days[i].price)} r={7} fill="none" className="sim-cap-floor-line" />
            ))}

        {/* Cheapest rival line (thin muted) */}
        <polyline
          points={rivalPts}
          fill="none"
          pathLength={1000}
          className="sim-line-rival sim-line-draw"
        />

        {/* Store's real price (grey dashed) */}
        <polyline points={realPts} fill="none" className="sim-line-real" />

        {/* Agent's price (accent, thick, draws in on mount) */}
        <polyline
          points={agentPts}
          fill="none"
          pathLength={1000}
          className="sim-line-agent sim-line-draw"
        />

        {/* Per-day dots, sales bars, refund markers, x-axis labels, and hit targets */}
        {days.map((d, i) => {
          const cx = x(i);
          const cy = yPrice(d.price);
          const isSel = d.day === selectedDay;
          const salesH = d.sales_count > 0 ? Math.max(6, (d.sales_count / Math.max(1, buyersPerDay)) * (barMaxH - 12)) : 0;
          const refH =
            d.refunds_known_today_usd > 0
              ? Math.max(12, (d.refunds_known_today_usd / maxRefund) * (barMaxH - 12))
              : 0;
          const showDateLabel = i % 2 === 0 || isSel || d.refunds_known_today_usd > 0 || i === days.length - 1;
          return (
            <g key={d.day}>
              {/* Price dot on agent line */}
              <circle
                cx={cx}
                cy={cy}
                r={isSel ? 5.5 : d.sales_count > 0 ? 4 : 3}
                className={`sim-agent-dot${isSel ? ' sel' : ''}${d.refunds_known_today_usd > 0 ? ' refund' : ''}`}
              />

              {/* Sales bar (green) */}
              {salesH > 0 && (
                <g>
                  <rect
                    x={d.refunds_known_today_usd > 0 ? cx - colW * 0.55 : cx - colW * 0.38}
                    y={BAR_BOT - salesH}
                    width={d.refunds_known_today_usd > 0 ? colW * 0.5 : colW * 0.76}
                    height={salesH}
                    rx={3}
                    className="sim-bar-sales"
                  />
                  <text
                    x={d.refunds_known_today_usd > 0 ? cx - colW * 0.3 : cx}
                    y={BAR_BOT - salesH - 3}
                    textAnchor="middle"
                    className="sim-svg-bar-num good"
                  >
                    {d.sales_count}
                  </text>
                </g>
              )}

              {/* Red refund marker / bar on days with refunds_known_today_usd > 0 */}
              {refH > 0 && (
                <g>
                  <line
                    x1={cx}
                    x2={cx}
                    y1={cy + 6}
                    y2={BAR_BOT - refH - 14}
                    className="sim-refund-connector"
                  />
                  <rect
                    x={d.sales_count > 0 ? cx + 1 : cx - colW * 0.38}
                    y={BAR_BOT - refH}
                    width={d.sales_count > 0 ? colW * 0.5 : colW * 0.76}
                    height={refH}
                    rx={3}
                    className="sim-bar-refund"
                  />
                  <text
                    x={cx}
                    y={BAR_BOT - Math.max(refH, salesH) - 13}
                    textAnchor="middle"
                    className="sim-svg-refund-tag"
                  >
                    −${Math.round(d.refunds_known_today_usd)}
                  </text>
                </g>
              )}

              {/* X-axis day label */}
              {showDateLabel && (
                <text
                  x={cx}
                  y={H - 10}
                  textAnchor="middle"
                  className={`sim-svg-day${isSel ? ' sel' : ''}`}
                >
                  {shortDay(d.day)}
                </text>
              )}

              {/* Clickable / hoverable hit column */}
              <rect
                x={cx - stepX / 2}
                y={PRICE_TOP - 8}
                width={stepX}
                height={H - PRICE_TOP}
                fill="transparent"
                style={{ cursor: 'pointer' }}
                role="button"
                tabIndex={0}
                aria-label={`${shortDay(d.day)}: ${usd(d.price)}, ${d.sales_count} sales`}
                onClick={() => onSelectDay(d.day)}
                onMouseEnter={() => onHoverDay(d.day)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectDay(d.day);
                  }
                }}
              />
            </g>
          );
        })}
      </svg>

      {/* Legend with swatches */}
      <div className="sim-legend small">
        <span><span className="sim-sw agent" />{t('Agent’s price', 'エージェントの価格')}</span>
        <span><span className="sim-sw band" />{fullPromise ? t('Promise on (ring) / off', '約束あり（輪）/ なし') : t('7-day promise cap (down to price − cap)', '7日間の約束の幅（価格 − 上限）')}</span>
        <span><span className="sim-sw real" />{t('Store’s real price', '店の実際の価格')}</span>
        <span><span className="sim-sw rival" />{t('Cheapest rival', '最安の競合店')}</span>
        <span><span className="sim-sw sales" />{t('Sales per day', '1日の販売数')}</span>
        <span><span className="sim-sw refund" />{t('Refunds triggered', '発生した返金')}</span>
      </div>
    </div>
  );
}
