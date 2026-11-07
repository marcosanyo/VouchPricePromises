import { useT } from '../i18n';
import { ExperimentCard } from '../components/ExperimentCard';
import { ErrorBox } from '../components/ErrorBox';
import { api } from '../api';
import { useAsync } from '../useAsync';
import { StoreStrategy, WhenPromiseWins } from '../components/PromiseEvidence';

interface Arm { runs: number; buy: number }
interface TrustRun { model: string; design: { levels: Record<string, string> }; results: Record<string, Arm> }

const LEVELS = [
  { key: 'none', label: ['No promise', '約束なし'] },
  { key: 'words', label: ["Store's words", '店の言葉だけ'] },
  { key: 'self_auto', label: ["Store's auto-refund claim", '店の自動返金の主張'] },
  { key: 'vouch', label: ['Registered with Vouch, verifiable', 'Vouch 登録済み（確かめられる）'] },
  { key: 'fake_vouch', label: ["Fake claim: says 'registered with Vouch', verify finds nothing", "偽の主張: 「Vouch 登録済み」と言うが、確認しても何も出ない"] },
];

function TrustCard() {
  const t = useT();
  const gem = useAsync(() => api.get<TrustRun>('/api/experiments/agent-wait-trust-v2-gemini'), []);
  const fake = useAsync(() => api.get<TrustRun>('/api/experiments/agent-wait-trust-v2-gemini-fake_vouch'), []);
  const err = gem.error ?? fake.error;
  const cell = (r: TrustRun | undefined, key: string) => {
    const a = r?.results[key];
    return a ? <><b>{a.buy}</b> / {a.runs}</> : '—';
  };
  return (
    <div className="card">
      <h2>{t("Words don't move agents; a verifiable promise does", 'エージェントは言葉では動かず、確かめられる約束で動く')}</h2>
      <ErrorBox error={err} />
      {gem.data && fake.data && (
        <table className="plain">
          <thead>
            <tr><th></th><th>Gemini 3.8 Flash</th></tr>
          </thead>
          <tbody>
            {LEVELS.map((l) => {
              const text = (l.key === 'fake_vouch' ? fake.data : gem.data)!.design.levels[l.key];
              return (
                <tr key={l.key}>
                  <td>
                    {t(l.label[0], l.label[1])}
                    <div className="muted tiny">{text}</div>
                  </td>
                  <td>{cell(l.key === 'fake_vouch' ? fake.data : gem.data, l.key)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="muted small">{t('Cell = bought now / runs.', '数字 = 今買った回数 / 試行数。')}</p>
      <p className="muted small">{t(
        '10 products × 1 run per condition; only the cheapest store’s sentence differs; the agent can call verify_promise in every condition.',
        '商品10個 × 条件ごとに1回。違うのは最安の店の一文だけ。どの条件でもエージェントは verify_promise を呼べる。',
      )}</p>
    </div>
  );
}

// Recorded on 2026-10-26 with Claude Code (`claude -p`) connected only to the
// Vouch MCP server; see docs/agent-demo-2026-10-26.md. Abridged, not edited.
const RUNS = [
  {
    stake: '$10',
    tag: ['Before', '変更前'],
    setup: ['Cheapest store (LK63, $298) stakes $10 per claim', '最安の店（LK63、$298）が各主張に $10 を保証'],
    pick: 'Demo store GL36 · $300.41',
    answer: [
      'I’d buy from Demo store GL36 at $300.41 — #1 on effective cost. LK63 is cheapest but its $10 stakes cover only about $10 of a possible ~$60 loss, and it already failed one claim, so it ranks #3.',
      'Demo store GL36（$300.41）で買う。実質コストで1位。LK63 は最安だが、$10 の保証は見込まれる約 $60 の損失のごく一部しか覆わず、過去に1回外しているので3位。',
    ],
  },
  {
    stake: '$60',
    tag: ['After', '変更後'],
    setup: ['LK63 raises each stake to $60 (≈ the expected loss)', 'LK63 が各主張の保証を $60（見込み損失とほぼ同じ）に上げる'],
    pick: 'Demo store LK63 · $298.00',
    answer: [
      'I’d buy from Demo store LK63 at $298 — cheapest, and the only store that puts money behind its claims. Each stake roughly covers the most you could lose, so your unprotected loss is $0. You get back only the gap, up to $60. These stakes are a demo: no real store has put up money.',
      'Demo store LK63（$298）で買う。最安で、主張にお金を賭けている唯一の店。保証が損失をほぼ覆うので、守られていない損失は $0。返るのは差額だけで、$60 は上限。保証はデモで、実在の店はお金を出していない。',
    ],
  },
];

export function Agents() {
  const t = useT();
  const cfg = JSON.stringify({ mcpServers: { vouch: { command: 'node', args: ['--env-file=/path/to/paypal-vouch/.env', '/path/to/paypal-vouch/server/src/mcp.ts'] } } }, null, 2);
  return (
    <div className="page">
      <div>
        <div className="eyebrow">{t('Small experiments · Gemini 3.8 Flash · real Channel3 prices and days', '小さな実験 · Gemini 3.8 Flash · Channel3 の実際の価格と日')}</div>
        <h1>{t("A store's words don't move the agent; a promise it can verify does, and only when it is worth it", 'エージェントは店の言葉では動かない。確かめられる約束で動く。それも、見合うときだけ')}</h1>
        <p className="lead">{t('Including the days where the promise loses. Small samples; every result file is in server/experiments/.', '約束が負ける日も含めて載せる。サンプルは小さい。結果のファイルはすべて server/experiments/ にある。')}</p>
      </div>

      <TrustCard />
      <WhenPromiseWins />
      <StoreStrategy />

      <div className="card">
        <div className="chat-q">
          <span className="who">{t('Buyer', '買い手')}</span>
          {t('“I want to buy [over-ear headphones, model name hidden]. Compare the stores and tell me where you’d buy and why.”', '「［オーバーイヤーのヘッドホン、型番は非表示］を買いたい。店を比べて、どこで買うか理由とともに教えて」')}
        </div>
        <div className="chat-pair">
          {RUNS.map((r) => (
            <div key={r.stake} className="chat-col">
              <div className="chat-setup"><span className="chip chip-info" style={{ marginLeft: 0 }}>{t(r.tag[0], r.tag[1])}</span> {t(r.setup[0], r.setup[1])}</div>
              <div className="chat-a">
                <span className="who">Claude · {t('agent', 'エージェント')}</span>
                <div className="chat-pick">{t('Pick:', '選択:')} <b>{r.pick}</b></div>
                {t(r.answer[0], r.answer[1])}
              </div>
            </div>
          ))}
        </div>
        <div className="chat-a" style={{ marginTop: 12 }}>
          <span className="who">Claude · {t('then asked to buy', '購入を頼まれて')}</span>
          {t('Bought from Demo store LK63 for $298.00 on PayPal Sandbox (order 4P068953G93651302). Contracts: lowest price (up to $60, judged after Nov 2) and no price drop (up to $60, judged after Nov 9).', 'Demo store LK63 から PayPal Sandbox で $298.00 で購入（注文 4P068953G93651302）。契約: 最安値（上限 $60、11/2 以降に判定）、値下がりしない（上限 $60、11/9 以降に判定）。')}
        </div>
        <p className="muted small">{t('Recorded 2026-10-26, abridged. Staking more than the expected loss would not move LK63 any higher (the expected loss is already $0).', '2026-10-26 に記録、抜粋。見込み損失を超えて保証しても、LK63 の順位はそれ以上上がらない（守られていない損失はすでに $0）。')}</p>
      </div>

      <ExperimentCard />

      <div className="grid2">
        <div className="card">
          <h2>{t('Tools', 'ツール')}</h2>
          <table className="plain">
            <tbody>
              <tr><td className="mono">find_vouched_products</td><td>{t('Stores ranked by price + unprotected risk only (no fees, no ad spend), with reasons and refund rules', '価格 ＋ 守られていないリスクだけで順位付けした店（手数料・広告費は使わない）。理由と返金ルール付き')}</td></tr>
              <tr><td className="mono">get_store_ranking</td><td>{t('Per-claim P(fail), stake, expected loss for one item', '1商品について、主張ごとの外れる確率・保証額・見込み損失')}</td></tr>
              <tr><td className="mono">buy_with_staked_claims</td><td>{t('Freezes the contracts, then pays the real price on PayPal Sandbox', '契約を固定してから、PayPal Sandbox で実際の価格を支払う')}</td></tr>
              <tr><td className="mono">get_contract_status</td><td>{t('Verdict and PayPal refund ID', '判定と PayPal の返金 ID')}</td></tr>
              <tr><td className="mono">get_rules</td><td>{t('The fixed judging and refund rules', '決まった判定と返金のルール')}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="card">
          <h2>{t('Connect your own agent', '自分のエージェントをつなぐ')}</h2>
          <pre className="mono">{cfg}</pre>
          <p className="muted small">Claude Code: <span className="mono">claude mcp add vouch -- node --env-file=.env server/src/mcp.ts</span></p>
        </div>
      </div>
    </div>
  );
}
