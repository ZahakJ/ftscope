// Print what ftscope would say about a trace, in the terminal.
//   npx vite-node scripts/brief.ts examples/traces/07-mystery.trace [--outliers] [--story]
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { analyze, explain, storyChildren } from '../src/core/analyze';
import { TraceParser } from '../src/core/parse';

const path = process.argv[2];
let bytes: Uint8Array = readFileSync(path);
if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
const t0 = performance.now();
const p = new TraceParser();
for (let i = 0; i < bytes.length; i += 1 << 20) p.push(bytes.subarray(i, i + (1 << 20)));
const trace = p.finish();
const t1 = performance.now();
const a = analyze(trace);
const t2 = performance.now();
const m = trace.meta;
console.log(
  `${path}: ${(bytes.length / 1e6).toFixed(1)} MB, ${m.lines} lines; parse ${(t1 - t0).toFixed(0)} ms (${(bytes.length / 1e6 / ((t1 - t0) / 1e3)).toFixed(0)} MB/s), analyze ${(t2 - t1).toFixed(0)} ms`,
);
console.log(
  `format=${m.format} clock=${m.clock} spans=${m.counts.spans} events=${m.counts.events} tracks=${trace.tracks.length} funcs=${trace.funcs.name.length} orphans=${m.counts.orphans} unclosed=${m.counts.unclosed} lost=${m.counts.lost} unparsed=${m.counts.unparsed}`,
);
for (const w of m.warnings) console.log(`  warning: ${w}`);
console.log('');
for (const i of a.insights) console.log(`[${i.level}/${i.kind}] ${i.title}${i.value ? `  — ${i.value}` : ''}\n    ${i.detail}`);
if (process.argv.includes('--outliers')) {
  console.log(`\n${a.outliers.length} outliers:`);
  for (const o of a.outliers.slice(0, 40)) {
    const s = trace.spans;
    console.log(
      `  line ${s.line[o.span] + 1} ${trace.funcs.name[s.func[o.span]]} ${s.dur[o.span].toFixed(1)}us x${o.ratio.toFixed(1)} +${o.excess.toFixed(1)}us irq=${a.irq[o.span].toFixed(1)} off=${a.off[o.span].toFixed(1)} :: ${o.reason}`,
    );
  }
}
if (process.argv.includes('--story')) {
  const names = trace.funcs.name;
  trace.tracks.slice(0, 4).forEach((tr, ti) => {
    console.log(`\n${tr.name} (${tr.spans} calls)`);
    for (const n of storyChildren(trace, a, -1, ti).slice(0, process.argv.includes("--all") ? 1e9 : 25)) {
      if (n.kind === 'span') console.log(`  ${names[trace.spans.func[n.span]]} ${trace.spans.dur[n.span].toFixed(2)}us`);
      else if (n.kind === 'group') console.log(`  x${n.spans.length} ${names[n.func]} median ${n.median.toFixed(2)} max ${n.max.toFixed(2)} outliers=${n.outliers.length}`);
      else if (n.kind === 'loop') console.log(`  loop x${n.reps} [${n.unit.map((f) => names[f]).join(', ')}] outliers=${n.outliers?.length ?? 0}`);
      else console.log(`  (${n.kind})`);
    }
  });
}
const worst = a.outliers[0];
if (worst) console.log(`\nexplain(worst): ${explain(trace, a, worst.span).verdict}`);
const xi = process.argv.indexOf('--explain');
if (xi > 0) {
  // --explain FUNC: contributors of that function's worst outlier
  const s = trace.spans;
  const o = a.outliers.find((o) => trace.funcs.name[s.func[o.span]] === process.argv[xi + 1]);
  if (o) {
    const e = explain(trace, a, o.span);
    console.log(`\nexplain(${process.argv[xi + 1]} line ${s.line[o.span] + 1}): ${e.verdict}`);
    for (const c of e.contributors)
      console.log(`  ${c.kind} ${c.path.map((f) => trace.funcs.name[f]).join('/')} time=${c.time.toFixed(1)} typ=${c.typical.toFixed(1)} ex=${c.excess.toFixed(1)} calls=${c.calls}/${c.typicalCalls.toFixed(1)}`);
  }
}
if (process.argv.includes('--cats')) {
  // share of total self time per category, and the biggest "other" functions
  const { categorize } = await import('../src/core/categories');
  const { CATEGORIES } = await import('../src/core/model');
  const s = trace.spans;
  const per = new Float64Array(CATEGORIES.length);
  const other = new Map<number, number>();
  let tot = 0;
  for (let i = 0; i < s.n; i++) {
    const v = a.self[i];
    if (!(v > 0)) continue;
    const c = categorize(trace.funcs.name[s.func[i]]);
    per[c] += v;
    tot += v;
    if (CATEGORIES[c] === 'other') other.set(s.func[i], (other.get(s.func[i]) ?? 0) + v);
  }
  console.log('\ncategories: ' + CATEGORIES.map((c, k) => `${c} ${((100 * per[k]) / tot).toFixed(1)}%`).join('  '));
  for (const [f, v] of [...other].sort((x, y) => y[1] - x[1]).slice(0, 25)) console.log(`  other ${((100 * v) / tot).toFixed(2)}% ${trace.funcs.name[f]}`);
}
if (process.argv.includes('--perf')) {
  const { profile } = await import('../src/core/analyze');
  const w = [...a.outliers].sort((x, y) => trace.spans.dur[y.span] - trace.spans.dur[x.span]).find((o) => /sys_read$/.test(trace.funcs.name[trace.spans.func[o.span]])) ?? a.outliers[0];
  if (w) {
    const t3 = performance.now();
    explain(trace, a, w.span);
    console.log(`explain(worst) ${(performance.now() - t3).toFixed(1)} ms`);
  }
  const loop = storyChildren(trace, a, -1, 0)
    .filter((n) => n.kind === 'loop' || n.kind === 'group')
    .sort((x, y) => ('spans' in y ? y.spans.length : 0) - ('spans' in x ? x.spans.length : 0))[0];
  if (loop && 'spans' in loop) {
    const t4 = performance.now();
    profile(trace, a, loop.spans);
    console.log(`profile(${loop.spans.length} spans) ${(performance.now() - t4).toFixed(1)} ms`);
  }
}
