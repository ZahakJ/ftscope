// "Beside a typical call": the pure parts of the two miniature icicles in the Inspector.
// Choosing the typical peer, flattening a subtree into boxes relative to its root,
// the shared scale, and per-pixel coalescing. Drawing lives in compare-view.tsx.

import { F, type Trace } from '../../core/model';
import { spanEndOf } from '../timeline/layout';

const UNTIMED = F.UNCLOSED | F.ORPHAN | F.GAP | F.NO_DUR;

/** A call with a duration the kernel actually printed. */
export function isTimed(t: Trace, id: number): boolean {
  return !(t.spans.flags[id] & UNTIMED) && Number.isFinite(t.spans.dur[id]);
}

/**
 * The peer whose duration is the median among the timed calls in `spans` (all calls of one function).
 * When `sel` is itself the median, the next one up (or down, at the end). -1 with fewer than 2 timed calls.
 */
export function typicalPeer(t: Trace, spans: ArrayLike<number>, sel: number): number {
  const timed: number[] = [];
  for (let i = 0; i < spans.length; i++) if (isTimed(t, spans[i])) timed.push(spans[i]);
  if (timed.length < 2) return -1;
  const d = t.spans.dur;
  timed.sort((a, b) => d[a] - d[b] || a - b);
  const m = (timed.length - 1) >> 1;
  if (timed[m] !== sel) return timed[m];
  return m + 1 < timed.length ? timed[m + 1] : timed[m - 1];
}

export interface MiniBox {
  id: number;
  /** Row, relative to the root (0); deeper levels are merged into the last row. */
  row: number;
  /** µs from the root's start. */
  x0: number;
  x1: number;
}

export interface MiniTree {
  root: number;
  dur: number;
  rows: number;
  boxes: MiniBox[];
  /** Spans in the subtree; more than `boxes.length` when the cap cut it short. */
  total: number;
  /** Off-CPU stretches of the root's task inside the call, µs from its start, as [a0, b0, a1, b1, …]. */
  off: number[];
}

/** Flattens the subtree under `root` (pre-order, so each row stays in time order), at most `cap` spans. */
export function flatten(t: Trace, root: number, maxRows = 12, cap = 5000): MiniTree {
  const sp = t.spans;
  const s0 = sp.start[root];
  const end = spanEndOf(t, root);
  const d0 = sp.depth[root];
  const boxes: MiniBox[] = [];
  let total = 0;
  let rows = 0;
  const stack = [root];
  while (stack.length) {
    const id = stack.pop()!;
    total++;
    if (boxes.length < cap) {
      const row = Math.min(sp.depth[id] - d0, maxRows - 1);
      if (row + 1 > rows) rows = row + 1;
      boxes.push({ id, row, x0: sp.start[id] - s0, x1: Math.min(spanEndOf(t, id), end) - s0 });
    }
    // Children pushed last-first so they pop in time order.
    const kids: number[] = [];
    for (let c = sp.firstChild[id]; c >= 0; c = sp.nextSibling[c]) kids.push(c);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return { root, dur: end - s0, rows, boxes, total, off: offStretches(t, sp.task[root], s0, end) };
}

/** Where `task` was switched out between `s0` and `s1`, relative to `s0`. */
export function offStretches(t: Trace, task: number, s0: number, s1: number): number[] {
  const S = t.switches;
  const out: number[] = [];
  let away = NaN;
  for (let i = 0; i < S.n; i++) {
    const ts = S.ts[i];
    if (ts > s1) break;
    if (S.prev[i] === task && S.next[i] !== task) away = ts;
    else if (S.next[i] === task && !Number.isNaN(away)) {
      const a = Math.max(away, s0);
      if (ts > a && ts >= s0) out.push(a - s0, ts - s0);
      away = NaN;
    }
  }
  if (!Number.isNaN(away) && away < s1) out.push(Math.max(away, s0) - s0, s1 - s0);
  return out;
}

/** µs per pixel for the two charts: one scale for both (the longer fills the width), or each to fit. */
export function scales(selDur: number, peerDur: number, width: number, same: boolean): [number, number] {
  const w = Math.max(1, width);
  const fit = (d: number) => Math.max(d, 1e-6) / w;
  if (!same) return [fit(selDur), fit(peerDur)];
  const k = fit(Math.max(selDur, peerDur));
  return [k, k];
}

export interface PxBox {
  /** The span drawn; for a coalesced run, its first span. */
  id: number;
  row: number;
  px0: number;
  px1: number;
  /** Spans merged into this box (1 = a real box). */
  n: number;
}

/**
 * Boxes in pixels at `usPerPx`, coalesced like the timeline: per row, everything narrower than a pixel
 * that lands in a column already covered joins the box before it.
 */
export function toPixels(tree: MiniTree, usPerPx: number): PxBox[] {
  const last: (PxBox | undefined)[] = [];
  const out: PxBox[] = [];
  for (const b of tree.boxes) {
    const px0 = b.x0 / usPerPx;
    const px1 = b.x1 / usPerPx;
    const prev = last[b.row];
    if (prev && px1 - px0 < 1 && Math.floor(px0) <= Math.ceil(prev.px1)) {
      if (px1 > prev.px1) prev.px1 = px1;
      prev.n++;
      continue;
    }
    const p: PxBox = { id: b.id, row: b.row, px0, px1, n: 1 };
    out.push(p);
    last[b.row] = p;
  }
  return out;
}

/** The box under (x, row), preferring the innermost real box. */
export function boxAt(boxes: PxBox[], x: number, row: number): PxBox | null {
  let hit: PxBox | null = null;
  for (const b of boxes) if (b.row === row && x >= b.px0 - 0.5 && x <= Math.max(b.px1, b.px0 + 1) + 0.5) hit = b;
  return hit;
}
