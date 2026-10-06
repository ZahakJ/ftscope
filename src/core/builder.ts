// TraceBuilder: the one place a Trace is assembled, so its invariants live here.
//
// The parser turns text into calls on this class in file order; tests use it
// to make small traces by hand. The builder owns the per-task call stacks and
// the tree links; it does not invent time — callers pass timestamps.

import { categorize } from './categories';
import { F, type Gap, type Task, type Trace, type TraceMeta, type Track } from './model';

const INITIAL = 1 << 12;

function grow<T extends { length: number; set(a: T): void }>(a: T, make: (n: number) => T): T {
  const b = make(a.length * 2);
  b.set(a);
  return b;
}

export interface EnterArgs {
  func: number;
  ts: number;
  cpu: number;
  task: number;
  line: number;
  byteStart: number;
  flags?: number;
  /** Depth the line's indentation shows (function_graph); lets an orphan close adopt only deeper calls. */
  indent?: number;
  /** End of the entry line, so an unclosed call still owns its own line. */
  byteEnd?: number;
}

export interface LeafArgs extends EnterArgs {
  /** NaN when the tracer prints none (`function` tracer; pass F.NO_DUR too). */
  dur: number;
  byteEnd: number;
  ret?: number;
  caller?: number;
}

export interface ExitArgs {
  /** End time of the call. */
  ts: number;
  /** Printed duration, NaN if absent. */
  dur: number;
  cpu: number;
  task: number;
  line: number;
  byteStart: number;
  byteEnd: number;
  /** Function named in the comment after a closing brace, 0 if none. Used to name orphans. */
  func?: number;
  ret?: number;
  flags?: number;
  /** Depth the closing line's indentation shows; an orphan adopts the trailing calls deeper than this. */
  indent?: number;
}

export interface EventArgs {
  name: string;
  ts: number;
  cpu: number;
  task: number;
  line: number;
  byteStart: number;
  byteEnd: number;
}

export function emptyMeta(): TraceMeta {
  return {
    format: 'unknown',
    source: 'unknown',
    tracer: '',
    clock: 'absolute',
    t0Abs: NaN,
    duration: 0,
    lines: 0,
    bytes: 0,
    options: {
      proc: false,
      abstime: false,
      cpu: false,
      duration: false,
      retval: false,
      args: false,
      latency: false,
      retaddr: false,
    },
    counts: { spans: 0, events: 0, lost: 0, gaps: 0, orphans: 0, unclosed: 0, unparsed: 0 },
    warnings: [],
    unparsedSamples: [],
  };
}

export class TraceBuilder {
  meta: TraceMeta = emptyMeta();

  private funcNames: string[] = ['?'];
  private funcIds = new Map<string, number>([['?', 0]]);
  private tasks: Task[] = [{ pid: -1, comm: '?' }];
  private taskIds = new Map<string, number>();
  private eventNames: string[] = [];
  private eventIds = new Map<string, number>();
  private cpuSet = new Set<number>();

  // spans
  private n = 0;
  private func = new Uint32Array(INITIAL);
  private start = new Float64Array(INITIAL);
  private dur = new Float64Array(INITIAL);
  private parent = new Int32Array(INITIAL);
  private firstChild = new Int32Array(INITIAL);
  private lastChild = new Int32Array(INITIAL);
  private nextSibling = new Int32Array(INITIAL);
  private cpu = new Int16Array(INITIAL);
  private task = new Uint32Array(INITIAL);
  private flags = new Uint8Array(INITIAL);
  private ret = new Float64Array(INITIAL);
  private caller = new Uint32Array(INITIAL);
  private line = new Uint32Array(INITIAL);
  private byteStart = new Float64Array(INITIAL);
  private byteEnd = new Float64Array(INITIAL);
  private ind = new Uint16Array(INITIAL);
  /** Per span: a slide to apply to its whole subtree, resolved in finish() (see fit()). */
  private lazy = new Float64Array(INITIAL);
  private fitKids: number[] = [];
  private fitPos: number[] = [];
  /** Calls that adopted an interrupt run, and how many leading children that run is. */
  private adopted = new Map<number, number>();

  // events
  private en = 0;
  private eName = new Uint32Array(INITIAL);
  private eTs = new Float64Array(INITIAL);
  private eCpu = new Int16Array(INITIAL);
  private eTask = new Uint32Array(INITIAL);
  private eSpan = new Int32Array(INITIAL);
  private eLine = new Uint32Array(INITIAL);
  private eByteStart = new Float64Array(INITIAL);
  private eByteEnd = new Float64Array(INITIAL);

