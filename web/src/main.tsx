import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import './styles.css';
import './app.css';
import { Buy } from './pages/Buy';
import { SellerApp } from './pages/SellerApp';
import { SellerSim } from './pages/SellerSim';
import { Guide } from './pages/Guide';
import { Market } from './pages/Market';
import { Seller } from './pages/Seller';
import { Ledger } from './pages/Ledger';
import { Model } from './pages/Model';
import { Agents } from './pages/Agents';
import { Sales } from './pages/Sales';
import { Demo } from './pages/Demo';
import { Icon } from './components/Icon';
import { LangProvider, useLang, useT } from './i18n';

ModuleRegistry.registerModules([AllCommunityModule]);

// The two consoles are the app; everything else is evidence, kept apart.
const MAIN = [
  { path: 'buy', icon: 'cart', label: ['Buyer', '買い手'], el: () => <Buy /> },
  { path: 'seller', icon: 'store', label: ['Seller', '売り手'], el: () => <SellerApp /> },
] as const;
const EVIDENCE = [
  { path: 'guide', label: ['Judge guide', '審査員ガイド'], el: () => <Guide /> },
  { path: 'sales', label: ['Is the sale real?', 'そのセールは本物？'], el: () => <Sales /> },
  { path: 'market', label: ['Market replay', '市場リプレイ'], el: () => <Market /> },
  { path: 'ledger', label: ['Ledger', '台帳'], el: () => <Ledger /> },
  { path: 'model', label: ['Model check', 'モデル確認'], el: () => <Model /> },
  { path: 'agents', label: ['Experiments & MCP', '実験と MCP'], el: () => <Agents /> },
  { path: 'demo', label: ['Experiment playground', '実験の遊び場'], el: () => <Demo /> },
  { path: 'store-ai-sim', label: ['AI store manager (earlier concept)', 'AI 店長（以前の案）'], el: () => <SellerSim /> },
  { path: 'seller-tools', label: ['Seller tools (LLM)', '売り手の補助（LLM）'], el: () => <Seller /> },
] as const;
const ALIASES: Record<string, string> = { shop: 'buy', '': 'buy' };

function LangToggle() {
  const { lang, setLang } = useLang();
  return (
    <div className="seg" role="group" aria-label="Language">
      <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
      <button className={lang === 'ja' ? 'on' : ''} onClick={() => setLang('ja')}>日本語</button>
    </div>
  );
}

function useHash() {
  const [h, setH] = useState(() => location.hash.slice(2));
  useEffect(() => {
    const on = () => setH(location.hash.slice(2));
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return h;
}

function App() {
  const t = useT();
  const hash = useHash();
  const raw = hash.split('?')[0];
  const path = ALIASES[raw] ?? raw;
  const main = MAIN.find((r) => r.path === path);
  const ev = EVIDENCE.find((r) => r.path === path);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  // Each main tab returns to where the viewer left it (e.g. Buyer → Seller → Buyer keeps the run
  // on screen). Per browser tab only; a missing or blocked storage just means a fresh tab.
  useEffect(() => {
    if (!main) return;
    try { sessionStorage.setItem(`vouch.tab.${main.path}`, `#/${hash}`); } catch { /* storage unavailable */ }
  }, [main, hash]);
  const tabHref = (p: string) => {
    try { return sessionStorage.getItem(`vouch.tab.${p}`) ?? `#/${p}`; } catch { return `#/${p}`; }
  };
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          Vouch<span>.</span>
        </div>
        <nav className="nav tabs">
          {MAIN.map((r) => (
            <a key={r.path} href={main === r ? `#/${r.path}` : tabHref(r.path)} className={`tab${main === r ? ' active' : ''}`}>
              <Icon name={r.icon} size={18} /> {t(r.label[0], r.label[1])}
            </a>
          ))}
        </nav>
        <div className="evidence-menu">
          <button className={`ev-btn${ev ? ' active' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
            <Icon name="receipt" size={16} /> {t('Evidence', '証拠')}{ev ? `: ${t(ev.label[0], ev.label[1])}` : ''} ▾
          </button>
          {open && (
            <div className="ev-list" role="menu">
              {EVIDENCE.map((r) => (
                <a key={r.path} role="menuitem" href={`#/${r.path}`} className={ev === r ? 'active' : ''}>{t(r.label[0], r.label[1])}</a>
              ))}
            </div>
          )}
        </div>
        <LangToggle />
      </header>
      {ev && <div className="ev-banner small"><Icon name="receipt" size={14} /> {t('Evidence — the data and checks behind the app.', '証拠 — アプリの裏のデータと検証。')} <a href="#/buy">{t('Back to the app', 'アプリに戻る')}</a></div>}
      <main>{(main ?? ev ?? MAIN[0]).el()}</main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </StrictMode>,
);
