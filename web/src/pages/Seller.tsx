import { useEffect, useMemo, useRef, useState } from 'react';
import { api, enc, usd, type ClaimType } from '../api';
import { AgentChoice } from '../components/AgentChoice';
import { ContractTimeline, sellerText } from '../components/ContractTimeline';
import { ErrorBox } from '../components/ErrorBox';
import { StakeCurve } from '../components/StakeCurve';
import { tReason, useT } from '../i18n';
import { useAsync } from '../useAsync';
import { STATUS } from '../viz';

interface Listing { store: string; product_id: string; group_key: string; title: string; claims: { claim_type: ClaimType; stake_usd: number }[] }
interface Quote {
  claim_type: ClaimType; price: number; as_of_day: string; p_fail: number | null; expected_shortfall_usd: number | null; expected_cost_per_order_usd: number | null;
  coupon_equivalent_pct: number | null; recommendation: string; drivers: { feature: string; contribution: number }[]; model: { target: string; trained_at: string } | null;
}
const CLAIMS: { type: ClaimType; en: string; ja: string; den: string; dja: string }[] = [
  { type: 'no_price_drop', en: 'No price drop', ja: '値下がりしない', den: 'for 14 days after purchase', dja: '購入から14日間' },
  { type: 'lowest_price', en: 'Lowest price', ja: '最安値', den: 'vs other stores, for 7 days', dja: '他店と比べて、7日間' },
  { type: 'genuine_sale', en: 'Genuine sale', ja: '本物のセール', den: '10%+ below your own 30-day average', dja: '自店の30日平均より10%以上安い' },
  { type: 'in_stock', en: 'In stock', ja: '在庫あり', den: 'at the moment of purchase', dja: '購入した時点で' },
];

function Gauge({ p }: { p: number | null }) {
  const t = useT();
  if (p == null) return <div className="gauge muted small">{t('not modelled', 'モデルなし')}</div>;
  const color = p >= 0.5 ? STATUS.critical : p >= 0.2 ? STATUS.warning : STATUS.good;
  return (
    <div className="gauge">
      <div className="gauge-v" style={{ color: p >= 0.5 ? STATUS.critical : 'var(--navy)' }}>{(p * 100).toFixed(p < 0.1 ? 1 : 0)}%</div>
      <div className="meter"><span style={{ width: `${Math.max(2, p * 100)}%`, background: color }} /></div>
      <div className="muted small">{t('chance this claim fails', 'この主張が外れる確率')}</div>
    </div>
  );
}