  // switches
  private sn = 0;
  private sTs = new Float64Array(256);
  private sCpu = new Int16Array(256);
  private sPrev = new Uint32Array(256);
  private sNext = new Uint32Array(256);
  private sEvent = new Int32Array(256);

  private gaps: Gap[] = [];
  /** Earliest timestamp passed to any call. */
  private firstTs = Infinity;

  /** Open spans per task, innermost last. */
  private stacks = new Map<number, number[]>();
  /** Root spans per task, in the order they were made. */
  private roots = new Map<number, number[]>();
  private taskOrder: number[] = [];
  /** task index -> task index it was merged into. */
  private alias = new Map<number, number>();

  // ---- interning -----------------------------------------------------------

  funcId(name: string): number {
    let id = this.funcIds.get(name);
    if (id === undefined) {
      id = this.funcNames.length;
      this.funcNames.push(name);
      this.funcIds.set(name, id);
    }
    return id;
  }

  /**
   * Task index for a pid. The idle task has pid 0 on every CPU, so it is keyed
   * by CPU as well: pass the CPU the line was printed on.
   */
  taskId(pid: number, comm: string, cpu: number): number {
    const key = pid === 0 ? `0/${cpu}` : String(pid);
    let id = this.taskIds.get(key);
    if (id === undefined) {
      id = this.tasks.length;
      this.tasks.push({ pid, comm });
      this.taskIds.set(key, id);
    } else if (comm && this.tasks[id].comm !== comm && comm !== '<...>') {
      // exec() renames a task mid-trace; keep the latest real name.
      this.tasks[id].comm = comm;
    }
    return id;
  }

  /**
   * A stand-in task for lines on a CPU whose owner is not yet known (default
   * function_graph output names tasks only at a switch banner). Merge it into
   * the real task with `mergeTask` once the first banner names it.
   */
  placeholderTask(cpu: number): number {
    const key = `?/${cpu}`;
    let id = this.taskIds.get(key);
    if (id === undefined) {
      id = this.tasks.length;
      this.tasks.push({ pid: -1, comm: `cpu${cpu}` });
      this.taskIds.set(key, id);
    }
    return id;
  }

  /** Everything recorded for `from` now belongs to `to`; `from`'s open stack continues on top of `to`'s. */
  mergeTask(from: number, to: number): void {
    from = this.resolve(from);
    to = this.resolve(to);
    if (from === to) return;
    this.alias.set(from, to);
    // the placeholder's names are the first the task is known by; keep the real one
    if (this.tasks[from].pid < 0) this.tasks[from].comm = this.tasks[to].comm;
    const fs = this.stacks.get(from);
    if (fs && fs.length) {
      const ts = this.stackOf(to);
      if (ts.length) {
        const top = ts[ts.length - 1];
        this.unlinkRoot(from, fs[0]);
        this.link(top, fs[0]);
      }
      for (const s of fs) ts.push(s);
    }
    this.stacks.delete(from);
    const fr = this.roots.get(from);
    if (fr) {
      const tr = this.rootsOf(to);
      for (const r of fr) tr.push(r);
      this.roots.delete(from);
    }
    // forget the placeholder key so a later unknown stretch on that CPU gets a fresh stand-in
    for (const [k, v] of this.taskIds) if (v === from && k.startsWith('?/')) this.taskIds.delete(k);
  }

  /**
   * Move every span and event of a task later by `delta` µs. A reconstructed
   * clock lays out a CPU's unknown owner before learning who it is; once the
   * owner turns out to have run elsewhere first, its stretch here came after.
   */
  shiftTask(task: number, delta: number): void {
    if (!(delta > 0)) return;
    task = this.resolve(task);
    for (let i = 0; i < this.n; i++) if (this.resolve(this.task[i]) === task) this.start[i] += delta;
    for (let i = 0; i < this.en; i++) if (this.resolve(this.eTask[i]) === task) this.eTs[i] += delta;
  }

  /** Earliest start among a task's spans, Infinity if none. */
  firstStartOf(task: number): number {
    task = this.resolve(task);
    let m = Infinity;
    for (let i = 0; i < this.n; i++) if (this.start[i] < m && this.resolve(this.task[i]) === task) m = this.start[i];
    return m;
  }

