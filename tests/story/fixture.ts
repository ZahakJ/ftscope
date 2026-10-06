// A hand-built trace and a tiny stand-in for the analysis queries, so the
// Story's logic is tested without depending on ./analyze.
import { TraceBuilder } from '../../src/core/builder';
import type { Analysis, ProfileNode, StoryNode } from '../../src/core/api';
import type { Trace } from '../../src/core/model';
import type { StoryQ } from '../../src/ui/story/rows';

/** Task A: main() { N × read() { copy(); [slow: disk() { io(); }] } ; write(); } ; task B: one idle-ish call. */
export function makeTrace(n = 20, slow: number[] = [7]): Trace {
  const b = new TraceBuilder();
  const A = b.taskId(100, 'cat', 0);
  const B = b.taskId(200, 'sh', 1);
  const f = (s: string) => b.funcId(s);
  let ts = 0, line = 0, byte = 0;
  const L = () => ({ cpu: 0, task: A, line: line++, byteStart: (byte += 10) });
  const main = b.enter({ func: f('main'), ts, ...L() });
  for (let i = 0; i < n; i++) {
    b.enter({ func: f('read'), ts: ++ts, ...L() });
    b.leaf({ func: f('copy'), ts: ++ts, dur: 1, byteEnd: byte + 5, ...L() });
    if (slow.includes(i)) {
      b.enter({ func: f('disk'), ts: ++ts, ...L() });
      b.leaf({ func: f('io'), ts: ++ts, dur: 50, byteEnd: byte + 5, ...L() });
      ts += 50;
      b.exit({ ts: ++ts, dur: NaN, ...L(), byteEnd: byte + 5 });
    }
    b.exit({ ts: ++ts, dur: NaN, ...L(), byteEnd: byte + 5 });
  }
  b.leaf({ func: f('write'), ts: ++ts, dur: 1, byteEnd: byte + 5, ...L() });
  b.exit({ ts: ++ts, dur: NaN, ...L(), byteEnd: byte + 5 });
  void main;
  b.leaf({ func: f('poll'), ts: 1, dur: 1, cpu: 1, task: B, line: line++, byteStart: (byte += 10), byteEnd: byte + 5 });
  return b.finish();
}

export function stubAnalysis(t: Trace, outliers: number[] = []): Analysis {
  const n = t.spans.n;
  const outlier = new Uint8Array(n);
  for (const s of outliers) outlier[s] = 1;
  return {
    self: new Float64Array(n), off: new Float64Array(n), irq: new Float64Array(n), funcStats: [],
    surprise: new Float32Array(n), outlier, outliers: [], insights: [],
  };
}

/** Folds runs of ≥ 3 same-function siblings into groups. */
export function stubQ(t: Trace, a: Analysis): StoryQ {
  const kids = (parent: number, track?: number): number[] => {
    if (parent < 0) return Array.from(t.tracks[track ?? 0].roots);
    const out: number[] = [];
    for (let c = t.spans.firstChild[parent]; c >= 0; c = t.spans.nextSibling[c]) out.push(c);
    return out;
  };
  return {
    trace: t,
    analysis: a,
    storyChildren(parent, track) {
      const ids = kids(parent, track);
      const out: StoryNode[] = [];
      for (let i = 0; i < ids.length; ) {
        let j = i;
        while (j < ids.length && t.spans.func[ids[j]] === t.spans.func[ids[i]]) j++;
        if (j - i >= 3) {
          const spans = Int32Array.from(ids.slice(i, j));
          const d = Array.from(spans, (s) => t.spans.dur[s]).sort((x, y) => x - y);
          out.push({ kind: 'group', func: t.spans.func[ids[i]], spans, total: d.reduce((x, y) => x + y, 0), median: d[d.length >> 1], max: d[d.length - 1],
            outliers: Array.from(spans).filter((s) => a.outlier[s]) });
        } else for (let k = i; k < j; k++) out.push({ kind: 'span', span: ids[k] });
        i = j;
      }
      return out;
    },
    profile(spans): ProfileNode {
      return { func: t.spans.func[spans[0]], calls: spans.length, members: spans.length, total: 0, self: 0, children: [] };
    },
  };
}

export function spansOf(t: Trace, name: string): number[] {
  const f = t.funcs.name.indexOf(name);
  const out: number[] = [];
  for (let i = 0; i < t.spans.n; i++) if (t.spans.func[i] === f) out.push(i);
  return out;
}
