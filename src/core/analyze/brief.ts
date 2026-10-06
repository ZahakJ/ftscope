// The Brief: the few things a person needs to know about this trace, most
// important first. Each insight is a title, a number, one or two sentences.

import type { Analysis, Explanation, Insight, Outlier } from '../api';
import { F, type Trace } from '../model';
import { chainText, irqKind, sleepFunc } from './explain';
import { ERRNO, count, fn, index, isIrqRoot, us } from './util';

const MAX = 9;
const UNTIMED_Q = F.UNCLOSED | F.ORPHAN | F.NO_DUR;
const DISK = /^(submit_bio|submit_bio_noacct|blk_mq_submit_bio|io_schedule|folio_wait_bit_common|blk_mq_get_tag|virtblk_|nvme_queue_rq|scsi_queue_rq)/;

const plural = (n: number, w: string) => `${count(n)} ${w}${n === 1 ? '' : 's'}`;

export function brief(t: Trace, a: Analysis): Insight[] {
  const out: Insight[] = [];
  const s = t.spans;
  const m = t.meta;
  const ix = index(t);
  const D = m.duration;

  // ---- summary
  const nfUsed = a.funcStats.reduce((k, st) => k + (st && st.count > 0 ? 1 : 0), 0);
  const tasks = new Set<number>();
  for (const tr of t.tracks) if (tr.spans > 0) tasks.add(tr.task);
  const on = t.cpus.length ? ` on ${plural(t.cpus.length, 'CPU')}` : '';
  let detail = s.n
    ? `${D > 0 ? us(D) + ' of ' : ''}${m.tracer || m.format}${on}: ${plural(s.n, 'call')} to ${plural(nfUsed, 'distinct function')} across ${plural(tasks.size, 'task')}` + (t.events.n ? `, and ${plural(t.events.n, 'event')}.` : '.')
    : `${D > 0 ? us(D) + ' of ' : ''}tracepoint events${on}: ${plural(t.events.n, 'event')}, no function calls.`;
  if (m.clock === 'reconstructed' && s.n)
    detail += ` The file has no timestamps, so time is laid out from the printed durations${t.switches.n ? ' and time spent switched out cannot be measured (it stays inside `schedule()` as its own time)' : ''}; for real timestamps, \`echo funcgraph-abstime > trace_options\` before recording.`;
  out.push({ id: 'summary', kind: 'summary', level: 'info', title: 'What was traced', value: D > 0 ? us(D) : count(s.n) + ' calls', detail, range: [0, D] });

  // ---- quality
  if (m.counts.lost > 0) {
    const per = new Map<number, number>();
    for (const g of t.gaps) per.set(g.cpu, (per.get(g.cpu) ?? 0) + g.lost);
    const cpus = [...per.keys()].sort((x, y) => x - y);
    out.push({
      id: 'lost', kind: 'lost', level: 'warn', title: 'Events were lost', value: count(m.counts.lost),
      detail: `The kernel dropped ${count(m.counts.lost)} events in ${plural(t.gaps.length, 'gap')} on CPU ${cpus.join(', ')}: calls around the hatched gaps are incomplete. A larger \`buffer_size_kb\` or a narrower filter avoids it.`,
      range: t.gaps.length ? [t.gaps[0].ts, t.gaps[t.gaps.length - 1].ts] : undefined,
    });
  }
  const housekeeping: Insight[] = [];
  let thresh = false;
  let flat = false;
  const q: string[] = [];
  const cut = m.counts.orphans + m.counts.unclosed;
  // a few calls open at either end is the normal shape of any trace: only say so when it is more than that
  if (cut > Math.max(16, 4 * t.tracks.length) || (cut > 0 && m.counts.unparsed)) {
    if (m.counts.orphans) q.push(`${plural(m.counts.orphans, 'call')} began before the trace starts (only their ends are in it)`);
    if (m.counts.unclosed) q.push(`${plural(m.counts.unclosed, 'call')} had not returned when it ends`);
  }
  if (m.counts.unparsed) q.push(`${plural(m.counts.unparsed, 'line')} could not be read`);
  if (q.length && !(m.format === 'function_graph' && m.counts.orphans >= 0.9 * s.n && !m.counts.unparsed))
    housekeeping.push({ id: 'cut', kind: 'quality', level: m.counts.unparsed ? 'warn' : 'note', title: m.counts.unparsed && !cut ? 'Unreadable lines' : 'Calls cut off at the ends', value: count(q.length === 1 && m.counts.unparsed ? m.counts.unparsed : cut), detail: q.join('; ') + (cut ? '. Calls without both ends are left out of the statistics.' : '.') });
  if (m.format === 'function' || (s.n > 0 && !m.options.duration && m.format !== 'function_graph'))
    out.push({ id: 'nodur', kind: 'quality', level: 'note', title: 'No durations', detail: 'The `function` tracer records only that a function was entered, not how long it ran, so nothing here can be called slow. Record with `echo function_graph > current_tracer` to get durations and nesting.' });
  else if (m.format === 'function_graph' && s.n > 0 && !m.options.duration)
    out.push({ id: 'nodur', kind: 'quality', level: 'note', title: 'No durations', detail: 'The durations column was turned off (`funcgraph-duration`), so calls show nesting but not time and nothing can be called slow. Leave `funcgraph-duration` on to get them.' });
  else if (m.format === 'function_graph' && s.n > 0) {
    // tracing_thresh prints only the returns of calls longer than the threshold: every call is an orphan.
    // max_graph_depth=1 prints only the outermost calls: nothing has children.
    let minD = Infinity, kids = 0, withDur = 0;
    for (let i = 0; i < s.n; i++) {
      if (s.firstChild[i] >= 0) kids++;
      if (isFinite(s.dur[i]) && s.dur[i] > 0) (withDur++, (minD = Math.min(minD, s.dur[i])));
    }
    if (m.counts.orphans >= 0.9 * s.n && withDur) {
      thresh = true;
      out.push({ id: 'thresh', kind: 'quality', level: 'note', title: 'Only slow calls recorded', value: `≥ ${us(minD)}`, detail: `\`tracing_thresh\` was set: the file holds only the returns of calls that took longer than it (the fastest here took ${us(minD)}), with no entries, no nesting and no faster calls. Nothing can be compared with a typical call, and the timeline is rebuilt from the returns alone.` });
    } else if (kids === 0 && s.n >= 20) {
      flat = true;
      out.push({ id: 'depth', kind: 'quality', level: 'note', title: 'Only top-level calls', detail: 'No call has a traced callee (`max_graph_depth` was 1, or a filter kept only the entry points): every duration includes everything the call did below, and the trace cannot say where inside a call the time went.' });
    }
  }

  if (s.n === 0 && t.events.n) {
    const byName = new Map<number, number>();
    for (let e = 0; e < t.events.n; e++) byName.set(t.events.name[e], (byName.get(t.events.name[e]) ?? 0) + 1);
    const top = [...byName].sort((x, y) => y[1] - x[1]);
    let detail = `${top.slice(0, 6).map(([k, c]) => `${count(c)} \`${t.eventNames[k]}\``).join(', ')}${top.length > 6 ? `, and ${plural(top.length - 6, 'other kind')}` : ''}.`;
    if (t.switches.n) {
      const per = new Map<number, number>();
      for (let k = 0; k < t.switches.n; k++) if (t.switches.prev[k] > 0 && t.tasks[t.switches.prev[k]]?.pid !== 0) per.set(t.switches.prev[k], (per.get(t.switches.prev[k]) ?? 0) + 1);
      const tops = [...per].sort((x, y) => y[1] - x[1]).slice(0, 4);
      if (tops.length) detail += ` Switched out most often (idle excluded): ${tops.map(([task, c]) => `${t.tasks[task]?.comm ?? '?'}-${t.tasks[task]?.pid ?? task} ${count(c)}×`).join(', ')}.`;
    }
    out.push({ id: 'events', kind: 'time', level: 'info', title: 'Events only', value: count(t.events.n), detail });
  }

  // ---- where the time went
  const timeIns: Insight[] = [];
  let traced = 0;
  const entry = new Map<number, number>();
  for (const tr of t.tracks)
    for (const r of tr.roots) {
      const d = s.dur[r];
      if (!isFinite(d) || s.flags[r] & F.ORPHAN) continue;
      traced += d;
      if (!ix.irqCtx[r]) entry.set(s.func[r], (entry.get(s.func[r]) ?? 0) + d);
    }
  if (traced > 0 && m.format === 'function_graph') {
    const pct = (v: number) => `${Math.round((100 * v) / traced)} %`;
    const topE = [...entry].sort((x, y) => y[1] - x[1]).slice(0, 3).filter(([, v]) => v >= 0.05 * traced);
    const topS = a.funcStats.filter((st) => st && st.self > 0).sort((x, y) => y.self - x.self).slice(0, 3);
    const parts: string[] = [];
    if (topE.length) parts.push(`Entry points: ${topE.map(([f, v]) => `${fn(t, f)} ${pct(v)}`).join(', ')}.`);
    if (topS.length && !flat) parts.push(`Most self time: ${topS.map((st) => `${fn(t, st.func)} ${pct(st.self)}`).join(', ')}.`);
    if (parts.length)
      timeIns.push({ id: 'time', kind: 'time', level: 'info', title: 'Where the time went', value: topE.length ? pct(topE[0][1]) : undefined, detail: parts.join(' ') + (t.tracks.length > 1 ? ` Shares are of ${us(traced)} spent inside traced calls across all tasks.` : ''), target: topE.length ? { kind: 'func', id: topE[0][0] } : undefined });
  }

  // ---- outliers, grouped: disk reads per function, interrupts across functions, the rest per function
  type O = Outlier & { _e?: Explanation };
  const groups = new Map<string, { kind: 'disk' | 'irq' | 'other'; os: O[]; func: number }>();
  for (const o of a.outliers as O[]) {
    const e = o._e;
    if (!e) continue;
    const top = e.contributors[0];
    const f = s.func[o.span];
    const kind = top?.kind === 'irq' ? 'irq' : subtreeHas(t, o.span, DISK) ? 'disk' : 'other';
    const key = kind === 'irq' ? 'irq' : `${f}:${kind}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { kind, os: [], func: f }));
    g.os.push(o);
  }
  const findings: (Insight & { weight: number })[] = [];
  const rangeOf = (os: O[]) => {
    const durs = os.map((o) => s.dur[o.span]).sort((x, y) => x - y);
    return span2(durs);
  };
  const restRange = (os: O[]) => {
    const r = os.map((o) => s.dur[o.span] - a.irq[o.span]).sort((x, y) => x - y);
    return span2(r);
  };
  const groupSel = (f: number, os: O[]) =>
    os.length > 1 ? { kind: 'group' as const, func: f, spans: Int32Array.from(os.map((o) => o.span).sort((x, y) => x - y)) } : { kind: 'span' as const, id: os[0].span };
  for (const [key, g] of groups) {
    const sum = g.os.reduce((k, o) => k + o.excess, 0);
    if (g.kind === 'irq') {
      // name the function most of them belong to; the rest are "other calls"
      const byF = new Map<number, O[]>();
      for (const o of g.os) byF.set(s.func[o.span], [...(byF.get(s.func[o.span]) ?? []), o]);
      const [mf, mine] = [...byF].sort((x, y) => y[1].length - x[1].length)[0];
      const others = g.os.filter((o) => s.func[o.span] !== mf);
      const worst = mine.reduce((x, y) => (s.dur[y.span] > s.dur[x.span] ? y : x));
      const irqF = new Map<number, number>();
      for (const o of g.os) {
        const c = o._e!.contributors.find((c) => c.kind === 'irq');
        if (c) irqF.set(c.path[0], (irqF.get(c.path[0]) ?? 0) + 1);
      }
      const kinds = new Set([...irqF.keys()].map((f) => irqKind(t, f)));
      const what = kinds.size === 1 ? `a ${[...kinds][0]} (${[...irqF.keys()].map((f) => fn(t, f)).join(', ')})` : 'an interrupt';
      const typical = g.os.every((o) => /own work/.test(o.reason));
      const st = a.funcStats[mf];
      const othersTxt = others.length ? ` The same happened to ${others.length === 1 ? '1 other call' : `${count(others.length)} other calls`} (${[...new Set(others.map((o) => fn(t, s.func[o.span])))].slice(0, 3).join(', ')}).` : '';
      findings.push({
        id: 'irq', kind: 'irq', level: 'note', weight: sum, title: 'Inflated by interrupts', value: plural(mine.length, 'call'),
        target: groupSel(mf, mine), range: [s.start[worst.span], s.start[worst.span] + s.dur[worst.span]],
        detail: `${count(mine.length)} of ${count(st.timed)} ${fn(t, mf)} calls took ${rangeOf(mine)} ${typical ? 'only ' : ''}because ${what} fired inside ${mine.length === 1 ? 'it' : 'them'}; ${typical ? `${mine.length === 1 ? 'its' : 'their'} own work was typical` : `without the interrupt ${mine.length === 1 ? 'it' : 'they'} took ${restRange(mine)}, against a typical ${us(st.p50)}`}.${othersTxt}`,
      });
      continue;
    }
    const worst = g.os.reduce((x, y) => (y.excess > x.excess ? y : x));
    const where: [number, number] = [s.start[worst.span], s.start[worst.span] + s.dur[worst.span]];
    const st = a.funcStats[g.func];
    const e = worst._e!;
    const head = `${count(g.os.length)} of ${count(st.timed)} ${fn(t, g.func)} calls took ${rangeOf(g.os)} instead of ${us(st.p50)}`;
    let why: string;
    if (g.kind === 'disk') {
      const newp = e.contributors.find((c) => c.kind === 'new-path') ?? e.contributors.find((c) => c.kind === 'off-cpu');
      const path = newp ? newp.path.filter((x) => !/schedule$/.test(t.funcs.name[x])) : e.blame.slice(1).map((b) => b.func);
      let sub = -1;
      walkNames(t, worst.span, (f) => {
        if (sub < 0 && /^submit_bio$/.test(t.funcs.name[f])) sub = f;
      });
      const chain = [...path.slice(-2).map((x) => fn(t, x)), ...(sub >= 0 && !path.includes(sub) ? ['…', fn(t, sub)] : [])].join(' → ');
      let sleeper = -1;
      walkNames(t, worst.span, (f) => {
        if (sleeper < 0 && /^io_schedule/.test(t.funcs.name[f])) sleeper = f;
      });
      const cache = path.some((x) => /^(filemap_|page_cache_|folio_)/.test(t.funcs.name[x]));
      why = `${cache ? 'they missed the page cache and read from disk' : 'they waited for the disk'} — ${chain}${sleeper >= 0 ? `, then slept in ${fn(t, sleeper)} until the disk answered` : ''}.`;
      if (g.os.length === 1) why = why.replace(/^they/, 'it');
    } else why = (g.os.length > 1 ? 'in the worst, ' : '') + worst.reason.charAt(0).toLowerCase() + worst.reason.slice(1);
    findings.push({
      id: 'out:' + key, kind: 'outlier', level: 'note', weight: sum + (g.kind === 'disk' ? 1e12 : 0), title: g.kind === 'disk' ? 'Slow: went to disk' : `Slow ${t.funcs.name[g.func]}`,
      value: `×${Math.round(worst.ratio)}`, detail: `${head.replace(/^1 of (\S+) (`[^`]+`) calls took/, '1 of $1 $2 calls took')}: ${why}`, target: groupSel(g.func, g.os), range: where,
    });
  }

  // ---- off-CPU: where tasks waited longest, outside the outliers already told
  const waits: number[] = [];
  for (let i = 0; i < s.n; i++) {
    let kids = 0;
    for (let c = s.firstChild[i]; c >= 0; c = s.nextSibling[c]) kids += a.off[c];
    if (!(a.off[i] - kids > 0.5 * a.off[i] && a.off[i] >= Math.max(50, 0.01 * D))) continue;
    let told = false;
    for (let p = i; p >= 0 && !told; p = s.parent[p]) told = a.outlier[p] === 1;
    if (!told) waits.push(i);
  }
  waits.sort((x, y) => a.off[y] - a.off[x]);
  if (waits.length) {
    const top = waits.slice(0, 3);
    const total = waits.reduce((k, i) => k + a.off[i], 0);
    const parentName = (i: number) => (s.parent[i] >= 0 ? ` (from ${fn(t, s.func[s.parent[i]])})` : '');
    findings.push({
      id: 'offcpu', kind: 'offcpu', level: 'info', weight: total * 0.2, title: 'Waiting off-CPU', value: us(a.off[top[0]]),
      detail: `Longest sleeps: ${top.map((i) => `${t.tasks[s.task[i]]?.comm ?? '?'} ${us(a.off[i])} in ${fn(t, s.func[i])}${parentName(i)}`).join('; ')}.`,
      target: { kind: 'span', id: top[0] }, range: [s.start[top[0]], s.start[top[0]] + s.dur[top[0]]],
    });
  }

  // ---- errors: errno-looking returns that are the exception for that function
  const errs: { f: number; n: number; of: number; code: number; span: number }[] = [];
  const nf = t.funcs.name.length;
  const rc = new Uint32Array(nf);
  const ec = new Uint32Array(nf);
  const code = new Map<number, Map<number, number>>();
  const first = new Int32Array(nf).fill(-1);
  for (let i = 0; i < s.n; i++) {
    if (!(s.flags[i] & F.HAS_RET)) continue;
    const f = s.func[i];
    rc[f]++;
    const r = s.ret[i];
    if (r <= -1 && r >= -4095 && Number.isInteger(r)) {
      ec[f]++;
      let cm = code.get(f);
      if (!cm) code.set(f, (cm = new Map()));
      cm.set(r, (cm.get(r) ?? 0) + 1);
      if (first[f] < 0) first[f] = i;
    }
  }
  for (const [f, cm] of code) {
    const name = t.funcs.name[f];
    const sys = /^__(x64|ia32|arm64)_sys_|^ksys_/.test(name);
    // retval is printed for void functions too, where it is register noise: a known errno name and a minority of calls only
    const [c, k] = [...cm].sort((x, y) => y[1] - x[1])[0];
    // -1 from a non-syscall is as often a boolean or register noise as -EPERM
    if (!ERRNO[-c] || c <= -512 || (!sys && c === -1)) continue;
    if (sys || (ec[f] * 2 < rc[f] && rc[f] >= 4 && ec[f] < 0.3 * rc[f])) errs.push({ f, n: k, of: rc[f], code: c, span: first[f] });
  }
  errs.sort((x, y) => Number(/sys_/.test(t.funcs.name[y.f])) - Number(/sys_/.test(t.funcs.name[x.f])) || y.n - x.n);
  if (errs.length) {
    const top = errs.slice(0, 3);
    findings.push({
      id: 'error', kind: 'error', level: 'note', weight: 1, title: 'Error returns', value: count(errs.reduce((k, e) => k + e.n, 0)),
      detail: top.map((e) => `${fn(t, e.f)} returned ${e.code} (${ERRNO[-e.code]}) ${e.n === e.of ? (e.n === 1 ? 'on its only call' : `on all ${e.n} calls`) : `on ${e.n} of ${e.of} calls`}`).join('; ') + '.',
      target: { kind: 'span', id: top[0].span },
    });
  }

  // outlier groups and the interrupt insight by total excess (disk first), then off-CPU, then errors
  const rank = (x: { kind: string }) => (x.kind === 'outlier' || x.kind === 'irq' ? 0 : x.kind === 'offcpu' ? 1 : 2);
  findings.sort((x, y) => rank(x) - rank(y) || y.weight - x.weight);
  const body: Insight[] = findings.map(({ weight: _w, ...f }) => f);
  const room = MAX - out.length - timeIns.length - housekeeping.length;
  return [...out, ...body.slice(0, Math.max(3, room)), ...timeIns, ...housekeeping];
}

/** `48.5–111 µs`, or `184 µs–2.21 ms` when the ends need different units. */
function span2(sorted: number[]): string {
  const [a, b] = [us(sorted[0]), us(sorted[sorted.length - 1])];
  if (sorted.length < 2 || a === b) return b;
  const ua = a.split(' ')[1];
  return ua === b.split(' ')[1] ? `${a.split(' ')[0]}–${b}` : `${a}–${b}`;
}

function walkNames(t: Trace, root: number, cb: (f: number) => void): void {
  const s = t.spans;
  const st = [root];
  while (st.length) {
    const i = st.pop()!;
    cb(s.func[i]);
    for (let c = s.firstChild[i]; c >= 0; c = s.nextSibling[c]) if (!isIrqRoot(t, index(t), c)) st.push(c);
  }
}

function subtreeHas(t: Trace, root: number, re: RegExp): boolean {
  let hit = false;
  walkNames(t, root, (f) => {
    if (!hit && re.test(t.funcs.name[f])) hit = true;
  });
  return hit;
}
