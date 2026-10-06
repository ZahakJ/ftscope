// URL state. `?trace=<url>` names the file; the hash names a place in it:
// `#sel=<span>&v=<t0>,<t1>&m=story&c=surprise&f=<func>` — enough for a link to
// "this exact call".

import { effect } from '@preact/signals';
import { colorMode, mode, selectSpan, selection, trace, view, zoomTo } from '../state';

export function parseHash(hash: string): {
  sel?: number;
  v?: [number, number];
  m?: 'timeline' | 'story';
  c?: 'subsystem' | 'surprise';
  f?: string;
} {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const out: ReturnType<typeof parseHash> = {};
  const sel = Number(p.get('sel'));
  if (p.has('sel') && Number.isInteger(sel) && sel >= 0) out.sel = sel;
  const v = (p.get('v') ?? '').split(',').map(Number);
  if (v.length === 2 && v.every(Number.isFinite) && v[1] > v[0]) out.v = [v[0], v[1]];
  if (p.get('m') === 'story') out.m = 'story';
  if (p.get('c') === 'surprise') out.c = 'surprise';
  const f = p.get('f');
  if (f) out.f = f;
  return out;
}

/** Short decimal for a time in the URL: enough digits to come back to the same view. */
function num(x: number, w: number): string {
  const d = Math.max(0, Math.min(6, Math.ceil(-Math.log10(Math.max(w, 1e-6) / 1e4))));
  return x.toFixed(d).replace(/\.?0+$/, '') || '0';
}

export function buildHash(): string {
  const p: string[] = [];
  const t = trace.value;
  const s = selection.value;
  if (t && s?.kind === 'span') p.push(`sel=${s.id}`);
  if (t && s?.kind === 'func') p.push(`f=${encodeURIComponent(t.funcs.name[s.id])}`);
  if (t) {
    const { t0, t1 } = view.value;
    p.push(`v=${num(t0, t1 - t0)},${num(t1, t1 - t0)}`);
  }
  if (mode.value === 'story') p.push('m=story');
  if (colorMode.value === 'surprise') p.push('c=surprise');
  return p.length ? '#' + p.join('&') : '';
}

/** Apply the hash to a freshly loaded trace. */
export function restoreHash(): void {
  const t = trace.value;
  if (!t) return;
  const h = parseHash(location.hash);
  if (h.m) mode.value = h.m;
  if (h.c) colorMode.value = h.c;
  if (h.f) {
    const id = t.funcs.name.indexOf(h.f);
    if (id > 0) selection.value = { kind: 'func', id };
  }
  if (h.sel !== undefined && h.sel < t.spans.n) selectSpan(h.sel, { reveal: !h.v });
  if (h.v) zoomTo(h.v[0], h.v[1]);
}

/** Keep the hash following the state, debounced, without adding history entries. */
export function syncHash(): () => void {
  let timer = 0;
  return effect(() => {
    // Touch every signal the hash depends on so the effect re-runs.
    void trace.value, selection.value, view.value, mode.value, colorMode.value;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (!trace.value) return;
      const h = buildHash();
      if (h !== location.hash) history.replaceState(null, '', location.pathname + location.search + h);
    }, 250);
  });
}