  private resolve(t: number): number {
    let r = this.alias.get(t);
    while (r !== undefined) {
      t = r;
      r = this.alias.get(t);
    }
    return t;
  }

  // ---- stream --------------------------------------------------------------

  /** Number of spans currently open on a task. */
  stackDepth(task: number): number {
    return this.stacks.get(this.resolve(task))?.length ?? 0;
  }

  /** Innermost open span of a task, -1 if none. */
  top(task: number): number {
    const s = this.stacks.get(this.resolve(task));
    return s && s.length ? s[s.length - 1] : -1;
  }

  /** Function id of the innermost open span, 0 if none. */
  topFunc(task: number): number {
    const t = this.top(task);
    return t < 0 ? 0 : this.func[t];
  }

  /** Or flags into every open span of a task (e.g. F.GAP after lost events). */
  flagOpen(task: number, flags: number): void {
    const s = this.stacks.get(this.resolve(task));
    if (s) for (const id of s) this.flags[id] |= flags;
  }

  /** Force-close open spans of a task until `depth` remain; they become UNCLOSED with unknown duration. */
  truncate(task: number, depth: number): void {
    const s = this.stacks.get(this.resolve(task));
    if (!s) return;
    while (s.length > depth) {
      const id = s.pop()!;
      this.flags[id] |= F.UNCLOSED;
      this.dur[id] = NaN;
    }
  }

  enter(a: EnterArgs): number {
    const task = this.resolve(a.task);
    const id = this.alloc(a.func, a.ts, NaN, a.cpu, task, a.line, a.byteStart, a.byteEnd ?? a.byteStart, a.flags ?? 0);
    const stack = this.stackOf(task);
    this.ind[id] = a.indent ?? stack.length;
    if (stack.length) this.link(stack[stack.length - 1], id);
    else this.rootsOf(task).push(id);
    stack.push(id);
    return id;
  }

  leaf(a: LeafArgs): number {
    const task = this.resolve(a.task);
    const id = this.alloc(a.func, a.ts, a.dur, a.cpu, task, a.line, a.byteStart, a.byteEnd, (a.flags ?? 0) | F.LEAF);
    if (a.ret !== undefined && !Number.isNaN(a.ret)) {
      this.ret[id] = a.ret;
      this.flags[id] |= F.HAS_RET;
    }
    if (a.caller) this.caller[id] = a.caller;
    const stack = this.stackOf(task);
    this.ind[id] = a.indent ?? stack.length;
    if (stack.length) this.link(stack[stack.length - 1], id);
    else this.rootsOf(task).push(id);
    return id;
  }

  /**
   * Close the innermost open span of a task. With nothing open, the closing
   * brace belongs to a call that began before the trace did: an ORPHAN span is
   * made that adopts everything the task has done so far.
   */
  exit(a: ExitArgs): number {
    const task = this.resolve(a.task);
    const stack = this.stackOf(task);
    let id: number;
    if (stack.length) {
      id = stack.pop()!;
      this.dur[id] = Number.isNaN(a.dur) ? Math.max(0, a.ts - this.start[id]) : a.dur;
      this.byteEnd[id] = a.byteEnd;
      if (a.func && this.func[id] === 0) this.func[id] = a.func;
    } else {
      id = this.orphan(task, a);
    }
    if (a.flags) this.flags[id] |= a.flags;
    if (a.ret !== undefined && !Number.isNaN(a.ret)) {
      this.ret[id] = a.ret;
      this.flags[id] |= F.HAS_RET;
    }
    return id;
  }

