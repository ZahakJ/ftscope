import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseText } from '../../src/core/parse';
import { checkTrace } from './invariants';

const root = join(__dirname, '../..');
const dir = join(root, 'examples/traces');
const files = readdirSync(dir).filter((f) => f.endsWith('.trace')).map((f) => join(dir, f));
const big = join(root, 'lab/out/04-big.trace');
if (existsSync(big)) files.push(big);

describe('example traces', () => {
  for (const f of files) {
    it(f.split('/').pop()!, () => {
      const text = readFileSync(f, 'utf8');
      const t = parseText(text);
      expect(t.meta.unparsedSamples).toEqual([]);
      expect(t.meta.counts.unparsed).toBe(0);
      expect(t.spans.n + t.events.n).toBeGreaterThan(0);
      checkTrace(t, text);
      const c = t.meta.counts;
      console.log(`${f.split('/').pop()}\t${t.meta.format}\t${t.meta.clock}\tspans=${c.spans} events=${c.events} orphans=${c.orphans} unclosed=${c.unclosed} gaps=${c.gaps} irq=${[...t.spans.flags].filter((x) => x & 8).length}`);
    }, 60_000);
  }
});
