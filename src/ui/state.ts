// The interface's shared state. Every view reads and writes these signals and
// nothing else, which is what keeps the views linked: select a call anywhere
// and every view shows it.

import { computed, signal } from '@preact/signals';
import type { Analysis, Selection } from '../core/api';
import type { Trace } from '../core/model';

export interface LoadedFile {
  name: string;
  /** Bytes of the text as parsed (after gunzip, if it was gzipped). */
  size: number;
  /** The decoded text's bytes, kept so raw lines can be shown: `text.slice(byteStart, byteEnd)`. */
  text: Blob;
}

export type LoadState =
  | { phase: 'empty' }
  | { phase: 'loading'; name: string; bytes: number; total: number; note: string }
  | { phase: 'error'; name: string; message: string }
  | { phase: 'ready' };

export const load = signal<LoadState>({ phase: 'empty' });
export const file = signal<LoadedFile | null>(null);
export const trace = signal<Trace | null>(null);
export const analysis = signal<Analysis | null>(null);

/** Visible time range of the timeline, µs. */
export const view = signal<{ t0: number; t1: number }>({ t0: 0, t1: 1 });
export const selection = signal<Selection | null>(null);
/** Span under the pointer, -1 if none. Views may highlight it; nothing else follows it. */
export const hover = signal<number>(-1);

export const mode = signal<'timeline' | 'story'>('timeline');
/** `subsystem`: tint by kernel subsystem. `surprise`: grey unless a call is slow among its peers. */
export const colorMode = signal<'subsystem' | 'surprise'>('subsystem');
export const leftTab = signal<'brief' | 'functions'>('brief');
export const helpOpen = signal(false);

/** Search box text. Plain text matches as a substring; `/re/` as a regular expression. */
export const search = signal('');

/** Per func id: 1 if the function matches the search, or null when the search is empty or invalid. */
export const matches = computed<Uint8Array | null>(() => {
  const t = trace.value;
  const q = search.value.trim();
  if (!t || !q) return null;
  let test: (s: string) => boolean;
  const re = /^\/(.+)\/([a-z]*)$/.exec(q);
  if (re) {
    try {
      const r = new RegExp(re[1], re[2].replace('g', ''));
      test = (s) => r.test(s);
    } catch {
      return null;
    }
  } else {
    const needle = q.toLowerCase();
    test = (s) => s.toLowerCase().includes(needle);
  }
  const names = t.funcs.name;
  const out = new Uint8Array(names.length);
  for (let i = 1; i < names.length; i++) if (test(names[i])) out[i] = 1;
  return out;
});

// ---- actions ---------------------------------------------------------------

/** End time of a span; an unclosed span runs to the end of its track. */
export function spanEnd(t: Trace, id: number): number {
  const d = t.spans.dur[id];
  return Number.isNaN(d) ? t.tracks[t.trackOf[id]].t1 : t.spans.start[id] + d;
}

/** Earliest time in the trace (0, or below it when a call began before the first timestamp). */
export function traceStart(t: Trace): number {
  let min = 0;
  for (const k of t.tracks) if (k.t0 < min) min = k.t0;
  return min;
}

export function zoomTo(t0: number, t1: number): void {
  const t = trace.value;
  if (!t) return;
  const min = traceStart(t);
  const max = Math.max(t.meta.duration, 1e-3);
  let w = Math.max(t1 - t0, 0.02); // never narrower than 20 ns
  w = Math.min(w, max - min);
  const a = Math.max(min, Math.min(t0, max - w));
  view.value = { t0: a, t1: a + w };
}

export function zoomAll(): void {
  const t = trace.value;
  if (!t) return;
  const min = traceStart(t);
  view.value = { t0: min, t1: Math.max(t.meta.duration, min + 1e-3) };
}

/** Select a call and, unless told not to, bring it into view with some air around it. */
export function selectSpan(id: number, opts: { reveal?: boolean } = {}): void {
  const t = trace.value;
  if (!t || id < 0 || id >= t.spans.n) return;
  selection.value = { kind: 'span', id };
  if (opts.reveal !== false) revealSpan(id);
}

export function revealSpan(id: number): void {
  const t = trace.value;
  if (!t) return;
  const s = t.spans.start[id];
  const e = spanEnd(t, id);
  const v = view.value;
  const w = Math.max(e - s, 0.05);
  const visible = s >= v.t0 && e <= v.t1;
  // "in view" is not enough: a call a few pixels wide is not shown, it is merely present
  const readable = w >= (v.t1 - v.t0) * 0.08;
  if (visible && readable) return;
  zoomTo(s - w * 1.5, e + w * 1.5);
}

export function select(sel: Selection | null): void {
  selection.value = sel;
  if (sel?.kind === 'span') revealSpan(sel.id);
}
