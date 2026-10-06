// Private harness for the timeline: a synthetic trace (or ?trace=… when the
// parser exists), the overview and the timeline, plus a frame-time bench (?bench=1).

import { TraceBuilder } from '../src/core/builder';
import { F, type Trace } from '../src/core/model';
import type { Analysis } from '../src/core/api';
import * as state from '../src/ui/state';
import { frameStats, mountOverview, mountTimeline } from '../src/ui/timeline';

declare global {
  interface Window { __ready?: boolean; __tl?: unknown }
}

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

const NAMES = [
  'x64_sys_call', 'vfs_read', 'ext4_file_read_iter', 'filemap_read', 'filemap_get_pages', 'submit_bio', 'blk_mq_submit_bio',
  '__alloc_pages', 'get_page_from_freelist', 'kmem_cache_alloc', 'schedule', 'pick_next_task_fair', 'tcp_sendmsg',
  'ip_finish_output2', '_raw_spin_lock', 'mutex_lock', 'rcu_read_unlock_strict', 'copy_page_to_iter', 'fsnotify', 'touch_atime',
];

function synth(total: number): Trace {
  const b = new TraceBuilder();
  b.meta.format = 'function_graph';
  b.meta.tracer = 'function_graph';
  b.meta.clock = 'absolute';
  const fid = NAMES.map((n) => b.funcId(n));
  const irq = b.funcId('__sysvec_apic_timer_interrupt');
  const tasks = [
    b.taskId(1201, 'postgres', 0), b.taskId(1202, 'postgres', 1), b.taskId(883, 'kworker/1:2H-kblockd', 1),
    b.taskId(950, 'nginx', 2), b.taskId(0, 'swapper/3', 3),
  ];
  let line = 0;
  let spans = 0;
  const call = (task: number, cpu: number, t: number, depth: number, deep: boolean): number => {
    const f = depth === 0 ? fid[0] : fid[Math.floor(rnd() * fid.length)];
    const isIrq = depth > 2 && rnd() < 0.004;
    b.enter({ func: isIrq ? irq : f, ts: t, cpu, task, line: line++, byteStart: line * 40, flags: isIrq ? F.IRQ : 0 });
    spans++;
    let now = t + 0.05 + rnd() * 0.3;
    const p = deep ? 1 : Math.max(0, 0.82 - depth * 0.06);
    if (depth < 22 && rnd() < p) {
      const n = 1 + Math.floor(rnd() * (depth < 3 ? 4 : 2.5));
      for (let i = 0; i < n; i++) {
        now = call(task, cpu, now + rnd() * 0.08, depth + 1, deep && i === 0) + rnd() * 0.05;
        if (rnd() < 0.002) b.event({ name: 'irq_handler_entry', ts: now, cpu, task, line: line++, byteStart: 0, byteEnd: 0 });
      }
    }
    now += rnd() * 0.2;
    b.exit({ ts: now, dur: now - t, cpu, task, line: line++, byteStart: line * 40, byteEnd: line * 40 + 30 });
    return now;
  };
  // An orphan at the start of nginx: its entry was before the trace.
  b.exit({ ts: 2, dur: NaN, cpu: 2, task: tasks[3], func: fid[12], line: line++, byteStart: 0, byteEnd: 10 });
  const per = [0.45, 0.25, 0.15, 0.12, 0.03];
  let end = 0;
  tasks.forEach((task, ti) => {
    const cpu = ti === 4 ? 3 : ti === 2 ? 1 : ti;
    let t = ti * 3 + 3;
    let deep = ti === 0;
    while (spans < total * per.slice(0, ti + 1).reduce((x, y) => x + y)) {
      if (ti === 0 && Math.abs(t - 4000) < 30) {
        // The off-CPU outlier: a read that went to disk and slept.
        const r = fid[1];
        b.enter({ func: fid[0], ts: t, cpu, task, line: line++, byteStart: 0 });
        b.enter({ func: r, ts: t + 0.2, cpu, task, line: line++, byteStart: 0 });
        b.enter({ func: fid[10], ts: t + 1, cpu, task, line: line++, byteStart: 0 });
        b.switch(t + 2, cpu, task, tasks[2]);
        b.event({ name: 'sched_switch', ts: t + 2, cpu, task, line: line++, byteStart: 0, byteEnd: 0 });
        b.switch(t + 182, cpu, tasks[2], task);
        b.exit({ ts: t + 183, dur: 182, cpu, task, line: line++, byteStart: 0, byteEnd: 0 });
        b.exit({ ts: t + 184, dur: 183.8, cpu, task, line: line++, byteStart: 0, byteEnd: 0 });
        b.exit({ ts: t + 185, dur: 185, cpu, task, line: line++, byteStart: 0, byteEnd: 0 });
        spans += 3;
        t += 200;
      }
      t = call(task, cpu, t, 0, deep) + (ti === 3 ? 6 + rnd() * 40 : 0.5 + rnd() * 3);
      deep = false;
    }
    end = Math.max(end, t);
    if (ti === 1) b.enter({ func: fid[11], ts: t + 1, cpu, task, line: line++, byteStart: 0 }); // never closed
  });
  b.gap({ cpu: 1, lost: 4210, ts: 2500, line: 0 });
  b.meta.duration = end + 2;
  const tr = b.finish();
  tr.meta.duration = Math.max(tr.meta.duration, end + 2);
  return tr;
}

