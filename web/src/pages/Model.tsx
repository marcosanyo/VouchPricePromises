import { api, pct } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { useT } from '../i18n';
import { useAsync } from '../useAsync';
import { INK } from '../viz';

interface ModelFile {
  target: string; trained_at: string; features: string[]; coef: number[]; data: any;
  metrics_test: Record<string, { log_loss: number; brier: number; base_rate_brier: number; auc: number | null }>;
  reliability_test: { bin_low: number; bin_high: number; n: number; mean_predicted: number; observed_rate: number }[];
  shortfall_fraction: { mean: number; median: number; n: number };
}
interface Batch {
  batch_id: string; created_at: string; n: number; as_of_to: string; horizon_end: string; expected: number; resolved: number; dropped: number | null;
  ledger: { ledger_hash: string; batch_hash: string } | null; brier: number | null; base_rate: number | null; base_rate_brier: number | null; auc: number | null;
  bins: { lo: number; hi: number; n: number; resolved: number; dropped: number; mean_p: number }[];
}

const TITLES: Record<string, [string, string]> = {
  drop14: ['Price drops within 14 days', '14日以内に値下がりする'],
  lowest7: ['Another store goes cheaper within 7 days', '7日以内に他店のほうが安くなる'],
};

// Predicted vs observed rate per probability bin, as paired bars on one axis.
function Reliability({ rows }: { rows: { label: string; n: number; predicted: number; observed: number | null }[] }) {
  const t = useT();
  const W = 520, H = 220, L = 36, B = 34, T = 10;
  const bw = (W - L) / rows.length;
  const y = (v: number) => T + (1 - v) * (H - T - B);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={t('Predicted versus observed rate by bin', 'ビンごとの予測と実際の割合')}>
        {[0, 0.5, 1].map((v) => (
          <g key={v}>
            <line x1={L} x2={W} y1={y(v)} y2={y(v)} stroke={v === 0 ? INK.axis : INK.grid} />
            <text x={L - 4} y={y(v) + 4} textAnchor="end" fontSize={10} fill={INK.muted}>{v * 100}%</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const x0 = L + i * bw + bw * 0.15;
          const w = bw * 0.33;
          return (
            <g key={r.label}>
              <rect x={x0} y={y(r.predicted)} width={w} height={y(0) - y(r.predicted)} rx={3} fill="#9ec5f4"><title>{`${t('predicted', '予測')} ${pct(r.predicted)} · n=${r.n}`}</title></rect>
              {r.observed != null && <rect x={x0 + w + 2} y={y(r.observed)} width={w} height={y(0) - y(r.observed)} rx={3} fill="#0070e0"><title>{`${t('observed', '実際')} ${pct(r.observed)} · n=${r.n}`}</title></rect>}
              <text x={L + i * bw + bw / 2} y={H - 18} textAnchor="middle" fontSize={10} fill={INK.muted}>{r.label}</text>
              <text x={L + i * bw + bw / 2} y={H - 4} textAnchor="middle" fontSize={9} fill={INK.muted}>n={r.n}</text>
            </g>
          );
        })}
      </svg>
      <div className="race-legend small">
        <span><span className="sw" style={{ background: '#9ec5f4' }} />{t('Predicted probability', '予測した確率')}</span>
        <span><span className="sw" style={{ background: '#0070e0' }} />{t('What actually happened', '実際に起きた割合')}</span>
      </div>
    </div>
  );
}

