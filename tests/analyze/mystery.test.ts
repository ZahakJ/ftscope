import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Trace } from '../../src/core/model';

// Guarded: the parser is written concurrently; without it these are skipped.
const parse = await import('../../src/core/parse/index').catch(() => null);
const load = (f: string): Trace => parse!.parseText(readFileSync(new URL(`../../examples/traces/${f}`, import.meta.url), 'utf8'));
const { analyze, explain, storyChildren } = await import('../../src/core/analyze');

describe.skipIf(!parse)('the mystery', () => {
  const t = load('07-mystery.trace');
  const a = analyze(t);
  const read = t.funcs.name.indexOf('__x64_sys_read');
  const reads: number[] = [];
  for (let i = 0; i < t.spans.n; i++) if (t.spans.func[i] === read) reads.push(i);
  const DISK = [137, 512, 846];
  const DECOYS = [3, 96, 160, 251, 532, 634, 732, 828, 921];

  it('finds the three disk reads with a disk reason', () => {
    expect(reads).toHaveLength(1000);
    for (const k of DISK) {
      const o = a.outliers.find((o) => o.span === reads[k]);
      expect(o, `read ${k}`).toBeDefined();
      expect(o!.reason).toMatch(/io_schedule|submit_bio/);
    }
  });

  it('finds the interrupt decoys with an irq reason', () => {
    const hit = DECOYS.filter((k) => a.outliers.find((o) => o.span === reads[k])?.reason.match(/interrupt/));
    expect(hit.length).toBeGreaterThanOrEqual(7);
    for (const k of DECOYS) expect(a.outliers.find((o) => o.span === reads[k])?.reason ?? '').not.toMatch(/submit_bio|io_schedule/);
  });

  it('writes one Brief insight per cause', () => {
    const disk = a.insights.filter((i) => i.kind === 'outlier' && /went to disk/.test(i.detail));
    expect(disk).toHaveLength(1);
    expect(disk[0].detail).toMatch(/^3 of 1\s000 `__x64_sys_read` calls took .*`submit_bio`.*slept/);
    const irq = a.insights.filter((i) => i.kind === 'irq');
    expect(irq).toHaveLength(1);
    expect(irq[0].detail).toMatch(/timer interrupts/);
  });

  it('folds the reads into one row and calls a typical read typical', () => {
    const tr = t.trackOf[reads[0]];
    const rows = storyChildren(t, a, -1, tr);
    const big = rows.find((r) => (r.kind === 'loop' && r.reps >= 990) || (r.kind === 'group' && r.spans.length >= 990));
    expect(big).toBeDefined();
    expect(explain(t, a, reads[10]).verdict).toMatch(/^Typical/);
  });
});
