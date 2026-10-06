// analyze(): the one pass over a parsed trace that splits every call's time
// into self / children / off-CPU / interrupt, gathers per-function statistics,
// finds the calls that are slow among their peers, and writes the Brief.

import type { Analysis, FuncStat, Outlier } from '../api';
import { F, type Trace } from '../model';
import { MIN_PEERS, causes, explainCore, minExcess } from './explain';
import { brief } from './brief';
import { UNTIMED, index, isIrqRoot, medianSorted, quantileSorted } from './util';

// Outlier thresholds, tuned on examples/traces (see the final report):
// robust z on log2 duration, a floor on the spread so a function whose calls
// are all alike does not flag 1.3× calls, and an absolute floor on the excess.
const Z_MIN = 4;
const SIGMA_FLOOR = 0.25; // log2 units: ~19 %
const RATIO_MIN = 3;
const MAX_EXPLAINED = 300;
const MAX_SHARE = 0.1; // at most this share of a function's timed calls may be outliers

/** Off-CPU intervals per task, from the switch records: off from `prev` until the next `next`. */
function offTime(t: Trace): Float64Array {
  const s = t.spans;
  const off = new Float64Array(s.n);
  const sw = t.switches;
  // Without real timestamps a switch is stamped with its CPU's reconstructed
  // clock while the task's own spans may be laid out on another CPU's: the
  // overlap would be fiction, so off-CPU time stays 0 (schedule() keeps it as self).
  if (!sw.n || t.meta.clock !== 'absolute') return off;
  const order = Array.from({ length: sw.n }, (_, k) => k).sort((x, y) => sw.ts[x] - sw.ts[y] || x - y);
  const since = new Map<number, number>();
  const iv = new Map<number, number[]>(); // flat [start, end, start, end, …] per task
  for (const k of order) {
    const ts = sw.ts[k];
    const p = sw.prev[k];
    const q = sw.next[k];
    if (p === q) continue;
    if (p > 0) since.set(p, ts);
    const s0 = since.get(q);
    if (q > 0 && s0 !== undefined) {
      since.delete(q);
      let a = iv.get(q);
      if (!a) iv.set(q, (a = []));
      a.push(s0, ts);
    }
  }
  for (const [task, s0] of since) {
    let a = iv.get(task);
    if (!a) iv.set(task, (a = []));
    a.push(s0, Infinity);
  }
  // prefix sums of interval lengths per task; overlap of [x, y) via two binary searches
  const pre = new Map<number, Float64Array>();
  for (const [task, a] of iv) {
    const m = a.length / 2;
    const ps = new Float64Array(m + 1);
    for (let j = 0; j < m; j++) ps[j + 1] = ps[j] + (isFinite(a[2 * j + 1]) ? a[2 * j + 1] - a[2 * j] : 0);
    pre.set(task, ps);
  }
  const until = (a: number[], ps: Float64Array, x: number): number => {
    // total off time in (-inf, x)
    let lo = 0;
    let hi = a.length / 2;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (a[2 * mid] < x) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return 0;
    const j = lo - 1;
    return ps[j] + Math.max(0, Math.min(x, a[2 * j + 1]) - a[2 * j]);
  };
  for (let i = 0; i < s.n; i++) {
    const a = iv.get(s.task[i]);
    const d = s.dur[i];
    if (!a || !isFinite(d) || d <= 0) continue;
    const ps = pre.get(s.task[i])!;
    off[i] = Math.min(d, until(a, ps, s.start[i] + d) - until(a, ps, s.start[i]));
  }
  return off;
}

