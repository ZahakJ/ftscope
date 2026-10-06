import { describe, expect, it } from 'vitest';
import { TraceBuilder } from '../../src/core/builder';
import { F } from '../../src/core/model';
import {
  HEADER, LANE_GAP, buildIndex, coalesce, coverage, easeOut, gapLanes, hitTest, lerpView, pinAt, pinGroups, layoutLanes, lowerBound, makeItems, tickStep, ticks,
  upperBound, visibleRange, type Row,
} from '../../src/ui/timeline/layout';

/** Two tasks: A runs `n` root calls of 1 µs each with one 0.5 µs child; B runs one 10 µs call. */
function small(n = 10) {
  const b = new TraceBuilder();
  const f = b.funcId('vfs_read');
  const g = b.funcId('filemap_read');
  const A = b.taskId(10, 'a', 0);
  const B = b.taskId(20, 'b', 1);
  let line = 0;
  for (let i = 0; i < n; i++) {
    const t = i * 2;
    b.enter({ func: f, ts: t, cpu: 0, task: A, line: line++, byteStart: 0 });
    b.leaf({ func: g, ts: t + 0.25, dur: 0.5, cpu: 0, task: A, line: line++, byteStart: 0, byteEnd: 0 });
    b.exit({ ts: t + 1, dur: 1, cpu: 0, task: A, line: line++, byteStart: 0, byteEnd: 0 });
  }
  b.enter({ func: f, ts: 100, cpu: 1, task: B, line: line++, byteStart: 0 });
  b.exit({ ts: 110, dur: 10, cpu: 1, task: B, line: line++, byteStart: 0, byteEnd: 0 });
  b.meta.duration = 110;
  return b.finish();
}

const row = (pairs: [number, number][]): Row => ({
  ids: Int32Array.from(pairs, (_, i) => i),
  s: Float64Array.from(pairs, (p) => p[0]),
  e: Float64Array.from(pairs, (p) => p[1]),
});

describe('binary search', () => {
  it('lower and upper bounds', () => {
    const a = [1, 2, 2, 3];
    expect(lowerBound(a, 2)).toBe(1);
    expect(upperBound(a, 2)).toBe(3);
    expect(lowerBound(a, 0)).toBe(0);
    expect(upperBound(a, 9)).toBe(4);
  });
  it('visible range includes spans straddling the edges', () => {
    const r = row([[0, 1], [2, 3], [4, 5], [6, 7]]);
    expect(visibleRange(r, 2.5, 4.5)).toEqual([1, 3]);
    expect(visibleRange(r, 8, 9)).toEqual([4, 4]);
  });
});

describe('index', () => {
  it('has one row per depth, sorted, and orders the busiest lane first', () => {
    const t = small(10);
    const ix = buildIndex(t);
    expect(ix.lanes.length).toBe(t.tracks.length);
    const a = ix.lanes.find((l) => t.tracks[l.track].name.startsWith('a'))!;
    expect(a.rows.length).toBe(2);
    expect(a.rows[0].ids.length).toBe(10);
    expect(a.rows[1].ids.length).toBe(10);
    for (let i = 1; i < 10; i++) expect(a.rows[0].s[i]).toBeGreaterThan(a.rows[0].s[i - 1]);
    // a: 10 µs total, b: 10 µs; a tie keeps both, but every lane has its busy time.
    expect(a.busy).toBeCloseTo(10);
  });
  it('puts function-tracer calls in one zero-width row', () => {
    const b = new TraceBuilder();
    const T = b.taskId(5, 'x', 0);
    for (let i = 0; i < 5; i++)
      b.leaf({ func: b.funcId('f' + (i % 2)), ts: i, dur: NaN, flags: F.NO_DUR, cpu: 0, task: T, line: i, byteStart: 0, byteEnd: 0 });
    const ix = buildIndex(b.finish());
    expect(ix.noDur).toBe(true);
    const l = ix.lanes.find((q) => q.rows[0].ids.length === 5)!;
    expect(l.rows.length).toBe(1);
    expect(Array.from(l.rows[0].e)).toEqual(Array.from(l.rows[0].s));
  });
});

