// "These are real prices": re-fetches Channel3 now and compares day by day
// with what is on screen. Shows only counts and the time, never names.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useT } from '../i18n';
import { ErrorBox } from './ErrorBox';

interface Result { checked_at: string; endpoint: string; results: { product_id: string; compared: number; matched: number; mismatches: { day: string }[]; api_call_id: number }[] }

// Pass the listings' ids, or the public key of an item (every store that sells it).
export function VerifyBadge({ productIds, groupKey }: { productIds?: string[]; groupKey?: string }) {
  const t = useT();
  const [r, setR] = useState<Result>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const compared = r?.results.reduce((s, x) => s + x.compared, 0) ?? 0;
  const matched = r?.results.reduce((s, x) => s + x.matched, 0) ?? 0;
  return (
    <div className="verify">
      <button
        disabled={busy || (!groupKey && !productIds?.length)}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            setR(await api.post<Result>('/api/verify', groupKey ? { group_key: groupKey } : { product_ids: productIds!.slice(0, 12) }));
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? t('Asking Channel3…', 'Channel3 に問い合わせ中…') : t('Check these prices against Channel3 now', 'この価格を今 Channel3 と照合する')}
      </button>
      {r && (
        <span className={`chip ${matched === compared && compared > 0 ? 'chip-good' : 'chip-warn'}`}>
          {t(`✓ ${matched} of ${compared} daily prices match Channel3 · ${r.checked_at.slice(0, 19).replace('T', ' ')} UTC`, `✓ 日次価格 ${compared} 件中 ${matched} 件が Channel3 と一致 · ${r.checked_at.slice(0, 19).replace('T', ' ')} UTC`)}
        </span>
      )}
      {r && <span className="muted small">{t(`live API calls #${r.results.map((x) => x.api_call_id).join(', #')} (names hidden)`, `その場の API 呼び出し #${r.results.map((x) => x.api_call_id).join(', #')}（名前は非表示）`)}</span>}
      <ErrorBox error={error} />
    </div>
  );
}

interface Provenance { points: number; listings: number; days: number; first_day: string; last_day: string; stores: number; channel3_calls: number }

// The band that says what the prices are: real Channel3 data, with counts from the database,
// why names are hidden, and the live check for the item on screen.
export function Channel3Provenance({ groupKey }: { groupKey: string }) {
  const t = useT();
  const [p, setP] = useState<Provenance>();
  const [error, setError] = useState<unknown>();
  useEffect(() => { api.get<Provenance>('/api/provenance').then(setP, setError); }, []);
  const n = (x: number) => x.toLocaleString('en-US');
  return (
    <div className="provenance">
      <div className="provenance-head">
        <b>{t('Real prices from Channel3', '価格は Channel3 の実データ')}</b>
        {p && <span className="small">{t(
          `${n(p.listings)} listings at ${n(p.stores)} stores · ${n(p.points)} daily prices, ${p.first_day} → ${p.last_day} · ${n(p.channel3_calls)} recorded Channel3 API calls`,
          `${n(p.stores)} 店の ${n(p.listings)} 出品 · 日次の価格 ${n(p.points)} 件（${p.first_day} → ${p.last_day}）· 記録した Channel3 の API 呼び出し ${n(p.channel3_calls)} 回`)}</span>}
      </div>
      <div className="small muted">{t(
        'Store and product names are hidden: a product name with its price and date is enough to find the real store, and the stores’ promises here are a demo assumption. Check the prices yourself:',
        '店名と商品名は伏せている。商品名と価格と日付があれば実在の店が分かり、ここでの店の約束はデモの仮定だから。価格はその場で確かめられる:')}</div>
      <VerifyBadge groupKey={groupKey} />
      <ErrorBox error={error} />
    </div>
  );
}