/** A `function`-tracer trace: duration-less calls in bursts, so density is the picture. */
function synthNoDur(total: number): Trace {
  const b = new TraceBuilder();
  b.meta.format = 'function';
  b.meta.tracer = 'function';
  const fid = NAMES.map((n) => b.funcId(n));
  const tasks = [b.taskId(300, 'cat', 0), b.taskId(301, 'sshd', 1), b.taskId(302, 'rcu_sched', 2)];
  let t = 0;
  for (let i = 0; i < total; i++) {
    const k = i % 7 === 0 ? 1 : i % 13 === 0 ? 2 : 0;
    t += rnd() < 0.002 ? 200 + rnd() * 800 : rnd() * 0.4;
    b.leaf({ func: fid[Math.floor(rnd() * fid.length)], ts: t, dur: NaN, flags: F.NO_DUR, cpu: k, task: tasks[k], line: i, byteStart: 0, byteEnd: 0 });
  }
  b.meta.duration = t + 1;
  return b.finish();
}

/** Stand-in analysis: surprise from each function's mean, the top few as outliers. */
function cheapAnalysis(t: Trace): Analysis {
  const n = t.spans.n;
  const sum = new Float64Array(t.funcs.name.length);
  const cnt = new Float64Array(t.funcs.name.length);
  for (let i = 0; i < n; i++) if (!Number.isNaN(t.spans.dur[i])) { sum[t.spans.func[i]] += t.spans.dur[i]; cnt[t.spans.func[i]]++; }
  // Typical ≈ twice the mean of the function's calls; good enough for a picture.
  const surprise = new Float32Array(n);
  const outlier = new Uint8Array(n);
  const cand: number[] = [];
  for (let i = 0; i < n; i++) {
    const m = sum[t.spans.func[i]] / cnt[t.spans.func[i]];
    const s = Math.max(0, Math.log2(t.spans.dur[i] / (2.5 * m)));
    surprise[i] = Number.isFinite(s) ? s : 0;
    if (surprise[i] > 2 && t.spans.depth[i] <= 2 && cnt[t.spans.func[i]] > 20) cand.push(i);
  }
  cand.sort((a, b) => surprise[b] - surprise[a]);
  const outs = cand.slice(0, 6);
  outs.forEach((i) => (outlier[i] = 1));
  const off = new Float64Array(n);
  return {
    self: new Float64Array(t.spans.dur), off, irq: new Float64Array(n), funcStats: [], surprise, outlier,
    outliers: outs.map((i) => ({ span: i, culprit: i, excess: 0, ratio: 2 ** surprise[i], reason: '' })), insights: [],
  } as Analysis;
}

async function main() {
  const q = new URLSearchParams(location.search);
  let t: Trace | null = null;
  const src = q.get('trace');
  if (src) {
    try {
      const p = '/src/core/parse/index.ts';
      const mod = await import(/* @vite-ignore */ p);
      t = mod.parseText(await (await fetch(src)).text());
    } catch (e) {
      console.warn('[harness] parser unavailable, using synthetic trace:', String(e));
    }
  }
  const t0 = performance.now();
  t ??= q.get('nodur') ? synthNoDur(Number(q.get('n') ?? 200_000)) : synth(Number(q.get('n') ?? 120_000));
  let a: Analysis | null = null;
  try {
    const p = '/src/core/analyze/index.ts';
    const mod = await import(/* @vite-ignore */ p);
    a = mod.analyze(t);
  } catch {
    a = cheapAnalysis(t);
  }
  document.getElementById('info')!.textContent = `${t.spans.n} spans · ${t.tracks.length} tracks · ${t.meta.clock}`;
  state.trace.value = t;
  state.analysis.value = a;
  state.zoomAll();
  if (q.get('light')) document.documentElement.dataset.theme = 'light';
  if (q.get('mode') === 'surprise') state.colorMode.value = 'surprise';
  const tb = performance.now();
  mountOverview(document.getElementById('ov')!);
  mountTimeline(document.getElementById('tl')!);
  window.__tl = { state, frameStats, trace: t };
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  console.warn(`[harness] ${t.spans.n} spans; build+analyse ${(tb - t0).toFixed(0)} ms; first frame ${frameStats.last.toFixed(1)} ms`);
  if (q.get('bench')) await bench(t);
  window.__ready = true;
}

/** Zoom in from the whole trace to ~20 µs and pan, one view change per frame. */
async function bench(t: Trace) {
  const s0 = { ...frameStats };
  const D = t.meta.duration;
  const steps = 240;
  const frameIntervals: number[] = [];
  let last = performance.now();
  for (let i = 0; i < steps; i++) {
    const w = D * Math.pow(20 / D, Math.min(1, i / 120));
    const c = D * (0.3 + 0.4 * (i / steps));
    state.zoomTo(c - w / 2, c + w / 2);
    await new Promise((r) => requestAnimationFrame(r));
    const now = performance.now();
    frameIntervals.push(now - last);
    last = now;
  }
  const n = frameStats.frames - s0.frames;
  const avg = (frameStats.total - s0.total) / n;
  frameIntervals.sort((x, y) => x - y);
  console.warn(
    `[bench] ${t.spans.n} spans, ${n} frames: draw avg ${avg.toFixed(2)} ms, max ${frameStats.max.toFixed(2)} ms; ` +
      `rAF interval p50 ${frameIntervals[steps >> 1].toFixed(1)} ms p95 ${frameIntervals[Math.floor(steps * 0.95)].toFixed(1)} ms`,
  );
  state.zoomAll();
}

main().catch((e) => {
  console.error(e);
  window.__ready = true;
});
