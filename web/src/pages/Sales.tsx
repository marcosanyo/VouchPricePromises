import { useMemo, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { themeQuartz } from 'ag-grid-community';
import { api, usd } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { useAsync } from '../useAsync';
import { tReason, useT } from '../i18n';
import { VerifyBadge } from '../components/VerifyBadge';

type Pattern = 'raised_first' | 'unchanged' | 'small_discount' | 'genuine';
interface Check {
  product_id: string; store: string; title: string; category: string | null; observed_day: string; price: number; was_price: number;
  advertised_discount_pct: number; mean_30d: number | null; actual_discount_pct: number | null;
  verdict: 'genuine' | 'not_genuine' | 'evidence_missing' | 'inconsistent'; pattern: Pattern | null; hypothetical_refund_usd: number; reason: string;
  series: { day: string; price: number }[];
}
interface Report {
  rule: { min_discount_pct: number; lookback_days: number; stake_usd: number };
  observed_days: string[];
  summary: {
    listings_with_discount_label: number; judged: number; not_genuine: number; evidence_missing: number; inconsistent: number;
    median_advertised_discount_pct: number; median_actual_discount_pct: number; patterns: Record<Pattern, number>; unchanged_band_pct: number; hypothetical_refunds_usd: number;
    was_never_charged: number;
  };
  checks: Check[];
  caveats: string[];
}

const gridTheme = themeQuartz.withParams({ fontFamily: 'Inter, system-ui, sans-serif', accentColor: '#0070e0' });
const PATTERN: Record<Pattern, { label: string; ja: string; color: string }> = {
  raised_first: { label: 'Price raised before the “sale”', ja: '「セール」の前に値上げ', color: '#b3261e' },
  unchanged: { label: 'Same price as the past month', ja: '先月と同じ価格', color: '#e8710a' },
  small_discount: { label: 'Real but under 10%', ja: '値引きはあるが10%未満', color: '#f9ab00' },
  genuine: { label: 'Genuine sale (10%+ below)', ja: '本物のセール（10%以上安い）', color: '#137333' },
};
const ORDER: Pattern[] = ['raised_first', 'unchanged', 'small_discount', 'genuine'];

function PatternBar({ s }: { s: Report['summary'] }) {
  const t = useT();
  return (
    <div>
      <div style={{ display: 'flex', height: 18, borderRadius: 9, overflow: 'hidden' }}>
        {ORDER.map((p) => <div key={p} title={`${t(PATTERN[p].label, PATTERN[p].ja)}: ${s.patterns[p]}`} style={{ width: `${(s.patterns[p] / s.judged) * 100}%`, background: PATTERN[p].color }} />)}
      </div>
      <div className="row small" style={{ marginTop: 8, gap: 16 }}>
        {ORDER.map((p) => (
          <span key={p}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: PATTERN[p].color, marginRight: 6 }} />{t(PATTERN[p].label, PATTERN[p].ja)}: <b>{s.patterns[p]}</b></span>
        ))}
      </div>
    </div>
  );
}

