// "Why was this one slow?": compare a call's subtree with the aggregated
// subtrees of the other calls of the same function, path by path.
//
// A path is the chain of function names below the call. Each path carries the
// self time and the directly-attributed off-CPU time of the spans on it, so the
// per-path excesses add up to the call's excess instead of counting every
// level of a deep chain again. Interrupt subtrees are cut out and reported as
// one `irq` contributor: they land anywhere and would otherwise look like new paths.

import type { Analysis, BlameStep, Contributor, Explanation } from '../api';
import type { Trace } from '../model';
import { UNTIMED, count, fn, index, isIrqRoot, us } from './util';

export type Core = Pick<Analysis, 'self' | 'off' | 'irq' | 'funcStats' | 'outlier'>;

const MAX_PEERS = 2000;
export const MIN_PEERS = 8;

/** Smallest excess worth calling slow in this trace: sub-microsecond jitter never is. */
export function minExcess(t: Trace): number {
  return Math.max(10, Math.min(50, t.meta.duration * 1e-5));
}

interface Agg {
  self: number; // Σ self over spans on the path
  off: number; // Σ off-CPU time that fell directly in spans on the path
  wall: number; // Σ (dur − irq) of spans on the path
  calls: number;
  members: number;
  last: number; // member index that last touched it, to count members once
  span: number; // a representative span (slow instance only)
}

function walk(t: Trace, a: Core, root: number, m: number, map: Map<string, Agg>, irqOut: number[] | null): void {
  const s = t.spans;
  const ix = index(t);
  const stack: number[] = [root];
  const keys: string[] = [''];
  while (stack.length) {
    const i = stack.pop()!;
    const key = keys.pop()!;
    let offKids = 0;
    for (let c = s.firstChild[i]; c >= 0; c = s.nextSibling[c]) {
      if (isIrqRoot(t, ix, c)) {
        irqOut?.push(c);
        continue;
      }
      offKids += a.off[c];
      stack.push(c);
      keys.push(key + '/' + s.func[c]);
    }
    let g = map.get(key);
    if (!g) map.set(key, (g = { self: 0, off: 0, wall: 0, calls: 0, members: 0, last: -1, span: i }));
    const d = s.dur[i];
    g.self += a.self[i] || 0;
    g.off += Math.max(0, a.off[i] - offKids);
    g.wall += isFinite(d) ? d - a.irq[i] : 0;
    g.calls++;
    if (g.last !== m) {
      g.last = m;
      g.members++;
    }
  }
}

const pathOf = (key: string): number[] => (key ? key.slice(1).split('/').map(Number) : []);

/** The timed calls of `f` other than `span`, evenly sampled down to MAX_PEERS. */
export function peersOf(t: Trace, f: number, span: number): number[] {
  const ix = index(t);
  const out: number[] = [];
  for (let k = ix.funcStart[f]; k < ix.funcStart[f + 1]; k++) {
    const p = ix.funcSpans[k];
    if (p !== span && !(t.spans.flags[p] & UNTIMED) && isFinite(t.spans.dur[p])) out.push(p);
  }
  if (out.length <= MAX_PEERS) return out;
  const step = out.length / MAX_PEERS;
  return Array.from({ length: MAX_PEERS }, (_, k) => out[Math.floor(k * step)]);
}

