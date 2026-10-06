import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Trace } from '../../src/core/model';

// Guarded: the parser is written concurrently; without it these are skipped.
const parse = await import('../../src/core/parse/index').catch(() => null);
const load = (f: string): Trace => parse!.parseText(readFileSync(new URL(`../../examples/traces/${f}`, import.meta.url), 'utf8'));
const { analyze, explain, storyChildren } = await import('../../src/core/analyze');

describe.skipIf(!parse)('the mystery (acceptance)', () => {
  const t = load('07-mystery.trace');
  const a = analyze(t);
  const s = t.spans;
  const read = t.funcs.name.indexOf('__x64_sys_read');
  const near = (i: number, d: number) => Math.abs(s.dur[i] - d) < 0.002;
  const readOut = a.outliers.filter((o) => s.func[o.span] === read);
  const DISK = [194.214, 87.965, 87.634];

  it('has exactly 12 outlier reads: 3 disk, 9 interrupt', () => {
    expect(readOut).toHaveLength(12);
    for (const o of readOut) {
      if (DISK.some((d) => near(o.span, d))) expect(o.reason).toMatch(/submit_bio|io_schedule/);
      else expect(o.reason).toMatch(/interrupt/);
    }
    expect(readOut.filter((o) => DISK.some((d) => near(o.span, d)))).toHaveLength(3);
  });

  it('the read at 68.749 µs carries its 54.4 µs interrupt under __rcu_read_unlock', () => {
    const o = readOut.find((o) => near(o.span, 68.749))!;
    expect(a.irq[o.span]).toBeCloseTo(54.4, 0);
    // the case this guards: an adopter whose id is larger than its children's (ids are not a topological order)
    const st = [o.span];
    let adopter = -1;
    while (st.length) {
      const i = st.pop()!;
      for (let c = s.firstChild[i]; c >= 0; c = s.nextSibling[c]) {
        if (c < i && t.funcs.name[s.func[i]] === '__rcu_read_unlock') adopter = i;
        st.push(c);
      }
    }
    expect(adopter).toBeGreaterThan(-1);
    expect(a.self[adopter]).toBeLessThan(10); // 59.5 µs if the interrupt were counted as its own
    expect(o.reason).not.toMatch(/__rcu_read_unlock` itself/);
  });

  it('the Brief leads with one disk insight and one interrupt insight, and says nothing of writev', () => {
    const [sum, first, second] = a.insights;
    expect(sum.kind).toBe('summary');
    const kinds = [first, second].map((i) => (i.kind === 'irq' ? 'irq' : /disk/.test(i.detail) ? 'disk' : i.kind)).sort();
    expect(kinds).toEqual(['disk', 'irq']);
    expect(a.insights.filter((i) => i.kind === 'irq')).toHaveLength(1);
    expect(a.insights.filter((i) => /disk/.test(i.title))).toHaveLength(1);
    const disk = [first, second].find((i) => i.kind !== 'irq')!;
    expect(disk.detail).toMatch(/^3 of 1.000 `__x64_sys_read` calls took 87\.6–194 µs/);
    expect([first, second].find((i) => i.kind === 'irq')!.detail).toMatch(/^9 of 1.000 `__x64_sys_read` calls took 48\.5–111 µs/);
    expect(a.insights.some((i) => /writev/.test(i.detail))).toBe(false);
  });

  it('folds the reads into one loop of 1000 whose outliers hold all 12, slowest first', () => {
    const loops = storyChildren(t, a, -1, 0).filter((n) => n.kind === 'loop' && n.unit.includes(read));
    expect(loops).toHaveLength(1);
    const l = loops[0] as Extract<(typeof loops)[number], { kind: 'loop' }>;
    expect(l.reps).toBe(1000);
    for (const o of readOut) expect(l.outliers!).toContain(o.span);
    const d = l.outliers!.map((x) => s.dur[x]);
    expect(d).toEqual([...d].sort((x, y) => y - x));
  });

  it('explains a typical read as typical', () => {
    const typical = a.funcStats[read];
    let i = 0;
    while (s.func[i] !== read || Math.abs(s.dur[i] - typical.p50) > 0.5) i++;
    expect(explain(t, a, i).verdict).toMatch(/^Typical/);
  });
});
