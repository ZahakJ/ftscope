// Small decisions the Story rows make, kept testable.

import type { Selection } from '../../core/api';
import type { Trace } from '../../core/model';
import type { RNode, Row } from './rows';

/** The function a row stands for, -1 when none (tracks, events, folds of several functions). */
export function nodeFunc(t: Trace, n: RNode): number {
  switch (n.kind) {
    case 'span': return t.spans.func[n.span];
    case 'group': case 'typical': return n.func;
    case 'prof': return n.node.func;
    default: return -1;
  }
}

/** What clicking a row selects. */
export function nodeSelection(n: RNode): Selection | null {
  switch (n.kind) {
    case 'span': return { kind: 'span', id: n.span };
    case 'group': return { kind: 'group', func: n.func, spans: n.spans };
    case 'typical': return { kind: 'group', func: n.func, spans: n.spans };
    case 'prof': return { kind: 'func', id: n.node.func };
    case 'event': return { kind: 'event', id: n.event };
    default: return null;
  }
}

export function rowIsSelected(r: Row, sel: Selection | null): boolean {
  if (!sel) return false;
  const n = r.node;
  if (sel.kind === 'span') return n.kind === 'span' && n.span === sel.id;
  if (sel.kind === 'group') {
    // Same run if same function, length and ends: selections from the Brief or the URL are fresh arrays.
    if (n.kind !== 'group' && n.kind !== 'loop') return false;
    const a = n.spans, b = sel.spans;
    if (a === b) return true;
    return (n.kind === 'loop' || n.func === sel.func) && a.length === b.length && a.length > 0 && a[0] === b[0] && a[a.length - 1] === b[b.length - 1];
  }
  if (sel.kind === 'event') return n.kind === 'event' && n.event === sel.id;
  return false;
}

/**
 * A group's durations as 8 bins of log2(dur / median) from -2 to +6, heights
 * 0..1 on a sqrt scale so a handful of slow members still show beside the bulk.
 */
export function distBins(t: Trace, spans: Int32Array, med: number): Float32Array {
  const bins = new Float32Array(8);
  const m = med > 0 ? med : 1;
  for (const s of spans) {
    const d = t.spans.dur[s];
    if (Number.isNaN(d)) continue;
    const b = Math.floor(Math.log2(Math.max(d, 1e-6) / m)) + 2;
    bins[Math.max(0, Math.min(7, b))]++;
  }
  let max = 0;
  for (const x of bins) max = Math.max(max, x);
  if (max) for (let i = 0; i < 8; i++) bins[i] = bins[i] ? Math.max(0.12, Math.sqrt(bins[i] / max)) : 0;
  return bins;
}
