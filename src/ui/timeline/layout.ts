// Pure timeline logic: the per-depth index, visible-range queries, pixel
// coalescing, ticks, lane layout and hit-testing. No DOM here, so all of it is
// testable and the renderer only has to paint what these functions return.

import { F, type Trace } from '../../core/model';

/** Spans of one track at one depth, sorted by start. They never overlap, so `e` is sorted too. */
export interface Row {
  ids: Int32Array;
  s: Float64Array;
  e: Float64Array;
}

export interface LaneIndex {
  track: number;
  rows: Row[];
  /** Sum of root durations: what lanes are ordered by. */
  busy: number;
  /** Off-CPU intervals of the task as flat [start, end, start, end …], sorted. */
  off: Float64Array;
  /** Events on this lane: ids sorted by ts. */
  events: Int32Array;
  /** Context switch times touching this task, sorted. */
  switches: Float64Array;
}

export interface TimelineIndex {
  lanes: LaneIndex[]; // in display order
  noDur: boolean;
}

/** First index i with a[i] >= x (a sorted ascending). */
export function lowerBound(a: ArrayLike<number>, x: number, lo = 0, hi = a.length): number {
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/** First index i with a[i] > x. */
export function upperBound(a: ArrayLike<number>, x: number, lo = 0, hi = a.length): number {
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (a[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export function spanEndOf(t: Trace, id: number): number {
  const d = t.spans.dur[id];
  return Number.isNaN(d) ? t.tracks[t.trackOf[id]].t1 : t.spans.start[id] + d;
}

/**
 * Build the index in O(n) plus a sort only where file order is not time order
 * (orphans are allocated after the roots they adopt). `function`-tracer traces
 * collapse every call of a lane into one row of zero-width ticks.
 */
export function buildIndex(t: Trace): TimelineIndex {
  const sp = t.spans;
  const nTracks = t.tracks.length;
  const noDur = sp.n > 0 && (sp.flags[0] & F.NO_DUR) !== 0;
  const rowCount = t.tracks.map((k) => (noDur ? 1 : k.maxDepth + 1));
  const base = new Int32Array(nTracks + 1);
  for (let k = 0; k < nTracks; k++) base[k + 1] = base[k] + rowCount[k];
  const cnt = new Int32Array(base[nTracks]);
  const depthOf = (id: number) => (noDur ? 0 : Math.min(sp.depth[id], rowCount[t.trackOf[id]] - 1));
  for (let i = 0; i < sp.n; i++) cnt[base[t.trackOf[i]] + depthOf(i)]++;
  const rows: Row[] = Array.from(cnt, (c) => ({ ids: new Int32Array(c), s: new Float64Array(c), e: new Float64Array(c) }));
  const fill = new Int32Array(cnt.length);
  const busy = new Float64Array(nTracks);
  for (let i = 0; i < sp.n; i++) {
    const r = base[t.trackOf[i]] + depthOf(i);
    const j = fill[r]++;
    const row = rows[r];
    row.ids[j] = i;
    row.s[j] = sp.start[i];
    row.e[j] = noDur ? sp.start[i] : spanEndOf(t, i);
    if (sp.depth[i] === 0 && !noDur) busy[t.trackOf[i]] += row.e[j] - row.s[j];
    if (noDur) busy[t.trackOf[i]] += 1;
  }
  for (const row of rows) sortRow(row);

  const laneOfTask = new Map<number, number>();
  t.tracks.forEach((k, i) => laneOfTask.set(k.task, i));

  // Off-CPU: from a switch away from the task to the next switch back to it.
  const offs: number[][] = t.tracks.map(() => []);
  const sw: number[][] = t.tracks.map(() => []);
  const outAt = new Map<number, number>();
  const S = t.switches;
  for (let i = 0; i < S.n; i++) {
    const p = laneOfTask.get(S.prev[i]);
    const q = laneOfTask.get(S.next[i]);
    if (p !== undefined) {
      outAt.set(p, S.ts[i]);
      sw[p].push(S.ts[i]);
    }
    if (q !== undefined) {
      const o = outAt.get(q);
      if (o !== undefined && S.ts[i] > o) offs[q].push(o, S.ts[i]);
      outAt.delete(q);
      if (q !== p) sw[q].push(S.ts[i]);
    }
  }
  const ev: number[][] = t.tracks.map(() => []);
  for (let i = 0; i < t.events.n; i++) {
    const l = laneOfTask.get(t.events.task[i]);
    if (l !== undefined) ev[l].push(i);
  }
  const lanes: LaneIndex[] = t.tracks.map((_, k) => ({
    track: k,
    rows: rows.slice(base[k], base[k + 1]),
    busy: busy[k],
    off: new Float64Array(offs[k]),
    events: Int32Array.from(ev[k].sort((a, b) => t.events.ts[a] - t.events.ts[b])),
    switches: Float64Array.from(sw[k]).sort(),
  }));
  // Busiest first; idle loops and unknown tasks last.
  const idle = (k: number) => (t.tracks[k].task === 0 || /^(idle|swapper)/.test(t.tracks[k].name) ? 1 : 0);
  lanes.sort((a, b) => idle(a.track) - idle(b.track) || b.busy - a.busy);
  return { lanes, noDur };
}

function sortRow(row: Row): void {
  let sorted = true;
  for (let i = 1; i < row.s.length && sorted; i++) if (row.s[i] < row.s[i - 1]) sorted = false;
  if (sorted) return;
  const order = Array.from(row.ids.keys()).sort((a, b) => row.s[a] - row.s[b]);
  const ids = Int32Array.from(order, (o) => row.ids[o]);
  const s = Float64Array.from(order, (o) => row.s[o]);
  const e = Float64Array.from(order, (o) => row.e[o]);
  row.ids.set(ids);
  row.s.set(s);
  row.e.set(e);
}

/** Index range [lo, hi) of a row's spans that intersect [t0, t1]. */
export function visibleRange(row: Row, t0: number, t1: number): [number, number] {
  return [lowerBound(row.e, t0), upperBound(row.s, t1)];
}

// ---- coalescing -------------------------------------------------------------

/** Output of `coalesce`: one entry per drawn rectangle. A box is one span; a run stands for many. */
export interface Items {
  n: number;
  kind: Uint8Array; // 0 box, 1 run
  id: Int32Array; // the span (box) or the dominant span of the run
  lo: Int32Array; // run: first row index; box: row index
  hi: Int32Array; // run: one past last row index
  x0: Float64Array; // px
  x1: Float64Array;
}

export function makeItems(cap = 1 << 14): Items {
  return {
    n: 0,
    kind: new Uint8Array(cap),
    id: new Int32Array(cap),
    lo: new Int32Array(cap),
    hi: new Int32Array(cap),
    x0: new Float64Array(cap),
    x1: new Float64Array(cap),
  };
}

function push(o: Items, kind: number, id: number, lo: number, hi: number, x0: number, x1: number): Items {
  if (o.n === o.kind.length) {
    const b = makeItems(o.n * 2);
    b.kind.set(o.kind);
    b.id.set(o.id);
    b.lo.set(o.lo);
    b.hi.set(o.hi);
    b.x0.set(o.x0);
    b.x1.set(o.x1);
    b.n = o.n;
    o = b;
  }
  const i = o.n++;
  o.kind[i] = kind;
  o.id[i] = id;
  o.lo[i] = lo;
  o.hi[i] = hi;
  o.x0[i] = x0;
  o.x1[i] = x1;
  return o;
}

/**
 * Turn one row into rectangles for a view of `width` px over [t0, t1].
 * Spans ≥ `minPx` wide are boxes; sub-pixel spans are gathered per pixel
 * column into runs (one binary search per column), and neighbouring columns
 * with the same dominant span merge. Cost is O(columns × log n) because the
 * dominant span of a crowded column is chosen from a bounded sample.
 * `key` maps a span to its colour key: adjacent runs merge only when it matches.
 */
export function coalesce(
  row: Row,
  t0: number,
  t1: number,
  width: number,
  out: Items,
  key: (id: number) => number = () => 0,
  minPx = 1,
): Items {
  const k = width / (t1 - t0);
  let [i, end] = visibleRange(row, t0, t1);
  const { s, e, ids } = row;
  while (i < end) {
    const x0 = (s[i] - t0) * k;
    const x1 = (e[i] - t0) * k;
    if (x1 - x0 >= minPx) {
      out = push(out, 0, ids[i], i, i + 1, x0, x1);
      i++;
      continue;
    }
    // Sub-pixel: take every span starting in this pixel column.
    const col = Math.floor(Math.max(x0, 0));
    let j = Math.min(end, lowerBound(s, t0 + (col + 1) / k, i));
    if (j <= i) j = i + 1;
    // The last one may be wide (it can run past the column); it gets its own box.
    let last = j;
    if (j - 1 > i && (e[j - 1] - s[j - 1]) * k >= minPx) last = j - 1;
    const dom = dominant(row, i, last);
    const kk = key(ids[dom]);
    const p = out.n - 1;
    if (p >= 0 && out.kind[p] === 1 && out.x1[p] >= col && out.hi[p] === i && key(out.id[p]) === kk) {
      out.hi[p] = last;
      out.x1[p] = col + 1;
    } else {
      out = push(out, 1, ids[dom], i, last, col, col + 1);
    }
    i = last;
  }
  return out;
}

/** Longest span among row[i..j), sampling at most 16 so a crowded column stays O(1). */
function dominant(row: Row, i: number, j: number): number {
  const n = j - i;
  const step = n > 16 ? n / 16 : 1;
  let best = i;
  let bw = -1;
  for (let f = i; f < j; f += step) {
    const m = Math.floor(f);
    const w = row.e[m] - row.s[m];
    if (w > bw) {
      bw = w;
      best = m;
    }
  }
  return best;
}

// ---- ticks ------------------------------------------------------------------

/** A 1-2-5 step whose spacing is at least `minPx` on screen. */
export function tickStep(span: number, width: number, minPx = 90): number {
  const raw = (span * minPx) / Math.max(width, 1);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

/** Ticks at t0 + i·step, labelled relative to the view's left edge. */
export function ticks(t0: number, t1: number, width: number, minPx = 90): { step: number; at: number[] } {
  const step = tickStep(t1 - t0, width, minPx);
  const at: number[] = [];
  for (let i = 1; t0 + i * step < t1 && i < 1000; i++) at.push(i * step);
  return { step, at };
}

// ---- lane layout ------------------------------------------------------------

export interface LaneBox {
  lane: number; // index into TimelineIndex.lanes
  top: number; // px from the top of the content
  height: number;
  rows: number; // depth rows shown
  depth: number; // visible max depth + 1 (rows available)
  capped: boolean;
}

export const HEADER = 16;
export const LANE_GAP = 4;

/** Deepest row with any span in [t0, t1], -1 if none. */
export function visibleDepth(l: LaneIndex, t0: number, t1: number): number {
  for (let d = l.rows.length - 1; d >= 0; d--) {
    const [lo, hi] = visibleRange(l.rows[d], t0, t1);
    if (hi > lo) return d;
  }
  return -1;
}

export function layoutLanes(
  idx: TimelineIndex,
  t0: number,
  t1: number,
  rowH: number,
  expanded: ReadonlySet<number>,
  zoomed: boolean,
  cap = 14,
): LaneBox[] {
  const out: LaneBox[] = [];
  let y = 0;
  idx.lanes.forEach((l, i) => {
    const d = visibleDepth(l, t0, t1) + 1;
    // Nothing in view while zoomed: a header-only stub, so busy lanes keep the room.
    const want = d === 0 ? (zoomed ? 0 : Math.max(1, l.rows.length)) : d;
    const rows = expanded.has(i) ? want : Math.min(want, cap);
    const h = HEADER + rows * rowH + LANE_GAP;
    out.push({ lane: i, top: y, height: h, rows, depth: want, capped: want > rows });
    y += h;
  });
  return out;
}

// ---- hit testing ------------------------------------------------------------

export type Hit =
  | { kind: 'none' }
  | { kind: 'header'; lane: number; chevron: boolean }
  | { kind: 'span'; lane: number; id: number }
  | { kind: 'run'; lane: number; depth: number; ids: Int32Array; lo: number; hi: number; t0: number; t1: number; dom: number };

/** What is under (x, y): x in px from the canvas's left, y in px from the content's top. */
export function hitTest(
  idx: TimelineIndex,
  boxes: LaneBox[],
  rowH: number,
  t0: number,
  t1: number,
  width: number,
  x: number,
  y: number,
): Hit {
  const b = boxes[upperBound(boxes.map((q) => q.top), y) - 1];
  if (!b || y >= b.top + b.height - LANE_GAP) return { kind: 'none' };
  if (y < b.top + HEADER) return { kind: 'header', lane: b.lane, chevron: x < 18 };
  const d = Math.floor((y - b.top - HEADER) / rowH);
  const l = idx.lanes[b.lane];
  if (d >= b.rows || d >= l.rows.length) return { kind: 'none' };
  const row = l.rows[d];
  const k = width / (t1 - t0);
  const tx = t0 + x / k;
  // Exact containment first: a box under the pointer wins if it is visible as one.
  const i = upperBound(row.s, tx) - 1;
  if (i >= 0 && row.e[i] >= tx && (row.e[i] - row.s[i]) * k >= 1) return { kind: 'span', lane: b.lane, id: row.ids[i] };
  // Otherwise everything within the pointer's pixel column.
  const col = Math.floor(x);
  const lo = lowerBound(row.e, t0 + col / k);
  const hi = upperBound(row.s, t0 + (col + 1) / k);
  if (hi <= lo) return { kind: 'none' };
  if (hi - lo === 1) return { kind: 'span', lane: b.lane, id: row.ids[lo] };
  return { kind: 'run', lane: b.lane, depth: d, ids: row.ids, lo, hi, t0: row.s[lo], t1: row.e[hi - 1], dom: row.ids[dominant(row, lo, hi)] };
}

// ---- overview coverage --------------------------------------------------------

/** Per CPU, `bins` cells of traced (root-span) time over [0, duration]; values are fractions 0..1 of a cell. */
export function coverage(t: Trace, bins: number): { cpus: number[]; cells: Float32Array[]; t0: number; t1: number } {
  const t0 = Math.min(0, ...t.tracks.map((k) => k.t0));
  const t1 = Math.max(t.meta.duration, t0 + 1e-3);
  const cpus = t.cpus.length ? t.cpus : [0];
  const rowOf = new Map(cpus.map((c, i) => [c, i]));
  const cells = cpus.map(() => new Float32Array(bins));
  const w = (t1 - t0) / bins;
  const sp = t.spans;
  const noDur = sp.n > 0 && (sp.flags[0] & F.NO_DUR) !== 0;
  for (let i = 0; i < sp.n; i++) {
    if (!noDur && sp.depth[i] !== 0) continue;
    const r = rowOf.get(sp.cpu[i]) ?? 0;
    const a = (sp.start[i] - t0) / w;
    if (noDur) {
      const c = Math.min(bins - 1, Math.max(0, Math.floor(a)));
      cells[r][c] += 0.05;
      continue;
    }
    const b = (spanEndOf(t, i) - t0) / w;
    let c = Math.max(0, Math.floor(a));
    const ce = Math.min(bins - 1, Math.floor(b));
    for (; c <= ce; c++) cells[r][c] += Math.min(b, c + 1) - Math.max(a, c);
  }
  for (const row of cells) for (let c = 0; c < bins; c++) row[c] = Math.min(1, row[c]);
  return { cpus, cells, t0, t1 };
}

// ---- animation ----------------------------------------------------------------

/** Ease-out cubic. */
export const easeOut = (p: number): number => 1 - (1 - Math.min(1, Math.max(0, p))) ** 3;

/**
 * The view part-way from `a` to `b` (p in 0..1, already eased). Width moves
 * geometrically (log space) so a 1000x zoom reads as steady; the point that is
 * fixed on screen (where the two views' edges meet in a zoom) stays put.
 */
export function lerpView(
  a: { t0: number; t1: number },
  b: { t0: number; t1: number },
  p: number,
): { t0: number; t1: number } {
  if (p <= 0) return a;
  if (p >= 1) return b;
  const wa = a.t1 - a.t0;
  const wb = b.t1 - b.t0;
  const w = Math.exp(Math.log(wa) + (Math.log(wb) - Math.log(wa)) * p);
  // Fraction along the width at which the fixed point sits: solves a.t0 + f*wa = b.t0 + f*wb.
  if (Math.abs(wa - wb) > 1e-9 * Math.max(wa, wb)) {
    const f = (b.t0 - a.t0) / (wa - wb);
    if (f >= 0 && f <= 1) {
      const fx = a.t0 + f * wa;
      return { t0: fx - f * w, t1: fx - f * w + w };
    }
  }
  // Pure pan, or a jump: move the centre linearly.
  const c = (a.t0 + a.t1) / 2 + ((b.t0 + b.t1) / 2 - (a.t0 + a.t1) / 2) * p;
  return { t0: c - w / 2, t1: c + w / 2 };
}

// ---- overview pins --------------------------------------------------------------

export interface PinGroup {
  x: number;
  /** Indices into the input arrays. */
  members: number[];
  /** Member with the largest duration. */
  slowest: number;
}

/** Merge pins whose pixel positions lie within `tol` px of the group's first pin. O(n log n). */
export function pinGroups(xs: ArrayLike<number>, durs: ArrayLike<number>, tol = 0): PinGroup[] {
  const order = Array.from({ length: xs.length }, (_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const out: PinGroup[] = [];
  for (const i of order) {
    const x = Math.round(xs[i]);
    const g = out[out.length - 1];
    if (g && x - g.x <= tol) {
      g.members.push(i);
      if (!(durs[g.slowest] >= durs[i])) g.slowest = i;
    } else out.push({ x, members: [i], slowest: i });
  }
  return out;
}

/** Nearest group within `tol` px of x, or null. */
export function pinAt(groups: PinGroup[], x: number, tol = 5): PinGroup | null {
  let best: PinGroup | null = null;
  for (const g of groups) if (Math.abs(g.x - x) <= tol && (!best || Math.abs(g.x - x) < Math.abs(best.x - x))) best = g;
  return best;
}

// ---- lost-event gaps --------------------------------------------------------------

/**
 * Per gap, the lanes whose task was running on the gap's CPU around it: a
 * root span on that CPU that contains the gap time or ends/starts within
 * `near` µs of it. null for a gap where no lane qualifies (draw it on all).
 */
export function gapLanes(t: Trace, idx: TimelineIndex, near: number): (number[] | null)[] {
  const cpu = t.spans.cpu;
  return t.gaps.map((g) => {
    const lanes: number[] = [];
    idx.lanes.forEach((l, li) => {
      const r = l.rows[0];
      if (!r) return;
      const i = upperBound(r.s, g.ts) - 1;
      for (const j of [i, i + 1]) {
        if (j < 0 || j >= r.ids.length) continue;
        const dist = g.ts < r.s[j] ? r.s[j] - g.ts : g.ts > r.e[j] ? g.ts - r.e[j] : 0;
        if (dist <= near && cpu[r.ids[j]] === g.cpu) {
          lanes.push(li);
          return;
        }
      }
    });
    return lanes.length ? lanes : null;
  });
}
