// The Inspector's arithmetic, kept apart from rendering so it can be tested
// on hand-built traces.

import type { Analysis, FuncStat } from '../../core/api';
import { F, type Trace } from '../../core/model';

// ---- arguments and return values from the raw lines ------------------------

const ERRNO: Record<number, string> = {
  1: 'EPERM', 2: 'ENOENT', 3: 'ESRCH', 4: 'EINTR', 5: 'EIO', 6: 'ENXIO', 7: 'E2BIG', 8: 'ENOEXEC', 9: 'EBADF', 11: 'EAGAIN',
  12: 'ENOMEM', 13: 'EACCES', 14: 'EFAULT', 16: 'EBUSY', 17: 'EEXIST', 19: 'ENODEV', 20: 'ENOTDIR', 21: 'EISDIR',
  22: 'EINVAL', 24: 'EMFILE', 28: 'ENOSPC', 32: 'EPIPE', 34: 'ERANGE', 38: 'ENOSYS', 39: 'ENOTEMPTY',
  61: 'ENODATA', 95: 'EOPNOTSUPP', 104: 'ECONNRESET', 110: 'ETIMEDOUT', 111: 'ECONNREFUSED', 115: 'EINPROGRESS',
  512: 'ERESTARTSYS', 516: 'EPROBE_DEFER', 524: 'ENOTSUPP',
};

export interface RawInfo {
  args: { name: string; value: string }[];
  /** As printed, e.g. `0x0` or `-8`. */
  ret: string | null;
  /** Errno name when the return value looks like one. */
  errno: string | null;
  retaddr: string | null;
}

