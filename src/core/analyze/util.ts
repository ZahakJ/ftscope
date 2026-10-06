// Small shared helpers for the analysis: formatting for sentences, robust
// statistics, and the per-trace indexes that several queries need.

import { F, type Trace } from '../model';

/** Duration with three significant digits, as DESIGN.md prescribes. Sentences only; the UI has its own. */
export function us(v: number): string {
  if (!isFinite(v)) return '?';
  if (v === 0) return '0 ns';
  const units: [number, string][] = [[1e-3, 'ns'], [1, 'µs'], [1e3, 'ms'], [1e6, 's']];
  for (let k = 0; k < units.length; k++) {
    const x = v / units[k][0];
    const ax = Math.abs(x);
    const txt = x.toFixed(ax >= 99.95 ? 0 : ax >= 9.995 ? 1 : 2);
    // round first so 999.6 ns reads `1.00 µs`, as src/ui/format.ts does
    if (Math.abs(Number(txt)) < 1000 || k === units.length - 1) return `${txt} ${units[k][1]}`;
  }
  return '?';
}

export function count(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export const fn = (t: Trace, f: number): string => '`' + t.funcs.name[f] + '`';

/** Median of a sorted array segment. */
export function medianSorted(a: Float64Array | number[], lo = 0, hi = a.length): number {
  const n = hi - lo;
  if (n <= 0) return NaN;
  const m = lo + (n >> 1);
  return n & 1 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export function quantileSorted(a: Float64Array, lo: number, hi: number, q: number): number {
  const n = hi - lo;
  if (n <= 0) return NaN;
  return a[lo + Math.min(n - 1, Math.floor(q * n))];
}

/** Calls whose duration can be compared with others. */
export const UNTIMED = F.UNCLOSED | F.ORPHAN | F.NO_DUR;

// Interrupt entry by name, for traces whose parser did not set F.IRQ (it must
// also catch the softirq tail run on irq exit, which nests under the entry).
const IRQ_NAME = /^(__)?sysvec_|^asm_sysvec|^(__)?common_interrupt$|^asm_common_interrupt|^do_IRQ$|^__do_softirq$|^handle_softirqs$|^irq_exit_rcu$/;

export interface Index {
  /** 1 when the span runs in interrupt context (itself or an ancestor is IRQ). */
  irqCtx: Uint8Array;
  /** Spans of each function in id (= time) order, CSR: funcStart[f]..funcStart[f+1] into funcSpans. */
  funcStart: Int32Array;
  funcSpans: Int32Array;
  /** Every span once, children before their parent (span ids are NOT a topological order: an adopter or orphan outnumbers its children). */
  post: Int32Array;
}

/** Post-order over the forest: iterative DFS from every track's roots via firstChild/nextSibling. */
function postOrder(t: Trace): Int32Array {
  const s = t.spans;
  const n = s.n;
  const out = new Int32Array(n);
  const seen = new Uint8Array(n);
  let k = 0;
  const stack = new Int32Array(n);
  const visit = (r: number) => {
    // stack holds nodes whose children are pushed after a first visit; seen=1 pushed, 2 expanded
    let sp = 0;
    stack[sp++] = r;
    seen[r] = 1;
    while (sp) {
      const i = stack[sp - 1];
      if (seen[i] === 1) {
        seen[i] = 2;
        for (let c = s.firstChild[i]; c >= 0; c = s.nextSibling[c]) if (!seen[c]) (seen[c] = 1), (stack[sp++] = c);
      } else {
        sp--;
        out[k++] = i;
      }
    }
  };
  for (const tr of t.tracks) for (const r of tr.roots) if (!seen[r]) visit(r);
  // anything unreachable from the roots (should not happen): its root first, by parent chain
  for (let i = 0; i < n; i++)
    if (!seen[i]) {
      let r = i;
      while (s.parent[r] >= 0 && !seen[s.parent[r]]) r = s.parent[r];
      visit(r);
    }
  return out;
}

const cache = new WeakMap<Trace, Index>();

export function index(t: Trace): Index {
  let ix = cache.get(t);
  if (ix) return ix;
  const s = t.spans;
  const n = s.n;
  const nf = t.funcs.name.length;
  const nameIrq = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) nameIrq[f] = IRQ_NAME.test(t.funcs.name[f]) ? 1 : 0;
  const irqCtx = new Uint8Array(n);
  const post = postOrder(t);
  // reverse post-order visits parents before children
  for (let k = n - 1; k >= 0; k--) {
    const i = post[k];
    const p = s.parent[i];
    irqCtx[i] = s.flags[i] & F.IRQ || nameIrq[s.func[i]] || (p >= 0 && irqCtx[p]) ? 1 : 0;
  }
  const funcStart = new Int32Array(nf + 1);
  for (let i = 0; i < n; i++) funcStart[s.func[i] + 1]++;
  for (let f = 0; f < nf; f++) funcStart[f + 1] += funcStart[f];
  const fill = funcStart.slice(0, nf);
  const funcSpans = new Int32Array(n);
  for (let i = 0; i < n; i++) funcSpans[fill[s.func[i]]++] = i;
  ix = { irqCtx, funcStart, funcSpans, post };
  cache.set(t, ix);
  return ix;
}

export const isIrqRoot = (t: Trace, ix: Index, i: number): boolean => {
  const p = t.spans.parent[i];
  return ix.irqCtx[i] === 1 && (p < 0 || ix.irqCtx[p] === 0);
};

export const ERRNO: Record<number, string> = {
  1: 'EPERM', 2: 'ENOENT', 3: 'ESRCH', 4: 'EINTR', 5: 'EIO', 6: 'ENXIO', 7: 'E2BIG', 9: 'EBADF', 10: 'ECHILD',
  11: 'EAGAIN', 12: 'ENOMEM', 13: 'EACCES', 14: 'EFAULT', 16: 'EBUSY', 17: 'EEXIST', 19: 'ENODEV', 20: 'ENOTDIR',
  21: 'EISDIR', 22: 'EINVAL', 24: 'EMFILE', 25: 'ENOTTY', 28: 'ENOSPC', 29: 'ESPIPE', 32: 'EPIPE', 34: 'ERANGE',
  36: 'ENAMETOOLONG', 38: 'ENOSYS', 39: 'ENOTEMPTY', 40: 'ELOOP', 61: 'ENODATA', 95: 'EOPNOTSUPP', 110: 'ETIMEDOUT',
  512: 'ERESTARTSYS', 513: 'ERESTARTNOINTR', 514: 'ERESTARTNOHAND', 515: 'ENOIOCTLCMD', 516: 'ERESTART_RESTARTBLOCK',
  524: 'ENOTSUPP',
};
