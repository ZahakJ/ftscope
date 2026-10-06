// The Story (folded call tree), group profiles and per-function detail.
//
// Interrupts carry no enclosing stub in a function_graph trace: one interrupt
// is a run of F.IRQ siblings (`irq_enter_rcu`, `__sysvec_…`, `irq_exit_rcu`, …)
// wherever it landed. They are kept out of run detection, so an interrupt
// between two reads does not split ×1000 into two groups, and are emitted as
// single spans at their time.
//
// profile(): interrupt subtrees are not merged where they landed (that would
// scatter one interrupt node under every function it ever hit). They are
// hoisted to children of the profile root, keyed by function, so the root shows
// e.g. `__sysvec_apic_timer_interrupt  calls 9  members 9` beside the real
// call path. A root child is an interrupt iff its function's category is
// `irq` or its spans carry F.IRQ — the UI can tell by `trace.funcs.cat`.

import type { Analysis, FuncDetail, ProfileNode, StoryNode } from '../api';
import type { Trace } from '../model';
import { index, isIrqRoot } from './util';

const MIN_RUN = 3;

export function storyChildren(t: Trace, a: Analysis, parent: number, track?: number): StoryNode[] {
  const s = t.spans;
  const ix = index(t);
  const kids: number[] = [];
  if (parent >= 0) for (let c = s.firstChild[parent]; c >= 0; c = s.nextSibling[c]) kids.push(c);
  else if (track !== undefined && t.tracks[track]) for (const r of t.tracks[track].roots) kids.push(r);

  const items: { t: number; node: StoryNode }[] = [];
  const seq: number[] = [];
  for (const c of kids) {
    if (isIrqRoot(t, ix, c)) items.push({ t: s.start[c], node: { kind: 'span', span: c } });
    else seq.push(c);
  }
  const F = (k: number) => s.func[seq[k]];
  const n = seq.length;
  for (let p = 0; p < n; ) {
    let r = 1;
    while (p + r < n && F(p + r) === F(p)) r++;
    // tandem repeats; a stray sibling or two between repetitions (the
    // `blkcg_maybe_throttle_current` after a read that went to disk) is
    // stepped over and shown on its own instead of breaking the fold
    let bestL = 0;
    let bestReps = 0;
    let bestEnd = p;
    let bestSkip: number[] = [];
    const unitAt = (q: number, L: number) => {
      if (q + L > n) return false;
      for (let j = 0; j < L; j++) if (F(q + j) !== F(p + j)) return false;
      return true;
    };
    if (r < MIN_RUN)
      for (let L = 2; L <= 8 && p + L * MIN_RUN <= n; L++) {
        let reps = 1;
        let q = p + L;
        const skip: number[] = [];
        for (;;) {
          if (unitAt(q, L)) [reps, q] = [reps + 1, q + L];
          // a stray sibling or two after the first repetition too: the loop's first
          // iteration often stands apart (a page fault between it and the rest)
          else if (unitAt(q + 1, L)) [skip[skip.length], reps, q] = [q, reps + 1, q + 1 + L];
          else if (unitAt(q + 2, L)) {
            skip.push(q, q + 1);
            [reps, q] = [reps + 1, q + 2 + L];
          } else break;
        }
        if (reps >= MIN_RUN && reps * L > bestReps * bestL) [bestL, bestReps, bestEnd, bestSkip] = [L, reps, q, skip];
      }
    const t0 = s.start[seq[p]];
    if (r >= MIN_RUN) {
      const spans = Int32Array.from(seq.slice(p, p + r));
      const d = Array.from(spans, (x) => s.dur[x]).filter(isFinite).sort((x, y) => x - y);
      items.push({
        t: t0,
        node: {
          kind: 'group', func: F(p), spans,
          total: d.reduce((k, v) => k + v, 0), median: d.length ? d[d.length >> 1] : NaN, max: d.length ? d[d.length - 1] : NaN,
          outliers: outlierMembers(t, a, spans),
        },
      });
      p += r;
    } else if (bestReps) {
      const skipped = new Set(bestSkip);
      const spans = Int32Array.from(seq.slice(p, bestEnd).filter((_, k) => !skipped.has(p + k)));
      for (const q of bestSkip) items.push({ t: s.start[seq[q]], node: { kind: 'span', span: seq[q] } });
      let total = 0;
      for (const x of spans) if (isFinite(s.dur[x])) total += s.dur[x];
      const unit = Array.from({ length: bestL }, (_, j) => F(p + j));
      items.push({ t: t0, node: { kind: 'loop', unit, reps: bestReps, spans, total, outliers: outlierMembers(t, a, spans) } });
      p = bestEnd;
    } else {
      items.push({ t: t0, node: { kind: 'span', span: seq[p] } });
      p++;
    }
  }

  // events that fired directly in this parent, and (at a track's top) its lost-event gaps
  const ev = t.events;
  const task = parent >= 0 ? s.task[parent] : track !== undefined ? t.tracks[track]?.task : undefined;
  for (let e = 0; e < ev.n; e++)
    if (ev.span[e] === parent && (parent >= 0 || ev.task[e] === task)) items.push({ t: ev.ts[e], node: { kind: 'event', event: e } });
  if (parent < 0 && track !== undefined && t.tracks[track]) {
    const tr = t.tracks[track];
    const cpus = new Set<number>();
    for (const r of tr.roots) cpus.add(s.cpu[r]);
    t.gaps.forEach((g, k) => {
      if (cpus.has(g.cpu) && g.ts >= tr.t0 && g.ts <= tr.t1) items.push({ t: g.ts, node: { kind: 'gap', gap: k } });
    });
  }
  // stable: folded rows keep their place relative to what happened at the same instant
  return items.map((x, k) => [x, k] as const).sort((x, y) => x[0].t - y[0].t || x[1] - y[1]).map(([x]) => x.node);
}