  /**
   * A `}` whose entry was never seen. It adopts the calls just before it that
   * sit deeper than its own indentation (all of them when no indentation is
   * known) and starts no earlier than the call before those, so siblings never
   * overlap. Its start is `ts - dur` when the duration is printed (that is
   * what tracing_thresh output gives), else the start of what it adopted, else
   * the trace's first timestamp. Its byte range is its own closing line.
   */
  private orphan(task: number, a: ExitArgs): number {
    const d = a.indent ?? -1;
    const stack = this.stackOf(task);
    const top = stack.length ? stack[stack.length - 1] : -1;
    const adopted: number[] = [];
    let low: number;
    if (top < 0) {
      const roots = this.rootsOf(task);
      let k = roots.length;
      while (k > 0 && this.ind[roots[k - 1]] > d) k--;
      for (let i = k; i < roots.length; i++) adopted.push(roots[i]);
      roots.length = k;
      low = k > 0 ? this.endOf(roots[k - 1]) : -Infinity;
    } else {
      let lastKeep = -1;
      for (let c = this.firstChild[top]; c >= 0; c = this.nextSibling[c]) if (this.ind[c] <= d) lastKeep = c;
      let first = lastKeep < 0 ? this.firstChild[top] : this.nextSibling[lastKeep];
      for (; first >= 0; first = this.nextSibling[first]) adopted.push(first);
      if (lastKeep < 0) this.firstChild[top] = this.lastChild[top] = -1;
      else {
        this.nextSibling[lastKeep] = -1;
        this.lastChild[top] = lastKeep;
      }
      low = lastKeep < 0 ? this.start[top] : this.endOf(lastKeep);
    }
    let start = Number.isNaN(a.dur) ? (top < 0 ? Math.min(this.firstTs, a.ts) : this.start[top]) : a.ts - a.dur;
    if (adopted.length && this.start[adopted[0]] < start) start = this.start[adopted[0]];
    if (start < low) start = low;
    let end = a.ts;
    for (const c of adopted) {
      this.nextSibling[c] = -1;
      const e = this.endOf(c);
      if (e > end) end = e;
    }
    if (end < start) end = start;
    const id = this.alloc(a.func ?? 0, start, end - start, a.cpu, task, a.line, a.byteStart, a.byteEnd, F.ORPHAN);
    this.ind[id] = Math.max(0, d);
    for (const c of adopted) this.link(id, c);
    if (top >= 0) this.link(top, id);
    else this.rootsOf(task).push(id);
    this.meta.counts.orphans++;
    return id;
  }

  /** End of a span (its start when the duration is unknown). */
  endOf(id: number): number {
    const d = this.dur[id];
    return d === d ? this.start[id] + d : this.start[id];
  }

  /**
   * Move the calls printed just before `id` (same parent, deeper indentation)
   * under it, as its first children. On this kernel an interrupt that lands in
   * the tracer's entry hook prints one level too deep, before the line of the
   * function being entered: that function is the run's parent. `id` starts no
   * later than the run, and stops being a leaf. Returns the run's end, or NaN.
   */
  adoptDeeperBefore(id: number): number {
    const p = this.parent[id];
    const sibs: number[] = [];
    if (p >= 0) for (let c = this.firstChild[p]; c >= 0; c = this.nextSibling[c]) sibs.push(c);
    else sibs.push(...this.rootsOf(this.resolve(this.task[id])));
    let k = sibs.indexOf(id);
    if (k < 0) return NaN;
    const me = k;
    while (k > 0 && this.ind[sibs[k - 1]] > this.ind[id]) k--;
    if (k === me) return NaN;
    const run = sibs.slice(k, me);
    if (p >= 0) {
      if (k === 0) this.firstChild[p] = id;
      else this.nextSibling[sibs[k - 1]] = id;
    } else {
      const roots = this.rootsOf(this.resolve(this.task[id]));
      roots.splice(k, me - k);
    }
    const oldFirst = this.firstChild[id];
    const oldLast = this.lastChild[id];
    this.firstChild[id] = -1;
    this.lastChild[id] = -1;
    let end = -Infinity;
    for (const c of run) {
      this.nextSibling[c] = -1;
      this.link(id, c);
      end = Math.max(end, this.endOf(c));
    }
    if (oldFirst >= 0) {
      this.nextSibling[run[run.length - 1]] = oldFirst;
      this.lastChild[id] = oldLast;
    }
    if (this.start[run[0]] < this.start[id]) this.start[id] = this.start[run[0]];
    this.flags[id] &= ~F.LEAF;
    this.adopted.set(id, run.length);
    return end;
  }

  /** Indentation depth recorded for a span. */
  indentOf(id: number): number {
    return this.ind[id];
  }

  /** Or flags into one span. */
  addFlags(id: number, flags: number): void {
    this.flags[id] |= flags;
  }

  flagsOf(id: number): number {
    return this.flags[id];
  }