function PreRegistered() {
  const t = useT();
  const r = useAsync(() => api.get<Batch[]>('/api/predictions'), []);
  if (r.error) return <ErrorBox error={r.error} />;
  const b = r.data?.[0];
  if (!b) return null;
  const today = new Date().toISOString().slice(0, 10);
  const daysLeft = Math.max(0, Math.round((Date.parse(b.horizon_end) - Date.parse(today)) / 86_400_000));
  const rows = b.bins.filter((x) => x.n > 0).map((x) => ({ label: `${Math.round(x.lo * 100)}–${Math.round(x.hi * 100)}%`, n: x.n, predicted: x.mean_p, observed: x.resolved ? x.dropped / x.resolved : null }));
  return (
    <div className="card hero">
      <div className="hero-num">
        <div className="muted small">{t('Pre-registered on', '事前登録日')} {b.created_at.slice(0, 10)} · {t('batch', 'バッチ')} <span className="mono">{b.batch_id}</span></div>
        <div className="n">{b.resolved === 0 ? (t.ja ? `あと${daysLeft}日` : `${daysLeft} days`) : `${b.dropped}/${b.resolved}`}</div>
        <div className="l">
          {b.resolved === 0
            ? t(`until real prices answer: we predicted ${b.expected.toFixed(1)} of ${b.n} listings will drop by ${b.horizon_end}`, `で実際の価格が答えを出す。${b.horizon_end} までに ${b.n} 件中 ${b.expected.toFixed(1)} 件が値下がりすると予測した`)
            : t(`listings dropped; we predicted ${b.expected.toFixed(1)} of ${b.n}`, `件が値下がりした（予測は ${b.n} 件中 ${b.expected.toFixed(1)} 件）`)}
        </div>
        {b.brier != null && <div className="small" style={{ marginTop: 8 }}>{t(
          `Brier ${b.brier.toFixed(3)} vs ${b.base_rate_brier != null ? b.base_rate_brier.toFixed(3) : '—'} for always predicting the training drop rate (${b.base_rate != null ? Math.round(b.base_rate * 1000) / 10 : '—'}%) · AUC ${b.auc != null ? b.auc.toFixed(2) : '—'} · ${b.resolved} of ${b.n} resolved`,
          `Brier ${b.brier.toFixed(3)}（学習データの値下がり率 ${b.base_rate != null ? Math.round(b.base_rate * 1000) / 10 : '—'}% を常に予測した場合は ${b.base_rate_brier != null ? b.base_rate_brier.toFixed(3) : '—'}）· AUC ${b.auc != null ? b.auc.toFixed(2) : '—'} · ${b.n} 件中 ${b.resolved} 件が確定`)}</div>}
        {b.ledger && <div className="muted small mono" style={{ marginTop: 8 }}>batch sha256 {b.ledger.batch_hash.slice(0, 24)}… · {t('ledger', '台帳')} {b.ledger.ledger_hash.slice(0, 16)}…</div>}
      </div>
      <div>
        <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{t('Predicted probability per bin (n = listings); actual rates appear after the horizon', 'ビンごとの予測確率（n は出品数）。期限後に実際の割合が並ぶ')}</div>
        <Reliability rows={rows} />
        <p className="muted small">{t('Frozen before the prices existed, so this is a test on the real future, not on past data. The daily job scores it automatically.', '価格が出る前に固定したので、過去のデータではなく本物の未来での検証になる。毎日のジョブが自動で答え合わせする。')}</p>
      </div>
    </div>
  );
}

function ModelCard({ target }: { target: 'drop14' | 'lowest7' }) {
  const t = useT();
  const m = useAsync(() => api.get<ModelFile>(`/api/models/${target}`), [target]);
  if (m.error) return <ErrorBox error={m.error} />;
  if (!m.data) return <div className="card muted">…</div>;
  const d = m.data;
  const lr = d.metrics_test.logistic_regression;
  const gb = d.metrics_test.gradient_boosting;
  const skill = 1 - lr.brier / lr.base_rate_brier;
  const rows = d.reliability_test.map((r) => ({ label: `${Math.round(r.bin_low * 100)}–${Math.round(r.bin_high * 100)}%`, n: r.n, predicted: r.mean_predicted, observed: r.observed_rate }));
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t(TITLES[target][0], TITLES[target][1])}</h2>
        {skill > 0.05 ? <span className="chip chip-good">{t(`Brier skill ${pct(skill)} over the base rate`, `基準率より Brier が ${pct(skill)} 改善`)}</span> : <span className="chip chip-warn">{t(`Brier skill ${pct(skill)}: barely better than the base rate`, `Brier の改善 ${pct(skill)}: 基準率とほぼ同じ`)}</span>}
      </div>
      <div className="grid2" style={{ marginTop: 12 }}>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{t('Held-out items: predicted vs actual', '学習に使っていない商品: 予測と実際')}</div>
          <Reliability rows={rows} />
        </div>
        <div className="kpi-stack">
          <div className="kv"><span>{t('AUC (logistic, served)', 'AUC（ロジスティック回帰、採用）')}</span><b>{lr.auc?.toFixed(2) ?? '—'}</b></div>
          <div className="kv"><span>{t('AUC (gradient boosting, compared)', 'AUC（勾配ブースティング、比較用）')}</span><b>{gb.auc?.toFixed(2) ?? '—'}</b></div>
          <div className="kv"><span>{t('Brier score / base rate', 'Brier スコア / 基準率')}</span><b>{lr.brier.toFixed(3)} / {lr.base_rate_brier.toFixed(3)}</b></div>
          <div className="kv"><span>{t('Shortfall when it fails (mean of price)', '外れたときの不足額（価格に対する平均）')}</span><b>{pct(d.shortfall_fraction.mean)}</b></div>
          <p className="muted small">
            {t(`Channel3 daily history ${d.data.days[0]} → ${d.data.days[1]}, split by product: ${d.data.units_train} items to train, ${d.data.units_test} held out.`, `Channel3 の日次履歴 ${d.data.days[0]} → ${d.data.days[1]}。商品単位で分割し、学習 ${d.data.units_train} 商品、検証 ${d.data.units_test} 商品。`)}
          </p>
          <details className="small">
            <summary>{t('Coefficients', '係数')}</summary>
            <table className="plain"><tbody>{d.features.map((f, i) => <tr key={f}><td className="mono">{f}</td><td>{d.coef[i].toFixed(3)}</td></tr>)}</tbody></table>
          </details>
        </div>
      </div>
    </div>
  );
}

