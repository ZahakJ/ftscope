// The Story as a flat row list: the folded tree, opened lazily, flattened so
// the view can virtualise it. Pure logic over a query object so it can be
// tested without the analysis module.

import type { Analysis, ProfileNode, StoryNode } from '../../core/api';
import type { Trace } from '../../core/model';

export interface StoryQ {
  trace: Trace;
  analysis: Analysis;
  storyChildren(parent: number, track?: number): StoryNode[];
  profile(spans: Int32Array): ProfileNode;
}

/** A node of the tree the Story draws. Wider than StoryNode: it also has the rows the view invents. */
export type RNode =
  | { kind: 'track'; track: number; time: number }
  | { kind: 'span'; span: number; pinned?: boolean }
  | { kind: 'group'; func: number; spans: Int32Array; total: number; median: number; max: number; outliers: number[]; pos?: number }
  | { kind: 'loop'; unit: number[]; reps: number; spans: Int32Array; total: number }
  | { kind: 'typical'; func: number; spans: Int32Array }
  | { kind: 'prof'; node: ProfileNode; per: number }
  | { kind: 'all'; spans: Int32Array }
  | { kind: 'event'; event: number }
  | { kind: 'gap'; gap: number };

export interface Row {
  key: string;
  depth: number;
  node: RNode;
  /** Time this row stands for (per member for profile rows), µs. */
  time: number;
  /** Share of the parent row's time, 0..1, NaN when meaningless. */
  share: number;
  hasKids: boolean;
  open: boolean;
}

