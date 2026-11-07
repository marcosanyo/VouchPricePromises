// Judge guide (evidence area): the idea in one line, a three-step diagram,
// where to click, and an index of the evidence. Loads nothing on open; the
// measured numbers load only when asked for.
import { useState } from 'react';
import { api } from '../api';
import { ErrorBox } from '../components/ErrorBox';
import { PromiseCost } from '../components/PromiseCost';
import { Icon } from '../components/Icon';
import { VerdictBadges } from '../components/VerdictBadges';
import { useT } from '../i18n';

export function Guide() {
  const t = useT();
  const [nums, setNums] = useState<{ sales: any; wait: any; shop: any }>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const steps: { icon: string; t: [string, string] }[] = [
    { icon: 'hourglass', t: ['Shopping agents wait: with no price-drop estimate or promise, our Gemini agent chose to wait for Black Friday in 29 of 30 runs', '買い物エージェントは待つ: 値下がりの見積もりも約束もないと、Gemini のエージェントは30回中29回ブラックフライデーまで待った'] },
    { icon: 'shieldCheck', t: ['Your agent asks stores that have an AI agent for a better deal. A member’s published promise comes with every order and its AI answers with it (price negotiation off); other stores’ AI may take a small fixed discount, with no promise. Stores without an agent are compared at their listed price', 'あなたのエージェントが、AI エージェントのいる店に条件を頼む。約束を公開した店の約束はどの注文にも付き、その店の AI は値下げ交渉に応じず約束で答える。ほかの AI のいる店は小さな固定の値引きに応じることがあるが、約束はない。AI のいない店は出品価格のまま比べる'] },
    { icon: 'coin', t: ['Your agent buys now, within the cap you signed; real prices decide, and a broken promise is refunded from the store’s PayPal', 'あなたのエージェントは署名した上限の中で今買う。実際の価格が判定し、破られた約束は店の PayPal から返金される'] },
  ];
  const stages: [string, string][] = [
    ['Few members: members turn waiting agents into sales today and take orders from non-members.', '加盟店が少ないとき: 加盟店は、待っているエージェントを今日の売上に変え、非加盟店から注文を取る。'],
    ['Many members: not being a member becomes a signal in itself — why can’t this store promise?', '加盟店が多いとき: 加盟していないこと自体が目印になる（なぜこの店は約束できないのか）。'],
    ['Everyone: less waiting across the market, and price-drop disputes become automatic refunds.', '全店が加盟したとき: 市場全体で待ちが減り、値下がりをめぐる紛争は自動の返金に置き換わる。'],
  ];
  const index: { href: string; t: [string, string]; d: [string, string] }[] = [
    { href: '#/sales', t: ['Is the sale real?', 'そのセールは本物？'], d: ['every discount label checked against 30 days of real prices', 'すべての値引き表示を30日分の実際の価格と照合'] },
    { href: '#/agents', t: ['Experiments & MCP', '実験と MCP'], d: ['Gemini as the shopping agent; connect your own agent', 'Gemini を買い物エージェントにした実験。自分のエージェントをつなぐ'] },
    { href: '#/market', t: ['Market replay', '市場リプレイ'], d: ['30 days of real prices played back', '30日分の実際の価格の再生'] },
    { href: '#/ledger', t: ['Ledger', '台帳'], d: ['every contract, verdict and PayPal id, hash-chained', 'すべての契約・判定・PayPal の ID（ハッシュの連鎖）'] },
    { href: '#/model', t: ['Model check', 'モデル確認'], d: ['held-out calibration and pre-registered predictions', '学習外のデータでの確率の対応と、事前登録した予測'] },
  ];
  return (
    <div className="page">
      <h1>{t('AI shopping agents wait. Vouch members win them now.', 'AI の買い物エージェントは待つ。Vouch の加盟店は、今その注文を取る。')}</h1>
      <div className="guide3">
        {steps.map((s, i) => (
          <div key={i} className="g3">
            <span className="g3-n">{i + 1}</span>
            <Icon name={s.icon} size={34} />
            <div className="small">{t(...s.t)}</div>
            {i < steps.length - 1 && <span className="g3-arrow" aria-hidden="true">→</span>}
          </div>
        ))}
      </div>
      <div className="card">
        <h2>{t('Why stores join, and the one rule', '店が加盟する理由と、ひとつの決まり')}</h2>
        <ol className="small">{stages.map((x, i) => <li key={i}>{t(...x)}</li>)}</ol>
        <PromiseCost />
        <p className="small"><b>{t('Membership never buys rank.', '加盟しても順位は買えない。')}</b> {t('The buyer agent is not told who is a member, and Vouch’s ranking uses only price and how much a promise lowers the buyer’s unprotected risk. A non-member that is cheap enough still wins.', '買い手のエージェントには誰が加盟店かを伝えず、Vouch の順位も価格と「約束が買い手の守られないリスクをどれだけ下げるか」だけで決まる。十分に安ければ非加盟店も勝つ。')}</p>
      </div>
      <div className="card">
        <h2>{t('Who does what', '誰が何をするか')}</h2>
        <ul className="small">
          <li>{t('Code answers instantly and the same way every time: the chance of a drop (a trained model), what a promise costs a store, the verdict and the refund (fixed rules, PayPal’s refund API).', 'コードが即座に、毎回同じに答える: 値下がりの確率（学習したモデル）、約束の店の費用、判定と返金（変えないルールと PayPal の返金 API）。')}</li>
          <li>{t('The language models make the judgment calls code cannot write down in advance: the buyer agent weighs offers, declines and your preference and decides to buy now or wait; each store’s agent chooses which computed offer to make under its private plan, and creates the PayPal order with the Agent Toolkit.', '言語モデルは、前もって式に書けない判断をする: 買い手のエージェントは各店の条件・断り・あなたの好みを比べて、今買うか待つかを決める。店のエージェントは、コードが計算した選択肢から店の非公開の方針に沿って出す条件を選び、Agent Toolkit で PayPal の注文を作る。')}</li>
          <li>{t('No model invents a price, a promise or a verdict.', 'どのモデルも、価格・約束・判定を作り出さない。')}</li>
        </ul>
      </div>
      <div className="row">
        <a className="button primary" href="#/buy"><Icon name="cart" size={16} /> {t('Try the buyer app', '買い手のアプリを試す')}</a>
        <a className="button" href="#/seller"><Icon name="store" size={16} /> {t('Try the seller console', '売り手コンソールを試す')}</a>
      </div>
      <div className="card">
        <h2>{t('Evidence', '証拠')}</h2>
        <ul className="ev-index">
          {index.map((x) => <li key={x.href}><a href={x.href}>{t(...x.t)}</a> — <span className="muted small">{t(...x.d)}</span></li>)}
        </ul>
        {!nums && (
          <button disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const [sales, wait, shop] = await Promise.all([api.get<any>('/api/insights/fake-sales'), api.get<any>('/api/experiments/agent-wait-norisk'), api.get<any>('/api/experiments/agent-shop-check')]);
              setNums({ sales, wait, shop });
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}>{busy ? t('Loading…', '読み込み中…') : t('Show the measured numbers', '測った数字を表示')}</button>
        )}
        {nums && (
          <div className="tiles3">
            <div className="tile3"><div className="tile3-big bad"><Icon name="alert" size={22} /> {nums.sales.summary.was_never_charged}/{nums.sales.summary.judged}</div><div className="small">{t('“was” prices never charged in the prior 30 days', '直前30日に一度も付いていない「通常価格」')}</div></div>
            <div className="tile3"><div className="tile3-big"><Icon name="hourglass" size={22} /> {nums.wait.results.none.n - nums.wait.results.none.buy_now}/{nums.wait.results.none.n} <Icon name="arrowBack" size={14} className="flip" /> <Icon name="shield" size={22} /> {nums.wait.results.cover.buy_now}/{nums.wait.results.cover.n}</div><div className="small">{t('agents waited without a promise → bought now with one', '約束なしで待った → 約束があれば今買った')}</div></div>
            <div className="tile3"><div className="tile3-big good"><Icon name="shield" size={22} /> {(nums.shop.results.no_estimates['Store LK63'] ?? 0) + (nums.shop.results.with_estimates['Store LK63'] ?? 0)}/{nums.shop.results.no_estimates.n + nums.shop.results.with_estimates.n}</div><div className="small">{t('picked the promising store over a 2% discount (shop check)', '2% 値引きより約束の店を選んだ（ショップの検査）')}</div></div>
          </div>
        )}
        <ErrorBox error={error} />
      </div>
      {nums && <VerdictBadges />}
    </div>
  );
}