export function Seller() {
  const t = useT();
  const listings = useAsync(() => api.get<Listing[]>('/api/seller/stores'), []);
  const [pid, setPid] = useState<string>('0OkcsQJ');
  const listing = listings.data?.find((l) => l.product_id === pid);
  const [stakes, setStakes] = useState<Record<string, number>>({});
  const [quotes, setQuotes] = useState<Record<string, Quote | undefined>>({});
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState('');
  const [purchase, setPurchase] = useState<any>();
  const [budget, setBudget] = useState(500);
  const ledger = useAsync(() => api.get<any>('/api/ledger?limit=1'), [purchase]);
  const debounce = useRef<number | undefined>(undefined);

  const active = (c: ClaimType) => listing?.claims.some((x) => x.claim_type === c) ?? false;
  const stakeOf = (c: ClaimType) => stakes[c] ?? listing?.claims.find((x) => x.claim_type === c)?.stake_usd ?? 10;

  const loadQuote = async (c: ClaimType, stake: number) => {
    if (!listing) return;
    try {
      const q = await api.post<Quote>('/api/seller/quote', { product_id: listing.product_id, claim_type: c, stake_usd: stake });
      setQuotes((prev) => ({ ...prev, [c]: q }));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    setQuotes({});
    setStakes({});
    setPurchase(undefined);
    if (listing) for (const c of CLAIMS) loadQuote(c.type, listing.claims.find((x) => x.claim_type === c.type)?.stake_usd ?? 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.product_id]);

  const onStake = (c: ClaimType, v: number) => {
    setStakes((prev) => ({ ...prev, [c]: v }));
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      loadQuote(c, v);
      if (active(c)) setClaim(c, true, v);
    }, 250);
  };

  const setClaim = async (c: ClaimType, on: boolean, stake = stakeOf(c)) => {
    if (!listing) return;
    setBusy(c);
    try {
      await api.put('/api/seller/claims', { product_id: listing.product_id, claim_type: c, stake_usd: stake, active: on });
      listings.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy('');
    }
  };

  const buy = async () => {
    if (!listing) return;
    setBusy('buy');
    setError(undefined);
    try {
      setPurchase(await api.post('/api/live/purchase', { product_id: listing.product_id }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy('');
    }
  };

  const groups = useMemo(() => {
    const m = new Map<string, Listing[]>();
    for (const l of listings.data ?? []) m.set(l.title, [...(m.get(l.title) ?? []), l]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [listings.data]);
  const groupStores = useMemo(() => (listing ? (listings.data ?? []).filter((l) => l.group_key === listing.group_key).map((l) => l.store) : []), [listings.data, listing]);
  const totalCost = CLAIMS.filter((c) => active(c.type)).reduce((s, c) => s + (quotes[c.type]?.expected_cost_per_order_usd ?? 0), 0);
  const myContracts = (ledger.data?.contracts ?? []).filter((c: any) => c.store === listing?.store);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Stake your claims instead of buying ads', '広告の代わりに、主張に保証を付ける')}</h1>
          <p className="lead">{t('You pay only when a claim turns out false — as a partial refund on your own PayPal order.', '払うのは主張が外れたときだけ。自分の PayPal の注文への部分返金として。')}</p>
        </div>
        <label className="field">
          {t('Your listing', 'あなたの出品')}
          <select value={pid} onChange={(e) => setPid(e.target.value)} style={{ minWidth: 300 }}>
            {groups.map(([title, ls]) => (
              <optgroup key={title} label={title}>
                {ls.map((l) => <option key={l.product_id} value={l.product_id}>{l.store} — {title}{l.claims.length ? ` (${l.claims.length} ${t('staked', '件保証')})` : ''}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
      </div>
      <ErrorBox error={listings.error ?? error} />

      {listing && (
        <>
          <div className="claim-grid">
            {CLAIMS.map((c) => {
              const q = quotes[c.type];
              const on = active(c.type);
              const s = stakeOf(c.type);
              return (
                <div key={c.type} className={`claim-card${on ? ' on' : ''}`}>
                  <div className="claim-head">
                    <div>
                      <div className="claim-t">{t(c.en, c.ja)}</div>
                      <div className="muted small">{t(c.den, c.dja)}</div>
                    </div>
                    <label className="switch" title={on ? t('Staked', '保証中') : t('Not staked', '保証していない')}>
                      <input type="checkbox" checked={on} disabled={busy === c.type} onChange={(e) => setClaim(c.type, e.target.checked)} />
                      <span />
                    </label>
                  </div>
                  <div className="claim-body">
                    <Gauge p={q?.p_fail ?? null} />
                    <div className="claim-cost">
                      <div className="claim-cost-v">{q ? usd(q.expected_cost_per_order_usd) : '…'}</div>
                      <div className="muted small">{t('expected cost per order', '1注文あたりの見込み費用')}</div>
                      {q?.coupon_equivalent_pct != null && <div className="small">{t(`= a ${q.coupon_equivalent_pct.toFixed(2)}% coupon`, `= ${q.coupon_equivalent_pct.toFixed(2)}% 引きのクーポンと同じ`)}</div>}
                    </div>
                  </div>
                  <label className="field">
                    {t('Stake (max refund per order):', '保証額（1注文あたりの返金の上限）:')} <b style={{ color: 'var(--text)' }}>{usd(s)}</b>
                    <input type="range" min={1} max={100} value={s} onChange={(e) => onStake(c.type, Number(e.target.value))} style={{ accentColor: 'var(--accent)' }} />
                  </label>
                  {q && q.p_fail != null && q.expected_shortfall_usd != null && q.p_fail < 1 && q.model && <StakeCurve p={q.p_fail} shortfall={q.expected_shortfall_usd} stake={s} />}
                  {q && <div className={`claim-rec small${q.p_fail != null && q.p_fail >= 0.5 ? ' bad' : ''}`}>{tReason(q.recommendation, t.ja)}</div>}
                </div>
              );
            })}
          </div>

          <div className="card buy-bar">
            <div>
              <div className="muted small">{t('Total expected cost per order for the claims you turned on', 'オンにした主張の、1注文あたりの見込み費用の合計')}</div>
              <div className="claim-cost-v">{usd(totalCost)} <span className="muted small">{t(`on a ${usd(quotes.no_price_drop?.price)} sale`, `（${usd(quotes.no_price_drop?.price)} の販売に対して）`)}</span></div>
            </div>
            <label className="field">{t('Monthly stake budget ($)', '月間の保証の予算（$）')}
              <div className="row"><input type="number" min={0} value={budget} onChange={(e) => setBudget(Number(e.target.value))} />
                <button onClick={async () => { try { await api.put('/api/seller/budget', { store: listing.store, monthly_budget_usd: budget }); } catch (e) { setError(e); } }}>{t('Save', '保存')}</button></div>
            </label>
            <button className="primary" disabled={busy === 'buy' || listing.claims.length === 0} onClick={buy}>
              {busy === 'buy' ? t('Paying on PayPal Sandbox…', 'PayPal Sandbox で支払い中…') : t('Buy as the demo buyer (PayPal Sandbox)', 'デモの買い手として購入（PayPal Sandbox）')}
            </button>
          </div>
          {purchase && (
            <div className="card">
              <div>{t('PayPal order', 'PayPal 注文')} <span className="mono">{purchase.order.orderId}</span> · {usd(purchase.price)} · {t('fee', '手数料')} {purchase.order.paypalFee?.value ?? '—'} · {t('paid to', '支払先')} {sellerText(purchase.paypal_seller, t)}</div>
              <ul>
                {purchase.judged.results.map((r: any) => (
                  <li key={r.contract_id}>
                    <span className="mono">{r.contract_id}</span> <span className={`chip ${r.status === 'hit' ? 'chip-good' : r.status === 'miss' ? 'chip-bad' : 'chip-info'}`}>{r.status}</span> {tReason(r.reason, t.ja)}
                    {r.refund?.ok && <> · {t('refund', '返金')} <span className="mono">{r.refund.paypal_refund_id}</span> ({usd(r.payout_usd)})</>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="card">
            <h2>{t('Where your stakes put you today', '今日の保証で、あなたの店は何位になるか')}</h2>
            <AgentChoice groupKey={listing.group_key} stores={groupStores} initialStore={listing.store} />
            <p className="muted small"><a href={`#/market?group=${enc(listing.group_key)}`}>{t('Replay 30 days of this product →', 'この商品の30日間をリプレイ →')}</a></p>
          </div>

          {myContracts.length > 0 && (
            <div className="card">
              <h2>{t(`Your live contracts (${listing.store})`, `あなたのライブ契約（${listing.store}）`)}</h2>
              <p className="muted small">{t(`Orders are paid to, and refunds come out of: ${sellerText(myContracts[0].paypal_seller, t)}. Your record follows this PayPal seller, not your site name.`, `注文の支払先で、返金の出どころ: ${sellerText(myContracts[0].paypal_seller, t)}。店の実績はサイト名ではなく、この PayPal の売り手に付く。`)}</p>
              <ContractTimeline contracts={myContracts} today={new Date().toISOString().slice(0, 10)} />
            </div>
          )}

          <div className="grid2">
            <ClaimExtractor />
            <CatalogAudit groupKey={listing.group_key} />
          </div>
        </>
      )}
    </div>
  );
}

function ClaimExtractor() {
  const t = useT();
  const [text, setText] = useState('Our lowest price of the season — 25% off for a limited time! In stock and ships today. Price protection: if the price drops within 14 days, we refund the difference. Compatible with every phone.');
  const [out, setOut] = useState<any>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="card">
      <h2>{t('Which promises does your copy make?', 'あなたの説明文は何を約束している？')}</h2>
      <p className="muted small">{t('Gemini 3.8 Flash only lists the promises. It never sets probabilities, prices, or verdicts.', 'Gemini 3.8 Flash は約束を書き出すだけ。確率・価格・判定は決めない。')}</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className="textarea" />
      <button disabled={busy} onClick={async () => { setBusy(true); setError(undefined); try { setOut(await api.post('/api/seller/extract-claims', { text })); } catch (e) { setError(e); } finally { setBusy(false); } }}>
        {busy ? t('Reading…', '読み取り中…') : t('Extract claims', '主張を抜き出す')}
      </button>
      <ErrorBox error={error} />
      {out && (
        <div className="chips">
          {out.claims.map((c: any, i: number) => <div key={i} className="pill pill-ok">✓ {c.type}<span className="muted"> “{c.quote}”</span></div>)}
          {out.unsupported.map((c: any, i: number) => <div key={'u' + i} className="pill">✕ {t('not stakeable', '保証できない')}<span className="muted"> “{c.quote}”</span></div>)}
        </div>
      )}
    </div>
  );
}

function CatalogAudit({ groupKey }: { groupKey: string }) {
  const t = useT();
  const [out, setOut] = useState<any>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState(false);
  useEffect(() => setOut(undefined), [groupKey]);
  return (
    <div className="card">
      <h2>{t('Do the other stores describe the same item?', '他の店は同じ商品として説明している？')}</h2>
      <p className="muted small">{t('Gemini compares listings for contradictions (model, capacity, compatibility, contents). Fix them before staking.', 'Gemini が出品同士の食い違い（型番、容量、対応機種、同梱物）を探す。保証の前に直す。')}</p>
      <div className="row">
        <label className="small"><input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} /> {t('include product images', '商品画像も使う')}</label>
        <button disabled={busy} onClick={async () => { setBusy(true); setError(undefined); try { setOut(await api.post('/api/seller/audit', { group_key: groupKey, images })); } catch (e) { setError(e); } finally { setBusy(false); } }}>
          {busy ? t('Auditing…', '確認中…') : t('Run audit', '監査する')}
        </button>
      </div>
      <ErrorBox error={error} />
      {out && (
        <div className="chips">
          {out.consistent ? <div className="pill pill-ok">✓ {t('consistent', '食い違いなし')}</div> : out.findings.map((f: any, i: number) => <div key={i} className="pill">⚠ {f.field}<span className="muted"> {f.detail}</span></div>)}
        </div>
      )}
    </div>
  );
}
