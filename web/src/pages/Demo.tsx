// Demo playground: the same buyer agent on the same real prices, only the
// featured store's promise changes (the other stores with an AI may take a fixed 3% off, no promise) (none / the store's words / a fake "registered
// with Vouch" / a Vouch promise the agent can verify). Each button runs one task;
// the table fills as runs finish. A run places a real PayPal Sandbox order only
// if the agent buys. Everything shown comes from the task's recorded events and
// state, or from the fast-forward result: no number is made up here.
// The condition switch and the store's promise are demo assumptions.
import { useEffect, useState } from 'react';
import { api, usd } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { Icon } from '../components/Icon';
import { useAsync } from '../useAsync';
import { StoreStrategy, WhenPromiseWins } from '../components/PromiseEvidence';
import { tReason, useT } from '../i18n';
import { shortDay } from '../viz';
import { dealText, negotiationText, runningLabel, type Event, type Lane, type Offer, type OwnerLimits, type ReplayVerdict, type Task } from './Buy';

interface Candidate {
  group_key: string;
  product_id: string;
  title: string;
  store: string;
  day: string;
  price: number;
  lowest_on_day: number;
  window_end: string;
  fell_to: { day: string; price: number };
  drop_usd: number;
  drop_pct: number;
  stores_on_day: number;
  has_published: boolean;
  drop_chance: number | null;
}
interface Scenario { window_days: number; earliest_as_of: string | null; candidates: Candidate[]; needs_publish: boolean; suggested: Candidate | null }

type Condition = 'none' | 'words' | 'fake' | 'vouch';
const CONDITIONS: Condition[] = ['none', 'words', 'fake', 'vouch'];
const COND_LABEL: Record<Condition, [string, string]> = {
  none: ['No promise', '約束なし'],
  words: ['Store’s words', '店の言葉だけ'],
  fake: ['Fake “registered with Vouch”', '偽の「Vouch 登録済み」'],
  vouch: ['Vouch promise (verifiable)', 'Vouch の約束（確認できる）'],
};

type DLane = Lane;
type DTask = Omit<Task, 'state'> & { state: Omit<Task['state'], 'lanes'> & { lanes: DLane[]; demo?: { condition: Condition; featured_product_id: string; featured_store: string } } };
interface Unprotected { kind: 'unprotected'; paid_usd: number; store: string; stores: { store: string; lowest_after: { day: string; price: number } | null }[] }
type Ff = (ReplayVerdict & { kind?: 'bought' }) | Unprotected;

const runsFromHash = (): string[] => {
  const p = new URLSearchParams(location.hash.split('?')[1]);
  const runs = p.get('runs');
  const one = p.get('task'); // older links: a single run
  return runs ? runs.split(',').filter(Boolean) : one ? [one] : [];
};
const setRunsHash = (ids: string[]) => history.replaceState(null, '', ids.length ? `#/demo?runs=${ids.join(',')}` : '#/demo');
const short = (h: string) => `${h.slice(0, 8)}…`;
const addDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const candLabel = (c: Candidate) => `${c.title} · ${c.store} · ${shortDay(c.day)} · ${usd(c.price)}`;
const chanceText = (c: number | null) => (c == null ? '—' : `${Math.round(c * 100)}%`);

