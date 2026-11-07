import { useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { themeQuartz } from 'ag-grid-community';
import { api, usd } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { ContractTimeline, sellerText } from '../components/ContractTimeline';
import { useAsync } from '../useAsync';
import { tReason, useT } from '../i18n';
import { VerdictBadges } from '../components/VerdictBadges';

const gridTheme = themeQuartz.withParams({ fontFamily: 'Inter, system-ui, sans-serif', accentColor: '#0070e0' });
const statusChip = (v: string) => <span className={`chip ${v === 'hit' ? 'chip-good' : v === 'miss' ? 'chip-bad' : 'chip-info'}`}>{v}</span>;

export function Ledger() {
  const t = useT();
  const ledger = useAsync(() => api.get<any>('/api/ledger'), []);
  const [sel, setSel] = useState<any>();
  const [judge, setJudge] = useState<any>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const v = ledger.data?.verification;

  return (
    <div className="page">
      <div>
        <h1>{t('Real purchases, waiting for real prices', '実際の購入が、実際の価格の判定を待っている')}</h1>
        <p className="lead">{t('Each claim was frozen and hashed at purchase. Channel3 prices decide it; a miss is refunded through PayPal with no action from the buyer.', '主張は購入時に固定し、ハッシュを記録した。Channel3 の価格が判定し、外れたら買い手が何もしなくても PayPal で返金される。')}</p>
      </div>
      {ledger.data && (
        <div className="card">
          <ContractTimeline contracts={ledger.data.contracts} today={new Date().toISOString().slice(0, 10)} />
          <VerdictBadges />
        </div>
      )}
      <ErrorBox error={ledger.error ?? error} />
      <div className="card row">
        {v && (v.ok ? <span className="chip chip-good">{t(`Hash chain verified · ${v.entries} entries`, `ハッシュの連鎖を検証済み · ${v.entries} 件`)}</span> : <span className="chip chip-bad">{t(`Chain broken at entry ${v.broken_at}`, `${v.broken_at} 件目で連鎖が切れている`)}</span>)}
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              setJudge(await api.post('/api/live/judge'));
              ledger.reload();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t('Judging on fresh Channel3 data…', '最新の Channel3 のデータで判定中…') : t('Judge due contracts now', '期限の来た契約を今すぐ判定')}
        </button>
        <span className="muted small">{t('Fetches fresh Channel3 history, applies the rules, and refunds misses on PayPal Sandbox.', 'Channel3 の最新の履歴を取得してルールで判定し、外れは PayPal Sandbox で返金する。')}</span>
      </div>
      {judge && (
        <div className="card small">
          {judge.results.map((r: any) => <div key={r.contract_id}><span className="mono">{r.contract_id}</span> {statusChip(r.status)} {tReason(r.reason, t.ja)}{r.refund?.ok && <> · refund <span className="mono">{r.refund.paypal_refund_id}</span></>}</div>)}
          {judge.errors.length > 0 && <pre className="mono">{JSON.stringify(judge.errors, null, 2)}</pre>}
        </div>
      )}
      <div className="card">
        <h2>{t('Contracts', '契約')}</h2>
        <div className="grid-wrap">
          <AgGridReact
            theme={gridTheme}
            rowData={ledger.data?.contracts ?? []}
            rowSelection={{ mode: 'singleRow', enableClickSelection: true }}
            onSelectionChanged={(e: any) => setSel(e.api.getSelectedRows()[0])}
            columnDefs={[
              { field: 'created_at', headerName: t('Created', '作成'), width: 190, sort: 'desc' },
              { field: 'store', headerName: t('Store', '店'), width: 120 },
              { field: 'claim_type', headerName: t('Claim', '主張'), width: 140 },
              { headerName: t('Paid', '支払い'), valueGetter: (p: any) => p.data.terms.purchase_price, valueFormatter: (p: any) => usd(p.value), width: 100 },
              { headerName: t('Stake', '保証額'), valueGetter: (p: any) => p.data.terms.stake_usd, valueFormatter: (p: any) => usd(p.value), width: 90 },
              { headerName: t('Judged after', '判定日'), valueGetter: (p: any) => p.data.terms.judge_after_day, width: 120 },
              { field: 'status', headerName: t('Status', '状態'), cellRenderer: (p: any) => statusChip(p.value), width: 90 },
              { field: 'payout_usd', headerName: t('Refund', '返金'), valueFormatter: (p: any) => usd(p.value), width: 90 },
              { field: 'paypal_order_id', headerName: t('PayPal order', 'PayPal 注文'), width: 170 },
              { headerName: t('PayPal seller (pays refunds)', 'PayPal の売り手（返金元）'), width: 190, valueGetter: (p: any) => sellerText(p.data.paypal_seller, t) },
              { field: 'paypal_refund_id', headerName: t('PayPal refund', 'PayPal 返金'), width: 170 },
              { field: 'reason', headerName: t('Reason', '理由'), flex: 1, minWidth: 260, valueFormatter: (p: any) => tReason(p.value, t.ja) },
            ]}
          />
        </div>
      </div>
      {sel && (
        <div className="grid2">
          <div className="card">
            <h2>{t('Frozen terms', '固定した条件')} · <span className="mono small">{sel.id}</span></h2>
            <div className="mono small">sha256 {sel.hash}</div>
            <pre className="mono small">{JSON.stringify(sel.terms, null, 2)}</pre>
          </div>
          <div className="card">
            <h2>{t('Evidence the rule used', 'ルールが使った根拠')}</h2>
            {sel.evidence ? <pre className="mono small">{JSON.stringify(sel.evidence, null, 2)}</pre> : <p className="muted">{t(`Not judged yet (window ends ${sel.terms.judge_after_day}).`, `まだ判定していない（判定期間は ${sel.terms.judge_after_day} まで）。`)}</p>}
          </div>
        </div>
      )}
      <div className="card">
        <h2>{t('Ledger entries (newest first)', '台帳の記録（新しい順）')}</h2>
        <table className="plain small">
          <thead><tr><th>#</th><th>{t('Time', '時刻')}</th><th>{t('Kind', '種類')}</th><th>{t('Ref', '参照')}</th><th>{t('Hash', 'ハッシュ')}</th><th>{t('Payload', '内容')}</th></tr></thead>
          <tbody>
            {ledger.data?.entries.map((e: any) => (
              <tr key={e.seq}>
                <td>{e.seq}</td><td className="mono">{e.ts}</td><td>{e.kind}</td><td className="mono">{e.ref_id}</td><td className="mono">{e.hash.slice(0, 16)}…</td>
                <td><details><summary className="muted">{t('show', '表示')}</summary><pre className="mono">{JSON.stringify(e.payload, null, 2)}</pre></details></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
