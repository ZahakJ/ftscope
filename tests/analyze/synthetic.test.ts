import { describe, expect, it } from 'vitest';
import { TraceBuilder } from '../../src/core/builder';
import { F, type Trace } from '../../src/core/model';
import { analyze, explain, funcDetail, profile, storyChildren } from '../../src/core/analyze';

// A small mystery: N reads, three go to disk and sleep, four take a timer interrupt.
function mystery(N = 200, disk = [37, 112, 160], irqs = [5, 50, 90, 140]): Trace {
  const b = new TraceBuilder();
  const me = b.taskId(100, 'mystery', 0);
  const other = b.taskId(7, 'kworker/0:1', 0);
  let ts = 0;
  let line = 0;
  const L = (name: string, dur: number, flags = 0) => {
    b.leaf({ func: b.funcId(name), ts, cpu: 0, task: me, line: line++, byteStart: 0, byteEnd: 0, dur, flags });
    ts += dur;
  };
  const open = (name: string, flags = 0) => b.enter({ func: b.funcId(name), ts, cpu: 0, task: me, line: line++, byteStart: 0, flags });
  const close = (t0: number) => b.exit({ ts, dur: ts - t0, cpu: 0, task: me, line: line++, byteStart: 0, byteEnd: 0 });
  for (let k = 0; k < N; k++) {
    L('trace_syscall_enter', 0.3);
    const r0 = ts;
    open('__x64_sys_read');
    const v0 = ts;
    open('vfs_read');
    L('touch_atime', 1 + (k % 7) * 0.1);
    const f0 = ts;
    open('filemap_get_pages');
    if (disk.includes(k)) {
      const a0 = ts;
      open('filemap_add_folio');
      L('submit_bio', 5);
      const s0 = ts;
      open('io_schedule');
      b.switch(ts + 1, 0, me, other);
      ts += 150;
      b.switch(ts - 1, 0, other, me);
      close(s0);
      close(a0);
    }
    if (irqs.includes(k)) {
      L('irq_enter_rcu', 0.2, F.IRQ);
      L('__sysvec_apic_timer_interrupt', 60, F.IRQ);
      L('irq_exit_rcu', 3, F.IRQ);
    }
    L('filemap_get_read_batch', 4 + (k % 5) * 0.2);
    close(f0);
    L('copy_page_to_iter', 2);
    close(v0);
    close(r0);
    L('trace_syscall_exit', 0.3);
    ts += 2;
  }
  return b.finish();
}

describe('analyze on a hand-built mystery', () => {
  const t = mystery();
  const a = analyze(t);
  const read = t.funcs.name.indexOf('__x64_sys_read');
  const reads = Array.from({ length: t.spans.n }, (_, i) => i).filter((i) => t.spans.func[i] === read);

  it('splits time into self, off-CPU and interrupt', () => {
    const slow = reads[37];
    expect(a.off[slow]).toBeGreaterThan(140);
    expect(a.irq[reads[5]]).toBeCloseTo(63.2, 3);
    expect(a.irq[reads[6]]).toBe(0);
    for (let i = 0; i < t.spans.n; i++) expect(a.self[i]).toBeGreaterThanOrEqual(0);
    const io = t.funcs.name.indexOf('io_schedule');
    const ioSpan = reads.length && Array.from({ length: t.spans.n }, (_, i) => i).find((i) => t.spans.func[i] === io)!;
    expect(a.self[ioSpan]).toBeLessThan(5);
  });

  it('flags the disk reads and the interrupt-inflated ones, once each', () => {
    const tops = a.outliers.map((o) => o.span).sort((x, y) => x - y);
    expect(tops).toEqual([37, 112, 160, 5, 50, 90, 140].map((k) => reads[k]).sort((x, y) => x - y));
    const disk = a.outliers.filter((o) => [37, 112, 160].some((k) => reads[k] === o.span));
    for (const o of disk) expect(o.reason).toMatch(/io_schedule|submit_bio/);
    for (const o of a.outliers.filter((o) => !disk.includes(o))) expect(o.reason).toMatch(/timer interrupt/);
    expect(a.funcStats[read].outliers).toBe(7);
  });

  it('writes one Brief insight per cause', () => {
    const out = a.insights.filter((i) => i.kind === 'outlier');
    const irq = a.insights.filter((i) => i.kind === 'irq');
    expect(a.insights[0].kind).toBe('summary');
    expect(out).toHaveLength(1);
    expect(out[0].detail).toMatch(/^3 of 200 `__x64_sys_read` calls took .* went to disk .*`submit_bio`.*slept in `io_schedule`/);
    expect(irq).toHaveLength(1);
    expect(irq[0].detail).toMatch(/^4 `__x64_sys_read` calls were inflated by timer interrupts/);
  });

  it('explains typical and slow calls', () => {
    expect(explain(t, a, reads[10]).verdict).toMatch(/^Typical: /);
    const e = explain(t, a, reads[37]);
    expect(e.slow).toBe(true);
    expect(e.verdict).toMatch(/off-CPU inside `io_schedule`.*never take/);
    expect(e.blame.map((b) => t.funcs.name[t.spans.func[b.span]])).toContain('filemap_add_folio');
    const i = explain(t, a, reads[50]);
    expect(i.contributors[0].kind).toBe('irq');
    expect(i.verdict).toMatch(/timer interrupt .* the call itself was typical/);
  });

  it('folds the reads into one loop despite interrupts', () => {
    const nodes = storyChildren(t, a, -1, 0);
    expect(nodes).toHaveLength(1);
    const n = nodes[0];
    expect(n.kind).toBe('loop');
    if (n.kind === 'loop') {
      expect(n.reps).toBe(200);
      expect(n.outliers?.[0]).toBe(reads[37]);
    }
    const kids = storyChildren(t, a, reads[5]);
    expect(kids.map((k) => k.kind)).toEqual(['span']);
    const fp = storyChildren(t, a, t.spans.firstChild[t.spans.firstChild[reads[5]]] + 1);
    expect(fp.length).toBeGreaterThan(0);
  });

  it('profiles a group with interrupts hoisted to the root', () => {
    const p = profile(t, a, Int32Array.from(reads));
    expect(p.calls).toBe(200);
    expect(p.children[0].func).toBe(t.funcs.name.indexOf('vfs_read'));
    const tim = p.children.find((c) => t.funcs.name[c.func] === '__sysvec_apic_timer_interrupt');
    expect(tim?.members).toBe(4);
    const d = funcDetail(t, a, read);
    expect(d.slowest[0]).toBe(reads[37]);
    expect(d.callees[0].func).toBe(t.funcs.name.indexOf('vfs_read'));
  });

  it('does not count recursion twice and needs peers', () => {
    const b = new TraceBuilder();
    const tk = b.taskId(1, 'x', 0);
    const f = b.funcId('rec');
    const i0 = b.enter({ func: f, ts: 0, cpu: 0, task: tk, line: 0, byteStart: 0 });
    b.leaf({ func: f, ts: 1, cpu: 0, task: tk, line: 1, byteStart: 0, byteEnd: 0, dur: 2 });
    b.exit({ ts: 10, dur: 10, cpu: 0, task: tk, line: 2, byteStart: 0, byteEnd: 0 });
    const t2 = b.finish();
    const a2 = analyze(t2);
    expect(i0).toBe(0);
    expect(a2.funcStats[f].total).toBe(10);
    expect(a2.outliers).toHaveLength(0);
    expect(explain(t2, a2, 0).verdict).toMatch(/too few/);
  });
});
