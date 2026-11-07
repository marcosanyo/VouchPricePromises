// The earlier concept, kept as evidence: the store's AI also set the daily price (15-day backtest).
import { SellerAgentSim } from '../components/SellerAgentSim';
import { useT } from '../i18n';

export function SellerSim() {
  const t = useT();
  return (
    <div className="page app seller">
      <div className="muted small" style={{ marginBottom: 12 }}>
        {t(
          'An earlier concept: here the store’s AI also set the daily price. In the current design the owner sets the price and the AI only answers with the promise.',
          '以前の構想: ここでは店の AI が毎日の価格も決めていた。現在の設計では、価格は店主が決め、AI は約束で答えるだけ。',
        )}
      </div>
      <SellerAgentSim />
    </div>
  );
}
