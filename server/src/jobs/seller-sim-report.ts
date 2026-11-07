// Summary of seller-sim runs (server/experiments/seller-sim/*.json), seller and
// buyer side. Buyer regret = what a buyer paid net of refunds minus the lowest
// price any store charged in the 7 days after (the agent store's price in that
// condition, the other stores' real prices). It answers "does the agent hold
// its price to dodge refunds at the buyer's expense?" (concept §27).
//   node src/jobs/seller-sim-report.ts [file-substring]
import { readdirSync, readFileSync } from 'node:fs';
import { round2 } from '../rules.ts';

const dir = new URL('../../experiments/seller-sim/', import.meta.url).pathname;
const filter = process.argv[2] ?? '';
const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f.includes(filter)).sort();
const mean = (xs: number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

for (const f of files) {
  const d = JSON.parse(readFileSync(dir + f, 'utf8'));
  console.log(`\n== ${f}  (${d.product_label}, ${d.agent_store}; goal: ${d.design.owner_goal ?? 'Maximise profit after refunds over the coming weeks.'}; promise: ${d.design.promise_rule ?? 'capped'})`);
  console.log('cond | sales | refunds | profit@20 | agent buyers: net paid − 7d market low | rival buyers: same');
  for (const [c, cond] of Object.entries<any>(d.conditions)) {
    const days: any[] = cond.days;
    const lowAfter = (day: string) => {
      const later = days.filter((r) => r.day > day).slice(0, 7);
      return Math.min(...later.flatMap((r) => [r.effective_min_price_usd ?? r.price, ...r.other_stores_today.map((o: any) => o.real_price_usd)]));
    };
    const refundOf = new Map<string, number>(cond.sales.map((s: any) => [`${s.sale_day}|${s.buyer_id}`, s.final_refund_usd]));
    const agentRegret: number[] = [];
    const rivalRegret: number[] = [];
    for (const r of days.filter((x) => x.is_sale_day)) {
      const low = lowAfter(r.day);
      for (const b of r.buyers) {
        if (b.choice === 'agent') agentRegret.push(b.price_paid_usd - (refundOf.get(`${r.day}|${b.buyer_id}`) ?? 0) - low);
        else if (b.choice === 'other_store') rivalRegret.push(b.price_paid_usd - low);
      }
    }
    const t = cond.totals;
    console.log(`(${c})  | ${String(t.sales).padStart(5)} | ${('$' + t.refunds_usd.toFixed(2)).padStart(7)} | ${('$' + t.profit_at_20pct_margin_usd.toFixed(2)).padStart(9)} | ${String(mean(agentRegret) ?? '-').padStart(6)} (n=${agentRegret.length}) | ${String(mean(rivalRegret) ?? '-').padStart(6)} (n=${rivalRegret.length})`);
  }
}
