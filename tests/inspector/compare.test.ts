import { describe, expect, it } from 'vitest';
import { TraceBuilder } from '../../src/core/builder';
import { F } from '../../src/core/model';
import { flatten, scales, toPixels, typicalPeer } from '../../src/ui/inspector/compare';

/** Five reads: 10, 12, 14, 300 (deep, sleeps), and one that never returned. */
function build() {
  const b = new TraceBuilder();
  const A = b.taskId(100, 'cat', 0);
  const I = b.taskId(0, 'swapper/0', 0);
  const f = (s: string) => b.funcId(s);
  let line = 0, byte = 0;
  const L = (task = A) => ({ cpu: 0, task, line: line++, byteStart: (byte += 10) });
  const E = (ts: number, dur: number) => ({ ts, dur, ...L(), byteEnd: byte + 5 });
  const reads: number[] = [];
  let t0 = 0;
  for (const d of [10, 12, 14]) {
    reads.push(b.enter({ func: f('read'), ts: t0, ...L() }));
    b.leaf({ func: f('copy'), ts: t0 + 1, dur: d - 2, byteEnd: byte + 5, ...L() });
    b.exit(E(t0 + d, d));
    t0 += 100;
  }
  // The slow one: read > submit > io > wait (sleeps 20..290).
  reads.push(b.enter({ func: f('read'), ts: 400, ...L() }));
  b.enter({ func: f('submit'), ts: 401, ...L() });
  b.enter({ func: f('io'), ts: 402, ...L() });
  b.leaf({ func: f('wait'), ts: 403, dur: 290, byteEnd: byte + 5, ...L() });
  b.switch(420, 0, A, I);
  b.switch(690, 0, I, A);
  b.exit(E(694, 292));
  b.exit(E(695, 294));
  for (let i = 0; i < 40; i++) b.leaf({ func: f('tiny'), ts: 696 + i * 0.01, dur: 0.005, byteEnd: byte + 5, ...L() });
  b.exit(E(700, 300));
  reads.push(b.enter({ func: f('read'), ts: 800, flags: F.UNCLOSED, ...L() }));
  return { t: b.finish(), reads };
}

describe('typicalPeer', () => {
  it('takes the median of timed calls, skipping the selection itself', () => {
    const { t, reads } = build();
    const timed = reads.filter((r) => !(t.spans.flags[r] & F.UNCLOSED));
    expect(timed.length).toBe(4);
    // Sorted 10, 12, 14, 300: median index 1 = the 12 µs call.
    expect(typicalPeer(t, reads, reads[3])).toBe(reads[1]);
    expect(typicalPeer(t, reads, reads[1])).toBe(reads[2]);
    expect(typicalPeer(t, [reads[0]], reads[0])).toBe(-1);
  });
});

describe('flatten', () => {
  it('lays a subtree out by depth relative to its root, with off-CPU stretches', () => {
    const { t, reads } = build();
    const m = flatten(t, reads[3]);
    expect(m.dur).toBe(300);
    expect(m.rows).toBe(4);
    expect(m.boxes[0]).toMatchObject({ id: reads[3], row: 0, x0: 0, x1: 300 });
    expect(m.boxes.map((b) => b.row).slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(m.total).toBe(44);
    expect(m.off).toEqual([20, 290]);
  });
  it('merges deep rows and caps the work', () => {
    const { t, reads } = build();
    expect(flatten(t, reads[3], 2).rows).toBe(2);
    const c = flatten(t, reads[3], 12, 5);
    expect(c.boxes.length).toBe(5);
    expect(c.total).toBe(44);
  });
});

describe('scales and pixels', () => {
  it('shares one µs-per-pixel unless each is fit', () => {
    expect(scales(300, 12, 300, true)).toEqual([1, 1]);
    expect(scales(300, 12, 300, false)).toEqual([1, 0.04]);
  });
  it('coalesces sub-pixel boxes per column', () => {
    const { t, reads } = build();
    const px = toPixels(flatten(t, reads[3]), 1);
    const tiny = px.filter((b) => b.row === 1 && b.px0 >= 295);
    expect(tiny.length).toBe(1);
    expect(tiny[0].n).toBe(40);
  });
});