describe('coalesce', () => {
  it('draws wide spans as boxes', () => {
    const out = coalesce(row([[0, 10], [10, 20]]), 0, 20, 200, makeItems(2));
    expect(out.n).toBe(2);
    expect(Array.from(out.kind.slice(0, 2))).toEqual([0, 0]);
    expect(out.x1[0]).toBeCloseTo(100);
  });
  it('merges sub-pixel spans per column into runs, bounded by the pixel count', () => {
    const pairs: [number, number][] = [];
    for (let i = 0; i < 100_000; i++) pairs.push([i, i + 0.5]);
    const out = coalesce(row(pairs), 0, 100_000, 500, makeItems());
    expect(out.n).toBeLessThanOrEqual(500);
    let covered = 0;
    for (let i = 0; i < out.n; i++) covered += out.hi[i] - out.lo[i];
    expect(covered).toBe(100_000);
  });
  it('keeps colour boundaries between runs', () => {
    const pairs: [number, number][] = [];
    for (let i = 0; i < 1000; i++) pairs.push([i, i + 0.5]);
    const out = coalesce(row(pairs), 0, 1000, 10, makeItems(), (id) => (id < 500 ? 0 : 1));
    expect(out.n).toBe(2);
    expect(out.hi[0]).toBe(500);
  });
  it('gives a wide span after tiny ones its own box', () => {
    const out = coalesce(row([[0, 0.01], [0.02, 0.03], [0.05, 50]]), 0, 100, 100, makeItems());
    expect(out.n).toBe(2);
    expect(out.kind[0]).toBe(1);
    expect(out.kind[1]).toBe(0);
    expect(out.id[1]).toBe(2);
  });
});

describe('ticks', () => {
  it('uses 1-2-5 steps at least minPx apart', () => {
    expect(tickStep(1000, 1000, 90)).toBe(100);
    expect(tickStep(100, 1000, 90)).toBe(10);
    expect(tickStep(37, 1000, 90)).toBe(5);
    const { step, at } = ticks(3, 13, 1000, 90);
    expect(step).toBe(1);
    expect(at[0]).toBe(1);
    expect(at.length).toBe(9);
  });
});

describe('lane layout and hit testing', () => {
  it('stacks lanes, caps depth, and shrinks idle lanes when zoomed', () => {
    const t = small(10);
    const ix = buildIndex(t);
    const full = layoutLanes(ix, 0, 110, 18, new Set(), false);
    expect(full.every((b) => b.rows >= 1)).toBe(true);
    expect(full[1].top).toBe(full[0].height);
    const zoomed = layoutLanes(ix, 0, 5, 18, new Set(), true);
    const bLane = zoomed.find((b) => t.tracks[ix.lanes[b.lane].track].name.startsWith('b'))!;
    // Nothing in view while zoomed: a header-only stub.
    expect(bLane.rows).toBe(0);
    expect(bLane.height).toBe(HEADER + LANE_GAP);
    const capped = layoutLanes(ix, 0, 110, 18, new Set(), false, 1);
    expect(capped.some((b) => b.capped)).toBe(true);
    const opened = layoutLanes(ix, 0, 110, 18, new Set(capped.filter((b) => b.capped).map((b) => b.lane)), false, 1);
    expect(opened.every((b) => !b.capped)).toBe(true);
  });
  it('finds spans, runs, headers and nothing', () => {
    const t = small(10);
    const ix = buildIndex(t);
    const boxes = layoutLanes(ix, 0, 20, 18, new Set(), false);
    const aBox = boxes.find((b) => t.tracks[ix.lanes[b.lane].track].name.startsWith('a'))!;
    // 1000 px over 20 µs: call 0 covers x 0..50, its child 12.5..37.5 in row 1.
    const h0 = hitTest(ix, boxes, 18, 0, 20, 1000, 25, aBox.top + HEADER + 5);
    expect(h0.kind).toBe('span');
    expect(h0.kind === 'span' && t.funcs.name[t.spans.func[h0.id]]).toBe('vfs_read');
    const h1 = hitTest(ix, boxes, 18, 0, 20, 1000, 25, aBox.top + HEADER + 18 + 5);
    expect(h1.kind === 'span' && t.funcs.name[t.spans.func[h1.id]]).toBe('filemap_read');
    expect(hitTest(ix, boxes, 18, 0, 20, 1000, 75, aBox.top + HEADER + 5).kind).toBe('none');
    expect(hitTest(ix, boxes, 18, 0, 20, 1000, 5, aBox.top + 3)).toMatchObject({ kind: 'header', chevron: true });
    // Zoomed out so ten calls share a pixel: a run.
    const far = hitTest(ix, boxes, 18, 0, 2000, 100, 0.5, aBox.top + HEADER + 5);
    expect(far.kind).toBe('run');
    expect(far.kind === 'run' && far.hi - far.lo).toBe(10);
  });
});

