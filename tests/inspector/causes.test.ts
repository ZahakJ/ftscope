import { describe, expect, it } from 'vitest';
import { TraceBuilder } from '../../src/core/builder';
import { F } from '../../src/core/model';
import { irqKind, irqParts, offWhere, taskWord } from '../../src/ui/inspector/logic';
import { stubAnalysis, spansOf } from '../story/fixture';

/** read() { [timer irq] ; io_schedule() { schedule(); } } — the task sleeps in schedule while idle runs. */
function build() {
  const b = new TraceBuilder();
  const A = b.taskId(100, 'cat', 0);
  const I = b.taskId(0, 'swapper/0', 0);
  const f = (s: string) => b.funcId(s);
  let line = 0, byte = 0;
  const L = (cpu = 0, task = A) => ({ cpu, task, line: line++, byteStart: (byte += 10) });
  b.enter({ func: f('read'), ts: 0, ...L() });
  b.enter({ func: f('sysvec_apic_timer_interrupt'), ts: 1, flags: F.IRQ, ...L() });
  b.leaf({ func: f('__sysvec_apic_timer_interrupt'), ts: 2, dur: 5, flags: F.IRQ, byteEnd: byte + 5, ...L() });
  b.exit({ ts: 8, dur: NaN, ...L(), byteEnd: byte + 5 });
  b.enter({ func: f('io_schedule'), ts: 10, ...L() });
  b.enter({ func: f('schedule'), ts: 11, ...L() });
  b.switch(12, 0, A, I);
  b.switch(60, 0, I, A);
  b.exit({ ts: 61, dur: NaN, ...L(), byteEnd: byte + 5 });
  b.exit({ ts: 62, dur: NaN, ...L(), byteEnd: byte + 5 });
  b.exit({ ts: 63, dur: NaN, ...L(), byteEnd: byte + 5 });
  return b.finish();
}

describe('naming the interrupt and the sleep', () => {
  const t = build();
  const read = spansOf(t, 'read')[0], ios = spansOf(t, 'io_schedule')[0], sch = spansOf(t, 'schedule')[0];
  const a = stubAnalysis(t);
  a.off[read] = 48; a.off[ios] = 48; a.off[sch] = 48;

  it('names interrupt kinds by their telling functions', () => {
    expect(irqKind('__sysvec_apic_timer_interrupt')).toBe('timer interrupt');
    expect(irqKind('common_interrupt')).toBe('device interrupt');
    expect(irqKind('handle_irq_event')).toBe('device interrupt');
    expect(irqKind('sysvec_call_function_single')).toBe('IPI');
    expect(irqKind('vfs_read')).toBeNull();
  });
  it('finds interrupt-context spans and names them by their most telling member', () => {
    const p = irqParts(t, read);
    expect(p).toHaveLength(1);
    expect(p[0].label).toBe('timer interrupt');
    expect(p[0].span).toBe(spansOf(t, 'sysvec_apic_timer_interrupt')[0]);
    expect(p[0].total).toBeCloseTo(t.spans.dur[p[0].span]);
  });
  it('says what it slept in, passing over the bare scheduler, and who ran', () => {
    const w = offWhere(t, a, read);
    expect(t.funcs.name[t.spans.func[w.span]]).toBe('io_schedule');
    expect(w.ranTask).toBeGreaterThanOrEqual(0);
    expect(taskWord(t, w.ranTask)).toBe('idle');
  });
  it('stays at the call when no child holds the off-CPU time', () => {
    const a2 = stubAnalysis(t);
    a2.off[read] = 5;
    expect(offWhere(t, a2, read).span).toBe(read);
  });
});
