// Global keys, in one place. The timeline handles w a s d f 0 itself.

import { analysis, colorMode, helpOpen, mode, search, select, selectSpan, selection, trace } from '../state';
import type { Trace } from '../../core/model';
import { pickFile } from './load';

export interface KeyHooks {
  focusSearch(): void;
  toggleLeft(): void;
  toggleRight(): void;
}

// Per function, its calls in time order; built the first time `[` or `]` asks.
let byFuncFor: Trace | null = null;
let byFunc = new Map<number, Int32Array>();

export function callsOf(t: Trace, func: number): Int32Array {
  if (byFuncFor !== t) {
    byFuncFor = t;
    byFunc = new Map();
  }
  let list = byFunc.get(func);
  if (!list) {
    const ids: number[] = [];
    const f = t.spans.func;
    for (let i = 0; i < t.spans.n; i++) if (f[i] === func) ids.push(i);
    const st = t.spans.start;
    ids.sort((a, b) => st[a] - st[b] || a - b);
    list = Int32Array.from(ids);
    byFunc.set(func, list);
  }
  return list;
}

/** Step through the calls of the selected span's function. */
export function stepSameFunc(dir: 1 | -1): void {
  const t = trace.value;
  const s = selection.value;
  if (!t || s?.kind !== 'span') return;
  const list = callsOf(t, t.spans.func[s.id]);
  const i = list.indexOf(s.id);
  const j = i + dir;
  if (j >= 0 && j < list.length) selectSpan(list[j]);
}

let outlierIdx = -1;
export function nextOutlier(): void {
  const a = analysis.value;
  if (!a || !a.outliers.length) return;
  const s = selection.value;
  const cur = s?.kind === 'span' ? a.outliers.findIndex((o) => o.span === s.id) : -1;
  outlierIdx = ((cur >= 0 ? cur : outlierIdx) + 1) % a.outliers.length;
  selectSpan(a.outliers[outlierIdx].span);
}

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

export function installKeys(h: KeyHooks): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (typing(e)) return;
    const k = e.key;
    let used = true;
    if (k === '?') helpOpen.value = !helpOpen.value;
    else if (k === 'Escape') {
      if (helpOpen.value) helpOpen.value = false;
      else if (search.value) search.value = '';
      else select(null);
    } else if (!trace.value) {
      if (k === 'o') pickFile();
      else used = false;
    } else if (k === '/') h.focusSearch();
    else if (k === '1') mode.value = 'timeline';
    else if (k === '2') mode.value = 'story';
    else if (k === 'c') colorMode.value = colorMode.value === 'surprise' ? 'subsystem' : 'surprise';
    else if (k === ',') h.toggleLeft();
    else if (k === '.') h.toggleRight();
    else if (k === 'o') nextOutlier();
    else if (k === '[') stepSameFunc(-1);
    else if (k === ']') stepSameFunc(1);
    else used = false;
    if (used) e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
