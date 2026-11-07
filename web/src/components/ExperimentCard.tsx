// Agent-choice experiment: share of picks for the slightly pricier store, by
// stake level, in two conditions (Vouch ranking shown vs facts only).
import { api, usd } from '../api';
const pct = (v: number | null) => `${Math.round((v ?? 0) * 100)}%`;
import { useT } from '../i18n';
import { useAsync } from '../useAsync';
import { INK } from '../viz';
import { ErrorBox } from './ErrorBox';

const LEVELS = ['none', 'low', 'cover'] as const;
const LEVEL_LABEL: Record<(typeof LEVELS)[number], [string, string]> = { none: ['No stake', '保証なし'], low: ['$10 stake', '保証 $10'], cover: ['Covers the expected drop', '見込み値下がり分を保証'] };
const COND: Record<string, { label: [string, string]; color: string }> = {
  facts: { label: ['Agent sees facts only (no Vouch ranking)', '事実だけを見せた（Vouch の順位なし）'], color: '#0070e0' },
  ranked: { label: ['Agent sees Vouch’s ranking', 'Vouch の順位を見せた'], color: '#9ec5f4' },
};

export function ExperimentCard() {
  const t = useT();
  const r = useAsync(() => api.get<any>('/api/experiments/agent-choice'), []);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return null;
  const d = r.data;
  const W = 560, H = 230, L = 40, B = 40, T = 10;
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const gw = (W - L) / LEVELS.length;
  const conds = ['facts', 'ranked'];
  const examples = (d.runs as any[]).filter((x) => x.condition === 'facts' && x.level === 'cover').slice(0, 3);
  // The product where the two conditions split most at full cover (largest price
  // gap on ties): the agent follows the stake, Vouch's ranking keeps the cheaper store.
  const split = new Map<string, { gap: number; facts: number; ranked: number; n: number }>();
  for (const x of d.runs as any[]) {
    if (x.level !== 'cover' || !x.valid) continue;
    const s = split.get(x.product) ?? { gap: x.price_gap_usd, facts: 0, ranked: 0, n: 0 };
    if (x.condition === 'facts') { s.facts += Number(x.picked_target); s.n += 1; } else s.ranked += Number(x.picked_target);
    split.set(x.product, s);
  }
  const contrast = [...split.entries()].map(([product, s]) => ({ product, ...s })).filter((s) => s.facts > s.ranked).sort((a, b) => b.facts - b.ranked - (a.facts - a.ranked) || b.gap - a.gap)[0];
  return (
    <div className="card">
      <h2>{t(`Experiment: does the stake change ${d.model}'s pick?`, `実験: 保証は ${d.model} の選択を変えるか？`)}</h2>
      <p className="muted small">
        {t(
          `${d.design.products} products sold at 3+ stores. The second-cheapest store (within 15% of the cheapest) gets a hypothetical “no price drop” stake at three levels. ${d.design.samples_per_cell} picks per cell at temperature ${d.design.temperature}. Products and stores anonymised in the prompt. Run ${d.run_at.slice(0, 10)}.`,
          `3店以上で売られている ${d.design.products} 商品。2番目に安い店（最安から15%以内）に、仮の「値下がりしない」保証を3段階で付けた。各条件 ${d.design.samples_per_cell} 回、温度 ${d.design.temperature}。プロンプトでは商品も店も匿名。実施日 ${d.run_at.slice(0, 10)}。`,
        )}
      </p>
      <div className="grid2">
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 4 }}>{t('Share of picks for the slightly pricier store', '少し高い店が選ばれた割合')}</div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={t('Pick rate by stake level and condition', '保証の段階と条件ごとの選択率')}>
            {[0, 0.5, 1].map((v) => (
              <g key={v}>
                <line x1={L} x2={W} y1={y(v)} y2={y(v)} stroke={v === 0 ? INK.axis : INK.grid} />
                <text x={L - 4} y={y(v) + 4} textAnchor="end" fontSize={10} fill={INK.muted}>{v * 100}%</text>
              </g>
            ))}
            {LEVELS.map((l, i) => (
              <g key={l}>
                {conds.map((c, j) => {
                  const cell = d.results[c][l];
                  const v = cell.rate ?? 0;
                  const w = gw * 0.3;
                  const x0 = L + i * gw + gw * 0.18 + j * (w + 3);
                  return (
                    <g key={c}>
                      <rect x={x0} y={y(v)} width={w} height={y(0) - y(v)} rx={4} fill={COND[c].color}><title>{`${t(COND[c].label[0], COND[c].label[1])}: ${cell.picked_target}/${cell.n}`}</title></rect>
                      <text x={x0 + w / 2} y={y(v) - 4} textAnchor="middle" fontSize={11} fontWeight={700} fill={INK.primary}>{Math.round(v * 100)}%</text>
                    </g>
                  );
                })}
                <text x={L + i * gw + gw / 2} y={H - 22} textAnchor="middle" fontSize={11} fill={INK.secondary}>{t(LEVEL_LABEL[l][0], LEVEL_LABEL[l][1])}</text>
                <text x={L + i * gw + gw / 2} y={H - 8} textAnchor="middle" fontSize={10} fill={INK.muted}>n={d.results.facts[l].n}+{d.results.ranked[l].n}</text>
              </g>
            ))}
          </svg>
          <div className="race-legend small">
            {conds.map((c) => <span key={c}><span className="sw" style={{ background: COND[c].color }} />{t(COND[c].label[0], COND[c].label[1])}</span>)}
          </div>
          <p className="small" style={{ marginTop: 10 }}>
            {t(
              `Just showing the stake made the agent pick the staked store more often (${pct(d.results.facts.none.rate)} → ${pct(d.results.facts.cover.rate)}). Vouch's ranking is one step more cautious (${pct(d.results.ranked.none.rate)} → ${pct(d.results.ranked.cover.rate)}): when the price gap is larger than the expected loss the stake removes, it keeps the store with the lowest effective cost on top.`,
              `保証を見せるだけで、エージェントは保証した店を選ぶようになった（${pct(d.results.facts.none.rate)} → ${pct(d.results.facts.cover.rate)}）。Vouch の順位はさらに一歩慎重で（${pct(d.results.ranked.none.rate)} → ${pct(d.results.ranked.cover.rate)}）、価格差が保証で消える見込み損失より大きいときは、実質コストが最安の店を上に残す。`,
            )}
          </p>
          {contrast && (
            <p className="small">
              {t(
                `Example — ${contrast.product}, price gap ${usd(contrast.gap)}: facts only ${contrast.facts}/${contrast.n} picks for the staked store; with Vouch's ranking ${contrast.ranked}/${contrast.n}.`,
                `例 — ${contrast.product}（価格差 ${usd(contrast.gap)}）: 事実だけなら保証した店が ${contrast.facts}/${contrast.n}、Vouch の順位を見せると ${contrast.ranked}/${contrast.n}。`,
              )}
            </p>
          )}
          <p className="muted small">{t('Neither condition is called right or wrong here: telling which choice is cheaper for the buyer needs an effective-cost comparison that has not been run yet.', 'どちらの条件が正しいとは言っていない。どちらが買い手に得かは、実質コストで比べる追加集計（未実施）が要る。')}</p>
          <p className="muted small">{t(`Small sample: ${d.design.products} products × ${d.design.samples_per_cell} picks; picks for the same product are not independent. ${d.invalid_picks} invalid picks.`, `標本は小さい: ${d.design.products} 商品 × ${d.design.samples_per_cell} 回。同じ商品の選択は互いに独立ではない。無効な選択は ${d.invalid_picks} 件。`)}</p>
        </div>
        <div>
          <div className="small" style={{ fontWeight: 600, marginBottom: 6 }}>{t('What the agent said (facts only, stake covers the drop)', 'エージェントの理由（事実だけ、値下がり分を保証）')}</div>
          <div className="chips">
            {examples.map((x: any, i: number) => (
              <div key={i} className="chat-a small">
                <span className="who">{x.product} · {t('picked', '選択')} {x.pick} {x.picked_target ? t('(the staked store)', '（保証した店）') : ''}</span>
                {x.reason}
              </div>
            ))}
          </div>
          <p className="muted small">{t('The agent is Gemini acting as a shopping agent; it does not set any Vouch number. Stakes are hypothetical.', 'エージェント役は Gemini で、Vouch の数値は一切決めない。保証は仮定。')}</p>
        </div>
      </div>
    </div>
  );
}
