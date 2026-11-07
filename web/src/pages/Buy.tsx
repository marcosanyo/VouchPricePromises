// Buyer app (landing). One vertical flow: pick an item → set the spending cap
// → the agent asks the stores → store cards arrive → payment → the promise is
// monitored. States show by colour and shape: the chosen card turns green and
// grows, the others fade; waiting freezes the cards amber; a promise is a
// shield with its window gauge. The main story replays a past day D: the
// agents see only data up to D, pay a real Sandbox order at D's price, and
// "fast-forward" judges the promise on the real prices after D. For purchases
// made today, a separate, labelled action runs a broken
// promise end to end (a new Sandbox order at a store already undercut today,
// judged by the ordinary rules) and shows the refund flowing back. Nothing is
// scripted: the page renders the task's recorded events and the APIs' data.
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, usd } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { Icon } from '../components/Icon';
import { ProductArt } from '../components/ProductArt';
import { useAsync } from '../useAsync';
import { tReason, useT } from '../i18n';
import { shortDay } from '../viz';
import { Channel3Provenance } from '../components/VerifyBadge';

type Autonomy = 'ask' | 'protected' | 'full';
interface Item { group_key: string; title: string; stores: number; from_usd: number; to_usd: number; featured: boolean; prices: { store: string; price: number; can_promise?: boolean }[] }
interface Catalog { items: Item[]; runs_today: number; daily_limit: number; mandate_ttl_hours: number }
// A promise whose cap reaches the price paid refunds the full difference (the only kind now).
const isFullDiff = (p: { cap_usd: number } | null | undefined, price: number) => !!p && p.cap_usd >= price - 0.005;
export const promiseText = (t: (en: string, ja: string) => string, p: { cap_usd: number } | null | undefined, price: number) =>
  !p ? t('no promise', '約束なし') : isFullDiff(p, price) ? t('full difference refunded', '差額を全額返金') : `${usd(p.cap_usd)}`;

// What a store's answer is: the verifiable promise, the owner's fixed discount (no promise), or the plain list price.
export const discountPct = (o: { price: number; discount_usd: number }) => (o.discount_usd > 0 ? Math.round((o.discount_usd / (o.price + o.discount_usd)) * 100) : 0);
export const dealText = (t: (en: string, ja: string) => string, o: { price: number; discount_usd: number; promise: { cap_usd: number } | null }) =>
  o.promise ? promiseText(t, o.promise, o.price) : o.discount_usd > 0 ? t(`${discountPct(o)}% off · no promise`, `${discountPct(o)}% 値下げ · 約束なし`) : t('no promise', '約束なし');
// The owner's setting for the store's AI (set by code; see agents/merchant.ts). Tasks recorded earlier lack the new fields.
export interface OwnerLimits { price_negotiation?: boolean; max_discount_pct?: number; can_promise: boolean; max_promise_days?: number | null }
export const negotiationText = (t: (en: string, ja: string) => string, l: OwnerLimits) =>
  l.price_negotiation === undefined ? null : l.price_negotiation ? t(`Price negotiation: up to ${l.max_discount_pct}% off (demo assumption)`, `値下げ交渉: 最大${l.max_discount_pct}%（デモの仮定）`) : t('Price negotiation: declines', '値下げ交渉: 応じない');

interface Option { id: string; price: number; discount_usd: number; cost_to_store_usd?: number; basis?: string; promise: { claim_type: string; window_days: number; cap_usd: number } | null }
export interface Offer { store: string; option: Option; message: string; round: number; effective_cost_usd: number; unprotected_loss_usd: number }
interface LaneRisk { p_drop: number; expected_drop_usd: number; window_days: number; method: string }
export interface Lane { store: string; policy: string; member?: boolean; list_price?: number; was_price?: number | null; fake_sale?: { reason: string } | null; risk?: LaneRisk; verification?: { found: boolean; status: string; terms_hash: string | null }; owner_limits?: OwnerLimits; offers: Offer[]; error?: any }
export interface Event { seq: number; ts: string; actor: string; kind: string; payload: any }
export interface Purchase { store: string; price: number; order_id: string; capture_id?: string; seller: { slot: number; merchant: string | null; shared: boolean }; ap2?: any; contracts: { id: string; judge_after_day: string; stake_usd: number }[] }
export interface Task {
  id: string;
  group_key: string;
  autonomy: Autonomy;
  max_usd: number;
  status: 'running' | 'needs_approval' | 'waiting' | 'bought' | 'failed';
  state: { product: string; risk_weight?: number; buyer_note?: string; as_of?: string; lanes: Lane[]; decision?: any; purchase?: Purchase };
  events: Event[];
}

const hashParams = () => new URLSearchParams(location.hash.split('?')[1]);
const taskFromHash = () => hashParams().get('task');
// The buyer app opens on the replay of a real past day (the scenario where the promise has to beat
// a rival's discount); live shopping on today's prices is the second tab (#/buy?mode=live).
const modeFromHash = (): 'replay' | 'live' => (hashParams().get('mode') === 'live' ? 'live' : 'replay');

type DefaultReason = 'promise_beats_discount' | 'cheapest' | 'some_store' | 'latest' | null;
interface ReplaySummary { window_days: number; earliest_as_of?: string | null; featured_group?: string | null; items: { group_key: string; default_day: string | null; default_reason: DefaultReason; default_has_published?: boolean }[] }