export function explainCore(t: Trace, a: Core, span: number): Explanation {
  const s = t.spans;
  const f = s.func[span];
  const dur = s.dur[span];
  const all = peersOf(t, f, span);
  const nPeers = all.length;
  const typical = a.funcStats[f]?.p50 ?? NaN;
  const excess = dur - typical;
  const ratio = dur / typical;
  const base: Explanation = { span, peers: nPeers, typical, excess, ratio, slow: false, blame: [], contributors: [], verdict: '' };
  if (!isFinite(dur)) return { ...base, verdict: `${fn(t, f)} has no duration here, so it cannot be compared.` };
  if (nPeers < MIN_PEERS)
    return { ...base, verdict: `Only ${nPeers} other timed call${nPeers === 1 ? '' : 's'} of ${fn(t, f)}: too few to say what is typical.` };
  const slow = a.outlier[span] === 1 || (ratio >= 3 && excess >= minExcess(t));
  const typ = `${us(dur)} against a median of ${us(typical)} over ${count(nPeers)} other calls.`;
  if (!slow) {
    const v = ratio < 1.5 ? `Typical: ${typ}` : `${ratio.toFixed(1)}× the median, within the usual spread: ${typ}`;
    return { ...base, verdict: v };
  }

  const peers = new Map<string, Agg>();
  let peerIrq = 0;
  for (let m = 0; m < nPeers; m++) {
    walk(t, a, all[m], m, peers, null);
    peerIrq += a.irq[all[m]];
  }
  peerIrq /= nPeers;
  const mine = new Map<string, Agg>();
  const irqRoots: number[] = [];
  walk(t, a, span, 0, mine, irqRoots);

  // contributors: self and off-CPU per path; a branch peers never take is
  // reported once at its top, with all the self time below it
  const contributors: Contributor[] = [];
  const newTop = new Map<string, Contributor>();
  const keys = [...mine.keys()].sort((x, y) => x.length - y.length);
  for (const key of keys) {
    const g = mine.get(key)!;
    const p = peers.get(key);
    const presence = p ? p.members / nPeers : 0;
    const path = pathOf(key);
    const tc = p ? p.calls / nPeers : 0;
    let top: Contributor | undefined;
    for (const [k, c] of newTop) if (key.startsWith(k + '/')) top = c;
    if (!top && presence < 0.05 && key) {
      top = { path, kind: 'new-path', time: 0, typical: 0, excess: 0, calls: g.calls, typicalCalls: tc, presence, span: g.span };
      newTop.set(key, top);
      contributors.push(top);
    }
    const selfEx = g.self - (p ? p.self / nPeers : 0);
    if (top) {
      top.time += g.self;
      top.typical += p ? p.self / nPeers : 0;
      top.excess += selfEx;
    } else if (selfEx > 0) {
      const kind = !key ? 'self' : g.calls >= 1.5 * tc + 1 ? 'more-calls' : 'slower';
      contributors.push({ path, kind, time: g.self, typical: p ? p.self / nPeers : 0, excess: selfEx, calls: g.calls, typicalCalls: tc, presence, span: g.span });
    }
    const offEx = g.off - (p ? p.off / nPeers : 0);
    if (offEx > 0)
      contributors.push({ path, kind: 'off-cpu', time: g.off, typical: p ? p.off / nPeers : 0, excess: offEx, calls: g.calls, typicalCalls: tc, presence, span: g.span });
  }
  const irqEx = a.irq[span] - peerIrq;
  let irqBig = -1;
  irqBig = tellingIrq(t, irqRoots);
  if (irqEx > 0 && irqBig >= 0)
    contributors.push({ path: [s.func[irqBig]], kind: 'irq', time: a.irq[span], typical: peerIrq, excess: irqEx, calls: irqRoots.length, typicalCalls: 0, presence: 0, span: irqBig });
  contributors.sort((x, y) => y.excess - x.excess);
  const contrib = contributors.filter((c) => c.excess > 0.05 * excess).slice(0, 8);
  const spread = contributors.filter((c) => c.kind !== 'irq' && c.excess > 0.01 * excess).length;

  // blame: follow the child with the largest excess while it carries most of it
  const blame: BlameStep[] = [{ span, func: f, dur, typical, excess, presence: 1 }];
  let cur = span;
  let key = '';
  let curEx = excess - Math.max(0, irqEx);
  for (;;) {
    let best = -1;
    let bestEx = 0;
    let bestTyp = 0;
    let bestPres = 0;
    for (let c = s.firstChild[cur]; c >= 0; c = s.nextSibling[c]) {
      if (isIrqRoot(t, index(t), c) || !isFinite(s.dur[c])) continue;
      const p = peers.get(key + '/' + s.func[c]);
      // expected time on this path per instance (a branch other slow calls also took is still rare)
      const ty = p ? p.wall / nPeers : 0;
      const ex = s.dur[c] - a.irq[c] - ty;
      if (ex > bestEx) [best, bestEx, bestTyp, bestPres] = [c, ex, ty, p ? p.members / nPeers : 0];
    }
    if (best < 0 || bestEx < 0.6 * curEx) break;
    key += '/' + s.func[best];
    blame.push({ span: best, func: s.func[best], dur: s.dur[best], typical: bestTyp, excess: bestEx, presence: bestPres });
    cur = best;
    curEx = bestEx;
  }

  const [cause, verdict] = verdictOf(t, a, span, { typical, excess, ratio, nPeers, contrib, blame, irqBig, peers, spread });
  const e = { ...base, slow: true, blame, contributors: contrib, verdict };
  causes.set(e, cause);
  return e;
}

