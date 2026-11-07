// Seller tab: the owner's view of one store (the same store the buyer app's default scenario uses).
//   1. Header: who you are, what you control.
//   2. Owner settings: your price, negotiation off, the promise, publish / withdraw.
//   3. What happened: orders on this listing, refunds paid, what the store kept.
//   4. What buyer agents see, what you owe, and the evidence for the promise.
import { useEffect, useMemo, useState } from 'react';
import { api, usd } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { Icon } from '../components/Icon';
import { ProductArt } from '../components/ProductArt';
import { StoreStrategy } from '../components/PromiseEvidence';
import { useAsync } from '../useAsync';
import { useT } from '../i18n';
import { shortDay } from '../viz';

interface ListingRow { store: string; product_id: string; group_key: string; title: string; claims: { claim_type: string; stake_usd: number }[] }
type Kind = 'bf' | '14';
interface Win { kind: Kind; days: number; end_day: string; p_drop: number; expected_drop_usd: number; method: string }
interface Order { id: string; mode: string; created_at: string; purchase_day: string | null; paid: number; window_days: number | null; judge_after_day: string | null; status: string; payout_usd: number | null; paypal_refund_id: string | null; refunded_at: string | null }
interface Listing {
  orders: Order[];
  store: string; product_id: string; group_key: string; title: string; price: number; as_of_day: string;
  peers: { store: string; price: number; risk: Record<Kind, { p_drop: number; expected_drop_usd: number }>; published_cap_usd: number | null }[];
  windows: Win[];
  published: { stake_usd: number; window_kind: Kind } | null;
  demand: { shop: { runs: number; waited: number; bought_here: number; bought_elsewhere: number }; experiment: { model: string; products: number; no_promise: { n: number; buy_now: number }; promise_covers_drop: { n: number; buy_now: number } } | null };
  record: { hits: number; misses: number };
  paypal_seller: { slot: number; merchant: string | null; shared: boolean };
  budget: { monthly_usd: number | null; open_stakes_usd: number; refunded_this_month_usd: number };
  contracts: { id: string; claim_type: string; status: string; created_at: string; slot: number | null; merchant: string | null; stake_usd: number; price: number; judge_after_day: string; payout_usd: number | null; paypal_refund_id: string | null }[];
}

interface Scenario { candidates: { product_id: string }[] }
interface PvD { measured: { window_days: number; expected_refund_share_of_price: number; drop_rate: number; drop_size_when_it_happens: number }[]; data_days: { from: string; to: string } }

