import { describe, expect, it } from 'vitest';
import {
  ancestors, bucketOf, collapseCrumbs, errnoOf, eventFields, fmtPct, histGeom, parseRaw, rawWindow, readRaw,
  slowerThan, timeSplit, topChildren,
} from '../../src/ui/inspector/logic';
import { makeTrace, spansOf } from '../story/fixture';

describe('raw line parsing', () => {
  it('reads arguments, nested parens included', () => {
    const r = parseRaw(' 1)   | vfs_read(file=0xffff8881, buf=(ptr, 2), count=4096) {', null, 'vfs_read');
    expect(r.args).toEqual([{ name: 'file', value: '0xffff8881' }, { name: 'buf', value: '(ptr, 2)' }, { name: 'count', value: '4096' }]);
  });
  it('reads return values from leaf and closing lines, with errno names', () => {
    expect(parseRaw('  0.5 us | foo(); /* ret=0x0 */', null, 'foo').ret).toBe('0x0');
    const c = parseRaw('do_open() {', '  3.1 us | } /* do_open ret=-2 */', 'do_open');
    expect(c.ret).toBe('-2');
    expect(c.errno).toBe('ENOENT');
    expect(parseRaw('x();  /* = -8 */', null, 'x').errno).toBe('ENOEXEC');
    expect(errnoOf('0xfffffffffffffffe')).toBe('ENOENT');
    expect(errnoOf('0x10')).toBeNull();
  });
  it('reads the return address', () => {
    const r = parseRaw('bar(); /* <-caller+0x24/0x120 ret=0x1 */', null, 'bar');
    expect(r.retaddr).toBe('caller+0x24/0x120');
    expect(r.ret).toBe('0x1');
  });
  it('lays out event fields', () => {
    const f = eventFields('  cat-100 [000] 1.0: sched_switch: prev_comm=cat prev_pid=100 prev_state=D ==> next_comm=swapper/0', 'sched_switch');
    expect(f.map((x) => x.key)).toEqual(['prev_comm', 'prev_pid', 'prev_state', 'next_comm']);
  });
});

describe('where the time went', () => {
  it('sums the four parts to the duration', () => {
    const s = timeSplit(111, 8, 0, 100);
    expect(s.self + s.children + s.off + s.irq).toBeCloseTo(111);
    expect(s.children).toBeCloseTo(3);
  });
  it('scales when the measured parts exceed the duration', () => {
    const s = timeSplit(10, 6, 6, 0);
    expect(s.self + s.off).toBeCloseTo(10);
    expect(s.children).toBe(0);
  });
  it('aggregates direct children by function, slowest member as the link', () => {
    const t = makeTrace(5, [2]);
    const read = spansOf(t, 'read')[2];
    const kids = topChildren(t, read);
    expect(kids[0].func).toBe(t.funcs.name.indexOf('disk'));
    const main = spansOf(t, 'main')[0];
    const agg = topChildren(t, main).find((k) => k.func === t.funcs.name.indexOf('read'))!;
    expect(agg.calls).toBe(5);
    expect(agg.span).toBe(read);
  });
  it('builds and collapses a breadcrumb', () => {
    const t = makeTrace(3, [1]);
    const io = spansOf(t, 'io')[0];
    expect(ancestors(t, io).map((s) => t.funcs.name[t.spans.func[s]])).toEqual(['main', 'read', 'disk']);
    expect(collapseCrumbs([1, 2, 3, 4, 5, 6, 7, 8], 5)).toEqual([1, 2, -1, 7, 8]);
  });
});

describe('among its peers', () => {
  it('buckets durations on the shared log2(ns) scale', () => {
    expect(bucketOf(1)).toBe(9); // 1000 ns
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(1e9)).toBe(39);
  });
  it('places a mark inside the padded range', () => {
    const h = new Uint32Array(40);
    h[10] = 1000; h[16] = 3;
    const g = histGeom(h);
    expect(g.lo).toBe(9);
    expect(g.hi).toBe(17);
    expect(g.bars[1]).toBe(1);
    expect(g.bars[7]).toBeGreaterThan(0.04);
    expect(g.x(2 ** 16 / 1000)).toBeGreaterThan(g.x(2 ** 10 / 1000));
  });
  it('says how many peers were faster', () => {
    const d = new Float64Array(1000).fill(2);
    d[5] = 100;
    const r = slowerThan(d, 100, 5);
    expect(r.of).toBe(999);
    expect(fmtPct(r.frac, r.of)).toBe('100 %');
    d[6] = 200; d[7] = 300; d[8] = 400;
    const r2 = slowerThan(d, 100, 5);
    expect(fmtPct(r2.frac, r2.of)).toBe('99.6 %');
  });
});

describe('raw lines', () => {
  it('keeps whole short ranges and marks entry and closing lines', () => {
    const w = rawWindow(10, 'a() {\n  b();\n}\n', null);
    expect(w.head.map((r) => r.n)).toEqual([10, 11, 12]);
    expect(w.head[0].mark).toBe('entry');
    expect(w.head[2].mark).toBe('close');
    expect(w.gap).toBeNull();
  });
  it('windows long ranges with a counted gap', () => {
    const text = Array.from({ length: 1000 }, (_, i) => 'l' + i).join('\n');
    const w = rawWindow(0, text, null);
    expect(w.head.length).toBe(200);
    expect(w.tail.length).toBe(20);
    expect(w.gap).toBe('… 780 lines …');
    expect(w.tail[19]).toMatchObject({ n: 999, mark: 'close' });
  });
  it('never reads more than the caps from a huge blob', async () => {
    const big = new Blob(['x'.repeat(5_000_000)]);
    const r = await readRaw(big, 0, 5_000_000);
    expect(r.head.length + (r.tail?.length ?? 0)).toBeLessThan(64 * 1024);
    const w = rawWindow(0, 'a {\nb\nc\nto', 'rn\nd\n}', 200, 20);
    expect(w.head.map((x) => x.text)).toEqual(['a {', 'b', 'c']);
    expect(w.tail.map((x) => x.text)).toEqual(['d', '}']);
  });
});