/** Names along a chain, shortened to first … last two when long. */
export function chainText(t: Trace, funcs: number[]): string {
  const names = funcs.map((x) => fn(t, x));
  return (names.length > 4 ? [names[0], '…', ...names.slice(-2)] : names).join(' → ');
}

/** A sleeping function worth naming: the outermost scheduler entry on the path, else its last element. */
export function sleepFunc(t: Trace, path: number[]): number {
  for (const x of path) if (/^(io_)?schedule(_timeout|_preempt_disabled|_hrtimeout.*)?$/.test(t.funcs.name[x])) return x;
  const last = path[path.length - 1] ?? 0;
  return t.funcs.name[last] === '?' ? 0 : last;
}

function verdictOf(
  t: Trace,
  a: Core,
  span: number,
  v: { typical: number; excess: number; ratio: number; nPeers: number; contrib: Contributor[]; blame: BlameStep[]; irqBig: number; peers: Map<string, Agg>; spread: number },
): [string, string] {
  const r = verdictText(t, a, span, v);
  return [r.slice(r.indexOf(HEAD_END) >= 0 ? r.indexOf(HEAD_END) + HEAD_END.length : 0).trim() || r, r.replace(HEAD_END, '')];
}

const HEAD_END = '\u0000';
/** The cause part of a verdict, without the "N µs slower" head: what Outlier.reason says. */
export const causes = new WeakMap<Explanation, string>();

