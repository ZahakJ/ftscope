// Parser throughput: node scripts/bench-parse.mjs [file]  (default lab/out/04-big.trace)
// Bundles src/core/parse with esbuild to a temp file, then feeds the file in 1 MB chunks.
import { build } from 'esbuild';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ?? join(root, 'lab/out/04-big.trace');
const out = join(mkdtempSync(join(tmpdir(), 'ftscope-bench-')), 'parse.mjs');
await build({ entryPoints: [join(root, 'src/core/parse/index.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const { TraceParser } = await import(pathToFileURL(out).href);
const bytes = readFileSync(file);
const runs = [];
for (let r = 0; r < 4; r++) {
  const t0 = performance.now();
  const p = new TraceParser();
  for (let i = 0; i < bytes.length; i += 1 << 20) p.push(bytes.subarray(i, i + (1 << 20)));
  const tr = p.finish();
  const ms = performance.now() - t0;
  runs.push({ ms, spans: tr.spans.n });
}
const best = runs.slice(1).sort((a, b) => a.ms - b.ms)[0];
const mb = bytes.length / 1e6;
console.log(`${file}: ${mb.toFixed(1)} MB, ${best.spans} spans`);
console.log(`best of 3 (after warm-up): ${best.ms.toFixed(0)} ms  ${(mb / (best.ms / 1000)).toFixed(1)} MB/s  ${(best.spans / (best.ms / 1000) / 1e6).toFixed(2)} M spans/s`);