/** Splits `a=1, b=(x, y), c=2` on top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { out.push(s.slice(from, i)); from = i + 1; }
  }
  out.push(s.slice(from));
  return out.map((x) => x.trim()).filter(Boolean);
}

export function errnoOf(ret: string): string | null {
  let v: number;
  if (/^-\d+$/.test(ret)) v = -Number(ret);
  else if (/^0xf{8,}[0-9a-f]+$/i.test(ret)) v = Number(2n ** 64n - BigInt(ret)); // -ENOENT printed as 0xfff…fe
  else return null;
  return v > 0 && v < 4096 ? ERRNO[v] ?? null : null;
}

/** Reads `name(a=1, b=0x2) {`, `/* ret=0x0 *\/`, `} /* name ret=-8 *\/` and `/* <-caller+0x24/0x120 *\/`. */
export function parseRaw(entry: string, close: string | null, func: string): RawInfo {
  const info: RawInfo = { args: [], ret: null, errno: null, retaddr: null };
  const at = entry.indexOf(func + '(');
  if (at >= 0) {
    let depth = 0, i = at + func.length;
    for (; i < entry.length; i++) {
      if (entry[i] === '(') depth++;
      else if (entry[i] === ')' && --depth === 0) break;
    }
    const inner = entry.slice(at + func.length + 1, i);
    for (const a of splitArgs(inner)) {
      const eq = a.indexOf('=');
      info.args.push(eq > 0 ? { name: a.slice(0, eq).trim(), value: a.slice(eq + 1).trim() } : { name: '', value: a });
    }
  }
  for (const line of close ? [entry, close] : [entry]) {
    for (const m of line.matchAll(/\/\*([^*]*)\*\//g)) {
      const c = m[1];
      const r = /(?:ret=|^\s*=\s*)(-?(?:0x)?[0-9a-fA-F]+)/.exec(c);
      if (r) info.ret = r[1];
      const ra = /<-(\S+)/.exec(c);
      if (ra) info.retaddr = ra[1];
    }
  }
  if (info.ret) info.errno = errnoOf(info.ret);
  return info;
}

/** `key=value` fields of an event line (after `name:`). */
export function eventFields(line: string, name: string): { key: string; value: string }[] {
  const at = line.indexOf(name + ':');
  const body = at >= 0 ? line.slice(at + name.length + 1) : line;
  const out: { key: string; value: string }[] = [];
  for (const m of body.matchAll(/([A-Za-z_][\w.]*)=("[^"]*"|\[[^\]]*\]|\S+)/g)) out.push({ key: m[1], value: m[2].replace(/\*\/$/, '') });
  return out;
}

// ---- where the time went ----------------------------------------------------

export interface Split { self: number; children: number; off: number; irq: number }

/** Duration as self · children · off-CPU · interrupts, summing exactly to `dur`. */
export function timeSplit(dur: number, self: number, off: number, irq: number): Split {
  const z = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);
  if (!(dur > 0)) return { self: 0, children: 0, off: 0, irq: 0 };
  let s = z(self), o = z(off), q = z(irq);
  let children = dur - s - o - q;
  if (children < 0) {
    // Rounding or overlap in the analysis: scale the measured parts into the duration.
    const k = dur / (s + o + q);
    s *= k; o *= k; q *= k; children = 0;
  }
  return { self: s, children, off: o, irq: q };
}

export interface ChildAgg { func: number; calls: number; total: number; span: number; slowest: number }

/** Direct children aggregated by function, by total time. */
export function topChildren(t: Trace, id: number, limit = 8): ChildAgg[] {
  const by = new Map<number, ChildAgg>();
  for (let c = t.spans.firstChild[id]; c >= 0; c = t.spans.nextSibling[c]) {
    const f = t.spans.func[c];
    const d = t.spans.dur[c];
    let g = by.get(f);
    if (!g) by.set(f, (g = { func: f, calls: 0, total: 0, span: c, slowest: -Infinity }));
    g.calls++;
    if (!Number.isNaN(d)) g.total += d;
    if (d > g.slowest) { g.slowest = d; g.span = c; }
  }
  return [...by.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

/** Ancestors from the root down to (excluding) the span. */
export function ancestors(t: Trace, id: number): number[] {
  const out: number[] = [];
  for (let p = t.spans.parent[id]; p >= 0; p = t.spans.parent[p]) out.push(p);
  return out.reverse();
}

/** A long breadcrumb keeps its ends; the middle becomes one ellipsis entry (-1). */
export function collapseCrumbs(ids: number[], keep = 5): number[] {
  if (ids.length <= keep) return ids;
  const head = Math.ceil((keep - 1) / 2), tail = keep - 1 - head;
  return [...ids.slice(0, head), -1, ...ids.slice(ids.length - tail)];
}

// ---- among its peers --------------------------------------------------------

export function bucketOf(durUs: number): number {
  const ns = durUs * 1000;
  if (!(ns >= 1)) return 0;
  return Math.max(0, Math.min(39, Math.floor(Math.log2(ns))));
}

/** Lower bound of a bucket in µs. */
export function bucketUs(b: number): number {
  return 2 ** b / 1000;
}

export interface HistGeom {
  lo: number;
  hi: number;
  /** Bar heights 0..1 for buckets lo..hi. */
  bars: number[];
  /** x of a duration in 0..1 across [lo, hi+1). */
  x(durUs: number): number;
}

/** The used range of a function's histogram, padded by one bucket each side. */
export function histGeom(hist: Uint32Array): HistGeom {
  let lo = 39, hi = 0, max = 0;
  for (let b = 0; b < 40; b++) if (hist[b]) { lo = Math.min(lo, b); hi = Math.max(hi, b); max = Math.max(max, hist[b]); }
  if (!max) { lo = 0; hi = 0; }
  lo = Math.max(0, lo - 1); hi = Math.min(39, hi + 1);
  const bars: number[] = [];
  // sqrt so a lone slow call is still a visible bar next to a thousand typical ones
  for (let b = lo; b <= hi; b++) bars.push(max ? Math.sqrt(hist[b] / max) : 0);
  const n = hi - lo + 1;
  return {
    lo, hi, bars,
    x(d: number) {
      const ns = Math.max(1, d * 1000);
      return Math.max(0, Math.min(1, (Math.log2(ns) - lo) / n));
    },
  };
}

/** Share (0..1) of the other timed calls that were faster than `dur`. */
export function slowerThan(durs: ArrayLike<number>, dur: number, self: number): { frac: number; of: number } {
  let below = 0, of = 0;
  for (let i = 0; i < durs.length; i++) {
    const d = durs[i];
    if (i === self || Number.isNaN(d)) continue;
    of++;
    if (d < dur) below++;
  }
  return { frac: of ? below / of : 0, of };
}

/** "99.7 %" with as many decimals as the population earns. */
export function fmtPct(frac: number, of: number): string {
  const p = frac * 100;
  const dec = of >= 200 && p > 99 && p < 100 ? 1 : 0;
  return (dec ? (Math.floor(p * 10) / 10).toFixed(1) : String(Math.floor(p))) + ' %';
}

// ---- a folded group ---------------------------------------------------------

/** Tick heights 0..1 for a strip of members: log of the ratio to the median, so slow ones stand out. */
export function stripTicks(t: Trace, spans: Int32Array, med: number): Float32Array {
  const out = new Float32Array(spans.length);
  const m = med > 0 ? med : 1;
  for (let i = 0; i < spans.length; i++) {
    const d = t.spans.dur[spans[i]];
    out[i] = Number.isNaN(d) ? 0 : Math.max(0.15, Math.min(1, 0.3 + Math.log2(Math.max(d, 1e-6) / m) / 6));
  }
  return out;
}

// ---- raw lines --------------------------------------------------------------

export interface RawRow { n: number | null; text: string; mark: 'entry' | 'close' | null }
export interface RawWindow { head: RawRow[]; gap: string | null; tail: RawRow[] }

/** Head and tail limits of a raw read: never pull megabytes for one call. */
export const RAW_HEAD_BYTES = 48 * 1024;
export const RAW_TAIL_BYTES = 4 * 1024;

/**
 * Windows the raw text of a span. `whole` is set when the whole byte range
 * was read; otherwise `head` and `tail` are partial reads and the line count
 * in the middle is unknown.
 */
export function rawWindow(firstLine: number, head: string, tail: string | null, headLines = 200, tailLines = 20): RawWindow {
  const strip = (s: string) => s.replace(/\r?\n$/, '');
  if (tail === null) {
    const lines = strip(head).split(/\r?\n/);
    const mk = (i: number): RawRow => ({ n: firstLine + i, text: lines[i], mark: i === 0 ? 'entry' : i === lines.length - 1 && lines.length > 1 ? 'close' : null });
    if (lines.length <= headLines + tailLines) return { head: lines.map((_, i) => mk(i)), gap: null, tail: [] };
    const tailFrom = lines.length - tailLines;
    return {
      head: lines.slice(0, headLines).map((_, i) => mk(i)),
      gap: `… ${lines.length - headLines - tailLines} lines …`,
      tail: lines.slice(tailFrom).map((_, i) => mk(tailFrom + i)),
    };
  }
  // Partial reads: drop the torn line at each cut.
  const h = head.split(/\r?\n/).slice(0, -1).slice(0, headLines);
  const tl = strip(tail).split(/\r?\n/).slice(1);
  const tt = tl.slice(-tailLines);
  return {
    head: h.map((text, i) => ({ n: firstLine + i, text, mark: i === 0 ? 'entry' : null })),
    gap: '… many lines …',
    tail: tt.map((text, i) => ({ n: null, text, mark: i === tt.length - 1 ? 'close' : null })),
  };
}

/** Reads a span's raw text without loading more than a few dozen KB. */
export async function readRaw(text: Blob, a: number, b: number): Promise<{ head: string; tail: string | null }> {
  if (b - a <= RAW_HEAD_BYTES + RAW_TAIL_BYTES) return { head: await text.slice(a, b).text(), tail: null };
  const [head, tail] = await Promise.all([text.slice(a, a + RAW_HEAD_BYTES).text(), text.slice(b - RAW_TAIL_BYTES, b).text()]);
  return { head, tail };
}

/**
 * Where the shared prefix columns (timestamp, CPU, task, latency flags) end:
 * just after the bar before the duration column, at an index where every
 * line has a bar. 0 when there is nothing safe to cut.
 */
/** Comment, banner and separator lines: they have no columns to cut. */
export function isNoise(line: string): boolean {
  return !line.trim() || /^\s*(#|-{3,}|=+>|<=+|\S+\s*=>\s*\S)/.test(line) || /^\s*\d+\)\s+\S+-\d+\s+=>/.test(line);
}

export function sharedCut(texts: string[]): number {
  const ls = texts.filter((x) => !isNoise(x));
  if (!ls.length) return 0;
  const bars: number[] = [];
  for (let i = 0; i < ls[0].length; i++) if (ls[0][i] === '|' && ls.every((l) => l[i] === '|')) bars.push(i);
  if (!bars.length) return 0;
  const durLike = (a: number, b: number) => ls.every((l) => /^[\s\d.+!#*@$]*(us|ms|s)?\s*$/.test(l.slice(a + 1, b)));
  const last = bars[bars.length - 1];
  // Last bar closes the duration column: cut at the bar before it.
  let cut: number;
  if (bars.length >= 2 && durLike(bars[bars.length - 2], last)) cut = bars[bars.length - 2] + 1;
  else if (durLike(-1, last)) cut = 0; // bare format: the duration column is first
  else cut = last + 1;
  // Then the padding every line shares, so rows start at their first character.
  while (cut < last && ls.every((l) => l[cut] === ' ')) cut++;
  return cut;
}

/** Peer durations of a function, for percentile lines. */
export function peerDurs(t: Trace, spans: Int32Array): Float64Array {
  const out = new Float64Array(spans.length);
  for (let i = 0; i < spans.length; i++) out[i] = t.spans.dur[spans[i]];
  return out;
}

export type { FuncStat, Analysis };

// ---- naming the interrupt and the sleep -------------------------------------

/** What kind of interrupt a function name tells, or null when it says nothing. */
export function irqKind(name: string): string | null {
  if (/apic_timer_interrupt|hrtimer_interrupt/.test(name)) return 'timer interrupt';
  if (/sysvec_call_function|reschedule/.test(name)) return 'IPI';
  if (/common_interrupt|handle_irq_event/.test(name)) return 'device interrupt';
  return null;
}

export interface IrqPart { label: string; total: number; count: number; span: number }

/**
 * Interrupt-context spans inside a call (IRQ spans whose parent is not),
 * named by their most telling member and summed per name, longest first.
 */
export function irqParts(t: Trace, id: number): IrqPart[] {
  const s = t.spans, by = new Map<string, IrqPart>();
  const end = s.start[id] + (s.dur[id] || 0);
  const name = (r: number): string => {
    // Breadth-first, so the entry's own name wins over what it happens to call.
    const q = [r];
    for (let i = 0; i < q.length && i < 64; i++) {
      const k = irqKind(t.funcs.name[s.func[q[i]]] ?? '');
      if (k) return k;
      for (let c = s.firstChild[q[i]]; c >= 0; c = s.nextSibling[c]) q.push(c);
    }
    return t.funcs.name[s.func[r]] ?? '?';
  };
  const visit = (p: number) => {
    for (let c = s.firstChild[p]; c >= 0; c = s.nextSibling[c]) {
      if (s.start[c] > end) break;
      if (s.flags[c] & F.IRQ && !(s.flags[p] & F.IRQ)) {
        const label = name(c), d = Number.isNaN(s.dur[c]) ? 0 : s.dur[c];
        const g = by.get(label);
        if (!g) by.set(label, { label, total: d, count: 1, span: c });
        else { g.total += d; g.count++; if (d > (s.dur[g.span] || 0)) g.span = c; }
      } else visit(c);
    }
  };
  if (!(s.flags[id] & F.IRQ)) visit(id);
  return [...by.values()].sort((a, b) => b.total - a.total);
}

export interface OffWhere { span: number; ranTask: number | -1 }

/**
 * Where a call slept: follow the off-CPU time (inclusive per span) down to the
 * deepest span still holding most of it; and which task the switch-out handed
 * the CPU to, when the trace recorded the switch.
 */
export function offWhere(t: Trace, a: Analysis, id: number): OffWhere {
  const s = t.spans;
  let at = id;
  for (;;) {
    let best = -1;
    for (let c = s.firstChild[at]; c >= 0; c = s.nextSibling[c]) if (best < 0 || a.off[c] > a.off[best]) best = c;
    if (best < 0 || !(a.off[best] >= a.off[at] * 0.5) || !(a.off[best] > 0)) break;
    at = best;
  }
  // `schedule` says only that it slept; the caller says why (io_schedule, schedule_timeout, futex_wait…).
  while (at !== id && /^(__)?schedule$|^schedule_idle$|^preempt_schedule/.test(t.funcs.name[s.func[at]] ?? '')) at = s.parent[at];
  const task = s.task[id], sw = t.switches;
  const from = s.start[at], to = s.start[at] + (Number.isNaN(s.dur[at]) ? Infinity : s.dur[at]);
  let ranTask = -1;
  for (let i = 0; i < sw.n; i++) {
    // Not assumed sorted: a reconstructed clock orders switches per CPU only.
    if (sw.ts[i] < from || sw.ts[i] > to) continue;
    if (sw.prev[i] === task && sw.next[i] !== task) { ranTask = sw.next[i]; break; }
  }
  return { span: at, ranTask };
}

/** `idle`, or a task's comm. */
export function taskWord(t: Trace, task: number): string {
  const k = t.tasks[task];
  return !k ? '?' : k.pid === 0 ? 'idle' : k.comm;
}