// x = discount the label advertises, y = discount vs the store's own 30-day mean.
function Scatter({ checks, selected, onSelect, threshold }: { checks: Check[]; selected?: string; onSelect: (c: Check) => void; threshold: number }) {
  const t = useT();
  const W = 560, H = 380, P = 58;
  const pts = checks.filter((c) => c.actual_discount_pct != null);
  const yMin = Math.max(-60, Math.min(-10, ...pts.map((c) => c.actual_discount_pct!)));
  const yMax = 60;
  const x = (v: number) => P + (Math.min(100, Math.max(0, v)) / 100) * (W - 2 * P);
  const y = (v: number) => H - P - ((Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin)) * (H - 2 * P);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Advertised discount versus actual discount">
      <rect x={P} y={y(yMax)} width={W - 2 * P} height={y(threshold) - y(yMax)} fill="#e6f4ea" />
      <line x1={x(0)} y1={y(threshold)} x2={x(100)} y2={y(threshold)} stroke="#137333" strokeDasharray="4 4" />
      <text x={x(0) + 6} y={y(yMax) + 16} fill="#137333" fontWeight={600}>{t(`Real sale: ${threshold}%+ below the store's own 30-day average`, `本物のセール: その店の30日平均より ${threshold}% 以上安い`)}</text>
      <line x1={x(0)} y1={y(0)} x2={x(100)} y2={y(0)} stroke="var(--border)" />
      <line x1={x(0)} y1={y(0)} x2={x(yMax)} y2={y(yMax)} stroke="var(--muted)" strokeDasharray="2 4" />
      {[0, 25, 50, 75, 100].map((t) => <text key={t} x={x(t)} y={H - P + 16} textAnchor="middle">{t}%</text>)}
      {[yMin, 0, threshold, 30, yMax].map((t) => <text key={t} x={P - 6} y={y(t) + 4} textAnchor="end">{Math.round(t)}%</text>)}
      <text x={W / 2} y={H - 6} textAnchor="middle">{t('discount shown on the listing', '出品に表示された値引き率')}</text>
      <text x={12} y={H / 2} textAnchor="middle" transform={`rotate(-90 12 ${H / 2})`}>{t('actual discount vs own 30-day mean', '30日平均と比べた実際の値引き率')}</text>
      {pts.map((c) => (
        <circle key={c.product_id} cx={x(c.advertised_discount_pct)} cy={y(c.actual_discount_pct!)} r={c.product_id === selected ? 7 : 4.5}
          fill={PATTERN[c.pattern!].color} fillOpacity={0.75} stroke={c.product_id === selected ? 'var(--text)' : 'white'} strokeWidth={c.product_id === selected ? 2 : 1}
          style={{ cursor: 'pointer' }} onClick={() => onSelect(c)}>
          <title>{`${c.store} · ${c.title}\nlabel ${c.advertised_discount_pct}% off · actual ${c.actual_discount_pct}%`}</title>
        </circle>
      ))}
    </svg>
  );
}

function History({ c }: { c: Check }) {
  const t = useT();
  const W = 560, H = 200, P = 40;
  const prices = [...c.series.map((p) => p.price), c.was_price];
  const lo = Math.min(...prices) * 0.9, hi = Math.max(...prices) * 1.05;
  const n = c.series.length;
  const x = (i: number) => P + (i / Math.max(1, n - 1)) * (W - 2 * P);
  const y = (v: number) => H - 24 - ((v - lo) / (hi - lo)) * (H - 48);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Daily price history">
      <line x1={P} x2={W - P} y1={y(c.was_price)} y2={y(c.was_price)} stroke="#b3261e" strokeDasharray="5 4" />
      <text x={W - P} y={y(c.was_price) - 6} textAnchor="end" fill="#b3261e">{t('“was”', '通常価格')} {usd(c.was_price)}</text>
      {c.mean_30d != null && <>
        <line x1={P} x2={W - P} y1={y(c.mean_30d)} y2={y(c.mean_30d)} stroke="var(--muted)" strokeDasharray="2 4" />
        <text x={P} y={y(c.mean_30d) - 6} fill="var(--muted)">{t('30-day mean', '30日平均')} {usd(c.mean_30d)}</text>
      </>}
      <polyline fill="none" stroke="#0070e0" strokeWidth={2.5} points={c.series.map((p, i) => `${x(i)},${y(p.price)}`).join(' ')} />
      <circle cx={x(n - 1)} cy={y(c.price)} r={5} fill="#0070e0" />
      <text x={x(n - 1)} y={y(c.price) + 18} textAnchor="end" fill="#0070e0">{t('now', '今')} {usd(c.price)}</text>
      <text x={P} y={H - 6}>{c.series[0]?.day}</text>
      <text x={W - P} y={H - 6} textAnchor="end">{c.observed_day}</text>
    </svg>
  );
}

