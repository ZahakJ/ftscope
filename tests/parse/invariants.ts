// Model invariants every Trace must satisfy; other areas reuse this on hand-built traces.
import { F, type Trace } from '../../src/core/model';

const EPS = 1e-6;

/** Throws an Error naming the first violated invariant. Pass the text to also check byte ranges. */
export function checkTrace(t: Trace, text?: string): void {
  const s = t.spans;
  const n = s.n;
  const fail = (msg: string) => {
    throw new Error(msg);
  };
  const end = (i: number) => (Number.isNaN(s.dur[i]) ? s.start[i] : s.start[i] + s.dur[i]);
  const seen = new Uint8Array(n);
  t.tracks.forEach((tr, ti) => {
    let count = 0;
    const walk = (first: number, parent: number, depth: number) => {
      let prev = -1;
      for (let c = first; c >= 0; c = s.nextSibling[c]) {
        if (c >= n) fail(`span id ${c} out of range`);
        if (seen[c]++) fail(`span ${c} reached twice`);
        count++;
        if (s.parent[c] !== parent) fail(`span ${c}: parent ${s.parent[c]} != ${parent}`);
        if (s.depth[c] !== depth) fail(`span ${c}: depth ${s.depth[c]} != ${depth}`);
        if (t.trackOf[c] !== ti) fail(`span ${c}: trackOf ${t.trackOf[c]} != ${ti}`);
        if (Number.isNaN(s.start[c])) fail(`span ${c}: NaN start`);
        if (parent >= 0) {
          if (s.start[c] < s.start[parent] - EPS) fail(`span ${c} starts before its parent ${parent}`);
          const closed = !(s.flags[c] & F.UNCLOSED) && !(s.flags[parent] & F.UNCLOSED);
          if (closed && !Number.isNaN(s.dur[c]) && !Number.isNaN(s.dur[parent]) && end(c) > end(parent) + EPS)
            fail(`span ${c} ends after its parent ${parent}`);
        }
        if (prev >= 0 && s.start[c] < end(prev) - EPS) fail(`span ${c} overlaps its previous sibling ${prev}`);
        if (prev >= 0 && s.start[c] < s.start[prev]) fail(`siblings out of order at ${c}`);
        walk(s.firstChild[c], c, depth + 1);
        prev = c;
      }
    };
    if (tr.roots.length) {
      for (let i = 0; i + 1 < tr.roots.length; i++)
        if (s.nextSibling[tr.roots[i]] !== tr.roots[i + 1]) fail(`track ${ti}: roots not chained`);
      walk(tr.roots[0], -1, 0);
    }
    if (count !== tr.spans) fail(`track ${ti}: ${count} spans walked, ${tr.spans} recorded`);
  });
  for (let i = 0; i < n; i++) {
    if (!seen[i]) fail(`span ${i} is in no track`);
    if (s.func[i] >= t.funcs.name.length) fail(`span ${i}: func out of range`);
    if (s.task[i] >= t.tasks.length) fail(`span ${i}: task out of range`);
    if (!(s.byteEnd[i] > s.byteStart[i])) fail(`span ${i}: empty byte range`);
    if (i && s.line[i] < s.line[i - 1] && !(s.flags[i] & F.ORPHAN)) fail(`span ${i}: line order`);
  }
  for (let i = 0; i < t.events.n; i++) {
    if (t.events.span[i] >= n || t.events.task[i] >= t.tasks.length) fail(`event ${i}: id out of range`);
    if (Number.isNaN(t.events.ts[i])) fail(`event ${i}: NaN ts`);
  }
  if (text !== undefined) {
    const bytes = new TextEncoder().encode(text);
    const dec = new TextDecoder();
    const step = Math.max(1, Math.floor(n / 2000)); // sample big traces
    for (let i = 0; i < n; i += step) {
      const name = t.funcs.name[s.func[i]];
      if (s.func[i] === 0) continue;
      const first = dec.decode(bytes.subarray(s.byteStart[i], Math.min(s.byteEnd[i], s.byteStart[i] + 4096))).split('\n')[0];
      if (!first.includes(name)) fail(`span ${i} (${name}): raw line does not name it: ${first}`);
    }
  }
}