function verdictText(
  t: Trace,
  a: Core,
  span: number,
  v: { typical: number; excess: number; ratio: number; nPeers: number; contrib: Contributor[]; blame: BlameStep[]; irqBig: number; peers: Map<string, Agg>; spread: number },
): string {
  const s = t.spans;
  const dur = s.dur[span];
  const head = `${us(v.excess)} slower than the typical ${us(v.typical)} (${v.ratio >= 10 ? Math.round(v.ratio) : v.ratio.toFixed(1)}×).${HEAD_END}`;
  const top = v.contrib[0];
  if (!top) return head;
  const irqT = a.irq[span];
  if (top.kind === 'irq') {
    const rest = dur - irqT;
    const p99 = a.funcStats[s.func[span]]?.p99 ?? v.typical;
    const tail =
      rest <= Math.max(1.5 * v.typical, p99) ? `the call's own work (${us(rest)}) was typical.` : `without it the call took ${us(rest)}, still ${(rest / v.typical).toFixed(1)}× typical.`;
    const what = 'a ' + irqKind(t, s.func[v.irqBig]);
    return `${us(irqT)} of the ${us(dur)} was ${what} (${fn(t, s.func[v.irqBig])}) that fired inside it; ${tail}`;
  }
  // a cause is only a cause when it carries most of the excess the interrupt does not explain
  const own = v.excess - Math.max(0, irqT - (v.contrib.find((c) => c.kind === 'irq')?.typical ?? 0));
  const irqNote = irqT >= 0.05 * dur ? ` (${us(irqT)} of it was ${v.irqBig >= 0 ? 'a ' + irqKind(t, s.func[v.irqBig]) : 'interrupts'})` : '';
  const selfC = v.contrib.find((c) => c.kind === 'self');
  if (selfC && selfC.excess >= 0.5 * own) {
    const name = fn(t, s.func[span]);
    // the same callees called many more times than usual: the call did more work, not slower work
    const loops = v.contrib.filter((c) => c.kind === 'more-calls' && c.calls >= 3 * c.typicalCalls + 2);
    const lx = loops.reduce((k, c) => k + c.excess, 0);
    const more = loops.length
      ? `; its callees ran ${count(loops[0].calls)} times instead of ~${loops[0].typicalCalls.toFixed(loops[0].typicalCalls < 10 ? 1 : 0)} (${loops.slice(0, 2).map((c) => fn(t, c.path[c.path.length - 1])).join(', ')}${loops.length > 2 ? ', …' : ''}), adding ${us(lx)}`
      : '';
    const irqPart = irqT >= 0.05 * dur ? `; ${us(irqT)} was ${v.irqBig >= 0 ? 'a ' + irqKind(t, s.func[v.irqBig]) : 'interrupts'}` : '';
    if (!more && !irqPart) return `${head} The time was in ${name} itself (${us(selfC.time)} against a typical ${us(selfC.typical)}), not in anything it called.`;
    return `${head} ${us(selfC.time)} was in ${name} itself (typically ${us(selfC.typical)})${more}${irqPart}.`;
  }
  const big = v.contrib.filter((c) => c.kind !== 'irq');
  let acc = 0;
  for (const c of big.slice(0, 2)) acc += c.excess;
  if (!big.length || acc < 0.5 * own) {
    const named = big.slice(0, 2).map((c) => `${c.path.length ? fn(t, c.path[c.path.length - 1]) : fn(t, s.func[span]) + ' itself'} +${us(c.excess)}`);
    return `${head} No single cause: the excess is spread over ${v.spread > 2 ? count(v.spread) + ' callees' : 'several callees'}${named.length ? ` (largest: ${named.join(', ')})` : ''}${irqNote}.`;
  }
  const newp = v.contrib.find((c) => c.kind === 'new-path');
  const never = (c: Contributor) => {
    const k = Math.round((1 - c.presence) * v.nPeers);
    return `a path ${count(k)} of ${count(v.nPeers)} other calls never take`;
  };
  if (top.kind === 'off-cpu') {
    const where = sleepFunc(t, top.path);
    // the first step of the path that peers rarely take, however little self time it has
    let rare = -1;
    for (let k = 1; k <= top.path.length && rare < 0; k++) {
      const p = v.peers.get('/' + top.path.slice(0, k).join('/'));
      if (!p || p.members / v.nPeers < 0.05) rare = p ? p.members : 0;
    }
    const upto = top.path.slice(0, Math.max(1, top.path.indexOf(where)));
    const via = upto.length && top.path[0] !== where ? `, reached through ${chainText(t, upto)}` : '';
    const nev = rare >= 0 ? `: a path ${count(v.nPeers - rare)} of ${count(v.nPeers)} other calls never take` : newp ? `: ${never(newp)}` : '';
    const inside = t.spans && where ? ` inside ${fn(t, where)}` : '';
    return `${head} ${us(top.excess)} of that was spent switched out${inside}${via}${nev}.`.replace('switched out inside `io_schedule`', 'off-CPU inside `io_schedule`').replace(/switched out inside (`[^`]*schedule[^`]*`)/, 'off-CPU inside $1');
  }
  if (top.kind === 'new-path') {
    let io = '';
    const st = [top.span];
    while (st.length && !io) {
      const i = st.pop()!;
      if (/^(submit_bio|io_schedule)$/.test(t.funcs.name[s.func[i]])) io = t.funcs.name[s.func[i]];
      for (let c = s.firstChild[i]; c >= 0; c = s.nextSibling[c]) st.push(c);
    }
    return `${head} ${us(top.excess)} of it was in ${chainText(t, top.path)}, ${never(top)}${io ? `; it issued block I/O (\`${io}\`)` : ''}.`;
  }
  if (top.kind === 'more-calls') {
    const g = top.path[top.path.length - 1];
    return `${head} ${fn(t, g)} was called ${top.calls} times instead of ${top.typicalCalls.toFixed(top.typicalCalls < 10 ? 1 : 0)}, adding ${us(top.excess)}.`;
  }
  if (top.kind === 'slower') {
    const g = top.path[top.path.length - 1];
    return `${head} ${us(top.excess)} of it was ${fn(t, g)} itself running longer (${us(top.time)} instead of ${us(top.typical)}), via ${chainText(t, top.path)}.`;
  }
  return `${head} The time was in ${fn(t, s.func[span])} itself, not in anything it called${irqNote}.`;
}

export function explain(t: Trace, a: Analysis, span: number): Explanation {
  return explainCore(t, a, span);
}

/** An interrupt has no traced entry stub, only a run of F.IRQ siblings; name it by its most telling member. */
export function tellingIrq(t: Trace, roots: number[]): number {
  let best = -1;
  let bestScore = -1;
  for (const r of roots) {
    const sc = (/sysvec|common_interrupt|handle_irq|_interrupt$/.test(t.funcs.name[t.spans.func[r]]) ? 1e9 : 0) + (t.spans.dur[r] || 0);
    if (sc > bestScore) [best, bestScore] = [r, sc];
  }
  return best;
}

export function irqKind(t: Trace, f: number): string {
  const n = t.funcs.name[f];
  return /timer/.test(n) ? 'timer interrupt' : /common_interrupt|handle_irq|handle_edge|handle_fasteoi/.test(n) ? 'device interrupt' : /call_function|reschedule/.test(n) ? 'IPI' : 'interrupt';
}