interface ReplayModelSummary {
  target: string;
  window_days: number;
  earliest_as_of: string | null;
  latest_as_of: string | null;
  min_train_rows: number;
  by_as_of: {
    as_of: string;
    last_resolved_purchase_day: string;
    n_train: number;
    n_units: number;
    base_rate: number;
    eval_next_day: { n: number; base_rate: number; brier: number; brier_climatology: number; auc: number | null } | null;
  }[];
  out_of_group: {
    method: string;
    n_folds: number;
    n_rows: number;
    n_units: number;
    base_rate: number;
    brier: number;
    brier_climatology: number;
    auc: number | null;
    reliability: { bin_low: number; bin_high: number; n: number; mean_predicted: number; observed_rate: number }[];
  };
}

function ReplayModelsCard() {
  const t = useT();
  const m = useAsync(() => api.get<ReplayModelSummary>('/api/models/drop14-replay'), []);
  if (m.error) return <ErrorBox error={m.error} />;
  if (!m.data) return null;
  const d = m.data;
  const oog = d.out_of_group;
  const skill = 1 - oog.brier / oog.brier_climatology;
  const rows = oog.reliability.map((r) => ({ label: `${Math.round(r.bin_low * 100)}–${Math.round(r.bin_high * 100)}%`, n: r.n, predicted: r.mean_predicted, observed: r.observed_rate }));
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{t('Leak-free models for past-day replay (drop14-replay)', '過去の日の再現用・リークなしモデル（drop14-replay）')}</h2>
        <span className="chip chip-good">{t(`Out-of-group Brier skill ${pct(skill)} · ${d.by_as_of.length} causal as-of models`, `商品群除外 Brier 改善 ${pct(skill)} · 時系列モデル ${d.by_as_of.length} 個`)}</span>
      </div>
      <div className="grid2" style={{ marginTop: 12 }}>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{t('5-fold out-of-group calibration (each product group excluded from its own training fold)', '5 分割交差検証（対象の商品群を学習から除外した予測と実際）')}</div>
          <Reliability rows={rows} />
        </div>
        <div className="kpi-stack">
          <div className="kv"><span>{t('Causal as-of D models (D ≥ ' + (d.earliest_as_of ?? '—') + ')', `時系列 as-of D モデル（D ≥ ${d.earliest_as_of ?? '—'}）`)}</span><b>{d.by_as_of.length} {t('days', '日分')}</b></div>
          <div className="kv"><span>{t('Out-of-group AUC (5-fold GroupKFold)', '商品群除外 AUC（5 分割 GroupKFold）')}</span><b>{oog.auc?.toFixed(2) ?? '—'}</b></div>
          <div className="kv"><span>{t('Out-of-group Brier / base rate', '商品群除外 Brier / 基準率')}</span><b>{oog.brier.toFixed(3)} / {oog.brier_climatology.toFixed(3)}</b></div>
          <p className="muted small">
            {t(
              `When replaying a past day D ≥ ${d.earliest_as_of}, Vouch serves the strictly causal as-of D model trained only on 14-day windows already resolved by D (purchase_day ≤ D − 14, ≥ ${d.min_train_rows} rows). For earlier replay dates where fewer than ${d.min_train_rows} windows had resolved, Vouch serves the fold model that never saw that product group.`,
              `過去の日 D ≥ ${d.earliest_as_of} を再現するときは、D 時点で確定済みの 14 日期間（purchase_day ≤ D − 14、${d.min_train_rows} 件以上）のみで学習した時系列モデルを使用。それより前の日は確定済み期間が ${d.min_train_rows} 件未満のため、その商品群を学習から除外した fold モデルを使用。`,
            )}
          </p>
          <details className="small">
            <summary>{t(`Causal as-of D models (${d.earliest_as_of} → ${d.latest_as_of})`, `時系列 as-of D モデル一覧（${d.earliest_as_of} → ${d.latest_as_of}）`)}</summary>
            <table className="plain">
              <thead>
                <tr>
                  <th>as_of (D)</th>
                  <th>{t('Resolved ≤', '確定済 ≤')}</th>
                  <th>n_train</th>
                  <th>{t('Next-day Brier', '翌日検証 Brier')}</th>
                  <th>AUC</th>
                </tr>
              </thead>
              <tbody>
                {d.by_as_of.map((row) => (
                  <tr key={row.as_of}>
                    <td className="mono">{row.as_of}</td>
                    <td className="mono">{row.last_resolved_purchase_day}</td>
                    <td>{row.n_train}</td>
                    <td>{row.eval_next_day ? `${row.eval_next_day.brier.toFixed(3)} (base ${row.eval_next_day.brier_climatology.toFixed(3)})` : '—'}</td>
                    <td>{row.eval_next_day?.auc != null ? row.eval_next_day.auc.toFixed(2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      </div>
    </div>
  );
}

export function Model() {
  const t = useT();
  return (
    <div className="page">
      <div>
        <h1>{t('Are the probabilities honest?', '確率は正直か？')}</h1>
        <p className="lead">{t('With at most 30 days of history, the goal is not a high score but probabilities that come true as often as they say.', '履歴は最大30日なので、目標は高い精度ではなく、言った確率どおりに起きること。')}</p>
      </div>
      <PreRegistered />
      <ModelCard target="drop14" />
      <ReplayModelsCard />
      <ModelCard target="lowest7" />
    </div>
  );
}