  /** Change a closed span's duration (the parser stretches a call so it covers its laid-out children). */
  /** Summed durations of a call's children, if it adopted an interrupt run; else 0. */
  adoptedLoad(id: number): number {
    if (!this.adopted.has(id)) return 0;
    let sum = 0;
    for (let c = this.firstChild[id]; c >= 0; c = this.nextSibling[c]) {
      const d = this.dur[c];
      if (d === d) sum += d;
    }
    return sum;
  }

  /**
   * Undo adoptDeeperBefore: the interrupt run turned out not to be inside this
   * call (its printed duration is too short to hold it), so the interrupt fired
   * just before the call's clock started. The run goes back to being siblings
   * right before the call, which then starts where the run ends.
   */
  releaseRun(id: number): boolean {
    const n = this.adopted.get(id);
    if (!n) return false;
    this.adopted.delete(id);
    const run: number[] = [];
    let c = this.firstChild[id];
    for (let i = 0; i < n && c >= 0; i++) {
      run.push(c);
      c = this.nextSibling[c];
    }
    if (!run.length) return false;
    this.firstChild[id] = c;
    if (c < 0) this.lastChild[id] = -1;
    const p = this.parent[id];
    const last = run[run.length - 1];
    if (p >= 0) {
      let prev = -1;
      for (let k = this.firstChild[p]; k >= 0 && k !== id; k = this.nextSibling[k]) prev = k;
      if (prev < 0) this.firstChild[p] = run[0];
      else this.nextSibling[prev] = run[0];
      for (const r of run) {
        this.parent[r] = p;
        this.ind[r] = this.ind[id];
      }
      this.nextSibling[last] = id;
    } else {
      const roots = this.rootsOf(this.resolve(this.task[id]));
      const at = roots.indexOf(id);
      roots.splice(at < 0 ? roots.length : at, 0, ...run);
      for (const r of run) {
        this.parent[r] = -1;
        this.nextSibling[r] = -1;
        this.ind[r] = this.ind[id];
      }
    }
    const runEnd = this.endOf(last);
    if (this.start[id] < runEnd) this.start[id] = runEnd;
    return true;
  }

  /**
   * Called when a call closes with printed duration D: if its children's
   * durations add up to more than D, some of them were never inside it.
   *
   * That happens when an interrupt lands in the tracer's own hooks. Landing in
   * the entry hook before the call's clock starts gives a run of interrupt
   * calls that looks like the call's first children; landing in the exit hook
   * after the clock stopped gives a run that looks like its last children. In
   * both cases the call's duration is honest and excludes the interrupt, so the
   * run is moved out: before the call, or after it. Returns the end time of a
   * run moved after the call, else NaN.
   */
  shed(id: number, D: number): number {
    const lead = this.adopted.get(id) ?? 0;
    let load = 0;
    let leadLoad = 0;
    let tailLoad = 0;
    let tailFirst = -1;
    let tailPrev = -1;
    let prev = -1;
    let i = 0;
    for (let c = this.firstChild[id]; c >= 0; prev = c, c = this.nextSibling[c], i++) {
      const d = this.dur[c];
      const w = d === d ? d : 0;
      load += w;
      if (i < lead) leadLoad += w;
      if (i >= lead && this.flags[c] & F.IRQ) {
        if (tailFirst < 0) {
          tailFirst = c;
          tailPrev = prev;
          tailLoad = 0;
        }
        tailLoad += w;
      } else {
        tailFirst = -1;
      }
    }
    if (load <= D + 1e-6) return NaN;
    let hoist = tailFirst >= 0;
    let release = lead > 0;
    if (hoist && load - tailLoad <= D + 1e-6) release = false;
    else if (release && load - leadLoad <= D + 1e-6) hoist = false;
    let end = NaN;
    if (hoist) {
      const run: number[] = [];
      for (let c = tailFirst; c >= 0; c = this.nextSibling[c]) run.push(c);
      if (tailPrev < 0) this.firstChild[id] = -1;
      else this.nextSibling[tailPrev] = -1;
      this.lastChild[id] = tailPrev;
      const p = this.parent[id];
      const roots = p < 0 ? this.rootsOf(this.resolve(this.task[id])) : null;
      end = this.start[id] + D;
      for (const r of run) {
        this.parent[r] = -1;
        this.nextSibling[r] = -1;
        this.ind[r] = this.ind[id]; // now at the call's own level: not a deeper run any more
        if (roots) roots.push(r);
        else this.link(p, r);
        const at = Math.max(this.start[r] + this.lazy[r], end);
        this.lazy[r] = at - this.start[r];
        const d = this.dur[r];
        end = d === d ? at + d : at;
      }
    }
    if (release) this.releaseRun(id);
    return end;
  }

