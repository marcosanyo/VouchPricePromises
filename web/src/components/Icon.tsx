// Small line icons for the buyer and seller apps (24px grid, currentColor).
const PATHS: Record<string, string> = {
  cart: 'M3 4h2l2.4 11h10.2l2-8H7 M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z M17 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  lock: 'M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3',
  megaphone: 'M3 10v4h3l7 4V6L6 10H3Z M16 9a4 4 0 0 1 0 6',
  store: 'M4 9l1.5-5h13L20 9 M4 9h16v11H4z M9 20v-6h6v6',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z',
  shieldCheck: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z M8.5 12l2.5 2.5 4.5-5',
  card: 'M3 6h18v12H3z M3 10h18',
  check: 'M5 12.5l4.5 4.5L19 7',
  hourglass: 'M7 3h10 M7 21h10 M8 3c0 5 8 5 8 9s-8 4-8 9 M16 3c0 5-8 5-8 9',
  alert: 'M12 3l10 18H2L12 3Z M12 10v5 M12 18h.01',
  coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5 M12 6.5v1.5 M12 16v1.5',
  bot: 'M5 9h14v10H5z M12 9V5 M12 4h.01 M9 13h.01 M15 13h.01 M9.5 16.5h5',
  arrowBack: 'M20 12H5 M11 6l-6 6 6 6',
  reply: 'M10 8L4 13l6 5 M4 13h10a6 6 0 0 1 6 6',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Z M9 8h6 M9 12h6',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M12 7v5l3 2',
  bag: 'M5 8h14l-1 13H6L5 8Z M9 8V6a3 3 0 0 1 6 0v2',
  tag: 'M3 12V4h8l10 10-8 8L3 12Z M7.5 8.5h.01',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className, title }: { name: IconName | string; size?: number; className?: string; title?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <path d={PATHS[name] ?? PATHS.bag} />
    </svg>
  );
}
