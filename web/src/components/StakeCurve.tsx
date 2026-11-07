// For one claim: as the stake grows, the seller's expected cost per order
// (P × min(stake, shortfall)) rises and the buyer's unprotected loss
// (P × max(0, shortfall − stake)) falls; both flatten at the expected
// shortfall. Same unit (USD per order) on one axis.
import { usd } from '../api';
import { useT } from '../i18n';
import { INK } from '../viz';

export function StakeCurve({ p, shortfall, stake }: { p: number; shortfall: number; stake: number }) {
  const t = useT();
  const W = 300, H = 120, L = 34, R = 8, T = 8, B = 20;
  const maxS = Math.max(10, Math.ceil(shortfall * 1.6));
  const maxY = Math.max(0.01, p * shortfall);
  const x = (s: number) => L + (s / maxS) * (W - L - R);
  const y = (v: number) => T + (1 - v / maxY) * (H - T - B);
  const steps = Array.from({ length: 41 }, (_, i) => (i / 40) * maxS);
  const cost = steps.map((s) => `${x(s)},${y(p * Math.min(s, shortfall))}`).join(' ');
  const loss = steps.map((s) => `${x(s)},${y(p * Math.max(0, shortfall - s))}`).join(' ');
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={t('Seller cost and buyer risk by stake', '保証額ごとの売り手の費用と買い手のリスク')}>
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke={INK.axis} />
        <text x={L - 4} y={y(maxY) + 4} textAnchor="end" fontSize={10} fill={INK.muted}>{usd(maxY)}</text>
        <text x={L - 4} y={y(0) + 4} textAnchor="end" fontSize={10} fill={INK.muted}>$0</text>
        <line x1={x(shortfall)} x2={x(shortfall)} y1={T} y2={y(0)} stroke={INK.grid} />
        <text x={x(shortfall)} y={H - 4} textAnchor="middle" fontSize={10} fill={INK.muted}>{usd(shortfall)}</text>
        <polyline fill="none" stroke="#0070e0" strokeWidth={2} points={cost} />
        <polyline fill="none" stroke="#ec835a" strokeWidth={2} points={loss} />
        <circle cx={x(Math.min(stake, maxS))} cy={y(p * Math.min(stake, shortfall))} r={5} fill="#0070e0" stroke="#fff" strokeWidth={2} />
        <circle cx={x(Math.min(stake, maxS))} cy={y(p * Math.max(0, shortfall - stake))} r={5} fill="#ec835a" stroke="#fff" strokeWidth={2} />
      </svg>
      <div className="race-legend small">
        <span><span className="sw" style={{ background: '#0070e0' }} />{t('Your expected cost per order', 'あなたの1注文あたりの見込み費用')}</span>
        <span><span className="sw" style={{ background: '#ec835a' }} />{t("Buyer's unprotected risk", '買い手の守られていないリスク')}</span>
        <span className="muted">{t('Both flatten at the expected shortfall', 'どちらも見込み損失の額で頭打ち')}</span>
      </div>
    </div>
  );
}
