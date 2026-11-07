// Shared chart tokens. Store colours follow the store (fixed order of the
// store list), never its rank. The categorical order is the validated default
// palette (dataviz skill); it passes the adjacent-pair CVD checks on white.
// Three slots are under 3:1 contrast on white, so every coloured mark also
// carries a visible store label.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };

export const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7' };

export function colorMap(stores: string[]): Map<string, string> {
  return new Map(stores.map((s, i) => [s, SERIES[i % SERIES.length]]));
}

export const shortDay = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