  /**
   * Make a closed call's children lie inside its printed duration.
   *
   * A printed duration is exact; where a child sits inside its parent is not
   * (timestamps are whole microseconds), so children laid out one after the
   * other can end up poking out of the parent by a fraction of a microsecond.
   * The parent's duration is the truth: children are slid, keeping their order
   * and their own durations, until they fit. A slide moves a child's whole
   * subtree, so it is recorded once on the child and applied in finish().
   * Returns true in the one case where they cannot fit (their durations add up
   * to more than the parent's), when the parent is stretched instead.
   */
  fit(id: number): boolean {
    this.adopted.delete(id);
    const D = this.dur[id];
    if (D !== D) return false;
    const s = this.start[id];
    const kids = this.fitKids;
    const pos = this.fitPos;
    let k = 0;
    let prev = s;
    for (let c = this.firstChild[id]; c >= 0; c = this.nextSibling[c]) {
      let at = this.start[c] + this.lazy[c];
      if (at < prev) at = prev;
      kids[k] = c;
      pos[k++] = at;
      const d = this.dur[c];
      prev = d === d ? at + d : at;
    }
    if (k === 0) return false;
    let stretched = false;
    if (prev > s + D + 1e-9) {
      let limit = s + D;
      for (let i = k - 1; i >= 0; i--) {
        const d = this.dur[kids[i]];
        const w = d === d ? d : 0;
        if (pos[i] + w > limit) pos[i] = limit - w;
        limit = pos[i];
      }
      if (pos[0] < s - 1e-9) {
        prev = s;
        for (let i = 0; i < k; i++) {
          pos[i] = prev;
          const d = this.dur[kids[i]];
          if (d === d) prev += d;
        }
        this.dur[id] = prev - s;
        stretched = true;
      }
    }
    for (let i = 0; i < k; i++) {
      const c = kids[i];
      this.lazy[c] = pos[i] - this.start[c];
    }
    return stretched;
  }

  setDur(id: number, dur: number): void {
    this.dur[id] = dur;
  }

  event(a: EventArgs): number {
    if (this.en === this.eName.length) this.growEvents();
    let name = this.eventIds.get(a.name);
    if (name === undefined) {
      name = this.eventNames.length;
      this.eventNames.push(a.name);
      this.eventIds.set(a.name, name);
    }
    if (a.ts < this.firstTs) this.firstTs = a.ts;
    const id = this.en++;
    const task = this.resolve(a.task);
    this.eName[id] = name;
    this.eTs[id] = a.ts;
    this.eCpu[id] = a.cpu;
    this.eTask[id] = task;
    this.eSpan[id] = this.top(task);
    this.eLine[id] = a.line;
    this.eByteStart[id] = a.byteStart;
    this.eByteEnd[id] = a.byteEnd;
    if (a.cpu >= 0) this.cpuSet.add(a.cpu);
    return id;
  }

  /** Record a context switch. `event` is the sched_switch event id, or -1 for a banner. */
  switch(ts: number, cpu: number, prev: number, next: number, event = -1): void {
    if (this.sn === this.sTs.length) {
      this.sTs = grow(this.sTs, (n) => new Float64Array(n));
      this.sCpu = grow(this.sCpu, (n) => new Int16Array(n));
      this.sPrev = grow(this.sPrev, (n) => new Uint32Array(n));
      this.sNext = grow(this.sNext, (n) => new Uint32Array(n));
      this.sEvent = grow(this.sEvent, (n) => new Int32Array(n));
    }
    const i = this.sn++;
    this.sTs[i] = ts;
    this.sCpu[i] = cpu;
    this.sPrev[i] = this.resolve(prev);
    this.sNext[i] = this.resolve(next);
    this.sEvent[i] = event;
  }

  gap(g: Gap): void {
    this.gaps.push(g);
    this.meta.counts.lost += g.lost;
  }

  /** Number of spans made so far. */
  get spanCount(): number {
    return this.n;
  }

  /** Start time of a span made earlier (the parser needs it to lay out a reconstructed clock). */
  startOf(id: number): number {
    return this.start[id];
  }

  // ---- finish --------------------------------------------------------------