export function Buy() {
  const t = useT();
  const catalog = useAsync(() => api.get<Catalog>('/api/shop/catalog'), []);
  const summary = useAsync(() => api.get<ReplaySummary>('/api/shop/replay-summary'), []);
  const [mode, setMode] = useState<'replay' | 'live'>(modeFromHash);
  const [pick, setPick] = useState<Item | null>(null);
  const [taskId, setTaskId] = useState<string | null>(taskFromHash);
  const setupRef = useRef<HTMLDivElement>(null);
  const replayable = new Map((summary.data?.items ?? []).map((x) => [x.group_key, x]));
  const items = (catalog.data?.items ?? []).filter((it) => mode === 'live' || replayable.has(it.group_key));
  useEffect(() => {
    const onHash = () => {
      const nextTask = taskFromHash();
      setTaskId(nextTask);
      if (!nextTask) {
        setMode(modeFromHash());
        setPick(null);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // In live mode, preselect the featured catalog item (if any).
  useEffect(() => {
    if (taskId || mode !== 'live' || pick || !catalog.data) return;
    const feat = catalog.data.items.find((it) => it.featured);
    if (feat) setPick(feat);
  }, [mode, taskId, catalog.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Replay opens on the #/demo item: a day where the store's published promise has to beat a
  // rival's discount (it is not the cheapest). Else an item where the cheapest store has a
  // published promise and its real price later fell; else any item where it fell.
  useEffect(() => {
    if (taskId || mode !== 'replay' || pick || !catalog.data || !summary.data) return;
    const beats = (g: string) => replayable.get(g)?.default_reason === 'promise_beats_discount';
    const first =
      catalog.data.items.find((it) => it.group_key === summary.data!.featured_group && beats(it.group_key)) ??
      catalog.data.items.find((it) => beats(it.group_key)) ??
      catalog.data.items.find((it) => {
        const r = replayable.get(it.group_key);
        return r?.default_reason === 'cheapest' && r?.default_has_published;
      }) ?? catalog.data.items.find((it) => replayable.get(it.group_key)?.default_reason === 'cheapest');
    if (first) setPick(first);
  }, [mode, taskId, catalog.data, summary.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pick) setupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [pick]);

  if (taskId) {
    return (
      <div className="page app">
        <TaskBoard
          id={taskId}
          onBack={() => { setTaskId(null); setPick(null); location.hash = mode === 'replay' ? '#/buy?mode=replay' : '#/buy?mode=live'; catalog.reload(); }}
          onReplay={() => { setTaskId(null); setMode('replay'); setPick(null); location.hash = '#/buy?mode=replay'; catalog.reload(); }}
          onSwitchTask={(newId) => { setTaskId(newId); location.hash = `#/buy?task=${newId}`; catalog.reload(); }}
        />
      </div>
    );
  }
  return (
    <div className="page app">
      <div className="app-head">
        <h1>{t('Hand your shopping to an agent', 'エージェントに買い物を任せる')}</h1>
        <div className="tag-note">{t('Real Channel3 prices · PayPal Sandbox · demo store names', 'Channel3 の実価格 · PayPal Sandbox · 店は仮名')}</div>
      </div>
      <div className="seg mode-switch" role="group" aria-label={t('When to shop', 'いつ買うか')}>
        <button className={mode === 'replay' ? 'on' : ''} onClick={() => { setMode('replay'); setPick(null); location.hash = '#/buy?mode=replay'; }}><Icon name="clock" size={16} /> {t('A real past day: does a promise beat a discount?', '実際の過去の日: 約束は値下げに勝つか')}</button>
        <button className={mode === 'live' ? 'on' : ''} onClick={() => { setMode('live'); setPick(null); location.hash = '#/buy?mode=live'; }}><Icon name="cart" size={16} /> {t("Shop today (today's prices)", '今日買う（今日の価格）')}</button>
      </div>
      <StepStrip active={pick ? 1 : 0} />
      <ErrorBox error={catalog.error ?? summary.error} />
      <div className="picker">
        {items.map((it) => (
          <button key={it.group_key} className={`pitem${pick?.group_key === it.group_key ? ' on' : ''}`} onClick={() => setPick(it)} aria-pressed={pick?.group_key === it.group_key}>
            {pick?.group_key === it.group_key && <span className="pitem-check"><Icon name="check" size={16} /></span>}
            <ProductArt title={it.title} />
            <span className="pitem-title">{it.title.split(' · ')[0]}</span>
            <span className="pitem-price">{usd(it.from_usd)}{it.to_usd > it.from_usd ? ` – ${usd(it.to_usd)}` : ''}</span>
            <span className="pitem-stores"><Icon name="store" size={14} /> {it.stores}</span>
          </button>
        ))}
      </div>
      <div ref={setupRef}>
        {pick && catalog.data && <Setup key={`${mode}-${pick.group_key}`} item={pick} replay={mode === 'replay'} ttlHours={catalog.data.mandate_ttl_hours} runsLeft={catalog.data.daily_limit - catalog.data.runs_today} onStarted={(id) => { setTaskId(id); location.hash = `#/buy?task=${id}`; }} onCancel={() => setPick(null)} />}
      </div>
    </div>
  );
}

// Pick → cap → agent at work → paid → watched. Lit up to `active`.
function StepStrip({ active }: { active: number }) {
  const t = useT();
  const steps: { icon: string; t: [string, string] }[] = [
    { icon: 'cart', t: ['Pick', '選ぶ'] },
    { icon: 'lock', t: ['Cap', '上限'] },
    { icon: 'megaphone', t: ['Offers', '申し出'] },
    { icon: 'card', t: ['Pay', '支払い'] },
    { icon: 'shieldCheck', t: ['Watched', '見張り'] },
  ];
  return (
    <ol className="strip">
      {steps.map((s, i) => (
        <li key={i} className={i < active ? 'done' : i === active ? 'now' : ''}>
          <span className="strip-dot"><Icon name={s.icon} size={18} /></span>
          <span className="small">{t(...s.t)}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------- Setup: the spending cap ----------------

function CapBar({ prices, cap, onCap, maxHint }: { prices: { store: string; price: number }[]; cap: number; onCap: (v: number) => void; maxHint?: number }) {
  const t = useT();
  const lo = Math.floor(Math.min(...prices.map((p) => p.price)) * 0.95);
  // The scale reaches past the default cap, so the default never sits pinned at the end.
  const hi = Math.ceil(Math.max(Math.max(...prices.map((p) => p.price)) * 1.05, (maxHint ?? 0) * 1.03));
  const x = (v: number) => `${((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * 100}%`;
  const edge = (Math.min(Math.max(cap, lo), hi) - lo) / (hi - lo);
  return (
    <div className="capbar">
      <div className="capbar-track">
        <div className="capbar-ok" style={{ width: x(cap) }} />
        {prices.map((p) => (
          <span key={p.store} className={`capbar-dot ${p.price <= cap ? 'in' : 'out'}`} style={{ left: x(p.price) }} title={`${p.store} ${usd(p.price)}`} />
        ))}
        <span className="capbar-line" style={{ left: x(cap) }}>
          <span className={`capbar-lock${edge > 0.88 ? ' end' : edge < 0.12 ? ' start' : ''}`}><Icon name="lock" size={14} /> {usd(cap)}</span>
        </span>
      </div>
      <input type="range" min={lo} max={hi} step={1} value={Math.min(Math.max(cap, lo), hi)} onChange={(e) => onCap(Number(e.target.value))} aria-label={t('Spending cap', '支払いの上限')} />
      <div className="capbar-scale small"><span>{usd(lo)}</span><span>{usd(hi)}</span></div>
    </div>
  );
}

interface ReplayDay { day: string; window_end: string; stores: { store: string; price: number; can_promise: boolean; has_published?: boolean; dropped_to: { day: string; price: number } | null }[] }
interface ReplayDays { window_days: number; earliest_as_of?: string | null; days: ReplayDay[]; default_day: string | null; default_reason: DefaultReason; default_has_published?: boolean }

function Setup({ item, replay, ttlHours, onStarted, onCancel, runsLeft }: { item: Item; replay: boolean; ttlHours: number; onStarted: (id: string) => void; onCancel: () => void; runsLeft: number }) {
  const t = useT();
  const rdays = useAsync(() => (replay ? api.get<ReplayDays>(`/api/shop/replay-days/${encodeURIComponent(item.group_key)}`) : Promise.resolve(null)), [replay, item.group_key]);
  const [day, setDay] = useState<string | null>(null);
  useEffect(() => setDay(rdays.data?.default_day ?? null), [rdays.data]);
  const rd = rdays.data?.days.find((d) => d.day === day) ?? null;
  const prices = replay ? (rd?.stores ?? []).map(({ store, price, can_promise }) => ({ store, price, can_promise })) : item.prices;
  const low = prices.length ? Math.min(...prices.map((p) => p.price)) : item.from_usd;
  const lowPromise = prices.filter((p) => p.can_promise !== false).map((p) => p.price);
  const defaultCap = Math.ceil(Math.max(low * 1.08, lowPromise.length ? Math.min(...lowPromise) : low));
  const [cap, setCap] = useState(defaultCap);
  const [autonomy, setAutonomy] = useState<Autonomy>('full');
  const [weight, setWeight] = useState(5);
  const [buyerNote, setBuyerNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => setCap(defaultCap), [item.group_key, defaultCap]);
  const inside = prices.filter((p) => p.price <= cap).length;
  const insidePromise = prices.filter((p) => p.price <= cap && p.can_promise !== false).length;
  const modes: { k: Autonomy; icon: string; t: [string, string] }[] = [
    { k: 'full', icon: 'bot', t: ['Agent decides: buy or wait', '買うか待つかを任せる'] },
    { k: 'protected', icon: 'shield', t: ['Only with a price promise', '値下がりの約束がある店だけ'] },
    { k: 'ask', icon: 'check', t: ['Ask me before paying', '払う前に聞く'] },
  ];
  // `say` is the sentence the buyer agent receives (preferenceLabel in server/src/agents/shopper.ts).
  const prefs: { w: number; t: [string, string]; say: [string, string] }[] = [
    { w: 1, t: ['price only', '価格だけ'], say: ['The user cares mostly about the price today.', '利用者は主に今日の価格を気にしている。'] },
    { w: 5, t: ['I mind a drop', '値下がりは気になる'], say: ['The user minds the price dropping after they buy.', '利用者は買った後の値下がりを気にする。'] },
    { w: 10, t: ['I hate a drop', '値下がりは絶対いや'], say: ['The user strongly dislikes the price dropping after they buy.', '利用者は買った後の値下がりをとても嫌う。'] },
  ];
  const notePresets: { val: string; label: [string, string] }[] = [
    { val: '', label: ['Standard', '指定なし'] },
    { val: 'Need it this week, but do not want to overpay right before a sale.', label: ['Need this week · avoid overpaying', '今週必要だがセール前の高値掴みは避けたい'] },
    { val: 'In no rush—happy to wait for Black Friday unless the store covers any price drop.', label: ['Can wait unless drop is covered', '保証がないならセールまで待てる'] },
    { val: 'Strict budget—prioritize the lowest upfront checkout price today.', label: ['Lowest upfront price', '今日の支払額の安さを最優先'] },
  ];
  const say = prefs.find((p) => p.w === weight)?.say;
  return (
    <div className="card setup">
      <div className="setup-item">
        <ProductArt title={item.title} size="lg" />
        <div>
          <div className="setup-title">{item.title}</div>
          {replay
            ? <div className="muted small"><Icon name="clock" size={14} /> {rd ? t(`${prices.length} stores on ${shortDay(rd.day)}`, `${shortDay(rd.day)} に ${prices.length} 店`) : '…'}{rd && <> · {usd(low)} – {usd(Math.max(...prices.map((p) => p.price)))}</>}</div>
            : <div className="muted small"><Icon name="store" size={14} /> {t(`${item.stores} stores today`, `今日 ${item.stores} 店`)} · {usd(item.from_usd)} – {usd(item.to_usd)}</div>}
        </div>
      </div>
      <Channel3Provenance groupKey={item.group_key} />
      {replay && <ErrorBox error={rdays.error} />}
      {replay && rdays.data && <ReplayDayPicker data={rdays.data} day={day} onDay={setDay} />}
      {prices.length > 0 && <div className="setup-cap mandate-panel">
        <div className="mandate-head">
          <span className="mandate-icon"><Icon name="lock" size={20} /></span>
          <div>
            <b>{t('Your AP2 mandate: the limits you sign for your agent', 'AP2 の委任: エージェントに任せる範囲（あなたが署名する）')}</b>
            <div className="small muted">{t('Drag to set the most your agent may pay (the dots are the stores’ prices that day). The store and PayPal both check your signature; the agent cannot pay more, buy elsewhere, or after it expires.', 'つまみで、エージェントが払ってよい上限を決める（点はその日の各店の価格）。店と PayPal の両方があなたの署名を確かめるので、上限を超えて払うことも、ほかの店や期限の後に買うこともできない。')}</div>
          </div>
        </div>
        <CapBar prices={prices} cap={cap} onCap={setCap} maxHint={defaultCap} />
        <div className="lockchips">
          <span className="lockchip"><Icon name="lock" size={15} /> ≤ {usd(cap)}</span>
          <span className="lockchip"><Icon name="store" size={15} /> {t(`${prices.length} stores, this item only`, `${prices.length} 店・この商品だけ`)}</span>
          <span className="lockchip"><Icon name="clock" size={15} /> {t(`expires in ${ttlHours} h`, `${ttlHours} 時間で失効`)}</span>
        </div>
        <div className="muted small">
          {t(`${inside} of ${prices.length} store prices are inside your cap (${insidePromise} can offer a price promise).`, `${prices.length} 店のうち ${inside} 店の価格が上限の内側（うち ${insidePromise} 店が値下がりの約束に対応）。`)}
        </div>
        {insidePromise === 0 && lowPromise.length > 0 && (
          <div className="small warn"><Icon name="alert" size={14} /> {t(`Stores that can offer a price promise start at ${usd(Math.min(...lowPromise))} — above your current cap ${usd(cap)}.`, `値下がりの約束を出せる店は ${usd(Math.min(...lowPromise))} からで、現在の上限 ${usd(cap)} を超えています。`)}</div>
        )}
      </div>}
      <div className="modes">
        {modes.map((m) => (
          <button key={m.k} className={`mode${autonomy === m.k ? ' on' : ''}`} onClick={() => setAutonomy(m.k)} aria-pressed={autonomy === m.k}>
            <Icon name={m.icon} size={22} />
            <span>{t(...m.t)}</span>
          </button>
        ))}
      </div>
      <div className="seg" role="group" aria-label={t('If the price drops after buying', '買った後に値下がりしたら')}>
        <span className="seg-label small"><Icon name="shield" size={14} /></span>
        {prefs.map((p) => <button key={p.w} className={weight === p.w ? 'on' : ''} onClick={() => setWeight(p.w)}>{t(...p.t)}</button>)}
      </div>
      {/* Optional, so folded: the default run needs only the cap, the mode and the button. */}
      <details className="buyer-note-box" open={!!buyerNote}>
        <summary className="small" style={{ fontWeight: 600 }}>
          <Icon name="megaphone" size={14} /> {t('Your situation, told only to your agent; stores never see it (optional)', 'あなたの状況（任意）。あなたのエージェントにだけ伝え、店には見せない')}
        </summary>
        <div className="buyer-note-chips" role="group" aria-label={t('Buyer situation presets', '買い手の状況プリセット')}>
          {notePresets.map((np) => (
            <button
              key={np.val || 'std'}
              type="button"
              className={`chip-btn${buyerNote === np.val ? ' on' : ''}`}
              onClick={() => setBuyerNote(np.val)}
            >
              {t(...np.label)}
            </button>
          ))}
        </div>
        <input
          type="text"
          className="buyer-note-input"
          value={buyerNote}
          maxLength={240}
          placeholder={t('Or type a note told only to your agent…', 'またはあなたのエージェントにだけ伝える一言を入力…')}
          onChange={(e) => setBuyerNote(e.target.value)}
        />
      </details>
      {say && (
        <div className="muted small">
          <Icon name="bot" size={14} /> {t('Your agent is told:', 'エージェントへの指示:')} “{t(...say)}”
          {buyerNote.trim() ? <> · “{buyerNote.trim()}”</> : null}
        </div>
      )}
      <div className="row" style={{ alignItems: 'center' }}>
        <button className="primary big" disabled={busy || runsLeft <= 0 || (replay && !rd)} onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            const r = await api.post<{ id: string }>('/api/shop/tasks', { group_key: item.group_key, autonomy, max_usd: cap, risk_weight: weight, ...(buyerNote.trim() ? { buyer_note: buyerNote.trim() } : {}), ...(replay && rd ? { as_of: rd.day } : {}) });
            onStarted(r.id);
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}><Icon name="lock" /> {busy ? t('Signing…', '署名中…') : t('Sign the AP2 mandate and hand over', 'AP2 の委任に署名して任せる')}</button>
        <button onClick={onCancel}>{t('Back', '戻る')}</button>
        <span className="muted small">{t(`${runsLeft} runs left today (Sandbox)`, `今日はあと ${runsLeft} 回（Sandbox）`)}</span>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

// Past days this item can be replayed on. The default day is picked because
// something happens after it, and the reason is printed, not hidden.
function ReplayDayPicker({ data, day, onDay }: { data: ReplayDays; day: string | null; onDay: (d: string) => void }) {
  const t = useT();
  const rd = data.days.find((d) => d.day === day);
  const recent = data.days.slice(-21);
  const def = data.default_day ? shortDay(data.default_day) : '';
  const reason = {
    promise_beats_discount: t(`Default ★ ${def}: a rival's AI takes 3% off and undercuts the store with a published promise, the model gave a real chance of a drop, and the store's real price then fell within ${data.window_days} days. The promise has to win against a discount here, not by being cheapest. Pick any day.`, `既定 ★ ${def}：競合の AI が3%値下げして、約束を公開した店より安くなる日。モデルの値下がり確率もそれなりにあり、店の実際の価格はその後 ${data.window_days} 日以内に下がった。約束は最安だからではなく、値下げに勝たないと選ばれない。どの日でも選べる。`),
    cheapest: t(`Default ★ ${def}: the latest day after which the cheapest store's real price fell within ${data.window_days} days. Chosen so that something happens; pick any day.`, `既定 ★ ${def}：最安の店の実際の価格が ${data.window_days} 日以内に下がった直近の日。何かが起きる日として選んだ。どの日でも選べる。`),
    some_store: t(`Default ★ ${def}: the latest day after which some store's real price fell within ${data.window_days} days. Pick any day.`, `既定 ★ ${def}：どこかの店の実際の価格が ${data.window_days} 日以内に下がった直近の日。どの日でも選べる。`),
    latest: t(`Default ★ ${def}: the latest day with real prices for the whole window. No store's price fell after any of these days.`, `既定 ★ ${def}：期間の実際の価格がそろう最新の日。どの日の後も値下がりはなかった。`),
  }[data.default_reason ?? 'latest'];
  const isTemporal = !!(rd && data.earliest_as_of && rd.day >= data.earliest_as_of);
  return (
    <div className="replay-pick">
      <div className="replay-banner"><Icon name="clock" size={18} /> <span><b>{t('Replay of a past day', '過去の日の再現')}</b> — {t("prices and verdict are real data; the promise is hypothetical. The agents see only data up to that day. A real Sandbox order is paid at that day's price.", '価格と判定は実データ、約束は仮定。エージェントはその日までのデータだけを見る。その日の価格で Sandbox の実注文を払う。')}</span></div>
      <div className="daychips" role="group" aria-label={t('Day to replay', '再現する日')}>
        {recent.map((d) => {
          const drop = d.stores.some((x) => x.dropped_to);
          return (
            <button key={d.day} className={`daychip${d.day === day ? ' on' : ''}${drop ? ' drop' : ''}`} onClick={() => onDay(d.day)} aria-pressed={d.day === day} title={drop ? t("a store's price fell later", 'のちに値下がりした店あり') : ''}>
              {shortDay(d.day)}{d.day === data.default_day && <span className="daychip-def">★</span>}
            </button>
          );
        })}
      </div>
      <div className="muted small"><span className="daychip-key" /> {t('a store\'s real price fell afterwards', 'のちに実際の価格が下がった店がある日')}</div>
      <div className="small">{reason}</div>
      {rd && (
        <div className="muted small">
          {isTemporal
            ? t(`Judged on real prices ${shortDay(rd.day)} → ${shortDay(rd.window_end)}. Drop risk uses the strictly causal as-of ${shortDay(rd.day)} model (trained only on 14-day windows already resolved by ${shortDay(rd.day)}).`, `${shortDay(rd.day)} → ${shortDay(rd.window_end)} の実際の価格で判定。値下がり予測は ${shortDay(rd.day)} 時点で確定済みの 14 日期間のみで学習した時系列モデルを使用（未来情報のリークなし）。`)
            : t(`Judged on real prices ${shortDay(rd.day)} → ${shortDay(rd.window_end)}. Because fewer than 300 14-day windows had resolved before ${shortDay(rd.day)}, drop risk uses a 5-fold out-of-group model with this product group excluded from training.`, `${shortDay(rd.day)} → ${shortDay(rd.window_end)} の実際の価格で判定。${shortDay(rd.day)} 以前は確定済みの 14 日期間が 300 件未満のため、この商品群を学習から除外した 5 分割交差検証モデルを使用。`)}
        </div>
      )}
    </div>
  );
}

// ---------------- The flow: cap → store cards → payment → monitoring ----------------

export function runningLabel(events: Event[], t: (en: string, ja: string) => string): string {
  const last = events.at(-1)?.kind;
  if (!last || last === 'cart' || last === 'mandate_signed') return t('Signing AP2 open mandates & checking Channel3 prices…', 'AP2 委任に署名し Channel3 の価格を確認中…');
  const rfqSent = events.some((e) => e.kind === 'rfq');
  if (last === 'rfq' || (last === 'offer' && rfqSent && !events.some((e) => e.kind === 'counter'))) return t('Asking member stores’ AI agents for offers…', '加盟店の AI エージェントに見積もりを依頼中…');
  if (last === 'counter' || (last === 'offer' && rfqSent && !events.some((e) => e.kind === 'evaluating'))) return t('Pushing back on member stores that are not in front…', '首位以外の加盟店に条件改善を交渉中…');
  if (last === 'evaluating' || last === 'offer') return t('Comparing final offers & Vouch drop-risk estimates…', '各店の最終条件と値下がりリスクを比較して判断中…');
  if (last === 'vouch_ranking' || last === 'decide') return t('Signing closed AP2 mandates & creating PayPal order…', 'AP2 限定委任に署名し PayPal 注文を作成中…');
  return t('Verifying AP2 mandate chain & capturing PayPal Sandbox payment…', 'AP2 委任チェーンを検証し PayPal Sandbox で決済確定中…');
}

function TaskBoard({ id, onBack, onReplay, onSwitchTask }: { id: string; onBack: () => void; onReplay: () => void; onSwitchTask: (newId: string) => void }) {
  const t = useT();
  const [task, setTask] = useState<Task>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const [ffDone, setFfDone] = useState(false);
  useEffect(() => setFfDone(false), [id]);
  useEffect(() => {
    let stop = false;
    api.get<Task>(`/api/shop/tasks/${id}`).then((r) => { if (!stop) setTask(r); }, setError);
    return () => { stop = true; };
  }, [id, tick]);
  useEffect(() => {
    if (task && task.status !== 'running') return;
    const h = setTimeout(() => setTick((x) => x + 1), 650);
    return () => clearTimeout(h);
  }, [task, tick]);

  const decision = task?.state.decision;
  const winner = decision && !decision.wait ? decision.store : null;
  const status = task?.status;
  const hasOffers = task?.state.lanes.some((l) => l.offers.length);
  const errors = task?.events.filter((e) => e.kind === 'error') ?? [];
  const lanes = task?.state.lanes ?? [];
  const asOf = task?.state.as_of;
  const counterEvents = task?.events.filter((e) => e.kind === 'counter') ?? [];
  const round2Started = counterEvents.length > 0;
  const evaluatingStarted = task?.events.some((e) => e.kind === 'evaluating') ?? false;
  const rfqStarted = task?.events.some((e) => e.kind === 'rfq') ?? false;
  const step: 1 | 2 | 3 | 4 = (asOf ? status === 'bought' && ffDone : status === 'bought') ? 4 : decision || evaluatingStarted ? 3 : rfqStarted ? 2 : 1;
  const leadStore: string | null =
    counterEvents[0]?.payload?.lead_store ??
    (round2Started ? lanes.find((l) => !l.error && l.offers.length && !counterEvents.some((e) => e.payload?.store === l.store) && l.policy !== 'holdout')?.store ?? null : null);
  const leadPrice = counterEvents[0]?.payload?.lead_price as number | undefined;
  const leadCap = counterEvents[0]?.payload?.lead_promise_cap as number | null | undefined;
  const isNegotiatingRound2 = status === 'running' && round2Started && !evaluatingStarted && !decision;
  // One scale for every card's bar: price plus the unprotected expected loss.
  const finals = lanes.map((l) => l.offers.at(-1)).filter((o): o is Offer => !!o);
  const barMax = finals.length ? Math.max(...finals.map((o) => o.option.price + o.unprotected_loss_usd)) : 1;
  const barMin = finals.length ? Math.min(...finals.map((o) => o.option.price)) * 0.97 : 0;
  const summaryText = decision ? (t.ja && decision.summary_ja ? decision.summary_ja : decision.summary) : null;
  return (
    <>
      <div className="app-head">
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          <button onClick={onBack} aria-label={t('Back to items', '商品に戻る')}><Icon name="arrowBack" size={16} /></button>
          <ProductArt title={task?.state.product} size="sm" />
          <div className="setup-title">{task?.state.product ?? '…'}</div>
        </div>
        <div className="tag-note">{t('Prices: Channel3 · payment: PayPal Sandbox · store plans: demo assumption', '価格: Channel3 · 支払い: PayPal Sandbox · 店の方針: デモ用の仮定')}</div>
      </div>
      {asOf && <div className="replay-banner"><Icon name="clock" size={18} /> <span><b>{t(`Replay of ${shortDay(asOf)}`, `${shortDay(asOf)} の再現`)}</b> — {t('prices and verdict are real data; the promise is hypothetical. The agents saw only data up to that day.', '価格と判定は実データ、約束は仮定。エージェントはその日までのデータだけを見た。')}</span></div>}
      <FlowSteps step={step} asOf={!!asOf} />
      <ErrorBox error={error} />
      {errors.map((e) => <ErrorBox key={e.seq} error={{ body: e.payload, status: e.payload.status, message: e.payload.message ?? e.kind } as any} />)}
      {task && (
        <div className={`flowv s-${status}`}>
          <div className="flow-cap">
            <Icon name="lock" size={16} /> <b>{usd(task.max_usd)}</b>
            <span className="cap-mini">
              {lanes.filter((l) => l.list_price != null).map((l) => {
                const lo = Math.min(...lanes.map((x) => x.list_price ?? Infinity), task.max_usd) * 0.95;
                const hi = Math.max(...lanes.map((x) => x.list_price ?? 0), task.max_usd) * 1.05;
                return <span key={l.store} className={`capbar-dot ${l.list_price! <= task.max_usd ? 'in' : 'out'}`} style={{ left: `${((l.list_price! - lo) / (hi - lo)) * 100}%` }} />;
              })}
            </span>
            <span className="muted small">{status === 'running' ? <>{runningLabel(task.events, t)}<span className="spin" /></> : t('your cap', 'あなたの上限')}</span>
          </div>
          <div className={`down${hasOffers ? ' lit' : ' live'}`} aria-hidden="true" />
          {isNegotiatingRound2 && (
            <div className="neg-bar">
              <span className="neg-pulse-icon"><Icon name="megaphone" size={16} /></span>
              <span>
                <b>{t('Round 2 push-back:', '第2ラウンド交渉中：')}</b>{' '}
                {leadStore && leadPrice != null
                  ? t(
                      `Using leader ${leadStore} (${usd(leadPrice)}${leadCap ? ' + full-difference promise' : ''}) to ask other stores for a lower price or stronger promise…`,
                      `首位の ${leadStore}（${usd(leadPrice)}${leadCap ? '・差額を全額返金' : ''}）を引き合いに、他店へ値下げ・保証強化を交渉中…`,
                    )
                  : t('Asking non-leading stores whether they can beat the leader on price or protection…', '首位以外の店に、首位の条件を上回れるか再交渉中…')}
              </span>
            </div>
          )}
          {lanes.length > 0 && (
            <div className="member-line small">
              <Icon name="shield" size={14} />{' '}
              {t(
                'Your agent asks the stores that have an AI agent for a better deal. A store whose owner turned negotiation off answers with its promise; one that allows it may take a small fixed % off (demo assumption, no promise). Other stores are compared at their listed price.',
                'あなたのエージェントは、AI エージェントのいる店に条件を頼みます。店主が値下げ交渉を切っている店は約束で答え、許している店は小さな固定の値引き（デモの仮定・約束なし）に応じることがあります。ほかの店は出品価格のまま比べます。',
              )}
            </div>
          )}
          <div className={`cards${status === 'waiting' ? ' frozen' : ''}${winner ? ' decided' : ''}${status === 'running' && evaluatingStarted && !decision ? ' evaluating' : ''}`}>
            {lanes.map((l) => (
              <StoreCard
                key={l.store}
                lane={l}
                maxUsd={task.max_usd}
                winner={winner === l.store}
                barMin={barMin}
                barMax={barMax}
                taskRunning={status === 'running'}
                round2Started={round2Started}
                isLead={leadStore === l.store}
                leadStore={leadStore}
                countered={counterEvents.some((e) => e.payload?.store === l.store)}
              />
            ))}
          </div>
          {hasOffers && (
            <>
              <div className="down lit" aria-hidden="true" />
              <NegotiationGraph
                lanes={lanes}
                events={task.events}
                winner={winner}
                maxUsd={task.max_usd}
                riskWeight={task.state.risk_weight ?? 5}
                buyerNote={task.state.buyer_note}
                taskRunning={status === 'running'}
              />
            </>
          )}
          {decision && (
            <>
              <div className={`down${status === 'bought' ? ' paid' : status === 'waiting' ? ' stop' : ' lit'}`} aria-hidden="true" />
              <DropCoverGauge lanes={lanes} winner={winner} />
            </>
          )}
          <div className={`down${status === 'bought' ? ' paid' : status === 'waiting' ? ' stop' : ''}`} aria-hidden="true" />
          <VerifyChecks events={task.events} />
          <Outcome task={task} onApproved={() => setTick((x) => x + 1)} />
          {status === 'waiting' && <ReRunWait task={task} onStarted={onSwitchTask} />}
          {status === 'waiting' && asOf && (<><div className="down stop" aria-hidden="true" /><FastForwardWait id={id} onFastForward={() => setFfDone(true)} /></>)}
          {status === 'bought' && task.state.purchase?.contracts.length ? (<><div className="down paid" aria-hidden="true" />{asOf ? <FastForward id={id} store={task.state.purchase.store} onFastForward={() => setFfDone(true)} /> : <PromiseWatch id={id} />}</>) : null}
          {status === 'bought' && asOf && !task.state.purchase?.contracts.length && <div className="small muted">{t('Bought without a price promise, so there is nothing to fast-forward.', '値下がりの約束なしで買ったので、早送りするものはない。')}</div>}
          {summaryText && <div className="agent-says small"><Icon name="bot" size={16} /> “{summaryText}”</div>}
          {!asOf && status !== 'running' && (
            <>
              <div className="down lit" aria-hidden="true" />
              <ReplayCta onReplay={onReplay} />
            </>
          )}
          {asOf && status !== 'running' && <AfterReplay />}
          {status !== 'running' && <TechProof task={task} />}
        </div>
      )}
    </>
  );
}

// What the agent actually does, in order. Highlights the current step.
function FlowSteps({ step, asOf }: { step: 1 | 2 | 3 | 4; asOf: boolean }) {
  const t = useT();
  const steps: { n: 1 | 2 | 3 | 4; icon: string; t: [string, string] }[] = [
    { n: 1, icon: 'tag', t: ['1 Price and drop estimate', '1 価格と値下がりの見込み'] },
    { n: 2, icon: 'bot', t: ['2 Talk to member stores’ AI', '2 加盟店の AI と交渉'] },
    { n: 3, icon: 'cart', t: ['3 Decide and buy', '3 判断・購入'] },
    { n: 4, icon: 'receipt', t: [asOf ? '4 Refund check (14 days later)' : '4 Refund check (after the window)', asOf ? '4 返金の判定（14日後）' : '4 返金の判定（期間の終わり）'] },
  ];
  return (
    <ol className="step-strip" aria-label={t('Steps', '手順')}>
      {steps.map((a, i) => {
        const state = a.n < step ? 'done' : a.n === step ? 'now' : 'todo';
        return (
          <li key={a.n} className={`step-item ${state}`}>
            <div className="step-pill">
              <span className="step-dot"><Icon name={a.icon} size={18} /></span>
              <span className="step-text">{t(...a.t)}</span>
            </div>
            {i < steps.length - 1 && (
              <span className={`step-conn${step > a.n ? ' lit' : step === a.n ? ' flow' : ''}`} aria-hidden="true">
                <span className="step-conn-line" />
                <span className="step-conn-arrow">→</span>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// Multi-turn agent-to-agent negotiation trajectory graph.
function NegotiationGraph({
  lanes,
  events,
  winner,
  maxUsd,
  buyerNote,
  taskRunning,
}: {
  lanes: Lane[];
  events: Event[];
  winner: string | null;
  maxUsd: number;
  riskWeight: number;
  buyerNote?: string;
  taskRunning: boolean;
}) {
  const t = useT();
  const promiseOf = (o: Offer) => promiseText(t, o.option.promise, o.option.price);
  const rows = lanes.filter((l) => l.member && l.offers.length > 0 && l.list_price != null);
  const listed = lanes.filter((l) => !l.member && l.offers.length > 0 && l.list_price != null);
  if (!rows.length && !listed.length) return null;

  const rfqEvent = events.find((e) => e.kind === 'rfq');
  const counterEvents = events.filter((e) => e.kind === 'counter');
  const leadStore = counterEvents[0]?.payload?.lead_store as string | undefined;

  const metrics = rows.map((l) => {
    const r1 = l.offers[0];
    const r2 = l.offers.length >= 2 ? l.offers[1] : null;
    return { lane: l, r1, r2, finalOffer: r2 ?? r1 };
  });

  return (
    <div className="card neg-graph" aria-label={t('Multi-turn negotiation trajectory', 'AI エージェント間の交渉履歴グラフ')}>
      <div className="neg-graph-head">
        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
          <span className="seller-badge"><Icon name="bot" size={18} /></span>
          <div>
            <div className="dc-title">
              {t('Negotiation with member stores (Round 1 → Round 2)', '加盟店の AI との交渉（第1R → 第2R）')}
            </div>
            <div className="small muted">
              {t(
                'Round 1 asks each store’s AI for its best offer. Round 2 shows trailing stores the leader’s offer. Each store can only use what its owner allows: a published promise (no discount), or a fixed small discount (no promise).',
                '第1Rは各店の AI に最良の条件を頼む。第2Rは首位の条件を見せる。各店が使えるのは店主が許した範囲だけ: 公開した約束（値引きなし）か、小さな固定の値引き（約束なし）。',
              )}
            </div>
          </div>
        </div>
        {buyerNote && (
          <div className="neg-note-pill small">
            <Icon name="megaphone" size={13} /> <span className="muted">{t('told only to your agent', 'あなたのエージェントだけが知っている')}:</span> <span>“{buyerNote}”</span>
          </div>
        )}
      </div>

      {/* Round 1 → Round 2 as two panels joined by an arrow, so the negotiation reads as a flow. */}
      <div className="neg-round">
        <div className="neg-round-head"><span className="neg-round-n">1</span> <b>{t('Round 1 · your agent asks each store’s AI for its best offer', '第1R · エージェントが各店の AI に最良の条件を頼む')}</b></div>
        {rfqEvent?.payload?.message && <div className="neg-quote small">“{rfqEvent.payload.message}”</div>}
        <div className="neg-round-grid">
          {metrics.map(({ lane, r1 }) => {
            const lead = leadStore === lane.store;
            return (
              <div key={lane.store} className={`neg-store-box${lead ? ' r1-lead' : ''}`}>
                <div className="neg-turn-top">
                  <span className="row" style={{ alignItems: 'center', gap: 6 }}><Icon name="store" size={14} /> <b>{lane.store}</b></span>
                  <span className="neg-offer-chip">
                    <b>{usd(r1.option.price)}</b>
                    {r1.option.promise ? <span className="neg-cap-tag good"><Icon name="shield" size={11} /> {t('full difference', '差額を全額')}</span> : <span className="neg-cap-tag none">{dealText(t, r1.option)}</span>}
                  </span>
                </div>
                <div className="tiny muted">
                  {t(`List ${usd(lane.list_price ?? r1.option.price)}`, `定価 ${usd(lane.list_price ?? r1.option.price)}`)}
                  {lane.risk ? ` · P(drop) ${(lane.risk.p_drop * 100).toFixed(1)}%` : ''}
                  {lane.owner_limits && negotiationText(t, lane.owner_limits) ? ` · ${negotiationText(t, lane.owner_limits)}` : ''}
                </div>
                {r1.message && <div className="neg-quote tiny">“{r1.message}”</div>}
                <div className="tiny muted">{t(`Risk-adjusted cost: ${usd(r1.effective_cost_usd)}`, `リスク込み実質コスト: ${usd(r1.effective_cost_usd)}`)}</div>
                {r1.option.price > maxUsd && <span className="badge bad"><Icon name="lock" size={11} /> {t('over cap', '上限超え')}</span>}
                {lead && <div className="tiny good-text">★ {t('Leader after Round 1 (lowest risk-adjusted cost)', '第1Rの首位（リスク込みで最安）')}</div>}
              </div>
            );
          })}
          {listed.map((l) => (
            <div key={l.store} className="neg-store-box listed">
              <span className="row" style={{ alignItems: 'center', gap: 6 }}><Icon name="store" size={14} /> <b>{l.store}</b></span>
              <span className="tiny muted">{t(`Listed ${usd(l.list_price!)} · no promise (no store agent)`, `出品価格 ${usd(l.list_price!)} · 約束なし（AI エージェントなし）`)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="neg-round-arrow" aria-live="polite">
        <span className="neg-round-arrow-line" aria-hidden="true" />
        <span className="small">
          {counterEvents.length
            ? <><Icon name="reply" size={13} /> {t(`Push back: your agent shows each store ${leadStore ?? 'the leader'}’s offer and asks for better terms`, `押し返す: ${leadStore ?? '首位'}の条件を各店に見せ、もっと良い条件を頼む`)}</>
            : taskRunning
              ? <><span className="spin" /> {t('Round 2 starts when every store has answered…', '全店の第1Rの答えがそろうと第2Rへ…')}</>
              : t('No Round 2: no other member store to push back on.', '第2Rなし（ほかに交渉できる加盟店がない）。')}
        </span>
      </div>

      {counterEvents.length > 0 && (
        <div className="neg-round">
          <div className="neg-round-head"><span className="neg-round-n">2</span> <b>{t('Round 2 · each store’s final answer', '第2R · 各店の最終回答')}</b></div>
          <div className="neg-round-grid">
            {metrics.map(({ lane, r1, r2 }) => {
              const countered = counterEvents.some((e) => e.payload?.store === lane.store);
              const waiting = taskRunning && countered && !r2 && !lane.error;
              const priceCut = !!(r2 && r2.option.price < r1.option.price - 0.004);
              const promiseAdded = !!(r2 && r2.option.promise && !r1.option.promise);
              const improved = priceCut || promiseAdded;
              return (
                <div key={lane.store} className={`neg-store-box${winner === lane.store ? ' win' : ''}${improved ? ' improved' : ''}`}>
                  <div className="neg-turn-top">
                    <span className="row" style={{ alignItems: 'center', gap: 6 }}>{winner === lane.store && <Icon name="check" size={14} />}<Icon name="store" size={14} /> <b>{lane.store}</b></span>
                    {r2 && (
                      <span className="neg-offer-chip">
                        <b>{usd(r2.option.price)}</b>
                        {r2.option.promise ? <span className="neg-cap-tag good"><Icon name="shield" size={11} /> {t('full difference', '差額を全額')}</span> : <span className="neg-cap-tag none">{dealText(t, r2.option)}</span>}
                      </span>
                    )}
                  </div>
                  {waiting && <div className="small muted"><span className="spin" /> {t('Waiting for its reply…', '回答を待機中…')}</div>}
                  {!r2 && !waiting && <div className="tiny muted">{t(`Not asked again; its Round 1 offer stands (${usd(r1.option.price)}, ${promiseOf(r1)}).`, `再交渉なし。第1Rの条件のまま（${usd(r1.option.price)}、${promiseOf(r1)}）。`)}</div>}
                  {r2?.message && <div className="neg-quote tiny">“{r2.message}”</div>}
                  {r2 && (
                    <div className={`tiny ${improved ? 'good-text' : 'muted'}`}>
                      {priceCut && promiseAdded ? t(`Cut ${usd(r1.option.price)} → ${usd(r2.option.price)} and added the promise`, `${usd(r1.option.price)} → ${usd(r2.option.price)} に値下げし、約束も追加`)
                        : priceCut ? t(`Cut ${usd(r1.option.price)} → ${usd(r2.option.price)}`, `${usd(r1.option.price)} → ${usd(r2.option.price)} に値下げ`)
                        : promiseAdded ? t('Added the promise', '約束を追加')
                        : t(`Held firm (risk-adjusted cost ${usd(r2.effective_cost_usd)})`, `据え置き（リスク込み実質コスト ${usd(r2.effective_cost_usd)}）`)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Per store: what the promise is expected to give back if you buy here, against
// how much more you pay than at the cheapest store. Both are the numbers the
// agent saw. A full-difference promise always covers; the question is whether
// its expected refund is worth the extra price.
function DropCoverGauge({ lanes, winner }: { lanes: Lane[]; winner: string | null }) {
  const t = useT();
  const rows = lanes.filter((l) => l.offers.length > 0 && l.risk != null);
  if (!rows.length) return null;
  const cheapest = Math.min(...rows.map((l) => l.offers.at(-1)!.option.price));
  const calc = rows.map((l) => {
    const r = l.risk!;
    const o = l.offers.at(-1)!;
    const p = o.option.promise;
    const refund = p ? r.p_drop * Math.min(r.expected_drop_usd, p.cap_usd) : 0;
    return { l, o, r, refund, extra: o.option.price - cheapest };
  });
  const scaleMax = Math.max(1, ...calc.map((c) => Math.max(c.refund, c.extra)));
  return (
    <div className="card drop-cover">
      <div className="dc-head">
        <Icon name="shieldCheck" size={20} />
        <div>
          <div className="dc-title">{t('Is the promise worth the extra price?', '約束は、上乗せ分に見合うか')}</div>
          <div className="small muted">
            {t(
              'Per store: the refund you can expect from the promise (chance of a drop × expected drop) against how much more it costs than the cheapest store. The agent decided; these are its facts.',
              '店ごとに、約束で戻る見込み（下がる確率×下がる額）と、最安の店より高い分を比べる。決めたのはエージェント。',
            )}
          </div>
        </div>
      </div>
      <div className="dc-rows">
        {calc.map(({ l, o, r, refund, extra }) => {
          const state: 'covers' | 'short' | 'none' = !o.option.promise ? 'none' : refund >= extra - 0.005 ? 'covers' : 'short';
          const isWin = winner === l.store;
          const pDropPct = Math.round(r.p_drop * 1000) / 10;
          return (
            <div key={l.store} className={`dc-row ${state}${isWin ? ' win' : ''}`}>
              <div className="dc-meta">
                <span className="dc-store">
                  {isWin && <Icon name="check" size={14} />}
                  <Icon name="store" size={14} /> <b>{l.store}</b>
                </span>
                <span className="small muted">{t(`${pDropPct}% chance in ${r.window_days}d · drop ${usd(r.expected_drop_usd)}`, `${r.window_days}日で ${pDropPct}% · 見込み ${usd(r.expected_drop_usd)}`)}</span>
              </div>
              <div className="dc-bars">
                <div className="dc-bar-line">
                  <span className="tiny muted">{t('expected refund', '戻る見込み')}</span>
                  <span className="dc-track"><span className={`dc-cap-fill ${state === 'none' ? 'short' : 'covers'}`} style={{ width: `${(refund / scaleMax) * 100}%` }} /></span>
                  <b className="tiny">{o.option.promise ? usd(refund) : '—'}</b>
                </div>
                <div className="dc-bar-line">
                  <span className="tiny muted">{t('extra vs cheapest', '最安との差')}</span>
                  <span className="dc-track"><span className="dc-drop-bar" style={{ width: `${(extra / scaleMax) * 100}%` }} /></span>
                  <b className="tiny">{usd(extra)}</b>
                </div>
              </div>
              <div className="dc-verdict">
                {o.option.promise ? (
                  <span className={`badge ${state === 'covers' ? 'good' : 'warn-badge'}`}>
                    <Icon name={state === 'covers' ? 'shieldCheck' : 'alert'} size={14} /> {t('full difference refunded', '差額を全額返金')}
                  </span>
                ) : (
                  <span className="badge none"><Icon name="shield" size={14} /> {t('no promise', '約束なし')}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// What the agent checked before paying: verify_promise per store (the registered terms), and the
// merchant-signed AP2 checkout (signature, and that its promise matches those terms).
function VerifyChecks({ events }: { events: Event[] }) {
  const t = useT();
  const checks = events.filter((e) => e.kind === 'verify').map((e) => e.payload as { store: string; result: { found: boolean; claim?: string } });
  const co = events.find((e) => e.kind === 'checkout_verified')?.payload as { store: string; found: boolean; signature_valid: boolean; promise_in_checkout_matches_terms: boolean } | undefined;
  if (!checks.length && !co) return null;
  const mark = (b: boolean) => <span className={`vc-mark ${b ? 'ok' : 'bad'}`}><Icon name={b ? 'check' : 'alert'} size={20} /></span>;
  return (
    <div className="card verify-panel">
      <div className="vc-head">
        <span className="vc-icon"><Icon name="shieldCheck" size={24} /></span>
        <div>
          <b>{t('Checked before paying: is the promise real?', '支払う前に確かめた: 約束は本物か')}</b>
          <div className="small muted">{t('The agent does not take the store’s word for it. If the signed checkout did not match the registered promise, the payment would stop here.', 'エージェントは店の言葉をうのみにしない。署名されたチェックアウトが登録された約束と合わなければ、支払いはここで止まる。')}</div>
        </div>
      </div>
      <div className="vc-steps">
        {checks.map((c, i) => (
          <div key={i} className={`vc-step${c.result.found ? ' ok' : ''}`}>
            {mark(c.result.found)}
            <div>
              <div className="vc-title">{c.result.found ? t('Registered with Vouch', 'Vouch に登録あり') : t('Nothing registered', '登録なし')}</div>
              <div className="small"><code>verify_promise</code> (MCP) · {c.store}</div>
              {c.result.found && c.result.claim && <div className="small muted">{c.result.claim}</div>}
            </div>
          </div>
        ))}
        {checks.length > 0 && co && <span className="vc-arrow" aria-hidden="true">→</span>}
        {co && (
          <div className={`vc-step${co.signature_valid && co.promise_in_checkout_matches_terms ? ' ok' : ''}`}>
            {mark(co.signature_valid && co.promise_in_checkout_matches_terms)}
            <div>
              <div className="vc-title">{t('Store-signed AP2 checkout', '店が署名した AP2 チェックアウト')}</div>
              <div className="small">{t(`signature ${co.signature_valid ? 'valid' : 'invalid'}`, `署名は${co.signature_valid ? '有効' : '無効'}`)} · {co.store}</div>
              <div className="small muted">{co.promise_in_checkout_matches_terms ? t('the promise inside matches the registered terms', '中の約束が登録された条件と一致') : t('the promise inside differs from the registered terms', '中の約束が登録された条件と不一致')}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// After a replay: the same day from the store's side, and the answer to "was this day picked?"
// (the experiments include days where the promise loses).
function AfterReplay() {
  const t = useT();
  return (
    <div className="card small" style={{ marginTop: 12 }}>
      <div><b>{t('Next', '次に見る')}</b></div>
      <div>· <a href="#/seller">{t("The same store's side: its settings, the sale, the refund it paid, what it kept", '同じ店の側: 設定、売上、払った返金、手元に残った額')} →</a></div>
      <div>· <a href="#/agents">{t('Is this day cherry-picked? On days a drop is unlikely, the agent takes the discount instead; with words or a fake claim, it waits (small experiments)', 'この日は選んだのでは？ 値下がりしそうにない日は、エージェントは値下げを選ぶ。店の言葉や偽の主張では待つ（小さな実験）')} →</a></div>
    </div>
  );
}

// Entry to replay mode on live tasks: re-run a past day through the refund.
function ReplayCta({ onReplay }: { onReplay: () => void }) {
  const t = useT();
  return (
    <div className="card act3-cta">
      <div className="act3-body">
        <div className="small muted">
          {t(
            'Same agents on a past day: real later prices judge the promise, and a broken one is refunded through PayPal.',
            '過去の日を同じエージェントで再現する。その後の実際の価格が約束を判定し、破られたら PayPal で返金される。',
          )}
        </div>
      </div>
      <a
        href="#/buy?mode=replay"
        className="button"
        onClick={(e) => {
          e.preventDefault();
          onReplay();
        }}
      >
        <Icon name="clock" size={16} /> {t('Replay a past day through the refund', '過去の日付で返金まで再現する')}
      </a>
    </div>
  );
}

function StoreCard({
  lane,
  maxUsd,
  winner,
  barMin,
  barMax,
  taskRunning,
  round2Started,
  isLead,
  leadStore,
  countered,
}: {
  lane: Lane;
  maxUsd: number;
  winner: boolean;
  barMin: number;
  barMax: number;
  taskRunning: boolean;
  round2Started: boolean;
  isLead: boolean;
  leadStore: string | null;
  countered: boolean;
}) {
  const t = useT();
  const member = !!lane.member;
  const o = lane.offers.at(-1);
  const r1 = lane.offers[0]?.option;
  const r2 = lane.offers.length >= 2 ? lane.offers[1].option : null;
  const isAskingR1 = member && taskRunning && !o && !lane.error;
  const isNegotiatingR2 = member && taskRunning && countered && !r2 && !lane.error;
  const priceDropped = !!(r1 && r2 && r2.price < r1.price - 0.004);
  const promiseAdded = !!(r1 && r2 && r2.promise && !r1.promise);
  const improved = priceDropped || promiseAdded;
  const promise = o?.option.promise;
  const seller = !!o && o.option.id.includes('-pub');
  const priceNow = o?.option.price ?? lane.list_price;
  const overCap = priceNow != null && priceNow > maxUsd;
  const span = barMax - barMin || 1;
  return (
    <div className={`store${winner ? ' win' : ''}${o ? ' in' : ' wait'}${lane.error ? ' off' : ''}${isNegotiatingR2 ? ' negotiating' : ''}${member && isLead && round2Started && !winner ? ' lead-bench' : ''}${improved ? ' r2-improved' : ''}`}>
      {winner && <span className="store-won"><Icon name="check" size={18} /></span>}
      {isAskingR1 && (
        <div className="neg-pill r1">
          <span className="neg-dots"><span /><span /><span /></span>
          <span>{t('Round 1: asking offer…', '第1R：見積もり要求中…')}</span>
        </div>
      )}
      {isNegotiatingR2 && (
        <div className="neg-pill active">
          <span className="neg-dots"><span /><span /><span /></span>
          <span>
            {isLead
              ? t('R2: asking the leader for better terms…', '第2R：首位にも条件改善を交渉中…')
              : t(`Pushing back vs. ${leadStore ?? 'leader'}…`, `${leadStore ?? '首位'}の条件をぶつけて再交渉中…`)}
          </span>
        </div>
      )}
      {member && !isNegotiatingR2 && isLead && round2Started && !r2 && (
        <div className="neg-pill lead">
          <Icon name="check" size={12} />
          <span>{t('Round 1 leader · benchmark', '第1R 首位（比較基準）')}</span>
        </div>
      )}
      {member && !isNegotiatingR2 && countered && r2 && improved && (
        <div className="neg-pill improved">
          <Icon name="reply" size={12} />
          <span>
            {priceDropped && promiseAdded
              ? t(`R2: ${usd(r1!.price)}→${usd(r2.price)} & added the promise`, `交渉で改善: ${usd(r1!.price)}→${usd(r2.price)}・約束を追加`)
              : priceDropped
                ? t(`R2 cut: ${usd(r1!.price)} → ${usd(r2.price)}`, `交渉で値下げ: ${usd(r1!.price)} → ${usd(r2.price)}`)
                : t('R2: added the promise', '交渉で約束を追加')}
          </span>
        </div>
      )}
      {member && !isNegotiatingR2 && countered && r2 && !improved && (
        <div className="neg-pill held">
          <Icon name="reply" size={12} />
          <span>{t('R2: held firm', '再交渉：条件据え置き')}</span>
        </div>
      )}
      {member && !isNegotiatingR2 && round2Started && !isLead && !countered && o && lane.policy === 'holdout' && (
        <div className="neg-pill held">
          <Icon name="lock" size={12} />
          <span>{t('Fixed price (no negotiation)', '定価固定（交渉なし）')}</span>
        </div>
      )}
      <div className="store-head"><Icon name="store" size={15} /> <b>{lane.store}</b>{member ? <span className="member-tag on">{t('member · store AI agent', '加盟店・AI エージェント')}</span> : <span className="agent-tag">{t('No store agent · listed price', 'AI エージェントなし・出品価格')}</span>}</div>
      <div className="store-price">
        {o ? usd(o.option.price) : lane.list_price != null ? usd(lane.list_price) : <span className="spin" />}
        {priceDropped && r1 ? <s className="r1-old">{usd(r1.price)}</s> : o && lane.list_price != null && o.option.price < lane.list_price - 0.004 ? <s className="r1-old">{usd(lane.list_price)}</s> : lane.was_price ? <s className={lane.fake_sale ? 'fake' : ''}>{usd(lane.was_price)}</s> : null}
        {isNegotiatingR2 && <span className="neg-exchange" title={t('Negotiating better terms…', '条件改善を交渉中…')}>⇄</span>}
      </div>
      {o && (
        <div className="cost-bar" title={t(`price ${usd(o.option.price)} + unprotected risk ${usd(o.unprotected_loss_usd)}`, `価格 ${usd(o.option.price)} ＋ 守られないリスク ${usd(o.unprotected_loss_usd)}`)}>
          <span className="seg-price" style={{ width: `${((o.option.price - barMin) / span) * 100}%` }} />
          <span className="seg-risk" style={{ width: `${(o.unprotected_loss_usd / span) * 100}%` }} />
        </div>
      )}
      <div className="badges">
        {overCap && <span className="badge bad" title={t(`Above your cap ${usd(maxUsd)}`, `上限 ${usd(maxUsd)} を超えている`)}><Icon name="lock" size={14} /> {t('over cap', '上限超え')}</span>}
        {lane.fake_sale && <span className="badge bad" title={lane.fake_sale.reason}><Icon name="alert" size={14} /> {t('fake sale', '偽のセール')}</span>}
        {member && o && (promise ? (
          <span className="badge good" title={t(`If this store's price falls below what you paid before the window ends, PayPal refunds the difference (${promise.window_days}-day window).`, `ウィンドウが終わる前にこの店の値段があなたの支払額より下がったら、差額を PayPal が返す（${promise.window_days}日間）。`)}><Icon name="shield" size={14} /> {promiseText(t, promise, o!.option.price)}</span>
        ) : o.option.discount_usd > 0 ? (
          <span className="badge info" title={t('The owner of this store allows its AI a small fixed discount (demo assumption). It comes with no promise: if the price falls later, nothing is refunded.', 'この店の店主は、AI に小さな固定の値引きを許している（デモの仮定）。約束はなく、あとで値下がりしても返金はない。')}><Icon name="tag" size={14} /> {dealText(t, o.option)}</span>
        ) : (
          <span className="badge none"><Icon name="shield" size={14} /> —</span>
        ))}
      </div>
      {/* Only what the store answered: its owner's settings stay with the store (shown, labelled as a demo assumption, in the negotiation detail below). */}
      {member && o && <div className="store-src small">{t('its answer to your agent', 'あなたのエージェントへの答え')}{seller ? '' : ` · ${t('demo assumption', 'デモの仮定')}`}</div>}
      {lane.error && <ErrorBox error={{ body: lane.error, message: lane.error.message ?? 'store agent error' } as any} />}
    </div>
  );
}

function Outcome({ task, onApproved }: { task: Task; onApproved: () => void }) {
  const t = useT();
  const [error, setError] = useState<unknown>();
  const p = task.state.purchase;
  const d = task.state.decision;
  if (task.status === 'running') {
    return (
      <div className="outcome running">
        <Icon name="card" size={30} />
        <span className="spin big" />
        <span className="small">{runningLabel(task.events, t)}</span>
      </div>
    );
  }
  if (task.status === 'bought' && p) {
    const c = p.contracts[0];
    return (
      <div className="outcome bought">
        <div className="outcome-icon"><Icon name="check" size={52} /></div>
        <div>
          <div className="outcome-word">{t('BOUGHT', '購入')}</div>
          <div className="outcome-amount">{usd(p.price)}</div>
          <div className="outcome-store"><Icon name="store" size={14} /> {p.store} · <Icon name="card" size={14} /> {t(`PayPal seller #${p.seller.slot}`, `PayPal 売り手 #${p.seller.slot}`)}{p.seller.merchant ? ` (${p.seller.merchant})` : ''}</div>
        </div>
        {c ? <div className="outcome-shield"><Icon name="shieldCheck" size={22} /> <b>{usd(c.stake_usd)}</b> <span className="small">→ {shortDay(c.judge_after_day)}</span></div> : <div className="outcome-shield none"><Icon name="shield" size={22} /> —</div>}
        <div className="mono small muted outcome-id">PayPal order {p.order_id}{p.capture_id ? ` · capture ${p.capture_id}` : ''}</div>
      </div>
    );
  }
  if (task.status === 'waiting') {
    return (
      <div className="outcome waited">
        <div className="outcome-icon"><Icon name="hourglass" size={52} /></div>
        <div>
          <div className="outcome-word">{t('WAITED', '待った')}</div>
          <div className="outcome-amount">$0</div>
          <div className="small">{t('nothing bought', '購入なし')}</div>
        </div>
      </div>
    );
  }
  if (task.status === 'needs_approval' && d && !d.wait) {
    return (
      <div className="outcome ask">
        <div className="outcome-icon"><Icon name="card" size={44} /></div>
        <div>
          <div className="outcome-amount">{usd(d.option.price)}</div>
          <div className="outcome-store"><Icon name="store" size={14} /> {d.store}</div>
        </div>
        <button className="primary big" onClick={async () => { try { await api.post(`/api/shop/tasks/${task.id}/approve`); onApproved(); } catch (e) { setError(e); } }}><Icon name="check" /> {t('Approve and pay', '承認して支払う')}</button>
        <ErrorBox error={error} />
      </div>
    );
  }
  return <div className="outcome failed"><div className="outcome-icon"><Icon name="alert" size={48} /></div><div className="outcome-word">{t('STOPPED', '停止')}</div></div>;
}

// One-click re-run options when the agent chose to wait, so the user can test
// raising the cap, requiring a price promise, or caring only about today's price.
function ReRunWait({ task, onStarted }: { task: Task; onStarted: (id: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const prices = task.state.lanes.map((l) => l.offers.at(-1)?.option.price ?? l.list_price ?? 0).filter((p) => p > 0);
  const maxPrice = prices.length ? Math.ceil(Math.max(...prices)) : task.max_usd;
  const hasOverCap = maxPrice > task.max_usd;
  const hasPromiseStore = task.state.lanes.some((l) => !!l.offers.at(-1)?.option.promise);
  const weight = task.state.risk_weight ?? 1;

  const rerun = async (overrides: { max_usd?: number; autonomy?: Autonomy; risk_weight?: number }) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.post<{ id: string }>('/api/shop/tasks', {
        group_key: task.group_key,
        autonomy: overrides.autonomy ?? task.autonomy,
        max_usd: overrides.max_usd ?? task.max_usd,
        risk_weight: overrides.risk_weight ?? weight,
        ...(task.state.as_of ? { as_of: task.state.as_of } : {}),
      });
      onStarted(r.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wait-actions">
      {hasOverCap && (
        <button disabled={busy} onClick={() => rerun({ max_usd: maxPrice })}>
          <Icon name="lock" size={14} /> {t(`Re-run with cap ${usd(maxPrice)} (all stores)`, `上限を ${usd(maxPrice)}（全店対象）に上げて再実行`)}
        </button>
      )}
      {hasPromiseStore && task.autonomy !== 'protected' && (
        <button disabled={busy} onClick={() => rerun({ autonomy: 'protected', max_usd: Math.max(task.max_usd, maxPrice) })}>
          <Icon name="shield" size={14} /> {t('Re-run: only stores with a price promise', '値下がりの約束がある店だけで再実行')}
        </button>
      )}
      {weight > 1 && (
        <button disabled={busy} onClick={() => rerun({ risk_weight: 1 })}>
          <Icon name="tag" size={14} /> {t('Re-run with preference “price only”', '「価格だけ」にして再実行')}
        </button>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

// Expandable technical proof: Vouch deterministic effective-cost ranking,
// One AP2 verification in the chain: who checked, PASS/FAIL, and each named check.
function Ap2Check({ who, icon, what, v }: { who: string; icon: string; what: string; v: { ok: boolean; checks?: { name: string; ok: boolean }[] } }) {
  return (
    <div className={`ap2-step${v.ok ? ' ok' : ' bad'}`}>
      <div className="ap2-who"><Icon name={icon} size={16} /> {who}</div>
      <div className="ap2-what">{what} · <b>{v.ok ? 'PASS' : 'FAIL'}</b></div>
      <div className="ap2-chips">{(v.checks ?? []).map((c) => <span key={c.name} className={`ap2-chip ${c.ok ? 'good' : 'bad'}`}>{c.ok ? '✓' : '✗'} {c.name.replace(/_/g, ' ')}</span>)}</div>
    </div>
  );
}

// AP2 open/closed mandate verification checks, and PayPal Agent Toolkit calls.
function TechProof({ task }: { task: Task }) {
  const t = useT();
  const ranking: { rank: number; store: string; price: number; promise_cap_usd: number | null; unprotected_loss_usd: number; effective_cost_usd: number; allowed: boolean }[] =
    task.state.decision?.vouch_ranking ?? [];
  const mandateSigned = task.events.find((e) => e.kind === 'mandate_signed')?.payload;
  const checkoutSigned = task.events.find((e) => e.kind === 'checkout_signed')?.payload;
  const merchantVerified = task.events.find((e) => e.kind === 'mandate_verified' && e.payload?.role === 'merchant')?.payload;
  const processorVerified = task.events.find((e) => e.kind === 'mandate_verified' && e.payload?.role === 'payment processor')?.payload;
  const paypalOrder = task.events.find((e) => e.kind === 'paypal_order')?.payload;
  const captured = task.events.find((e) => e.kind === 'captured')?.payload;

  return (
    <details className="tech-proof">
      <summary>{t('AP2 mandate checks · PayPal Agent Toolkit · Vouch effective-cost ranking', 'AP2 委任の署名検証 · PayPal Agent Toolkit · Vouch 実質コスト順位')}</summary>
      <div className="tech-grid small">
        {ranking.length > 0 && (
          <div>
            <b>{t('Vouch effective-cost ranking (shown alongside agent choice, not imposed)', 'Vouch 実質コスト順位（エージェントの判断と並べて表示・強制しない）')}</b>
            <div className="muted">{t('Inputs: price and the promise’s effect on unprotected risk. Vouch membership is not an input, and the buyer agent is not told who is a member.', '入力は価格と、約束が守られないリスクをどれだけ減らすかだけ。加盟しているかは入力にせず、買い手のエージェントにも伝えない。')}</div>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('Store', '店')}</th>
                  <th>{t('Offer price', '提示価格')}</th>
                  <th>{t('Promise', '約束')}</th>
                  <th>{t('Unprotected risk', '未保護リスク')}</th>
                  <th>{t('Effective cost', '実質コスト')}</th>
                  <th>{t('Mandate', 'AP2 委任')}</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((r) => (
                  <tr key={r.store}>
                    <td>{r.rank}</td>
                    <td><b>{r.store}</b></td>
                    <td>{usd(r.price)}</td>
                    <td>{r.promise_cap_usd ? promiseText(t, { cap_usd: r.promise_cap_usd }, r.price) : '—'}</td>
                    <td>{usd(r.unprotected_loss_usd)}</td>
                    <td><b>{usd(r.effective_cost_usd)}</b></td>
                    <td>{r.allowed ? <span className="good">{t('allowed', '許可')}</span> : <span className="bad">{t('blocked', '対象外')}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(mandateSigned || checkoutSigned || paypalOrder) && (
          <div className="ap2-block">
            <b>{t('How the payment was authorised (AP2), step by step', '支払いが認められるまで（AP2）の流れ')}</b>
            <div className="ap2-chain">
              {mandateSigned && (
                <div className="ap2-step">
                  <div className="ap2-who"><Icon name="lock" size={16} /> {t('You', 'あなた')}</div>
                  <div className="ap2-what">{t('signed the open mandates', '開いた委任に署名')}</div>
                  <div className="ap2-chips"><span className="ap2-chip">≤ {usd(mandateSigned.max_usd)}</span>{(mandateSigned.stores ?? []).length > 0 && <span className="ap2-chip">{t(`${mandateSigned.stores.length} stores`, `${mandateSigned.stores.length} 店`)}</span>}</div>
                  <div className="mono tiny muted">ref {String(mandateSigned.checkout_reference).slice(0, 12)}…</div>
                </div>
              )}
              {checkoutSigned && <span className="ap2-arrow" aria-hidden="true">→</span>}
              {checkoutSigned && (
                <div className="ap2-step">
                  <div className="ap2-who"><Icon name="store" size={16} /> {t('Store', '店')}</div>
                  <div className="ap2-what">{t('signed the checkout', 'チェックアウトに署名')}</div>
                  <div className="ap2-chips"><span className="ap2-chip">{usd(checkoutSigned.total_usd)}</span>{checkoutSigned.vouch_promise && <span className="ap2-chip good"><Icon name="shield" size={11} /> {t('promise inside', '約束入り')}</span>}</div>
                  <div className="mono tiny muted">hash {String(checkoutSigned.checkout_hash).slice(0, 12)}…</div>
                </div>
              )}
              {merchantVerified && <span className="ap2-arrow" aria-hidden="true">→</span>}
              {merchantVerified && <Ap2Check who={t('Store', '店')} icon="store" what={t('checked your mandate', 'あなたの委任を確認')} v={merchantVerified} />}
              {processorVerified && <span className="ap2-arrow" aria-hidden="true">→</span>}
              {processorVerified && <Ap2Check who="PayPal" icon="card" what={t('checked the mandate', '委任を確認')} v={processorVerified} />}
              {paypalOrder && <span className="ap2-arrow" aria-hidden="true">→</span>}
              {paypalOrder && (
                <div className={`ap2-step${captured ? ' ok' : ''}`}>
                  <div className="ap2-who"><Icon name="card" size={16} /> PayPal Agent Toolkit</div>
                  <div className="ap2-what">{captured ? t('order created and paid', '注文を作り、支払い') : t('order created', '注文を作成')}</div>
                  <div className="mono tiny">create_order → {paypalOrder.order_id}</div>
                  {captured && <div className="mono tiny">pay_order → {captured.capture_id}</div>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

// ---------------- After the purchase: the promise is monitored ----------------

interface PromiseStatus { status: string; paid_usd: number; cap_usd: number; purchase_day: string; judge_after_day: string; points: { day: string; price: number }[]; lowest_since_purchase: number | null; judgment: any; refund: any }

function PromiseWatch({ id }: { id: string }) {
  const t = useT();
  const s = useAsync(() => api.get<PromiseStatus>(`/api/shop/tasks/${id}/promise`), [id]);
  if (s.error) return <ErrorBox error={s.error} />;
  if (!s.data) return null;
  const d = s.data;
  const today = new Date().toISOString().slice(0, 10);
  const span = (Date.parse(d.judge_after_day) - Date.parse(d.purchase_day)) / 86_400_000 || 1;
  const pos = Math.min(1, Math.max(0, (Date.parse(today) - Date.parse(d.purchase_day)) / 86_400_000 / span));
  const kept = d.status === 'hit' || (d.status === 'open' && (d.lowest_since_purchase ?? d.paid_usd) >= d.paid_usd - 0.005);
  return (
    <div className={`watch ${d.status === 'miss' ? 'refunded' : kept ? 'kept' : 'dropped'}`}>
      <div className="watch-shield"><Icon name="shieldCheck" size={40} /></div>
      <div className="watch-body">
        <div className="gauge">
          <span className="gauge-fill" style={{ width: `${pos * 100}%` }} />
          <span className="gauge-start small">{shortDay(d.purchase_day)}</span>
          <span className="gauge-end small"><Icon name="check" size={12} /> {shortDay(d.judge_after_day)}</span>
        </div>
        <div className="small">
          {d.status === 'miss' ? t(`broken → ${usd(d.refund?.amount_usd)} back`, `外れ → ${usd(d.refund?.amount_usd)} 返金`) : d.status === 'hit' ? t('kept', '守られた') : kept ? t(`monitoring · no drop below ${usd(d.paid_usd)} so far`, `見張り中 · いまのところ ${usd(d.paid_usd)} を下回っていない`) : t(`price is below ${usd(d.paid_usd)} — refund on the verdict day`, `${usd(d.paid_usd)} を下回った — 判定日に返金`)}
        </div>
      </div>
    </div>
  );
}

// ---------------- Replay: fast-forward when the agent waited ----------------

interface WaitedFastForward {
  kind: 'waited';
  as_of: string;
  window_end: string;
  cheapest_on_day: { store: string; price: number };
  best_if_waited: { store: string; day: string; price: number; saved_vs_cheapest_on_day_usd: number } | null;
  best_promised_on_day: { store: string; paid_usd: number; cap_usd: number; payout_usd: number; net_paid_usd: number; reason: string } | null;
  stores: {
    store: string;
    price_on_day: number;
    promise_cap_usd: number | null;
    points: { day: string; price: number }[];
    lowest_after: { day: string; price: number } | null;
    promised_verdict: { outcome: 'hit' | 'miss'; payout_usd: number; reason: string; net_paid_usd: number } | null;
  }[];
}

function FastForwardWait({ id, onFastForward }: { id: string; onFastForward?: () => void }) {
  const t = useT();
  const [r, setR] = useState<WaitedFastForward>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <div className="card ff waited">
      {!r && (
        <div className="ff-start">
          <div className="watch-shield" style={{ color: 'var(--warn)' }}><Icon name="clock" size={40} /></div>
          <button className="primary big" disabled={busy} onClick={async () => {
            setBusy(true); setError(undefined);
            try { setR(await api.post<WaitedFastForward>(`/api/shop/tasks/${id}/fast-forward`)); onFastForward?.(); } catch (e) { setError(e); } finally { setBusy(false); }
          }}><Icon name="clock" /> {busy ? t('Checking real later prices…', 'その後の実価格を確認中…') : t('Fast-forward 14 days (if you waited)', '14 日早送り（待った場合）')}</button>
          <span className="muted small">{t('See what happened to every store’s real price over the next 14 days, vs. buying with a price promise.', 'その後 14 日間の各店の実際の価格推移と、約束付きで買っていた場合を比較する。')}</span>
        </div>
      )}
      {r && (
        <div className="ff-result" style={{ justifyItems: 'stretch' }}>
          <WaitedPriceChart r={r} />
          <div className="wait-compare">
            {r.best_if_waited && (
              <div className="wait-box warn">
                <div className="small muted">{t(`If you waited (${shortDay(r.as_of)} → ${shortDay(r.window_end)})`, `待った場合（${shortDay(r.as_of)} → ${shortDay(r.window_end)}）`)}</div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{usd(r.best_if_waited.price)} <span className="small muted">{t(`at ${r.best_if_waited.store} on ${shortDay(r.best_if_waited.day)}`, `${shortDay(r.best_if_waited.day)} に ${r.best_if_waited.store}`)}</span></div>
                <div className="small">
                  {r.best_if_waited.saved_vs_cheapest_on_day_usd > 0
                    ? t(`Fell ${usd(r.best_if_waited.saved_vs_cheapest_on_day_usd)} below ${shortDay(r.as_of)}’s lowest offer (${usd(r.cheapest_on_day.price)}).`, `${shortDay(r.as_of)} の最安提示（${usd(r.cheapest_on_day.price)}）より ${usd(r.best_if_waited.saved_vs_cheapest_on_day_usd)} 値下がり。`)
                    : t(`No store went below ${shortDay(r.as_of)}’s lowest offer (${usd(r.cheapest_on_day.price)}). Waiting saved $0.`, `どの店も ${shortDay(r.as_of)} の最安提示（${usd(r.cheapest_on_day.price)}）を下回らず、待っても $0 の節約。`)}
                </div>
              </div>
            )}
            {r.best_promised_on_day && (
              <div className="wait-box good">
                <div className="small muted">{t(`If bought on ${shortDay(r.as_of)} with a price promise`, `${shortDay(r.as_of)} に値下がりの約束付きで買っていた場合`)}</div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>
                  {r.best_promised_on_day.payout_usd > 0 ? <><s>{usd(r.best_promised_on_day.paid_usd)}</s> → {usd(r.best_promised_on_day.net_paid_usd)}</> : usd(r.best_promised_on_day.paid_usd)}{' '}
                  <span className="small muted">{r.best_promised_on_day.store}</span>
                </div>
                <div className="small">
                  {r.best_promised_on_day.payout_usd > 0
                    ? t(`The full-difference promise would have refunded ${usd(r.best_promised_on_day.payout_usd)} automatically (${tReason(r.best_promised_on_day.reason, t.ja)}).`, `差額の全額返金により ${usd(r.best_promised_on_day.payout_usd)} が自動返金（${tReason(r.best_promised_on_day.reason, t.ja)}）。`)
                    : t(`Promise held (${tReason(r.best_promised_on_day.reason, t.ja)}) — you got the item on ${shortDay(r.as_of)} without waiting.`, `約束どおり値下がりなし（${tReason(r.best_promised_on_day.reason, t.ja)}）— 待たずに ${shortDay(r.as_of)} に受け取れた。`)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

function WaitedPriceChart({ r }: { r: WaitedFastForward }) {
  const t = useT();
  const allPts = r.stores.flatMap((s) => s.points);
  if (allPts.length < 2) return null;
  const W = 560, H = 184, L = 60, R = 12, T = 14, B = 42;
  const t0 = Date.parse(r.as_of), t1 = Date.parse(r.window_end);
  const vals = allPts.map((p) => p.price);
  const lo = Math.min(...vals) * 0.98, hi = Math.max(...vals) * 1.02;
  const x = (d: string) => L + ((Date.parse(d) - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const palette = ['#005ea6', '#0ca30c', '#e8a33d', '#8e44ad', '#d03b3b'];
  return (
    <svg className="price-after" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Real store prices over the 14 days after waiting', '待った後の 14 日間の各店の実際の価格')}>
      {r.stores.map((s, i) => (
        <g key={s.store}>
          <polyline points={s.points.map((p) => `${x(p.day)},${y(p.price)}`).join(' ')} fill="none" stroke={palette[i % palette.length]} strokeWidth={2.2} />
          {s.points.map((p) => <circle key={p.day} cx={x(p.day)} cy={y(p.price)} r={2} fill={palette[i % palette.length]} />)}
        </g>
      ))}
      {r.best_if_waited && (
        <>
          <circle cx={x(r.best_if_waited.day)} cy={y(r.best_if_waited.price)} r={6} className="pa-verdict hit" />
          <text x={Math.min(Math.max(x(r.best_if_waited.day), L + 40), W - R - 40)} y={y(r.best_if_waited.price) + 20} textAnchor="middle" className="pa-label strong">{r.best_if_waited.store} {usd(r.best_if_waited.price)}</text>
        </>
      )}
      <text x={L} y={H - 6} className="pa-label">{shortDay(r.as_of)}</text>
      <text x={W - R} y={H - 6} textAnchor="end" className="pa-label">{shortDay(r.window_end)}</text>
      <text x={L - 6} y={y(hi) + 10} textAnchor="end" className="pa-label">{usd(hi)}</text>
      <text x={L - 6} y={y(lo)} textAnchor="end" className="pa-label">{usd(lo)}</text>
    </svg>
  );
}

// ---------------- Replay: fast-forward to the verdict on real later prices ----------------

export interface ReplayVerdict { contract_id: string; paid_usd: number; cap_usd: number; purchase_day: string; judge_after_day: string; points: { day: string; price: number }[]; verdict: { outcome: string; reason: string; payout_usd: number }; refund: { ok: boolean; paypal_refund_id?: string; amount_usd: number; error?: unknown } | null; paypal_seller_slot: number }

function FastForward({ id, store, onFastForward }: { id: string; store: string; onFastForward?: () => void }) {
  const t = useT();
  const [r, setR] = useState<ReplayVerdict>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  // Reopening a run that was already fast-forwarded shows its verdict and refund again (404 = not judged yet).
  useEffect(() => {
    let stop = false;
    api.get<ReplayVerdict>(`/api/shop/tasks/${id}/verdict`).then(
      (v) => { if (!stop) { setR(v); onFastForward?.(); } },
      (e) => { if (!stop && !(e instanceof ApiError && e.status === 404)) setError(e); },
    );
    return () => { stop = true; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const miss = r?.verdict.outcome === 'miss';
  const refunded = !!r?.refund?.ok;
  const back = r?.refund?.amount_usd ?? r?.verdict.payout_usd ?? 0;
  return (
    <div className={`card ff${r ? (miss ? ' refunded' : ' held') : ''}`}>
      {!r && (
        <div className="ff-start">
          <div className="watch-shield"><Icon name="shieldCheck" size={40} /></div>
          <button className="primary big" disabled={busy} onClick={async () => {
            setBusy(true); setError(undefined);
            try { setR(await api.post<ReplayVerdict>(`/api/shop/tasks/${id}/fast-forward`)); onFastForward?.(); } catch (e) { setError(e); } finally { setBusy(false); }
          }}><Icon name="clock" /> {busy ? t('Judging on real prices…', '実際の価格で判定中…') : t('Fast-forward 14 days', '14 日早送り')}</button>
          <span className="muted small">{t('The unchanged rules on the real prices of the following days.', '変えていないルールを、その後の日の実際の価格に当てる。')}</span>
        </div>
      )}
      {r && <PriceAfter r={r} />}
      {r && miss && (
        <div className="ff-result">
          <div className="flow3 refunded">
            <div className="node3"><Icon name="store" size={28} /><b>{store}</b><span className="small">{t(`PayPal seller ${r.paypal_seller_slot}`, `PayPal 売り手 ${r.paypal_seller_slot}`)}</span></div>
            <span className="wire3" aria-hidden="true" />
            <div className="node3 bad"><Icon name="alert" size={28} /><b>{t('rules', 'ルール')}</b><span className="small">{t('price fell', '値下がり')}</span></div>
            <span className="wire3" aria-hidden="true" />
            <div className={`node3 ${refunded ? 'good' : ''}`}><Icon name="coin" size={28} /><b>{t('you', 'あなた')}</b><span className="small">{refunded ? `+${usd(back)}` : '—'}</span></div>
            {refunded && <span className="coin-fly" aria-hidden="true"><Icon name="coin" size={22} /></span>}
          </div>
          <div className="outcome-word bad">{t(`REFUNDED ${usd(back)}`, `${usd(back)} 返金`)}</div>
          <div className="price-change">
            <s>{usd(r.paid_usd)}</s> <Icon name="arrowBack" size={14} className="flip" /> <b>{usd(r.paid_usd - back)}</b>
            <span className="small muted">{t('what you effectively paid', '実質の支払い')}</span>
          </div>
          {refunded && <div className="mono small muted">PayPal refund {r.refund!.paypal_refund_id}</div>}
        </div>
      )}
      {r && !miss && (
        <div className="ff-result">
          <div className="outcome held-big"><div className="outcome-icon"><Icon name="shieldCheck" size={52} /></div><div><div className="outcome-word">{t('PROMISE HELD', '約束は守られた')}</div><div className="small">{t(`No real price below ${usd(r.paid_usd)} until ${shortDay(r.judge_after_day)} — no refund.`, `${shortDay(r.judge_after_day)} まで ${usd(r.paid_usd)} を下回る実際の価格はなかった — 返金なし。`)}</div></div></div>
        </div>
      )}
      {r && <div className="small muted">{t('Rule', 'ルール')}: {tReason(r.verdict.reason, t.ja)}</div>}
      {r?.refund && !r.refund.ok && <ErrorBox error={{ body: r.refund.error, message: 'PayPal refund failed' } as any} />}
      <ErrorBox error={error} />
    </div>
  );
}

// The real price line from the purchase day to the verdict day, the price paid
// as a dashed line, and the verdict point (the lowest price, or the last day).
function PriceAfter({ r }: { r: ReplayVerdict }) {
  const t = useT();
  const pts = r.points;
  if (pts.length < 2) return null;
  const W = 560, H = 184, L = 60, R = 12, T = 14, B = 42;
  const t0 = Date.parse(r.purchase_day), t1 = Date.parse(r.judge_after_day);
  const vals = [...pts.map((p) => p.price), r.paid_usd];
  const lo = Math.min(...vals) * 0.98, hi = Math.max(...vals) * 1.02;
  const x = (d: string) => L + ((Date.parse(d) - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const low = pts.reduce((m, p) => (p.price < m.price ? p : m), pts[0]);
  const miss = r.verdict.outcome === 'miss';
  const v = miss ? low : pts.at(-1)!;
  return (
    <svg className="price-after" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Real price after the purchase', '購入後の実際の価格')}>
      <line x1={L} x2={W - R} y1={y(r.paid_usd)} y2={y(r.paid_usd)} className="pa-paid" />
      <text x={W - R} y={y(r.paid_usd) + 14} textAnchor="end" className="pa-label">{t('paid', '支払い')} {usd(r.paid_usd)}</text>
      <polyline points={pts.map((p) => `${x(p.day)},${y(p.price)}`).join(' ')} className="pa-line" />
      {pts.map((p) => <circle key={p.day} cx={x(p.day)} cy={y(p.price)} r={2.5} className="pa-dot" />)}
      <circle cx={x(v.day)} cy={y(v.price)} r={7} className={`pa-verdict ${miss ? 'miss' : 'hit'}`} />
      <text x={Math.min(Math.max(x(v.day), L + 24), W - R - 24)} y={y(v.price) + (miss ? 22 : -12)} textAnchor="middle" className="pa-label strong">{usd(v.price)}</text>
      <text x={L} y={H - 6} className="pa-label">{shortDay(r.purchase_day)}</text>
      <text x={W - R} y={H - 6} textAnchor="end" className="pa-label">{shortDay(r.judge_after_day)}</text>
      <text x={L - 6} y={y(hi) + 10} textAnchor="end" className="pa-label">{usd(hi)}</text>
      <text x={L - 6} y={y(lo)} textAnchor="end" className="pa-label">{usd(lo)}</text>
    </svg>
  );
}