export function Demo() {
  const t = useT();
  const scenario = useAsync(() => api.get<Scenario>('/api/demo/scenario'), []);
  const [pick, setPick] = useState(0);
  const [runs, setRuns] = useState<string[]>(runsFromHash);
  const [conds, setConds] = useState<Record<string, Condition>>({});
  const [starting, setStarting] = useState<Condition | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<unknown>();
  const sc = scenario.data;
  const cand = sc?.candidates[pick] ?? sc?.suggested ?? null;

  const update = (ids: string[]) => { setRuns(ids); setRunsHash(ids); };
  const publish = async (c: Candidate) => {
    setPublishing(true);
    setError(undefined);
    try {
      await api.put('/api/seller/claims', { product_id: c.product_id, claim_type: 'no_price_drop', stake_usd: Math.max(1, Math.ceil(c.price)), active: true, window_kind: '14' });
      scenario.reload();
    } catch (e) {
      setError(e);
    } finally {
      setPublishing(false);
    }
  };
  const run = async (c: Candidate, condition: Condition) => {
    setStarting(condition);
    setError(undefined);
    try {
      const r = await api.post<{ id: string }>('/api/shop/tasks', { group_key: c.group_key, autonomy: 'full', max_usd: Math.ceil(c.price * 1.08), risk_weight: 5, as_of: c.day, demo_condition: condition, featured_product_id: c.product_id });
      update([...runs, r.id]);
    } catch (e) {
      setError(e);
    } finally {
      setStarting(null);
    }
  };
  const ordered = [...runs].sort((a, b) => CONDITIONS.indexOf(conds[a] ?? 'vouch') - CONDITIONS.indexOf(conds[b] ?? 'vouch'));

  return (
    <div className="page">
      <h1>{t('Vouch demo', 'Vouch デモ')}</h1>
      <p className="demo-pitch">{t('Same agent, same list prices. Only the featured store’s promise changes; its price stays (negotiation off). Competing stores with an AI may take a fixed 3% off, with no promise.', '同じエージェント、同じ定価。変わるのは注目する店の約束だけ（価格は据え置き・値下げ交渉は切ってある）。競合の AI のいる店は、固定の3%値引きに応じることがあるが、約束はない。')}</p>
      <WhenPromiseWins />
      <StoreStrategy />

      <div className="card demo-card">
        {scenario.loading && <div className="muted small">{t('Loading real replay candidates…', '実データから再現の候補を探しています…')}</div>}
        <ErrorBox error={scenario.error} />
        {sc && !cand && <div className="small">{t('No store qualifies in the data: none is lowest on a day when its real price then fell.', 'データに合う店がない（最安の日のあと、実際に値下がりした店がない）。')}</div>}
        {cand && (
          <>
            <div className="row">
              {sc && sc.candidates.length > 1 ? (
                <label className="field">
                  {t('Scenario (real prices, past day)', '場面（実際の価格・過去の日）')}
                  <select value={pick} onChange={(e) => { setPick(Number(e.target.value)); if (runs.length) update([]); }}>
                    {sc.candidates.map((c, i) => <option key={i} value={i}>{candLabel(c)}</option>)}
                  </select>
                </label>
              ) : (
                <b>{candLabel(cand)}</b>
              )}
            </div>
            <div className="small">
              {t(
                `${cand.title} · ${cand.store} is the lowest of ${cand.stores_on_day} stores on ${shortDay(cand.day)} (${usd(cand.price)}). Chance of a drop in ${sc?.window_days ?? 14} days: ${chanceText(cand.drop_chance)} (model, as of that day).`,
                `${cand.title} · ${shortDay(cand.day)} は ${cand.stores_on_day} 店中 ${cand.store} が最安（${usd(cand.price)}）。${sc?.window_days ?? 14} 日以内に下がる確率: ${chanceText(cand.drop_chance)}（その日時点のモデル）。`,
              )}
            </div>
            {!cand.has_published && (
              <div className="row">
                <span className="small">{t('The Vouch condition needs this store’s promise to be published in the seller console.', 'Vouch の条件には、この店が売り手コンソールで約束を公開している必要がある。')}</span>
                <button disabled={publishing} onClick={() => publish(cand)}>{publishing ? '…' : t('Publish the store’s promise (seller console)', '店の約束を公開する（売り手コンソール）')}</button>
              </div>
            )}
            <div className="demo-conds">
              {CONDITIONS.map((c) => (
                <button key={c} className={c === 'vouch' ? 'primary' : ''} disabled={!!starting || (c === 'vouch' && !cand.has_published)} onClick={() => run(cand, c)}>
                  {c === 'vouch' && <Icon name="shieldCheck" size={16} />} {starting === c ? t('Starting…', '開始中…') : t(...COND_LABEL[c])}
                </button>
              ))}
            </div>
            <div className="small muted">{t('Each button runs the agent once. A real PayPal Sandbox order is placed only if the agent buys.', 'ボタンごとにエージェントを1回動かす。実際の PayPal Sandbox の注文は、エージェントが買ったときだけ。')}</div>
          </>
        )}
        <ErrorBox error={error} />
      </div>

      {ordered.length > 0 && (
        <div className="card demo-card">
          <div className="demo-table-wrap">
            <table className="plain demo-table">
              <thead>
                <tr>
                  <th>{t('Store’s promise', '店の約束')}</th>
                  <th>{t('Agent did', 'エージェント')}</th>
                  <th>{t('Why', '理由')}</th>
                  <th>{t('Store’s sales today', '店の今日の売上')}</th>
                  <th>{t('After the verdict', '判定のあと')}</th>
                </tr>
              </thead>
              <tbody>
                {ordered.map((id) => <RunRow key={id} id={id} onCondition={(c) => setConds((m) => (m[id] === c ? m : { ...m, [id]: c }))} />)}
              </tbody>
            </table>
          </div>
          <div className="row"><button onClick={() => update([])}>{t('Clear the table', '表を空にする')}</button></div>
        </div>
      )}

      <p className="small">
        {t('Why the store doesn’t just cut the price: a cut refunds earlier buyers — see the store AI’s 15 days ', 'なぜ店は値下げしないのか: 値下げは先に買った人への返金になる — 店の AI の15日間は ')}
        <a href="#/seller">(#/seller)</a>
      </p>
      <p className="demo-foot">
        {t(
          'Replay of a past day with real Channel3 prices; stores are anonymised. The store’s promise and the condition switch are demo assumptions.',
          '過去の日の再現。Channel3 の実際の価格を使い、店は匿名化している。店の約束と条件の切り替えはデモ用の仮定。',
        )}
      </p>
    </div>
  );
}

// "When does the promise win?": recorded runs of the buyer agent choosing between a fixed 3% discount
// and the verified promise (server/src/jobs/discount-vs-promise.ts). Read-only; every number is from the files.
function RunRow({ id, onCondition }: { id: string; onCondition: (c: Condition) => void }) {
  const t = useT();
  const [task, setTask] = useState<DTask>();
  const [error, setError] = useState<unknown>();
  const [tick, setTick] = useState(0);
  const [ff, setFf] = useState<Ff>();
  const [ffBusy, setFfBusy] = useState(false);
  const [ffError, setFfError] = useState<unknown>();
  useEffect(() => {
    let stop = false;
    api.get<DTask>(`/api/shop/tasks/${id}`).then((r) => { if (!stop) { setTask(r); onCondition(r.state.demo?.condition ?? 'vouch'); } }, (e) => { if (!stop) setError(e); });
    return () => { stop = true; };
  }, [id, tick]);
  useEffect(() => {
    if (task && task.status !== 'running') return;
    const h = setTimeout(() => setTick((x) => x + 1), 650);
    return () => clearTimeout(h);
  }, [task, tick]);
  // A run that is already judged shows its verdict and refund without pressing the button (read-only; 404 means not judged yet).
  const judgedBefore = task?.status === 'bought' && !!task.state.purchase?.contracts.length;
  useEffect(() => {
    if (!judgedBefore) return;
    let stop = false;
    api.get<ReplayVerdict>(`/api/shop/tasks/${id}/verdict`).then((r) => { if (!stop) setFf((cur) => cur ?? r); }, () => {});
    return () => { stop = true; };
  }, [id, judgedBefore]);

  if (!task) return <tr><td colSpan={5}>{error ? <ErrorBox error={error} /> : <span className="muted small">…</span>}</td></tr>;
  const { state, events, status } = task;
  const cond: Condition = state.demo?.condition ?? 'vouch';
  const decision = state.decision;
  const purchase = state.purchase;
  // The featured store: the one whose promise this run switches. Older runs without a condition: the registered or chosen store.
  const featuredName = state.demo?.featured_store ?? state.lanes.find((l) => l.verification?.found)?.store ?? purchase?.store ?? null;
  const featured = state.lanes.find((l) => l.store === featuredName) ?? null;
  const boughtHere = status === 'bought' && !!purchase && purchase.store === featuredName;
  const sales = boughtHere ? purchase!.price : 0;
  const reason = decision ? (t.ja && decision.summary_ja ? decision.summary_ja : decision.summary) : null;
  const errors = events.filter((e) => e.kind === 'error');
  const canFf = status === 'bought' && !!purchase && !!state.as_of;
  const offers = events.filter((e) => e.kind === 'offer' && e.actor === `merchant:${featuredName}`).map((e) => e.payload as Offer & { demo_condition?: Condition });
  const verify = events.find((e) => e.kind === 'verify' && e.payload?.store === featuredName)?.payload;
  const checkout = purchase ? events.find((e) => e.kind === 'checkout_verified' && e.payload?.store === purchase.store)?.payload : undefined;
  const dTime = (n: number) => (state.as_of ? addDay(state.as_of, n) : '');

  const doFf = async () => {
    setFfBusy(true);
    setFfError(undefined);
    try { setFf(await api.post<Ff>(`/api/shop/tasks/${id}/fast-forward`)); } catch (e) { setFfError(e); } finally { setFfBusy(false); }
  };

  // The store's side of the negotiation, in one line (vouch: the AI answered; the price stays).
  const finalOffer = offers.at(-1);
  const promiseEnd = finalOffer?.option.promise ? dTime(finalOffer.option.promise.window_days) : null;
  const negotiation = cond === 'vouch' && finalOffer && (
    <div className="small demo-nego">
      <Icon name="bot" size={14} /> {finalOffer.round === 2 ? t('Agent: lower price or better protection?', 'エージェント: 値下げか、もっと手厚い保護は？') : t('Agent: cover a price drop?', 'エージェント: 値下がりを保証できる？')}
      {' → '}
      <Icon name="store" size={14} /> {t('Store AI: price stays', '店の AI: 価格はそのまま')}{promiseEnd ? t(`; promise until ${shortDay(promiseEnd)}`, `。約束は ${shortDay(promiseEnd)} まで`) : t('; no promise', '。約束なし')}
    </div>
  );

  let after: React.ReactNode = <span className="muted">—</span>;
  if (ff) {
    if ('kind' in ff && ff.kind === 'unprotected') {
      const low = ff.stores.find((s) => s.store === ff.store)?.lowest_after;
      after = low && low.price < ff.paid_usd - 0.005
        ? <><b className="bad-text">{t('No refund', '返金なし')}</b><div className="small">{t(`The buyer paid ${usd(ff.paid_usd)}; the price fell to ${usd(low.price)} on ${shortDay(low.day)}.`, `買い手は ${usd(ff.paid_usd)} を支払った。${shortDay(low.day)} に ${usd(low.price)} へ下がった。`)}</div></>
        : <><b>{t('No refund needed', '返金は不要')}</b><div className="small">{t('The price did not fall.', '価格は下がらなかった。')}</div></>;
    } else {
      const v = ff as ReplayVerdict;
      const miss = v.verdict.outcome === 'miss';
      const back = v.refund?.amount_usd ?? v.verdict.payout_usd;
      after = miss
        ? v.refund?.ok
          ? <><b className="good-text">{t(`Refund paid ${usd(back)}`, `返金 ${usd(back)}`)}</b><div className="small">{t(`The store kept ${usd(v.paid_usd - back)} of the ${usd(v.paid_usd)} sale.`, `${usd(v.paid_usd)} の売上のうち、${usd(v.paid_usd - back)} が店に残った。`)}</div></>
          : <ErrorBox error={{ body: v.refund?.error, message: 'PayPal refund failed' } as any} />
        : <><b className="good-text">{t('Promise held', '約束は守られた')}</b><div className="small">{t(`No refund; the store kept ${usd(v.paid_usd)}.`, `返金なし。店に ${usd(v.paid_usd)} が残った。`)}</div></>;
    }
  } else if (status === 'bought' && !boughtHere) {
    // The column is about this store's sale; the buyer went to another store.
    after = <span className="small muted">{t('Nothing to judge: this store made no sale.', 'この店に売上がないので、判定するものがない。')}</span>;
  } else if (canFf) {
    after = <button disabled={ffBusy} onClick={doFf}><Icon name="clock" size={14} /> {ffBusy ? t('Judging…', '判定中…') : t('Fast-forward to the verdict', '判定まで早送り')}</button>;
  } else if (status === 'waiting') {
    after = <span className="small muted">{t('Nothing to judge: no sale.', '売上がないので、判定するものがない。')}</span>;
  }

  return (
    <>
      <tr>
        <td><b>{t(...COND_LABEL[cond])}</b>{negotiation}</td>
        <td>
          {status === 'running' ? <span className="small muted">{runningLabel(events, t)}<span className="spin" /></span>
            : status === 'waiting' ? <b>{t('Waited', '待った')}</b>
            : status === 'bought' ? <><b>{t('Bought', '買った')}</b>{!boughtHere && purchase && <div className="small muted">{t(`at ${purchase.store}`, `${purchase.store} で`)}</div>}</>
            : status === 'failed' ? <span className="badge bad">{t('failed', '失敗')}</span>
            : <span className="badge none">{status}</span>}
        </td>
        <td className="small demo-why">{reason ?? ''}</td>
        <td className={`demo-num ${status === 'running' ? '' : sales > 0 ? 'good-text' : 'bad-text'}`}>{status === 'running' ? '…' : usd(sales).replace(/\.00$/, '')}</td>
        <td>{after}</td>
      </tr>
      <tr className="demo-detail-row">
        <td colSpan={5}>
          {errors.map((e) => <ErrorBox key={e.seq} error={{ body: e.payload, status: e.payload.status, message: e.payload.message ?? e.kind } as any} />)}
          <ErrorBox error={ffError} />
          <details>
            <summary className="small">{t('How the agent decided', 'エージェントはどう決めたか')}</summary>
            <div className="demo-detail small">
              {offers.map((o, i) => (
                <div key={i}>
                  <span className="muted">{t(`Store said (round ${o.round})`, `店の言葉（第 ${o.round} ラウンド）`)}:</span> <span className="demo-msg">“{o.message}”</span>{' '}
                  <span className="mono">{usd(o.option.price)}</span> · {dealText(t, o.option)}{o.option.promise ? ` · ${t(`${o.option.promise.window_days} days`, `${o.option.promise.window_days} 日`)}` : ''}
                </div>
              ))}
              {featured?.owner_limits && (
                <div className="muted"><Icon name="lock" size={12} /> {t(`Owner’s limits: ${negotiationText(t, featured.owner_limits) ?? 'price negotiation: off'}${featured.owner_limits.max_promise_days != null ? `; promise ${featured.owner_limits.max_promise_days} days` : ''}. The AI cannot go past them.`, `店主の範囲: ${negotiationText(t, featured.owner_limits) ?? '値下げ交渉: 応じない'}${featured.owner_limits.max_promise_days != null ? `、約束は ${featured.owner_limits.max_promise_days} 日` : ''}。AI は越えられない。`)}</div>
              )}
              {verify ? (
                <div className="mono">verify_promise({featuredName}) → found: {String(verify.result.found)}{verify.result.found ? `, terms_hash ${short(verify.result.terms_hash)}${verify.result.terms_signed_by_store ? ', signed by store' : ''}` : ''}</div>
              ) : (
                <div className="muted">{t('The agent had no promise to check.', '確認する約束がなかった。')}</div>
              )}
              {checkout && (checkout.found ? (
                <div>
                  <span className={`badge ${checkout.signature_valid ? 'good' : 'bad'}`}>{checkout.signature_valid ? t('checkout signature valid', 'チェックアウトの署名は有効') : t('checkout signature invalid', '署名が無効')}</span>{' '}
                  <span className={`badge ${checkout.promise_in_checkout_matches_terms ? 'good' : 'bad'}`}>{checkout.promise_in_checkout_matches_terms ? t('promise matches the registered terms', '約束は登録された条件と一致') : t('promise differs from the registered terms', '約束が登録された条件と違う')}</span>
                </div>
              ) : (
                <div className="muted">{t('The checkout’s promise is not registered with Vouch, so there was nothing to compare with.', 'チェックアウトの約束は Vouch に登録されていないので、照らす相手がなかった。')}</div>
              ))}
              {purchase && <div className="mono"><Icon name="card" size={12} /> PayPal order {purchase.order_id}{purchase.capture_id ? ` · capture ${purchase.capture_id}` : ''} · AP2 mandates signed</div>}
              {ff && 'refund' in ff && ff.refund?.ok && <div className="mono"><Icon name="coin" size={12} /> PayPal refund {ff.refund.paypal_refund_id}</div>}
              {ff && 'verdict' in ff && <div className="muted">{t('Rule', 'ルール')}: {tReason(ff.verdict.reason, t.ja)}</div>}
              <div><a href={`#/buy?task=${id}`}>{t('Open in the buyer app', '買い手アプリで開く')}</a></div>
            </div>
          </details>
        </td>
      </tr>
    </>
  );
}