  finish(): Trace {
    const n = this.n;
    // Whatever is still open never closed.
    for (const stack of this.stacks.values()) {
      for (const id of stack) {
        this.flags[id] |= F.UNCLOSED;
        this.dur[id] = NaN;
      }
    }

    const depth = new Uint16Array(n);
    const trackOf = new Uint32Array(n);
    /** Per span: the summed slide of it and its ancestors (see fit()). */
    const slide = new Float64Array(n);
    const tracks: Track[] = [];
    let end = 0;
    let unclosed = 0;

    for (const task of this.taskOrder) {
      const roots = this.roots.get(task);
      if (!roots || !roots.length) continue;
      roots.sort((a, b) => this.start[a] + this.lazy[a] - (this.start[b] + this.lazy[b]) || a - b);
      // chain roots as siblings so a track can be walked like any child list
      for (let i = 0; i < roots.length; i++) this.nextSibling[roots[i]] = i + 1 < roots.length ? roots[i + 1] : -1;
      const ti = tracks.length;
      let maxDepth = 0;
      let count = 0;
      let t0 = Infinity;
      let t1 = -Infinity;
      // iterative DFS
      const todo: number[] = [];
      for (let i = roots.length - 1; i >= 0; i--) todo.push(roots[i]);
      while (todo.length) {
        const id = todo.pop()!;
        const p = this.parent[id];
        const d = p < 0 ? 0 : depth[p] + 1;
        depth[id] = d;
        trackOf[id] = ti;
        if (d > maxDepth) maxDepth = d;
        count++;
        const sl = (p < 0 ? 0 : slide[p]) + this.lazy[id];
        slide[id] = sl;
        const s = (this.start[id] += sl);
        if (s < t0) t0 = s;
        const e = Number.isNaN(this.dur[id]) ? s : s + this.dur[id];
        if (e > t1) t1 = e;
        if (this.flags[id] & F.UNCLOSED) unclosed++;
        for (let c = this.firstChild[id]; c >= 0; c = this.nextSibling[c]) todo.push(c);
      }
      if (t1 > end) end = t1;
      const t = this.tasks[task];
      tracks.push({
        task,
        name: t.pid === 0 ? `idle/${this.cpu[roots[0]]}` : t.pid < 0 ? t.comm : `${t.comm} ${t.pid}`,
        roots: Int32Array.from(roots),
        maxDepth,
        spans: count,
        t0,
        t1,
      });
    }
    for (let i = 0; i < this.en; i++) {
      const sp = this.eSpan[i];
      if (sp >= 0) this.eTs[i] += slide[sp];
      if (this.eTs[i] > end) end = this.eTs[i];
    }

    const funcCat = new Uint8Array(this.funcNames.length);
    for (let i = 0; i < funcCat.length; i++) funcCat[i] = categorize(this.funcNames[i]);

    const m = this.meta;
    m.duration = end;
    m.counts.spans = n;
    m.counts.events = this.en;
    m.counts.gaps = this.gaps.length;
    m.counts.unclosed = unclosed;

    return {
      meta: m,
      funcs: { name: this.funcNames, cat: funcCat },
      tasks: this.tasks,
      cpus: [...this.cpuSet].sort((a, b) => a - b),
      eventNames: this.eventNames,
      spans: {
        n,
        func: this.func.slice(0, n),
        start: this.start.slice(0, n),
        dur: this.dur.slice(0, n),
        parent: this.parent.slice(0, n),
        firstChild: this.firstChild.slice(0, n),
        nextSibling: this.nextSibling.slice(0, n),
        depth,
        cpu: this.cpu.slice(0, n),
        task: this.task.slice(0, n).map((t) => this.resolve(t)),
        flags: this.flags.slice(0, n),
        ret: this.ret.slice(0, n),
        caller: this.caller.slice(0, n),
        line: this.line.slice(0, n),
        byteStart: this.byteStart.slice(0, n),
        byteEnd: this.byteEnd.slice(0, n),
      },
      events: {
        n: this.en,
        name: this.eName.slice(0, this.en),
        ts: this.eTs.slice(0, this.en),
        cpu: this.eCpu.slice(0, this.en),
        task: this.eTask.slice(0, this.en).map((t) => this.resolve(t)),
        span: this.eSpan.slice(0, this.en),
        line: this.eLine.slice(0, this.en),
        byteStart: this.eByteStart.slice(0, this.en),
        byteEnd: this.eByteEnd.slice(0, this.en),
      },
      switches: {
        n: this.sn,
        ts: this.sTs.slice(0, this.sn),
        cpu: this.sCpu.slice(0, this.sn),
        prev: this.sPrev.slice(0, this.sn).map((t) => this.resolve(t)),
        next: this.sNext.slice(0, this.sn).map((t) => this.resolve(t)),
        event: this.sEvent.slice(0, this.sn),
      },
      gaps: this.gaps,
      tracks,
      trackOf,
    };
  }

