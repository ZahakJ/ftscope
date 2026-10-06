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
  let detail = `${D > 0 ? us(D) + ' of ' : ''}${m.tracer || m.format}${on}: ${plural(s.n, 'call')} to ${plural(nfUsed, 'distinct function')} across ${plural(tasks.size, 'task')}`;
  detail += t.events.n ? `, and ${plural(t.events.n, 'event')}.` : '.';
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
  const q: string[] = [];
  const cut = m.counts.orphans + m.counts.unclosed;
  // a few calls open at either end is the normal shape of any trace: only say so when it is more than that
  if (cut > Math.max(16, 4 * t.tracks.length) || (cut > 0 && m.counts.unparsed)) {
    if (m.counts.orphans) q.push(`${plural(m.counts.orphans, 'call')} began before the trace starts (only their ends are in it)`);
    if (m.counts.unclosed) q.push(`${plural(m.counts.unclosed, 'call')} had not returned when it ends`);
  }
  if (m.counts.unparsed) q.push(`${plural(m.counts.unparsed, 'line')} could not be read`);
  if (q.length)
    housekeeping.push({ id: 'cut', kind: 'quality', level: m.counts.unparsed ? 'warn' : 'note', title: m.counts.unparsed && !cut ? 'Unreadable lines' : 'Calls cut off at the ends', value: count(q.length === 1 && m.counts.unparsed ? m.counts.unparsed : cut), detail: q.join('; ') + (cut ? '. Calls without both ends are left out of the statistics.' : '.') });
  if (m.format === 'function' || (s.n > 0 && !m.options.duration && m.format !== 'function_graph'))
    out.push({ id: 'nodur', kind: 'quality', level: 'note', title: 'No durations', detail: 'The `function` tracer records only that a function was entered, not how long it ran, so nothing here can be called slow. Record with `echo function_graph > current_tracer` to get durations and nesting.' });
  else if (m.format === 'function_graph' && s.n > 0 && !m.options.duration)
    out.push({ id: 'nodur', kind: 'quality', level: 'note', title: 'No durations', detail: 'The durations column was turned off (`funcgraph-duration`), so calls show nesting but not time and nothing can be called slow. Leave `funcgraph-duration` on to get them.' });
  else if (m.format === 'function_graph' && s.n > 0) {
    // tracing_thresh: only calls longer than a threshold are printed, as bare `}` lines with no children
    let timed = 0, minD = Infinity, kids = 0;
    for (let i = 0; i < s.n; i++) {
      if (s.firstChild[i] >= 0) kids++;
      const d = s.dur[i];
      if (isFinite(d) && !(s.flags[i] & UNTIMED_Q)) (timed++, (minD = Math.min(minD, d)));
    }
    if (timed >= 20 && minD >= 5 && kids < 0.02 * s.n)
      out.push({ id: 'thresh', kind: 'quality', level: 'note', title: 'Only slow calls recorded', value: '≥ ' + us(Math.floor(minD)), detail: `Every call in the file took at least ${us(Math.floor(minD))}: \`tracing_thresh\` was set, so faster calls and all nesting are missing. Medians and outliers here are among slow calls only.` });
  }
  if (s.n === 0 && t.events.n) {
    const byName = new Map<number, number>();
    for (let e = 0; e < t.events.n; e++) byName.set(t.events.name[e], (byName.get(t.events.name[e]) ?? 0) + 1);
    const top = [...byName].sort((x, y) => y[1] - x[1]);
    let detail = `No function calls, only tracepoint events: ${top.slice(0, 6).map(([k, c]) => `${count(c)} \`${t.eventNames[k]}\``).join(', ')}${top.length > 6 ? `, and ${plural(top.length - 6, 'other kind')}` : ''}.`;
    if (t.switches.n) {
      const per = new Map<number, number>();
      for (let k = 0; k < t.switches.n; k++) if (t.switches.prev[k] > 0) per.set(t.switches.prev[k], (per.get(t.switches.prev[k]) ?? 0) + 1);
      const tops = [...per].sort((x, y) => y[1] - x[1]).slice(0, 4);
      if (tops.length) detail += ` Switched out most often: ${tops.map(([task, c]) => `${t.tasks[task]?.comm ?? '?'}-${t.tasks[task]?.pid ?? task} ${count(c)}×`).join(', ')}.`;
    }
    out.push({ id: 'events', kind: 'time', level: 'info', title: 'Events only', value: count(t.events.n), detail });
  }

  // ---- where the time went
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
    if (topS.length) parts.push(`Most self time: ${topS.map((st) => `${fn(t, st.func)} ${pct(st.self)}`).join(', ')}.`);
    if (parts.length)
      out.push({ id: 'time', kind: 'time', level: 'info', title: 'Where the time went', value: topE.length ? pct(topE[0][1]) : undefined, detail: parts.join(' ') + (t.tracks.length > 1 ? ` Shares are of ${us(traced)} spent inside traced calls across all tasks.` : ''), target: topE.length ? { kind: 'func', id: topE[0][0] } : undefined });
  }

  // ---- outliers, grouped by function and cause
  type O = Outlier & { _e?: Explanation };
  const groups = new Map<string, { kind: 'disk' | 'irq' | 'other'; os: O[]; chain: string; func: number }>();
  for (const o of a.outliers as O[]) {
    const e = o._e;
    if (!e) continue;
    const top = e.contributors[0];
    const f = s.func[o.span];
    let kind: 'disk' | 'irq' | 'other' = 'other';
    let key = `${f}:`;
    if (top?.kind === 'irq') {
      kind = 'irq';
      key = 'irq:' + irqKind(t, top.path[0]);
    } else if (subtreeHas(t, o.span, DISK)) {
      kind = 'disk';
      key += 'disk';
    }
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { kind, os: [], chain: '', func: f }));
    g.os.push(o);
  }
  const findings: (Insight & { weight: number })[] = [];
  for (const [key, g] of groups) {
    const worst = g.os.reduce((x, y) => (y.excess > x.excess ? y : x));
    const durs = g.os.map((o) => s.dur[o.span]).sort((x, y) => x - y);
    const range = durs.length > 1 ? `${us(durs[0]).replace(/ \S+$/, '')}–${us(durs[durs.length - 1])}` : us(durs[0]);
    const sum = g.os.reduce((k, o) => k + o.excess, 0);
    const where: [number, number] = [s.start[worst.span], s.start[worst.span] + s.dur[worst.span]];
    const target = { kind: 'span' as const, id: worst.span };
    if (g.kind === 'irq') {
      const funcs = new Set(g.os.map((o) => s.func[o.span]));
      const maxIrq = Math.max(...g.os.map((o) => a.irq[o.span]));
      const who = funcs.size === 1 ? `${fn(t, g.func)} calls` : 'calls';
      findings.push({
        id: 'irq:' + key, kind: 'irq', level: 'note', weight: sum * 0.5, title: 'Inflated by interrupts', value: count(g.os.length), target, range: where,
        detail: `${count(g.os.length)} ${who} ${g.os.length === 1 ? 'was' : 'were'} inflated by ${key.slice(4)}s landing inside ${g.os.length === 1 ? 'it' : 'them'}, up to ${us(maxIrq)}; without the interrupt they were typical.`,
      });
      continue;
    }
    const st = a.funcStats[g.func];
    const e = worst._e!;
    const head = `${count(g.os.length)} of ${count(st.timed)} ${fn(t, g.func)} calls took ${range} instead of ${us(st.p50)}`;
    let why: string;
    if (g.kind === 'disk') {
      const chain = e.blame.slice(1).map((b) => b.func);
      const sleeper = e.contributors.find((c) => c.kind === 'off-cpu');
      const extra = new Set<number>();
      walkNames(t, worst.span, (f) => {
        if (/^(submit_bio|io_schedule)$/.test(t.funcs.name[f])) extra.add(f);
      });
      for (const x of chain) extra.delete(x);
      const names = chainText(t, chain.filter((x) => !/^(io_)?schedule$|^__schedule$/.test(t.funcs.name[x])));
      const tail = [...extra].sort((x, y) => t.funcs.name[y].localeCompare(t.funcs.name[x])).map((x) => fn(t, x)).join(' → ');
      why = `they went to disk — ${[names, tail].filter(Boolean).join(' → ')}${sleeper ? `, and slept in ${fn(t, sleepFunc(t, sleeper.path))}` : ''}.`;
    } else why = (g.os.length > 1 ? 'in the worst, ' : '') + worst.reason.charAt(0).toLowerCase() + worst.reason.slice(1);
    findings.push({ id: 'out:' + key, kind: 'outlier', level: 'note', weight: sum, title: g.kind === 'disk' ? 'Slow: went to disk' : `Slow ${t.funcs.name[g.func]}`, value: `×${Math.round(worst.ratio)}`, detail: `${head}: ${why}`, target, range: where });
  }

  // ---- off-CPU: where tasks waited longest, outside the outliers already told
  const waits: number[] = [];
  for (let i = 0; i < s.n; i++) {
    let kids = 0;
    for (let c = s.firstChild[i]; c >= 0; c = s.nextSibling[c]) kids += a.off[c];
    if (a.off[i] - kids > 0.5 * a.off[i] && a.off[i] >= Math.max(50, 0.01 * D)) waits.push(i);
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
    if (!ERRNO[-c] || c <= -512) continue;
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

  findings.sort((x, y) => (y.kind === 'outlier' ? 1 : 0) - (x.kind === 'outlier' ? 1 : 0) || y.weight - x.weight);
  for (const { weight: _w, ...f } of findings) out.push(f);
  return out.slice(0, MAX);
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