export function analyze(t: Trace): Analysis {
  const s = t.spans;
  const n = s.n;
  const ix = index(t);
  const off = offTime(t);
  const irq = new Float64Array(n);
  const childDur = new Float64Array(n);
  const childOff = new Float64Array(n);
  // post-order: every child is folded before its parent
  for (let k = 0; k < n; k++) {
    const i = ix.post[k];
    const p = s.parent[i];
    if (p < 0) continue;
    const d = s.dur[i];
    childDur[p] += isFinite(d) ? d : 0;
    if (ix.irqCtx[i]) {
      if (!ix.irqCtx[p]) irq[p] += isFinite(d) ? d : 0;
      irq[i] = 0;
    } else {
      irq[p] += irq[i];
      childOff[p] += off[i];
    }
  }
  const self = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = s.dur[i];
    self[i] = isFinite(d) ? Math.max(0, d - childDur[i] - Math.max(0, off[i] - childOff[i])) : NaN;
  }

  // ---- per-function statistics over the CSR of spans by function
  const nf = t.funcs.name.length;
  const funcStats: FuncStat[] = new Array(nf);
  const surprise = new Float32Array(n);
  const cand = new Uint8Array(n);
  const durs = new Float64Array(n);
  const logs = new Float64Array(n);
  const minEx = minExcess(t);
  const sameAbove = (i: number): boolean => {
    for (let p = s.parent[i]; p >= 0; p = s.parent[p]) if (s.func[p] === s.func[i]) return true;
    return false;
  };
  for (let f = 0; f < nf; f++) {
    const lo = ix.funcStart[f];
    const hi = ix.funcStart[f + 1];
    const hist = new Uint32Array(40);
    let m = lo;
    let total = 0;
    let selfSum = 0;
    let max = -Infinity;
    let maxSpan = -1;
    for (let k = lo; k < hi; k++) {
      const i = ix.funcSpans[k];
      const d = s.dur[i];
      if (s.flags[i] & UNTIMED || !isFinite(d)) continue;
      durs[m++] = d;
      selfSum += self[i];
      if (!sameAbove(i)) total += d;
      if (d > max) [max, maxSpan] = [d, i];
      hist[Math.max(0, Math.min(39, Math.floor(Math.log2(Math.max(1, d * 1000)))))]++;
    }
    const sorted = durs.subarray(lo, m).sort();
    const timed = m - lo;
    const p50 = medianSorted(sorted);
    funcStats[f] = {
      func: f, count: hi - lo, timed, total, self: selfSum,
      min: timed ? sorted[0] : NaN, p50, p90: quantileSorted(sorted, 0, timed, 0.9), p99: quantileSorted(sorted, 0, timed, 0.99),
      max: timed ? max : NaN, maxSpan, hist, outliers: 0,
    };
    if (timed - 1 < MIN_PEERS || !(p50 > 0)) continue;
    for (let k = 0; k < timed; k++) logs[lo + k] = Math.log2(Math.max(sorted[k], 1e-3));
    const medLog = medianSorted(logs, lo, lo + timed);
    for (let k = 0; k < timed; k++) logs[lo + k] = Math.abs(logs[lo + k] - medLog);
    const devs = logs.subarray(lo, lo + timed).sort();
    let nc = 0;
    const sigma = Math.max(1.4826 * medianSorted(devs), SIGMA_FLOOR);
    for (let k = lo; k < hi; k++) {
      const i = ix.funcSpans[k];
      const d = s.dur[i];
      if (s.flags[i] & UNTIMED || !isFinite(d)) continue;
      surprise[i] = Math.max(0, Math.log2(d / p50));
      if (s.flags[i] & F.GAP) continue;
      const z = (Math.log2(d) - medLog) / sigma;
      if (z >= Z_MIN && d >= RATIO_MIN * p50 && d - p50 >= Math.max(minEx, p50)) {
        cand[i] = 1;
        nc++;
      }
    }
    // outliers are rare by definition: when many calls are "slow" the function
    // simply has a wide spread, and none of them is an outlier
    if (nc > Math.max(1, Math.floor(MAX_SHARE * timed))) for (let k = lo; k < hi; k++) cand[ix.funcSpans[k]] = 0;
  }

  // ---- root causes: the outermost slow call, explained once
  const outlier = new Uint8Array(n);
  const tops: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!cand[i]) continue;
    let nested = false;
    for (let p = s.parent[i]; p >= 0 && !nested; p = s.parent[p]) nested = cand[p] === 1;
    if (!nested) {
      outlier[i] = 1;
      tops.push(i);
      funcStats[s.func[i]].outliers++;
    }
  }
  tops.sort((x, y) => s.dur[y] - funcStats[s.func[y]].p50 - (s.dur[x] - funcStats[s.func[x]].p50));
  const core = { self, off, irq, funcStats, outlier };
  const outliers: Outlier[] = tops.map((i, k) => {
    const st = funcStats[s.func[i]];
    const excess = s.dur[i] - st.p50;
    const ratio = s.dur[i] / st.p50;
    if (k >= MAX_EXPLAINED) return { span: i, culprit: i, excess, ratio, reason: `${ratio.toFixed(1)}× its typical duration.` };
    const e = explainCore(t, core, i);
    return { span: i, culprit: e.blame[e.blame.length - 1]?.span ?? i, excess, ratio, reason: causes.get(e) ?? e.verdict, _e: e } as Outlier;
  });

  const a: Analysis = { self, off, irq, funcStats, surprise, outlier, outliers, insights: [] };
  a.insights = brief(t, a);
  for (const o of outliers) delete (o as { _e?: unknown })._e;
  return a;
}

export { isIrqRoot };
