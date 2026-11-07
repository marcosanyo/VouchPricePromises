// English by default, with a Japanese switch in the header (kept for judges and viewers
// who read Japanese; user decision 2026-10-31). Each UI string is t(english, japanese)
// at the call site. Server-generated rule reasons are translated by pattern in tReason().
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Lang = 'en' | 'ja';
const LangContext = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: 'en', setLang: () => {} });

function initial(): Lang {
  try {
    return localStorage.getItem('vouch.lang') === 'ja' ? 'ja' : 'en';
  } catch {
    return 'en';
  }
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>(initial);
  useEffect(() => {
    try {
      localStorage.setItem('vouch.lang', lang);
    } catch {
      /* storage unavailable: the choice just isn't remembered */
    }
    document.documentElement.lang = lang;
  }, [lang]);
  return <LangContext.Provider value={{ lang, setLang }}>{children}</LangContext.Provider>;
}

export function useLang() {
  return useContext(LangContext);
}

export function useT() {
  const { lang } = useContext(LangContext);
  const t = (en: string, ja: string) => (lang === 'ja' ? ja : en);
  return Object.assign(t, { ja: lang === 'ja' });
}

const REASONS: [RegExp, string][] = [
  [/^Price fell to \$([\d.,]+) on (\S+) \(paid \$([\d.,]+)\)$/, '$2 に $$$1 まで値下がり（支払いは $$$3）'],
  [/^No price below \$([\d.,]+) in (\d+) daily prices$/, '$2 日分の価格で $$$1 を下回らなかった'],
  [/^Another store sold it for \$([\d.,]+) on (\S+) \(paid \$([\d.,]+)\)$/, '$2 に別の店が $$$1 で販売（支払いは $$$3）'],
  [/^No compared store was below \$([\d.,]+) \((\d+) stores\)$/, '比較した $2 店のどれも $$$1 を下回らなかった'],
  [/^Paid \$([\d.,]+) is ([\d.]+)% below the (\d+)-day mean \$([\d.,]+) \(contract requires (\d+)% below\)$/, '支払い $$$1 は $3 日平均 $$$4 より $2% 安いだけ（契約は $5% 以上安いこと）'],
  [/^Paid \$([\d.,]+) is ([\d.]+)% above the (\d+)-day mean \$([\d.,]+) \(contract requires (\d+)% below\)$/, '支払い $$$1 は $3 日平均 $$$4 より $2% 高い（契約は $5% 以上安いこと）'],
  [/^Paid \$([\d.,]+) is at least (\d+)% below the prior mean \$([\d.,]+)$/, '支払い $$$1 は過去の平均 $$$3 より $2% 以上安い'],
  [/^Expected cost \$([\d.,]+) per order for a \$([\d.,]+) stake\.$/, '保証 $$$2 で、1注文あたりの見込み費用は $$$1'],
  [/^Window ends (\S+)$/, '判定期間は $1 まで'],
  [/^Window ends (\S+); no compared store is yet cheaper by the full stake$/, '判定期間は $1 まで（まだ保証額の全額分安い比較店舗はない）'],
  [/^Waiting for Channel3 daily price of (\S+) \(latest (\S+)\)$/, 'Channel3 の $1 の日次価格を待っています（最新は $2）'],
  [/^Channel3 listed the offer as InStock at purchase$/, '購入時、Channel3 で在庫あり'],
  [/^Channel3 listed the offer as OutOfStock at purchase$/, '購入時、Channel3 で在庫切れ'],
  [/^Listed price \$([\d.,]+) differs from the daily history \(\$([\d.,]+)\) on (\S+)$/, '$3 の表示価格 $$$1 が日次の履歴（$$$2）と食い違う'],
  [/^No daily price for (\S+)$/, '$1 の日次価格がない'],
  [/^Judged from the Channel3 availability at purchase; not modelled\.$/, '購入時の Channel3 の在庫表示で判定する。確率のモデルはない'],
  [/^No other store with price data sells this item; lowest_price cannot be judged\.$/, '価格データのある他店がこの商品を売っていないので、最安値は判定できない'],
  [/^another store is \$([\d.,]+) cheaper today\. Every order would pay out\.$/, '今日、別の店のほうが $$$1 安い。すべての注文で返金が発生する'],
  [/^Stake above the expected shortfall \(\$([\d.,]+)\) adds no ranking benefit\.$/, '見込み損失（$$$1）を超える保証は、順位を上げない'],
  [/^this claim is more likely to fail than hold\. Fix the price or catalog first\.$/, 'この主張は当たるより外れる可能性が高い。先に価格かカタログを直す'],
  [/^Evidence missing: (.*)\. Contract rule: buyer favour, full stake\.$/, '判定データが不足: $1。契約のルールにより買い手に有利に、保証額の全額'],
];

export function tReason(text: string | null | undefined, ja: boolean): string {
  if (!text || !ja) return text ?? '';
  const early = text.match(/^(.*); settled early: the stake is already owed in full$/);
  if (early) return `${tReason(early[1], true)}（保証額の全額に達したため早期確定）`;
  const pre = text.match(/^(Holds today|Not recommended): (.*)$/);
  if (pre) return `${pre[1] === 'Holds today' ? '今日の時点では成立' : 'おすすめしない'}: ${tReason(pre[2], true)}`;
  for (const [re, out] of REASONS) if (re.test(text)) return text.replace(re, out);
  return text;
}
