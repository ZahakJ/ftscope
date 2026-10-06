// Token colours for canvas code, re-read whenever the colour scheme changes.

import { CATEGORIES } from '../../core/model';

export interface Palette {
  bg: string;
  surface1: string;
  surface2: string;
  surface3: string;
  line: string;
  lineStrong: string;
  text: string;
  text2: string;
  text3: string;
  accent: string;
  warn: string;
  critical: string;
  /** Category colour mixed toward surface-1 by --cat-fill, per Category. */
  catFill: string[];
  cat: string[];
  /** Label ink per catFill / heat step: whichever of text and bg reads better on it. */
  catInk: string[];
  heat: string[];
  heatInk: string[];
  fontMono: string;
  fontUi: string;
  row: number;
}

function hex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) {
    const r = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    return r ? [+r[1], +r[2], +r[3]] : [128, 128, 128];
  }
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: string, b: string, f: number): string {
  const x = hex(a);
  const y = hex(b);
  const c = x.map((v, i) => Math.round(v * f + y[i] * (1 - f)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** WCAG relative luminance of a colour. */
export function luminance(c: string): number {
  const [r, g, b] = hex(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Of the candidate inks, the one with the most contrast on `fill`. */
export function inkOn(fill: string, inks: string[]): string {
  let best = inks[0];
  for (const k of inks) if (contrast(k, fill) > contrast(best, fill)) best = k;
  return best;
}

export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const fill = parseFloat(v('--cat-fill')) || 0.4;
  const s1 = v('--surface-1');
  const cat = CATEGORIES.map((c) => v(`--cat-${c}`));
  const catFill = cat.map((c) => mix(c, s1, fill));
  const heat = [0, 1, 2, 3, 4].map((i) => v(`--heat-${i}`));
  const inks = [v('--text'), v('--bg')];
  return {
    bg: v('--bg'),
    surface1: s1,
    surface2: v('--surface-2'),
    surface3: v('--surface-3'),
    line: v('--line'),
    lineStrong: v('--line-strong'),
    text: v('--text'),
    text2: v('--text-2'),
    text3: v('--text-3'),
    accent: v('--accent'),
    warn: v('--warn'),
    critical: v('--critical'),
    cat,
    catFill,
    catInk: catFill.map((c) => inkOn(c, inks)),
    heat,
    heatInk: heat.map((c) => inkOn(c, inks)),
    fontMono: v('--font-mono') || 'monospace',
    fontUi: v('--font-ui') || 'sans-serif',
    row: parseFloat(v('--row')) || 18,
  };
}

/** Calls `fn` when the OS scheme or the root's data-theme changes. Returns a disposer. */
export function onSchemeChange(fn: () => void): () => void {
  const mq = matchMedia('(prefers-color-scheme: light)');
  mq.addEventListener('change', fn);
  const mo = new MutationObserver(fn);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
  return () => {
    mq.removeEventListener('change', fn);
    mo.disconnect();
  };
}