export function Sales() {
  const t = useT();
  const r = useAsync(() => api.get<Report>('/api/insights/fake-sales'), []);
  const [sel, setSel] = useState<Check>();
  const featured = useMemo(() => {
    const d = r.data;
    if (!d) return undefined;
    return sel ?? d.checks.find((c) => c.pattern === 'raised_first' && c.series.length >= 20 && c.price >= 30) ?? d.checks.find((c) => c.pattern === 'unchanged');
  }, [r.data, sel]);

  if (r.error) return <div className="page"><ErrorBox error={r.error} /></div>;
  if (!r.data) return <div className="page"><div className="card muted">{t('Checking every discount label against 30 days of real prices…', 'すべての値引き表示を30日分の実際の価格と照合しています…')}</div></div>;
  const { summary: s, rule } = r.data;

  return (
    <div className="page">
      <div className="card hero">
        <div className="hero-num">
          <div className="n">{s.was_never_charged}<span> / {s.judged}</span></div>
          <div className="l">{t.ja ? <>件の「セール」表示が、直前の {rule.lookback_days} 日間に<b>その店が一度も付けていない「通常価格」</b>を使っていた</> : <>“sale” labels showed a <b>“was” price the store never charged</b> in the previous {rule.lookback_days} days</>}</div>
        </div>
        <div className="hero-side">
          <div className="kv"><span>{t('Discount on the label (median)', '表示上の値引き率（中央値）')}</span><b>{s.median_advertised_discount_pct.toFixed(0)}%</b></div>
          <div className="kv"><span>{t("Real discount vs the store's own 30-day average (median)", 'その店の30日平均と比べた実際の値引き率（中央値）')}</span><b>{s.median_actual_discount_pct.toFixed(0)}%</b></div>
          <div className="kv"><span>{t(`Refunds if each had staked $${rule.stake_usd} on “genuine sale”`, `各店が「本物のセール」に $${rule.stake_usd} の保証を付けていたら返金される額`)}</span><b>{usd(s.hypothetical_refunds_usd)}</b></div>
          <PatternBar s={s} />
          <div className="muted small">{t('Real Channel3 prices · observed', 'Channel3 の実際の価格 · 観測日')} {r.data.observed_days.join(', ')} · {t('stores anonymised', '店名は匿名化')}</div>
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <h2>{t('Every label, checked', 'すべての表示を確認')}</h2>
          <p className="muted small">{t('Each dot is one listing. Above the green line: a real sale. Click a dot.', '点は1つの出品。緑の線より上が本物のセール。点をクリックしてください。')}</p>
          <Scatter checks={r.data.checks} selected={featured?.product_id} onSelect={setSel} threshold={rule.min_discount_pct} />
        </div>
        {featured && (
          <div className="card">
            <h2>{featured.store} · {featured.title}</h2>
            <div className="row small" style={{ gap: 8, marginBottom: 8 }}>
              {featured.pattern && <span className="chip" style={{ background: PATTERN[featured.pattern].color, color: '#fff', marginLeft: 0 }}>{t(PATTERN[featured.pattern].label, PATTERN[featured.pattern].ja)}</span>}
              <span>{t('Label:', '表示:')} <s>{usd(featured.was_price)}</s> → <b>{usd(featured.price)}</b> ({featured.advertised_discount_pct.toFixed(0)}% {t('off', 'オフ')})</span>
            </div>
            <History c={featured} />
            <p className="small">{tReason(featured.reason, t.ja)}</p>
            <VerifyBadge key={featured.product_id} productIds={[featured.product_id]} />
            {featured.verdict === 'not_genuine' && <p className="small">{t.ja ? <>「本物のセール」に ${rule.stake_usd} の保証が付いていれば、買い手には PayPal で <b>{usd(featured.hypothetical_refund_usd)}</b> が自動で返金されていた。</> : <>A ${rule.stake_usd} staked “genuine sale” claim would have refunded <b>{usd(featured.hypothetical_refund_usd)}</b> to the buyer automatically, through PayPal.</>}</p>}
          </div>
        )}
      </div>

      <div className="card">
        <h2>{t(`All ${s.listings_with_discount_label} listings with a discount label`, `値引き表示のある全 ${s.listings_with_discount_label} 件`)}</h2>
        <p className="muted small">{t(`${s.inconsistent} excluded because the listed price did not match the daily history on the same day; ${s.evidence_missing} had too little history to judge.`, `${s.inconsistent} 件は当日の表示価格が日次の履歴と合わないため除外。${s.evidence_missing} 件は履歴が少なく判定できない。`)}</p>
        <div className="grid-wrap">
          <AgGridReact
            theme={gridTheme}
            rowData={r.data.checks}
            rowSelection={{ mode: 'singleRow', enableClickSelection: true }}
            onSelectionChanged={(e: any) => { const row = e.api.getSelectedRows()[0]; if (row?.pattern) setSel(row); }}
            defaultColDef={{ sortable: true, filter: true, resizable: true }}
            columnDefs={[
              { field: 'store', headerName: t('Store', '店'), width: 120 },
              { field: 'title', headerName: t('Title', '商品'), flex: 1, minWidth: 220 },
              { field: 'category', headerName: t('Category', 'カテゴリ'), width: 150 },
              { field: 'was_price', headerName: t('“Was”', '通常価格'), valueFormatter: (p: any) => usd(p.value), width: 110 },
              { field: 'price', headerName: t('Now', '今'), valueFormatter: (p: any) => usd(p.value), width: 110 },
              { field: 'advertised_discount_pct', headerName: t('Label % off', '表示の値引き'), width: 120, valueFormatter: (p: any) => `${p.value.toFixed(1)}%` },
              { field: 'mean_30d', headerName: t('30-day mean', '30日平均'), valueFormatter: (p: any) => usd(p.value), width: 130 },
              { field: 'actual_discount_pct', headerName: t('Actual % off', '実際の値引き'), width: 120, valueFormatter: (p: any) => (p.value == null ? '—' : `${p.value.toFixed(1)}%`) },
              { field: 'pattern', headerName: t('Pattern', 'パターン'), width: 220, cellRenderer: (p: any) => (p.value ? <span style={{ color: PATTERN[p.value as Pattern].color, fontWeight: 600 }}>{t(PATTERN[p.value as Pattern].label, PATTERN[p.value as Pattern].ja)}</span> : <span className="muted">{t(p.data.verdict.replace('_', ' '), p.data.verdict === 'inconsistent' ? '食い違い' : 'データ不足')}</span>) },
              { field: 'reason', headerName: t('Reason', '理由'), flex: 1, minWidth: 280, valueFormatter: (p: any) => tReason(p.value, t.ja) },
            ]}
          />
        </div>
      </div>

      <div className="card small muted">
        {t.ja ? <><b>読み方。</b>「通常価格」は出品に表示されていた価格で、その店の過去の価格ではなくメーカー希望価格の場合もある。10% の基準は Vouch の契約の設定値で、法的な基準ではない。価格は Channel3 の日次履歴で、店名は匿名化し、どの店も実際には保証していない。当日の表示価格が日次の履歴と2%を超えて食い違う出品は除外した。判定は「本物のセール」の契約と同じルール（<a href="/api/rules" target="_blank">ルール</a>）。集計は Channel3 の許可を得て公開。</> : <><b>How to read this.</b> {r.data.caveats.join(' ')} Verdicts use the same rule as a staked “genuine sale” contract (<a href="/api/rules" target="_blank">rules</a>). Aggregate figures are published with Channel3's permission.</>}
      </div>
    </div>
  );
}