/** Outlier members of a folded row, and members whose subtree holds an outlier, slowest first. */
function outlierMembers(t: Trace, a: Analysis, spans: Int32Array): number[] {
  const out: number[] = [];
  const set = new Set<number>();
  for (const x of spans) set.add(x);
  for (const o of a.outliers) {
    let p = o.span;
    while (p >= 0 && !set.has(p)) p = t.spans.parent[p];
    if (p >= 0 && !out.includes(p)) out.push(p);
  }
  return out.sort((x, y) => t.spans.dur[y] - t.spans.dur[x]);
}

interface Acc {
  node: ProfileNode;
  kids: Map<number, Acc>;
  last: number;
}

export function profile(t: Trace, a: Analysis, spans: Int32Array): ProfileNode {
  const s = t.spans;
  const ix = index(t);
  const mk = (func: number): Acc => ({ node: { func, calls: 0, members: 0, total: 0, self: 0, children: [] }, kids: new Map(), last: -1 });
  const root = mk(spans.length ? s.func[spans[0]] : 0);
  const add = (acc: Acc, i: number, m: number) => {
    const nd = acc.node;
    nd.calls++;
    if (isFinite(s.dur[i])) nd.total += s.dur[i];
    if (isFinite(a.self[i])) nd.self += a.self[i];
    if (acc.last !== m) {
      acc.last = m;
      nd.members++;
    }
  };
  const child = (acc: Acc, f: number) => {
    let c = acc.kids.get(f);
    if (!c) acc.kids.set(f, (c = mk(f)));
    return c;
  };
  const st: number[] = [];
  const at: Acc[] = [];
  for (let m = 0; m < spans.length; m++) {
    add(root, spans[m], m);
    st.push(spans[m]);
    at.push(root);
    while (st.length) {
      const i = st.pop()!;
      const acc = at.pop()!;
      for (let c = s.firstChild[i]; c >= 0; c = s.nextSibling[c]) {
        const irqTop = isIrqRoot(t, ix, c);
        const ca = child(irqTop ? root : acc, s.func[c]);
        add(ca, c, m);
        st.push(c);
        at.push(ca);
      }
    }
  }
  const finish = (acc: Acc): ProfileNode => {
    acc.node.children = [...acc.kids.values()].map(finish).sort((x, y) => y.total - x.total);
    return acc.node;
  };
  return finish(root);
}

export function funcDetail(t: Trace, a: Analysis, func: number): FuncDetail {
  const s = t.spans;
  const ix = index(t);
  const spans = ix.funcSpans.slice(ix.funcStart[func], ix.funcStart[func + 1]);
  const callers = new Map<number, { func: number; calls: number; total: number }>();
  const callees = new Map<number, { func: number; calls: number; total: number }>();
  const bump = (m: typeof callers, f: number, d: number) => {
    let e = m.get(f);
    if (!e) m.set(f, (e = { func: f, calls: 0, total: 0 }));
    e.calls++;
    if (isFinite(d)) e.total += d;
  };
  for (const i of spans) {
    const p = s.parent[i];
    if (p >= 0) bump(callers, s.func[p], s.dur[i]);
    else if (s.caller[i]) bump(callers, s.caller[i], s.dur[i]);
    for (let c = s.firstChild[i]; c >= 0; c = s.nextSibling[c]) if (!isIrqRoot(t, ix, c)) bump(callees, s.func[c], s.dur[c]);
  }
  const byTotal = (m: typeof callers) => [...m.values()].sort((x, y) => y.total - x.total || y.calls - x.calls);
  const slowest = Array.from(spans).filter((i) => isFinite(s.dur[i])).sort((x, y) => s.dur[y] - s.dur[x]).slice(0, 20);
  return { stat: a.funcStats[func], callers: byTotal(callers), callees: byTotal(callees), slowest, spans };
}