export function SellerApp() {
  const t = useT();
  const rows = useAsync(() => api.get<ListingRow[]>('/api/seller/stores'), []);
  const scenario = useAsync(() => api.get<Scenario>('/api/demo/scenario'), []);
  const [pick, setPick] = useState<string>();
  const [n, setN] = useState(0);
  // Default: the featured listing of the buyer app's default scenario.
  const pid = pick ?? scenario.data?.candidates[0]?.product_id;
  const listing = useAsync(() => (pid ? api.get<Listing>(`/api/seller/listing/${pid}`) : Promise.resolve(undefined)), [pid, n]);
  const groups = useMemo(() => {
    const m = new Map<string, ListingRow[]>();
    for (const r of rows.data ?? []) m.set(r.title, [...(m.get(r.title) ?? []), r]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows.data]);
  const L = listing.data;
  const refresh = () => setN((x) => x + 1);
  return (
    <div className="page app seller">
      <ErrorBox error={rows.error ?? scenario.error ?? listing.error} />
      <div className="seller-live-head">
        <div className="app-head">
          <div className="row" style={{ alignItems: 'center', gap: 12 }}>
            <span className="seller-badge"><Icon name="store" size={22} /></span>
            <div>
              <h2 className="seller-live-title">{L ? `${L.store} · ${L.title}` : '…'}</h2>
              <div className="small">{t('You run this store. You keep your price; when a buyer’s agent asks for a discount, your store’s AI answers with your promise instead.', 'あなたはこの店の店主です。価格はあなたが決めます。買い手のエージェントが値引きを求めても、店の AI は値引きせず、あなたの約束で答えます。')}</div>
              <select value={pid ?? ''} onChange={(e) => setPick(e.target.value)} aria-label={t('Your listing', 'あなたの出品')} style={{ marginTop: 6 }}>
                {groups.map(([title, ls]) => (
                  <optgroup key={title} label={title}>
                    {ls.map((l) => <option key={l.product_id} value={l.product_id}>{l.store} — {title}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
          <div className="tag-note">{t('Demo stores; prices are real Channel3 data. The guarantee is an assumption.', '店は仮名、価格は Channel3 の実データ。保証は仮定。')}</div>
        </div>
      </div>
      {L && <OwnerFlow L={L} onChanged={refresh} />}
    </div>
  );
}

function OwnerFlow({ L, onChanged }: { L: Listing; onChanged: () => void }) {
  const t = useT();
  return (
    <div className="sflow">
      <section className="sstep">
        <div className="sstep-n">1</div>
        <div className="sstep-body">
          <h2>{t('Owner settings', '店主の設定')}</h2>
          <div className="stand">
            <ProductArt title={L.title} size="md" />
            <div className="stand-strip">
              <div className="small"><Icon name="tag" size={14} /> {t('Price', '価格')}: <b>{usd(L.price)}</b> <span className="muted">({t(`set by you, as of ${shortDay(L.as_of_day)}`, `あなたが設定・${shortDay(L.as_of_day)} 時点`)})</span></div>
              <div className="small"><Icon name="lock" size={14} /> {t('Price negotiation', '値下げ交渉')}: <b>{t('off', 'しない')}</b> <span className="muted">({t('your AI answers with the promise', 'AI は約束で答える')})</span></div>
              <div className="small"><Icon name="shield" size={14} /> {t('Promise', '約束')}: <b>{t('full difference refunded if your price drops within 14 days', '14 日以内にあなたの価格が下がったら、差額を全額返金')}</b></div>
              <div className="small"><Icon name={L.published ? 'shieldCheck' : 'shield'} size={14} /> {t('Status', '状態')}: <b className={L.published ? 'good-text' : ''}>{L.published ? t('published', '公開中') : t('not published', '未公開')}</b></div>
            </div>
          </div>
          <Publish L={L} kind="14" onChanged={onChanged} />
        </div>
      </section>

      <section className="sstep">
        <div className="sstep-n">2</div>
        <div className="sstep-body"><WhatHappened L={L} /></div>
      </section>

      <section className="sstep">
        <div className="sstep-n">3</div>
        <div className="sstep-body">
          <h2>{t('What buyer agents see', '買い手のエージェントに見える姿')}</h2>
          <div className="cards preview">
            <div className="store in win">
              <div className="store-head"><Icon name="store" size={15} /> <b>{L.store}</b></div>
              <div className="store-price">{usd(L.price)}</div>
              <div className="badges">{L.published ? <span className="badge good"><Icon name="shield" size={14} /> {t('full difference refunded', '差額を全額返金')}</span> : <span className="muted small">{t('no promise (not published)', '約束なし（未公開）')}</span>}</div>
              <div className="store-src small"><Icon name="clock" size={12} /> {t('14 days', '14 日間')}</div>
            </div>
            <div className="preview-note small"><Icon name="card" size={16} /> {L.paypal_seller.shared ? t('Refunds come from the shared demo PayPal seller (slot 1).', '返金は共用のデモ用 PayPal 売り手（1）から。') : t(`Refunds come from your PayPal seller (slot ${L.paypal_seller.slot}, ${L.paypal_seller.merchant}).`, `返金はあなたの PayPal 売り手（${L.paypal_seller.slot}、${L.paypal_seller.merchant}）から。`)}</div>
          </div>
        </div>
      </section>

      <section className="sstep">
        <div className="sstep-n">4</div>
        <div className="sstep-body">
          <h2>{t('Evidence for the owner', '店主のための根拠')}</h2>
          <StoreStrategy />
          <CostLine price={L.price} />
          <div className="small" style={{ marginTop: 8 }}><a href="#/agents">{t('Agent experiments: how buyer agents react to a promise →', 'エージェント実験: 買い手のエージェントは約束にどう反応するか →')}</a></div>
        </div>
      </section>

      <section className="sstep">
        <div className="sstep-n">5</div>
        <div className="sstep-body"><Obligations L={L} onChanged={onChanged} /></div>
      </section>
    </div>
  );
}

// What the full-difference promise costs on average, measured on real Channel3 prices (14-day window).
function CostLine({ price }: { price: number }) {
  const t = useT();
  const r = useAsync(() => api.get<PvD>('/api/experiments/promise-vs-discount'), []);
  const m = r.data?.measured.find((x) => x.window_days === 14);
  return (
    <div className="card demo-card" style={{ marginTop: 10 }}>
      <b>{t('What the promise costs you', '約束の費用')}</b>
      <ErrorBox error={r.error} />
      {r.data && m && (
        <>
          <div className="small">{t(
            `Expected refund: ${(m.expected_refund_share_of_price * 100).toFixed(1)}% of the price over 14 days (about ${usd(price * m.expected_refund_share_of_price)} on this item), measured: a price drop in ${(m.drop_rate * 100).toFixed(1)}% of listing-days, ${(m.drop_size_when_it_happens * 100).toFixed(1)}% deep when it happens.`,
            `見込みの返金: 14 日間で価格の ${(m.expected_refund_share_of_price * 100).toFixed(1)}%（この商品なら約 ${usd(price * m.expected_refund_share_of_price)}）。実測: 出品日の ${(m.drop_rate * 100).toFixed(1)}% で値下がりし、下がるときの深さは ${(m.drop_size_when_it_happens * 100).toFixed(1)}%。`,
          )}</div>
          <div className="muted tiny">{t(
            `Caveats: real Channel3 prices ${r.data.data_days.from} to ${r.data.data_days.to}, an ordinary period (no Black Friday); an average, not a guarantee for one item. File: server/experiments/promise-vs-discount.json.`,
            `注意: Channel3 の実際の価格 ${r.data.data_days.from}〜${r.data.data_days.to}、通常の時期（ブラックフライデーなし）。平均であり、1商品での保証ではない。ファイル: server/experiments/promise-vs-discount.json。`,
          )}</div>
        </>
      )}
    </div>
  );
}

// The newest order (usually the viewer's own run in the buyer app), with what the refund means
// for the store: it paid back the difference only because its own price really fell, and a
// matching discount would not have made this sale (see the table in "Evidence for the owner").
function LatestOrder({ o }: { o: Order }) {
  const t = useT();
  const refund = o.payout_usd ?? 0;
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="small muted">{t('Latest order', '最新の注文')} · {o.mode === 'replay-live' ? t(`replay of ${o.purchase_day ? shortDay(o.purchase_day) : ''}`, `${o.purchase_day ? shortDay(o.purchase_day) : ''} の再現`) : t('live order', '実注文')}</div>
      <OrderRow o={o} />
      {o.status === 'miss' && (
        <div className="small" style={{ marginTop: 8 }}>
          <div>· {t(`You sold today at your price, ${usd(o.paid)}, without a discount.`, `値下げせず、あなたの値段 ${usd(o.paid)} で今日売れた。`)}</div>
          <div>· {t(`You paid back ${usd(refund)} only because your own price really fell afterwards; when it does not fall, you pay nothing. You kept ${usd(o.paid - refund)}.`, `返した ${usd(refund)} は、その後あなたの値段が本当に下がったから。下がらなければ0。手元に ${usd(o.paid - refund)} が残った。`)}</div>
          <div>· {t('Matching the 3% discount would not have made this sale: on days a drop was likely, agents kept waiting (table below).', '3%値下げで合わせても、この売上は取れなかった: 値下がりしそうな日は、エージェントは待ち続けた（下の表）。')}</div>
        </div>
      )}
    </div>
  );
}

function OrderRow({ o }: { o: Order }) {
  const t = useT();
  const refund = o.payout_usd ?? 0;
  return (
    <div className={`orow ${o.status}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px' }}>
      <Icon name={o.status === 'miss' ? 'coin' : o.status === 'hit' ? 'check' : 'shield'} size={16} />
      <span className="small">{o.mode === 'replay-live' ? t(`replay of ${o.purchase_day ? shortDay(o.purchase_day) : ''}`, `${o.purchase_day ? shortDay(o.purchase_day) : ''} の再現`) : t('live order', '実注文')}</span>
      {o.status === 'open' ? (
        <span className="small">{o.mode === 'replay-live'
          ? t(`paid ${usd(o.paid)} · not judged yet: press “Fast-forward” on this run in the buyer app`, `支払い ${usd(o.paid)} · まだ判定していない: 買い手アプリのこの実行で「早送り」を押す`)
          : t(`paid ${usd(o.paid)} · judged after ${o.judge_after_day ? shortDay(o.judge_after_day) : '?'}`, `支払い ${usd(o.paid)} · ${o.judge_after_day ? shortDay(o.judge_after_day) : '?'} 以降に判定`)}</span>
      ) : (
        <span className="small">{t(`paid ${usd(o.paid)} · refunded ${usd(refund)} · kept ${usd(o.paid - refund)}`, `支払い ${usd(o.paid)} · 返金 ${usd(refund)} · 店に残る ${usd(o.paid - refund)}`)}</span>
      )}
      <span className="mono tiny muted">{o.paypal_refund_id ? `${o.paypal_refund_id}${o.refunded_at ? ` · ${o.refunded_at.slice(0, 10)}` : ''}` : ''}</span>
    </div>
  );
}

// Orders on this listing, refunds paid, and what the store kept (paid minus refund).
function WhatHappened({ L }: { L: Listing }) {
  const t = useT();
  const orders = L.orders;
  const judged = orders.filter((o) => o.status !== 'open');
  const refunds = orders.filter((o) => o.paypal_refund_id);
  const refundedTotal = refunds.reduce((s, o) => s + (o.payout_usd ?? 0), 0);
  const latest = orders[0];
  const soldTotal = orders.reduce((s, o) => s + o.paid, 0);
  return (
    <div>
      <h2>{t('What happened', '何が起きたか')}</h2>
      {orders.length === 0 ? (
        <div className="small muted">{t('No orders yet. Run the buyer app’s default scenario to see one.', 'まだ注文はありません。買い手アプリの標準シナリオを動かすと表示されます。')} <a href="#/buy?mode=replay">{t('Open the buyer app →', '買い手アプリを開く →')}</a></div>
      ) : (
        <>
          <div className="tiles3">
            <div className="tile3"><div className="tile3-big"><Icon name="receipt" size={22} /> {orders.length}</div><div className="small">{t('orders on this listing', 'この出品の注文')}</div><div className="muted tiny">{t(`${judged.length} judged, ${orders.length - judged.length} waiting`, `判定済み ${judged.length}、判定待ち ${orders.length - judged.length}`)}</div></div>
            <div className="tile3"><div className="tile3-big"><Icon name="coin" size={22} /> {usd(soldTotal - refundedTotal)}</div><div className="small">{t(`kept of ${usd(soldTotal)} sold`, `売上 ${usd(soldTotal)} のうち手元に残った額`)}</div><div className="muted tiny">{t(`after ${usd(refundedTotal)} refunded by PayPal (${refunds.length} orders whose price later fell)`, `PayPal が返金した ${usd(refundedTotal)} を引いた額（その後値段が下がった ${refunds.length} 件）`)}</div></div>
          </div>
          {latest && <LatestOrder o={latest} />}
          {orders.length > 1 && (
            <details style={{ marginTop: 10 }}>
              <summary className="small">{t(`Earlier orders on this listing (${orders.length - 1}, including other viewers' runs)`, `この出品の以前の注文（${orders.length - 1} 件。ほかの人の実行も含む）`)}</summary>
              <div className="olist">{orders.slice(1, 20).map((o) => <OrderRow key={o.id} o={o} />)}</div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Publish({ L, kind, onChanged }: { L: Listing; kind: Kind; onChanged: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const live = L.published && L.published.window_kind === kind;
  const put = async (active: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await api.put('/api/seller/claims', { product_id: L.product_id, claim_type: 'no_price_drop', stake_usd: Math.max(1, Math.ceil(L.price)), active, window_kind: kind });
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="publish">
      <div className={`pub-state${L.published ? ' on' : ''}`}>
        <Icon name={L.published ? 'shieldCheck' : 'shield'} size={28} />
        <div>
          <b>{L.published ? t(`Live: full difference refunded · ${L.published.window_kind === 'bf' ? 'until after Black Friday (old setting)' : '14 days'}`, `公開中: 差額を全額返金 · ${L.published.window_kind === 'bf' ? 'ブラックフライデーの翌日まで' : '14 日間'}`) : t('Not published', '未公開')}</b>
          <div className="muted small">{t('Store agents attach it to every order of this listing.', '店のエージェントが、この出品のすべての注文に付ける。')}</div>
          <div className="small"><Icon name="lock" size={13} /> {t('Owner setting · price negotiation: off. Asked for a lower price, your store’s AI declines and answers with this promise (the promise is its answer; the AI cannot discount).', '店主の設定・値下げ交渉: 応じない。買い手のエージェントに値下げを求められても、店の AI は断り、この約束で答える（AI は値引きできない）。')}</div>
          <div className="muted small">{t('Publishing makes this listing a Vouch member: the promise comes with every order, your store’s agent answers buyer agents with it, and if it is broken, PayPal refunds the difference from your account. Membership alone never raises your rank; the promise does, by lowering the buyer’s unprotected risk.', '公開すると、この出品は Vouch の加盟店になります。約束はどの注文にも付き、あなたの店のエージェントはこの約束つきで買い手のエージェントに答え、破られれば PayPal があなたの口座から差額を返金します。加盟しているだけで順位は上がりません。順位を動かすのは、買い手の守られないリスクを下げる約束の中身です。')}</div>
        </div>
      </div>
      <div className="row">
        <button className="primary big" disabled={busy || !!live} onClick={() => put(true)}><Icon name="shieldCheck" /> {L.published ? t('Update the promise', '約束を更新') : t('Join Vouch: publish the promise', 'Vouch に加盟: 約束を公開')}</button>
        {L.published && <button disabled={busy} onClick={() => put(false)}>{t('Withdraw', '取り下げる')}</button>}
        <a className="small" href={`#/buy`}>{t('See it in the buyer app →', '買い手のアプリで見る →')}</a>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

function Obligations({ L, onChanged }: { L: Listing; onChanged: () => void }) {
  const t = useT();
  const [budget, setBudget] = useState<number>(L.budget.monthly_usd ?? 500);
  const [error, setError] = useState<unknown>();
  const used = L.budget.open_stakes_usd + L.budget.refunded_this_month_usd;
  const cap = L.budget.monthly_usd;
  const open = L.contracts.filter((c) => c.status === 'open');
  const refunds = L.contracts.filter((c) => c.status === 'miss');
  return (
    <div>
      <h2>{t('Live orders at today’s prices, all your listings', '今日の価格での実注文（あなたの全出品）')}</h2>
      <p className="small muted">{t('Real orders placed on today’s prices; they are judged on their real verdict day. Replays of past days are counted above, not here.', '今日の価格で入った実注文。実際の判定日に判定する。過去の日の再現は上の欄で数え、ここには入れない。')}</p>
      <div className="tiles3">
        <div className="tile3"><div className="tile3-big"><Icon name="shield" size={22} /> {open.length}</div><div className="small">{t('open promises', '判定待ちの約束')}</div><div className="muted tiny">{t(`up to ${usd(L.budget.open_stakes_usd)} at stake`, `最大 ${usd(L.budget.open_stakes_usd)}`)}</div></div>
        {/* Live orders only; the replay refund is counted in step 2, so a zero here must not read as "the refund did not happen". */}
        <div className="tile3"><div className={`tile3-big${refunds.length ? ' bad' : ''}`}><Icon name="coin" size={22} /> {usd(refunds.reduce((s, c) => s + (c.payout_usd ?? 0), 0))}</div><div className="small">{t(`refunded on live orders (${refunds.length})`, `実注文の返金（${refunds.length} 件）`)}</div><div className="muted tiny">{refunds.length ? t('from your PayPal, automatically', 'あなたの PayPal から自動で') : t('none yet: open promises are judged on their verdict day. The replay refund is in step 2.', 'まだなし: 約束は判定日に判定する。再現の返金は ② に数えている。')}</div></div>
        <div className="tile3">
          <div className="small">{t('Monthly budget', '月の予算')}</div>
          <div className="budget-bar"><span style={{ width: `${cap ? Math.min(100, (used / cap) * 100) : 0}%` }} /></div>
          <div className="small">{usd(used)} / {cap != null ? usd(cap) : t('not set', '未設定')}</div>
          <div className="row">
            <input type="number" min={0} value={budget} onChange={(e) => setBudget(Number(e.target.value))} aria-label={t('Monthly budget (USD)', '月の予算（USD）')} style={{ width: 90 }} />
            <button onClick={async () => { try { await api.put('/api/seller/budget', { store: L.store, monthly_budget_usd: budget }); onChanged(); } catch (e) { setError(e); } }}>{t('Set', '設定')}</button>
          </div>
        </div>
      </div>
      {L.contracts.length > 0 && (
        <div className="olist">
          {L.contracts.slice(0, 8).map((c) => (
            <div key={c.id} className={`orow ${c.status}`}>
              <Icon name={c.status === 'miss' ? 'coin' : c.status === 'hit' ? 'check' : 'shield'} size={16} />
              <span className="small">{c.claim_type === 'no_price_drop' ? t('no price drop', '値下がりしない') : c.claim_type === 'lowest_price' ? t('lowest price', '最安値') : c.claim_type === 'genuine_sale' ? t('genuine sale', '本物のセール') : c.claim_type}</span>
              <span className="small">{usd(c.price)}</span>
              <span className="small">{c.status === 'miss' ? `−${usd(c.payout_usd)}` : c.status === 'open' ? `→ ${shortDay(c.judge_after_day)}` : t('kept', '守った')}</span>
              <span className="mono tiny muted">{c.paypal_refund_id ?? ''} {c.slot ? t(`seller ${c.slot}`, `売り手 ${c.slot}`) : ''}</span>
            </div>
          ))}
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}