  // ---- internals -----------------------------------------------------------

  private stackOf(task: number): number[] {
    let s = this.stacks.get(task);
    if (!s) {
      s = [];
      this.stacks.set(task, s);
    }
    return s;
  }

  private rootsOf(task: number): number[] {
    let r = this.roots.get(task);
    if (!r) {
      r = [];
      this.roots.set(task, r);
      this.taskOrder.push(task);
    }
    return r;
  }

  private unlinkRoot(task: number, id: number): void {
    const r = this.roots.get(task);
    if (!r) return;
    const i = r.indexOf(id);
    if (i >= 0) r.splice(i, 1);
  }

  private link(parent: number, child: number): void {
    this.parent[child] = parent;
    const last = this.lastChild[parent];
    if (last < 0) this.firstChild[parent] = child;
    else this.nextSibling[last] = child;
    this.lastChild[parent] = child;
  }

  private alloc(
    func: number,
    start: number,
    dur: number,
    cpu: number,
    task: number,
    line: number,
    byteStart: number,
    byteEnd: number,
    flags: number,
  ): number {
    if (this.n === this.func.length) this.growSpans();
    if (start < this.firstTs) this.firstTs = start;
    const id = this.n++;
    this.func[id] = func;
    this.start[id] = start;
    this.dur[id] = dur;
    this.parent[id] = -1;
    this.firstChild[id] = -1;
    this.lastChild[id] = -1;
    this.nextSibling[id] = -1;
    this.cpu[id] = cpu;
    this.task[id] = task;
    this.flags[id] = flags;
    this.ret[id] = NaN;
    this.line[id] = line;
    this.byteStart[id] = byteStart;
    this.byteEnd[id] = byteEnd;
    this.lazy[id] = 0;
    if (cpu >= 0) this.cpuSet.add(cpu);
    return id;
  }

  private growSpans(): void {
    this.func = grow(this.func, (n) => new Uint32Array(n));
    this.start = grow(this.start, (n) => new Float64Array(n));
    this.dur = grow(this.dur, (n) => new Float64Array(n));
    this.parent = grow(this.parent, (n) => new Int32Array(n));
    this.firstChild = grow(this.firstChild, (n) => new Int32Array(n));
    this.lastChild = grow(this.lastChild, (n) => new Int32Array(n));
    this.nextSibling = grow(this.nextSibling, (n) => new Int32Array(n));
    this.cpu = grow(this.cpu, (n) => new Int16Array(n));
    this.task = grow(this.task, (n) => new Uint32Array(n));
    this.flags = grow(this.flags, (n) => new Uint8Array(n));
    this.ret = grow(this.ret, (n) => new Float64Array(n));
    this.caller = grow(this.caller, (n) => new Uint32Array(n));
    this.line = grow(this.line, (n) => new Uint32Array(n));
    this.byteStart = grow(this.byteStart, (n) => new Float64Array(n));
    this.byteEnd = grow(this.byteEnd, (n) => new Float64Array(n));
    this.ind = grow(this.ind, (n) => new Uint16Array(n));
    this.lazy = grow(this.lazy, (n) => new Float64Array(n));
  }

  private growEvents(): void {
    this.eName = grow(this.eName, (n) => new Uint32Array(n));
    this.eTs = grow(this.eTs, (n) => new Float64Array(n));
    this.eCpu = grow(this.eCpu, (n) => new Int16Array(n));
    this.eTask = grow(this.eTask, (n) => new Uint32Array(n));
    this.eSpan = grow(this.eSpan, (n) => new Int32Array(n));
    this.eLine = grow(this.eLine, (n) => new Uint32Array(n));
    this.eByteStart = grow(this.eByteStart, (n) => new Float64Array(n));
    this.eByteEnd = grow(this.eByteEnd, (n) => new Float64Array(n));
  }
}
