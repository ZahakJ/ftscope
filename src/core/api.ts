// What analysis derives from a Trace: the shapes the interface draws.
//
// `analyze()` runs once, in the worker, right after parsing. The query
// functions run on the page, on demand, and must stay fast (a few ms).
// Implementations live in ./analyze; this file is only types.

import type { Trace } from './model';

/** Per-function statistics over every call that has a duration. */
export interface FuncStat {
  func: number;
  /** Calls, including those without a duration. */
  count: number;
  /** Calls with a known duration (the population of the numbers below). */
  timed: number;
  /** Sum of wall durations, µs. Recursive calls are counted once (outermost). */
  total: number;
  /** Sum of self time, µs. */
  self: number;
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  /** Span id of the slowest call, -1 if none timed. */
  maxSpan: number;
  /**
   * Duration histogram on a log scale shared by all functions:
   * bucket b counts calls with floor(log2(dur_ns)) === b, clamped to [0, 39].
   */
  hist: Uint32Array;
  /** How many of its calls are outliers (see Analysis.surprise). */
  outliers: number;
}

export interface Analysis {
  /** Per span, µs: its duration minus its children's, minus `off` and `irq` that happened directly in it. ≥ 0. NaN if dur unknown. */
  self: Float64Array;
  /** Per span, µs: time its task was switched out while it was open (inclusive of children). */
  off: Float64Array;
  /** Per span, µs: time spent in interrupt handlers that fired while it was open (inclusive; 0 for spans that are themselves IRQ). */
  irq: Float64Array;
  /** Indexed by func id. */
  funcStats: FuncStat[];
  /**
   * Per span: how surprising its duration is among calls of the same function,
   * as log2(dur / typical). 0 means typical or not enough peers to say; 3 means 8× slower.
   * Negative values (faster than typical) are clamped to 0.
   */
  surprise: Float32Array;
  /** Per span: 1 if it is an outlier worth flagging (slow among peers AND its excess is not explained by an outlier child... see analyze/outliers). */
  outlier: Uint8Array;
  /** The outliers, most excess time first. Root causes only: a slow parent whose slowness is one slow child is listed as the child's chain, once. */
  outliers: Outlier[];
  /** The Brief: the few things worth knowing about this trace, most important first. */
  insights: Insight[];
}

export interface Outlier {
  /** The outermost span that is slow among its peers (what the user would call "the slow call"). */
  span: number;
  /** The deepest span that still accounts for most of the excess (where to look). */
  culprit: number;
  /** µs above the typical duration of `span`'s peers. */
  excess: number;
  /** dur / typical. */
  ratio: number;
  /** One line: why, in words. */
  reason: string;
}

export type Selection =
  | { kind: 'span'; id: number }
  | { kind: 'func'; id: number }
  | { kind: 'event'; id: number }
  /** A folded run of calls in the Story view. */
  | { kind: 'group'; func: number; spans: Int32Array };

export interface Insight {
  id: string;
  kind: 'summary' | 'time' | 'outlier' | 'offcpu' | 'irq' | 'lost' | 'error' | 'quality';
  /** `warn` = the trace itself is unreliable somewhere; `note` = worth a look; `info` = orientation. */
  level: 'info' | 'note' | 'warn';
  /** A few words. */
  title: string;
  /** One or two plain sentences. May contain function names wrapped in backticks. */
  detail: string;
  /** The headline number, already formatted, e.g. `412 µs` or `×229`. */
  value?: string;
  /** What clicking it selects. */
  target?: Selection;
  /** Time range to zoom to, µs. */
  range?: [number, number];
}

// ---- "why was this one slow?" ----------------------------------------------

export interface BlameStep {
  /** Span in the slow instance. */
  span: number;
  func: number;
  /** This span's duration and what is typical for the same position among peers (0 if peers never get here). */
  dur: number;
  typical: number;
  /** dur - typical, µs. */
  excess: number;
  /** Fraction of peers (0..1) whose call tree contains this path at all. */
  presence: number;
}

export interface Contributor {
  /** Path of func ids from (excluding) the explained span down to this function. Empty = the span's own self time. */
  path: number[];
  kind: 'self' | 'new-path' | 'more-calls' | 'slower' | 'off-cpu' | 'irq';
  /** Time on this path in the slow instance vs. the peers' mean, µs. */
  time: number;
  typical: number;
  excess: number;
  /** Calls on this path in the slow instance vs. the peers' mean. */
  calls: number;
  typicalCalls: number;
  presence: number;
  /** A representative span on this path inside the slow instance, for navigation. */
  span: number;
}

export interface Explanation {
  span: number;
  /** Peers = other timed calls of the same function. */
  peers: number;
  typical: number;
  excess: number;
  ratio: number;
  /** false when there are too few peers, or this call is not slower than typical; `verdict` says which. */
  slow: boolean;
  /** Chain from the span down to where the excess concentrates. First step is the span itself. */
  blame: BlameStep[];
  /** Where the excess went, largest first; sums (roughly) to `excess`. */
  contributors: Contributor[];
  /** One or two sentences a person would say. Function names in backticks. */
  verdict: string;
}

// ---- the Story: the call tree with repetition folded -------------------------

/** A node of the aggregated call tree of a group of calls. */
export interface ProfileNode {
  func: number;
  /** Calls at this path, summed over the group's members. */
  calls: number;
  /** Members (0..group size) in which this path occurs. */
  members: number;
  total: number;
  self: number;
  children: ProfileNode[];
}

export type StoryNode =
  /** One call, shown as itself. */
  | { kind: 'span'; span: number }
  /** A run of consecutive sibling calls to one function, folded. */
  | {
      kind: 'group';
      func: number;
      spans: Int32Array;
      total: number;
      median: number;
      max: number;
      /** Members flagged as outliers, slowest first (shown pinned under the group). */
      outliers: number[];
    }
  /** A repeating sequence of sibling calls (`read, write, read, write, …`), folded. */
  | {
      kind: 'loop';
      /** The repeating unit, as func ids. */
      unit: number[];
      reps: number;
      /** All member spans in order (length = unit.length * reps). */
      spans: Int32Array;
      total: number;
      /** Members (spans in `spans`) that are or contain an outlier, slowest first. Optional for older producers. */
      outliers?: number[];
    }
  | { kind: 'event'; event: number }
  | { kind: 'gap'; gap: number };

export interface FuncDetail {
  stat: FuncStat;
  /** Who calls it / what it calls, by total time. */
  callers: { func: number; calls: number; total: number }[];
  callees: { func: number; calls: number; total: number }[];
  /** Its slowest calls, slowest first (up to 20). */
  slowest: number[];
  /** Every call, in time order. */
  spans: Int32Array;
}

/** The functions ./analyze/index.ts exports. */
export interface AnalyzeModule {
  analyze(trace: Trace): Analysis;
  explain(trace: Trace, a: Analysis, span: number): Explanation;
  /** Children of a track root list (`parent` = -1 with `track`), or of a span, folded. */
  storyChildren(trace: Trace, a: Analysis, parent: number, track?: number): StoryNode[];
  /** Aggregated call tree of a set of calls to one function. */
  profile(trace: Trace, a: Analysis, spans: Int32Array): ProfileNode;
  funcDetail(trace: Trace, a: Analysis, func: number): FuncDetail;
}