export function median(xs: number[]): number {
  const v = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length & 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Tracks in display order: traced time descending, idle tracks last. */
export function trackOrder(t: Trace): number[] {
  const idle = (i: number) => /^idle|swapper/.test(t.tracks[i].name);
  const time = (i: number) => t.tracks[i].t1 - t.tracks[i].t0;
  return t.tracks.map((_, i) => i).sort((a, b) => Number(idle(a)) - Number(idle(b)) || time(b) - time(a));
}

export function isIdleTrack(t: Trace, i: number): boolean {
  return /^idle|swapper/.test(t.tracks[i].name);
}

export function nodeTime(q: StoryQ, n: RNode): number {
  const d = q.trace.spans.dur;
  switch (n.kind) {
    case 'track': return n.time;
    case 'span': return d[n.span];
    case 'group': case 'loop': return n.total;
    case 'typical': return n.spans.length ? q.profile(n.spans).total / n.spans.length : NaN;
    case 'prof': return n.node.total / Math.max(1, n.per);
    case 'all': {
      let s = 0;
      for (const x of n.spans) if (!Number.isNaN(d[x])) s += d[x];
      return s;
    }
    default: return NaN;
  }
}

function maxDur(t: Trace, spans: Int32Array): number {
  let m = 0;
  for (const s of spans) if (t.spans.dur[s] > m) m = t.spans.dur[s];
  return m;
}

function fromStory(n: StoryNode): RNode {
  return n as RNode;
}

/** A group made from one position of a loop's unit. */
function loopPos(q: StoryQ, l: Extract<RNode, { kind: 'loop' }>, pos: number): RNode {
  const k = l.unit.length;
  const spans = new Int32Array(l.reps);
  for (let r = 0; r < l.reps; r++) spans[r] = l.spans[r * k + pos];
  const durs = Array.from(spans, (s) => q.trace.spans.dur[s]);
  const outs = Array.from(spans).filter((s) => q.analysis.outlier[s]);
  outs.sort((a, b) => q.trace.spans.dur[b] - q.trace.spans.dur[a]);
  let total = 0;
  for (const x of durs) if (!Number.isNaN(x)) total += x;
  return { kind: 'group', func: l.unit[pos], spans, total, median: median(durs), max: Math.max(...durs.filter((x) => !Number.isNaN(x)), 0), outliers: outs, pos };
}

function storyKey(n: StoryNode | RNode): string {
  switch (n.kind) {
    case 'span': return (('pinned' in n && n.pinned) ? 'o' : 's') + n.span;
    case 'group': return 'g' + (n.spans[0] ?? 0) + ('pos' in n && n.pos !== undefined ? '.' + n.pos : '');
    case 'loop': return 'l' + (n.spans[0] ?? 0);
    case 'event': return 'e' + n.event;
    case 'gap': return 'x' + n.gap;
    default: return n.kind;
  }
}

export function hasKids(q: StoryQ, n: RNode): boolean {
  switch (n.kind) {
    case 'track': return q.trace.tracks[n.track].roots.length > 0;
    case 'span': return q.trace.spans.firstChild[n.span] >= 0;
    case 'group': case 'loop': case 'all': return n.spans.length > 0;
    case 'typical': return true;
    case 'prof': return n.node.children.length > 0;
    default: return false;
  }
}

/** The children of a node with their keys (relative to the parent's). */
export function childrenOf(q: StoryQ, n: RNode): { key: string; node: RNode }[] {
  const out: { key: string; node: RNode }[] = [];
  const add = (node: RNode) => out.push({ key: storyKey(node), node });
  switch (n.kind) {
    case 'track': for (const c of q.storyChildren(-1, n.track)) add(fromStory(c)); break;
    case 'span': for (const c of q.storyChildren(n.span)) add(fromStory(c)); break;
    case 'group':
      for (const s of n.outliers) add({ kind: 'span', span: s, pinned: true });
      if (n.spans.length > 1) {
        out.push({ key: 'typ', node: { kind: 'typical', func: n.func, spans: n.spans } });
        out.push({ key: 'all', node: { kind: 'all', spans: n.spans } });
      } else if (n.spans.length === 1 && !n.outliers.includes(n.spans[0])) add({ kind: 'span', span: n.spans[0] });
      break;
    case 'loop': for (let p = 0; p < n.unit.length; p++) add(loopPos(q, n, p)); break;
    case 'typical': {
      const root = q.profile(n.spans);
      for (const c of root.children) out.push({ key: 'f' + c.func, node: { kind: 'prof', node: c, per: n.spans.length } });
      break;
    }
    case 'prof': for (const c of n.node.children) out.push({ key: 'f' + c.func, node: { kind: 'prof', node: c, per: n.per } }); break;
    case 'all': for (const s of n.spans) add({ kind: 'span', span: s }); break;
  }
  return out;
}

/** Memoises children per row key; dropped whenever the trace changes. */
export class StoryTree {
  private kids = new Map<string, { key: string; node: RNode }[]>();
  readonly q: StoryQ;
  constructor(q: StoryQ) {
    // profile() is the costly query and flatten() asks for it on every pass.
    const memo = new WeakMap<Int32Array, ProfileNode>();
    const profile = (s: Int32Array) => {
      let p = memo.get(s);
      if (!p) memo.set(s, (p = q.profile(s)));
      return p;
    };
    this.q = { ...q, profile };
  }
  children(key: string, n: RNode): { key: string; node: RNode }[] {
    let c = this.kids.get(key);
    if (!c) {
      c = childrenOf(this.q, n).map((x) => ({ key: key + '/' + x.key, node: x.node }));
      this.kids.set(key, c);
    }
    return c;
  }
  tops(): { key: string; node: RNode }[] {
    const t = this.q.trace;
    return trackOrder(t).map((i) => ({ key: 't' + i, node: { kind: 'track', track: i, time: t.tracks[i].t1 - t.tracks[i].t0 } }));
  }
  /** Depth-first over the open nodes. Iterative: open trees can be deep and wide. */
  flatten(open: Set<string>): Row[] {
    const rows: Row[] = [];
    const walk = (list: { key: string; node: RNode }[], depth: number, parentTime: number) => {
      for (const { key, node } of list) {
        const time = nodeTime(this.q, node);
        const kids = hasKids(this.q, node);
        const isOpen = kids && open.has(key);
        const share = parentTime > 0 && time >= 0 ? Math.min(1, time / parentTime) : NaN;
        rows.push({ key, depth, node, time, share, hasKids: kids, open: isOpen });
        // Members of a fold are measured against its slowest, so the odd ones read as long bars.
        if (isOpen) walk(this.children(key, node), depth + 1, node.kind === 'group' ? node.max : node.kind === 'all' ? maxDur(this.q.trace, node.spans) : time);
      }
    };
    walk(this.tops(), 0, NaN);
    return rows;
  }
  /** Keys to open, and the row key, that make a span visible. Null if the span is not in the Story. */
  revealPath(span: number): { open: string[]; target: string } | null {
    const t = this.q.trace;
    if (span < 0 || span >= t.spans.n) return null;
    const chain: number[] = [];
    for (let s = span; s >= 0; s = t.spans.parent[s]) chain.push(s);
    chain.reverse();
    const track = t.trackOf[chain[0]];
    let cur = this.tops().find((x) => x.node.kind === 'track' && x.node.track === track);
    if (!cur) return null;
    const open: string[] = [];
    for (const s of chain) {
      open.push(cur.key);
      const hit = this.findIn(cur, s, open);
      if (!hit) return null;
      cur = hit;
    }
    return { open, target: cur.key };
  }
  /** Within `parent`'s children, the row that is span `s`, opening groups/loops on the way. */
  private findIn(parent: { key: string; node: RNode }, s: number, open: string[]): { key: string; node: RNode } | null {
    for (const c of this.children(parent.key, parent.node)) {
      const n = c.node;
      if (n.kind === 'span' && n.span === s) return c;
      if ((n.kind === 'group' || n.kind === 'loop' || n.kind === 'all') && n.spans.includes(s)) {
        open.push(c.key);
        return this.findIn(c, s, open);
      }
    }
    return null;
  }
}