describe('overview coverage', () => {
  it('fills cells with root-span time per CPU', () => {
    const t = small(10);
    const c = coverage(t, 110);
    const cpu1 = c.cpus.indexOf(1);
    expect(c.cells[cpu1][105]).toBeCloseTo(1);
    expect(c.cells[cpu1][50]).toBe(0);
    const cpu0 = c.cpus.indexOf(0);
    expect(c.cells[cpu0][0]).toBeCloseTo(1);
    expect(c.cells[cpu0][1]).toBe(0);
  });
});

describe('view animation', () => {
  it('interpolates width geometrically and keeps the zoom anchor fixed', () => {
    const a = { t0: 0, t1: 1000 };
    const b = { t0: 400, t1: 410 }; // zoom about t = 404.04…
    const mid = lerpView(a, b, 0.5);
    expect(mid.t1 - mid.t0).toBeCloseTo(100); // sqrt(1000 * 10)
    const f = (b.t0 - a.t0) / (1000 - 10);
    expect(mid.t0 + f * (mid.t1 - mid.t0)).toBeCloseTo(a.t0 + f * 1000);
    expect(lerpView(a, b, 0)).toEqual(a);
    expect(lerpView(a, b, 1)).toEqual(b);
  });
  it('pans linearly at constant width', () => {
    const m = lerpView({ t0: 0, t1: 10 }, { t0: 100, t1: 110 }, 0.25);
    expect(m.t0).toBeCloseTo(25);
    expect(m.t1).toBeCloseTo(35);
  });
  it('eases out and clamps', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(2)).toBe(1);
    expect(easeOut(0.5)).toBeGreaterThan(0.5);
  });
});

describe('overview pins', () => {
  it('merges pins on the same pixel and picks the slowest', () => {
    const g = pinGroups([10.2, 50, 9.8, 10.4], [5, 1, 9, 2]);
    expect(g.length).toBe(2);
    expect(g[0].x).toBe(10);
    expect(g[0].members.sort()).toEqual([0, 2, 3]);
    expect(g[0].slowest).toBe(2);
    expect(pinAt(g, 13)?.x).toBe(10);
    expect(pinAt(g, 30)).toBeNull();
    expect(pinGroups([0, 2, 9], [1, 1, 1], 3).length).toBe(2);
  });
});

describe('lost-event gaps', () => {
  it('lands on lanes that ran on that CPU near the gap, or on all when unknown', () => {
    const t = small(10);
    const ix = buildIndex(t);
    const cpuA = t.spans.cpu[ix.lanes[0].rows[0].ids[0]];
    (t as { gaps: unknown }).gaps = [
      { cpu: cpuA, lost: 5, ts: 1, line: 0 },
      { cpu: 77, lost: 5, ts: 1, line: 0 },
    ];
    const gl = gapLanes(t, ix, 0.5);
    expect(gl[0]).not.toBeNull();
    for (const li of gl[0]!) expect(t.spans.cpu[ix.lanes[li].rows[0].ids[0]]).toBe(cpuA);
    expect(gl[1]).toBeNull();
  });
});
