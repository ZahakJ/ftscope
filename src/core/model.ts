// The trace model: what a parsed ftrace is, as plain data.
//
// Everything here is structured-cloneable (plain objects, arrays and typed
// arrays; no classes, Maps or functions) because a Trace is built in a worker
// and posted to the page. Times are microseconds as float64, relative to the
// first timestamp in the file, unless a field says otherwise.

export type TraceFormat = 'function_graph' | 'function' | 'events' | 'unknown';

/** How `start` values were obtained. */
export type ClockKind =
  /** Real timestamps were present on the lines (funcgraph-abstime, function tracer, trace-cmd). */
  | 'absolute'
  /** No timestamps in the file: time is laid out from printed durations, per CPU. Order is true, gaps are not. */
  | 'reconstructed';

export interface TraceMeta {
  format: TraceFormat;
  /** Where the text came from, as far as the line shapes tell. */
  source: 'tracefs' | 'trace-cmd' | 'unknown';
  /** Value of the `# tracer:` header line, when present. */
  tracer: string;
  clock: ClockKind;
  /** Absolute timestamp (seconds) of time 0, NaN when the clock is reconstructed. */
  t0Abs: number;
  /** End of the last span or event, µs. */
  duration: number;
  lines: number;
  bytes: number;
  /** Column options detected from the lines themselves (not from the header). */
  options: {
    proc: boolean;
    abstime: boolean;
    cpu: boolean;
    duration: boolean;
    retval: boolean;
    args: boolean;
    latency: boolean;
    retaddr: boolean;
  };
  counts: {
    spans: number;
    events: number;
    /** Sum of `[LOST n EVENTS]`. */
    lost: number;
    gaps: number;
    /** `}` lines whose entry was never seen. */
    orphans: number;
    /** Entries still open when the file ended or a gap forced them shut. */
    unclosed: number;
    /** Non-blank, non-comment lines no rule understood. */
    unparsed: number;
  };
  /** Plain sentences worth showing the user ("3 lines were not understood"). */
  warnings: string[];
  /** The first few lines the parser could not read, for the user to see. */
  unparsedSamples: { line: number; text: string }[];
}

/** Coarse kernel subsystem of a function, guessed from its name. Index into CATEGORIES. */
export type Category = number;

export const CATEGORIES = [
  'other', // 0 — everything unrecognised; neutral
  'entry', // 1 — syscall / exception entry glue; neutral
  'fs', // 2 — VFS and filesystems
  'block', // 3 — block layer and I/O
  'mm', // 4 — memory management
  'sched', // 5 — scheduler
  'net', // 6 — networking
  'sync', // 7 — locking and RCU
  'irq', // 8 — interrupts, softirqs, timers
] as const;

export interface Task {
  pid: number;
  comm: string;
}

/** Span flag bits. */
export const F = {
  /** Printed on one line as `func();` — no children were traced. */
  LEAF: 1,
  /** Never saw its closing brace (file ended, or events were lost). `dur` is NaN. */
  UNCLOSED: 2,
  /** Made from a `}` whose entry was never seen: the call began before the trace. `start` is the trace's first
   *  timestamp and `dur` covers only the part inside the trace; `line` is the closing line. */
  ORPHAN: 4,
  /** Runs in hard-interrupt context (between the `==========>` markers), or is an interrupt entry. */
  IRQ: 8,
  /** A return value was printed (`ret` holds it). */
  HAS_RET: 16,
  /** Arguments were printed (read them from the raw line). */
  HAS_ARGS: 32,
  /** Events were lost on its CPU while it was open; its children and timings are incomplete. */
  GAP: 64,
  /** No duration exists for this call at all (`function` tracer). `dur` is NaN. */
  NO_DUR: 128,
} as const;

/**
 * One traced function call. Struct-of-arrays; index = span id. Ids ascend in file order of the line that made the
 * span, which is NOT a topological order: an orphan, or a call that adopted an interrupt run printed before it,
 * has a larger id than its children. Walk `firstChild` / `nextSibling` when parent-before-child order matters.
 */
export interface Spans {
  n: number;
  func: Uint32Array; // index into Trace.funcs.name
  start: Float64Array; // µs
  dur: Float64Array; // µs, wall time as the kernel printed it; NaN if unknown
  parent: Int32Array; // span id, -1 for a root
  firstChild: Int32Array; // span id, -1 if none
  nextSibling: Int32Array; // span id, -1 if last; roots of one track are chained too
  depth: Uint16Array; // 0 for a root; follows the reconstructed stack
  cpu: Int16Array; // CPU the entry was printed on, -1 unknown
  task: Uint32Array; // index into Trace.tasks (0 = unknown)
  flags: Uint8Array; // F.*
  ret: Float64Array; // return value as a number (lossy above 2^53), NaN if none
  /** For the `function` tracer: func id of the printed caller (`<-parent`), else 0. */
  caller: Uint32Array;
  line: Uint32Array; // 0-based line number of the entry line
  /** Byte range of the raw text: from the start of the entry line to the end of the closing line. */
  byteStart: Float64Array;
  byteEnd: Float64Array;
}

/** A trace event printed inside the stream (sched_switch, irq_handler_entry, sys_enter, …). */
export interface Events {
  n: number;
  name: Uint32Array; // index into Trace.eventNames
  ts: Float64Array; // µs
  cpu: Int16Array;
  task: Uint32Array; // task that was running, index into Trace.tasks
  span: Int32Array; // innermost open span of that task when it fired, -1 if none
  line: Uint32Array;
  byteStart: Float64Array;
  byteEnd: Float64Array;
}

/** A context switch, from a sched_switch event or a `prev => next` banner. */
export interface Switches {
  n: number;
  ts: Float64Array; // µs (in a reconstructed clock: the CPU's clock at the banner)
  cpu: Int16Array;
  prev: Uint32Array; // task index
  next: Uint32Array; // task index
  /** Event id when this came from a sched_switch event, -1 when from a banner. */
  event: Int32Array;
}

/** Events the kernel dropped: `CPU:n [LOST m EVENTS]`. */
export interface Gap {
  cpu: number;
  lost: number;
  /** Time of the first line after the gap on that CPU (µs). */
  ts: number;
  line: number;
}

/** One lane of execution: a task (thread), or a CPU's idle loop. Spans nest within a track, never across. */
export interface Track {
  task: number; // index into Trace.tasks
  /** Display name, e.g. `cat 1234` or `idle/2`. */
  name: string;
  /** Root spans in time order. */
  roots: Int32Array;
  maxDepth: number;
  /** Total number of spans in the track. */
  spans: number;
  /** First start and last end among its spans, µs. */
  t0: number;
  t1: number;
}

export interface Trace {
  meta: TraceMeta;
  funcs: {
    /** Function names; index 0 is `?` (unknown). */
    name: string[];
    cat: Uint8Array; // Category per function
  };
  /** Index 0 is the unknown task `{ pid: -1, comm: '?' }`. */
  tasks: Task[];
  /** CPU ids seen, ascending. */
  cpus: number[];
  eventNames: string[];
  spans: Spans;
  events: Events;
  switches: Switches;
  gaps: Gap[];
  /** Ordered by first appearance. */
  tracks: Track[];
  /** Per span: index into `tracks`. */
  trackOf: Uint32Array;
}
