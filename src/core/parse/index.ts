// Streaming ftrace text parser: bytes in, Trace out through TraceBuilder.
//
// Every line is classified on its own (pasted excerpts have no header, and
// columns may change mid-file), by a cheap hand scan of its fixed shape:
//   function_graph  [abstime |] [cpu)] [comm-pid |] [lat |] [mark dur us |]  text
//   function/events comm-pid [cpu] [flags] ts: rest      (tracefs and trace-cmd)
//   latency-format  comm-pid cpu+flags 8055us : rest
// Times are µs relative to the first timestamp in the file.
//
// Nesting follows the task and the printed indentation (two spaces a level),
// which is the truth about depth:
// - an entry at indent d first closes, as UNCLOSED, open calls at indent >= d;
// - a close at indent d closes the open call at indent d (deeper ones become
//   UNCLOSED); with none there it is an orphan that adopts the calls just
//   before it that are deeper (builder.exit with `indent`). tracing_thresh
//   output is all such closes, so each one becomes an orphan holding the
//   deeper closes printed before it: the same tree, children elided.
// - a line more than one level deeper than its open parent is an interrupt
//   that entered through an untraced stub (sysvec_* is noinstr on this
//   kernel): it is attached to the open call and flagged F.IRQ with
//   everything beneath it.

import { TraceBuilder } from '../builder';
import { F, type Trace } from '../model';

export { TraceBuilder };

const SP = 32;
const BAR = 124; // |
const IRQ_NAMES = new Set([
  'common_interrupt', 'asm_common_interrupt', '__common_interrupt', 'handle_irq_event', 'irq_enter_rcu',
  'irq_exit_rcu', '__irq_exit_rcu', 'irq_exit', 'handle_softirqs', '__do_softirq', 'do_softirq',
  // the tail of the interrupt return path, printed as a sibling after irq_exit_rcu
  'raw_irqentry_exit_cond_resched', 'irqentry_exit_cond_resched', 'dynamic_irqentry_exit_cond_resched',
  'irqentry_enter', 'irqentry_exit',
]);
const isIrqName = (n: string) =>
  IRQ_NAMES.has(n) || n.startsWith('sysvec_') || n.startsWith('__sysvec_') || n.startsWith('asm_sysvec_');

function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n++;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

const isDigit = (c: number) => c >= 48 && c <= 57;

/** Parse `123.456789` (or ns digits) at [a, b) into µs; NaN if not a number. */
function parseSecs(s: string, a: number, b: number): number {
  let ip = 0;
  let i = a;
  for (; i < b && isDigit(s.charCodeAt(i)); i++) ip = ip * 10 + s.charCodeAt(i) - 48;
  if (i === a) return NaN;
  let frac = 0;
  let scale = 1e6;
  if (i < b && s.charCodeAt(i) === 46) {
    for (i++; i < b && isDigit(s.charCodeAt(i)); i++) {
      frac = frac * 10 + s.charCodeAt(i) - 48;
      scale /= 10;
    }
  }
  return i === b ? ip * 1e6 + frac * scale : NaN;
}

/** Parse a decimal float at [a, b) (durations: `27.572`). */
function parseNum(s: string, a: number, b: number): number {
  let ip = 0;
  let i = a;
  for (; i < b && isDigit(s.charCodeAt(i)); i++) ip = ip * 10 + s.charCodeAt(i) - 48;
  if (i === a) return NaN;
  if (i < b && s.charCodeAt(i) === 46) {
    let f = 0;
    let d = 1;
    for (i++; i < b && isDigit(s.charCodeAt(i)); i++) {
      f = f * 10 + s.charCodeAt(i) - 48;
      d *= 10;
    }
    return ip + f / d;
  }
  return ip;
}

/** `0x1f`, `-22`, `18446744073709551594`; NaN otherwise. */
function parseRet(v: string): number {
  if (/^0x[0-9a-f]+$/i.test(v)) return Number.parseInt(v.slice(2), 16);
  if (/^-?\d+$/.test(v)) return Number(v);
  return NaN;
}

interface CommentInfo {
  name: string;
  ret: number;
  retaddr: boolean;
}

/** Tokens of a `/* name ret=X *\/`, `/* = -22 *\/`, `/* <-caller ret=0x0 *\/` comment. */
function readComment(body: string): CommentInfo {
  const t = body.trim().split(/\s+/);
  const r: CommentInfo = { name: '', ret: NaN, retaddr: false };
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (!w) continue;
    if (w.startsWith('ret=')) r.ret = parseRet(w.slice(4));
    else if (w === '=' && i + 1 < t.length) r.ret = parseRet(t[++i]);
    else if (w.startsWith('<-')) r.retaddr = true;
    else if (!r.name) r.name = w;
  }
  return r;
}

/** `comm-pid` → [comm, pid]; the pid follows the last dash. */
function splitTask(s: string): [string, number] {
  s = s.trim();
  const d = s.lastIndexOf('-');
  if (d < 0) return [s, NaN];
  const pid = /^\d+$/.test(s.slice(d + 1)) ? Number(s.slice(d + 1)) : NaN;
  return [s.slice(0, d), pid];
}

export class TraceParser {
  readonly progress = { lines: 0, bytes: 0 };
  private b = new TraceBuilder();
  private dec = new TextDecoder('utf-8');
  private rest = '';
  private restAscii = true;

  private t0 = NaN; // absolute µs of the first timestamp
  private sawGraph = false;
  private sawFunc = false;
  private sawEvent = false;
  private sawHeader = false;
  private sawSchedSwitch = false;
  private traceCmd = false;
  private flagsCol = false;

  // per CPU slot (cpu + 1, so the unknown CPU -1 is slot 0)
  private cursor: number[] = [];
  private curTask: number[] = [];
  private irqMark: boolean[] = [];
  private pendingGap: number[] = [];
  // per task
  private floor: number[] = [];
  private lastInd: number[] = [];
  private placeholders = new Set<number>();
  private irqFunc: Uint8Array = new Uint8Array(1024);
  private funcCache = new Map<string, number>();

  push(bytes: Uint8Array): void {
    const s = this.dec.decode(bytes, { stream: true });
    this.progress.bytes += bytes.length;
    this.feed(s, s.length === bytes.length);
  }

  finish(): Trace {
    const tail = this.dec.decode();
    if (tail) this.feed(tail, false);
    if (this.rest) {
      const line = this.rest;
      this.rest = '';
      const len = this.restAscii ? line.length : utf8Len(line);
      this.line(line, this.progress.lines, this.byte, this.byte + len);
      this.byte += len;
      this.progress.lines++;
    }
    return this.done();
  }

  private byte = 0;
  /** Closes whose laid-out children overran the printed duration. */
  stretched = 0;

  private feed(s: string, ascii: boolean): void {
    const text = this.rest ? this.rest + s : s;
    const oldRest = this.rest.length;
    let pos = 0;
    let nl = text.indexOf('\n');
    while (nl >= 0) {
      const lineAscii = ascii && (pos >= oldRest || this.restAscii);
      let end = nl;
      if (end > pos && text.charCodeAt(end - 1) === 13) end--;
      const line = text.substring(pos, end);
      const len = (lineAscii ? nl - pos : utf8Len(text.substring(pos, nl))) + 1;
      try {
        this.line(line, this.progress.lines, this.byte, this.byte + len);
      } catch {
        this.unparsed(line, this.progress.lines);
      }
      this.byte += len;
      this.progress.lines++;
      pos = nl + 1;
      nl = text.indexOf('\n', pos);
    }
    this.restAscii = ascii && (pos >= oldRest || this.restAscii);
    this.rest = text.substring(pos);
  }

  // ---- helpers -------------------------------------------------------------

  private fid(name: string): number {
    let id = this.funcCache.get(name);
    if (id === undefined) {
      id = this.b.funcId(name);
      this.funcCache.set(name, id);
      if (id >= this.irqFunc.length) {
        const g = new Uint8Array(id * 2);
        g.set(this.irqFunc);
        this.irqFunc = g;
      }
      this.irqFunc[id] = isIrqName(name) ? 1 : 0;
    }
    return id;
  }

  /** Absolute µs → relative µs; the first one seen is time 0. */
  private rel(abs: number): number {
    if (this.t0 !== this.t0) this.t0 = abs;
    return abs - this.t0;
  }

  private slotTask(slot: number, cpu: number): number {
    let t = this.curTask[slot];
    if (t === undefined) {
      t = this.b.placeholderTask(cpu);
      this.placeholders.add(t);
      this.curTask[slot] = t;
    }
    return t;
  }

  private task(pid: number, comm: string, cpu: number): number {
    return this.b.taskId(pid, comm, cpu);
  }

  /** The running task of a slot is now `t`; a placeholder there becomes `t`. */
  private claim(slot: number, t: number): void {
    const ph = this.curTask[slot];
    if (ph !== undefined && ph !== t && this.placeholders.has(ph)) {
      const ft = this.floor[t];
      if (ft !== undefined) {
        const delta = ft - this.b.firstStartOf(ph);
        if (delta > 0) {
          this.b.shiftTask(ph, delta);
          this.floor[ph] = (this.floor[ph] ?? 0) + delta;
          const slot2 = this.curTask.indexOf(ph);
          if (slot2 >= 0) this.cursor[slot2] = Math.max(this.cursor[slot2] ?? 0, this.floor[ph]);
        }
      }
      this.b.mergeTask(ph, t);
      this.placeholders.delete(ph);
      this.floor[t] = Math.max(this.floor[t] ?? 0, this.floor[ph] ?? 0);
    }
  }

  private unparsed(text: string, line: number): void {
    const m = this.b.meta;
    m.counts.unparsed++;
    if (m.unparsedSamples.length < 20) m.unparsedSamples.push({ line, text: text.slice(0, 500) });
  }

  // ---- lines ---------------------------------------------------------------

  private line(s: string, ln: number, bs: number, be: number): void {
    let p = 0;
    const n = s.length;
    while (p < n && (s.charCodeAt(p) === SP || s.charCodeAt(p) === 9)) p++;
    if (p === n) return;
    const c0 = s.charCodeAt(p);
    if (c0 === 35) {
      // '#'
      this.sawHeader = true;
      const m = /^#\s*tracer:\s*(\S+)/.exec(s.slice(p));
      if (m) this.b.meta.tracer = m[1];
      return;
    }
    if (c0 === 45 && /^-+$/.test(s.slice(p).trimEnd())) return; // banner rule
    if (c0 === 67 && s.startsWith('CPU:', p)) {
      const m = /^CPU:\s*(\d+)\s*\[LOST (\d+) EVENTS\]/.exec(s.slice(p));
      if (m) return this.lost(Number(m[1]), Number(m[2]), ln);
    }
    if (this.graphLine(s, p, ln, bs, be)) return;
    if (this.bracketLine(s, ln, bs, be)) return;
    if (this.latencyFnLine(s, ln, bs, be)) return;
    if (this.bareGraph(s, p, ln, bs, be)) return;
    this.unparsed(s, ln);
  }

  private lost(cpu: number, lost: number, ln: number): void {
    const slot = cpu + 1;
    const g = { cpu, lost, ts: this.cursor[slot] ?? 0, line: ln };
    this.b.gap(g);
    this.gapObjs.push(g);
    this.pendingGap[slot] = this.gapObjs.length; // 1-based; ts is filled by the next line on that CPU
    const t = this.curTask[slot];
    if (t !== undefined) this.b.flagOpen(t, F.GAP);
  }
  private gapObjs: { ts: number }[] = [];

  /** `[abstime |] cpu) [proc |] [lat |] [dur |] text`, or a `cpu) a-1 => b-2` banner. */
  private graphLine(s: string, p: number, ln: number, bs: number, be: number): boolean {
    const n = s.length;
    let T = NaN;
    let i = p;
    while (i < n && isDigit(s.charCodeAt(i))) i++;
    if (i === p) return false;
    if (s.charCodeAt(i) === 46) {
      // abstime
      let j = i + 1;
      while (j < n && isDigit(s.charCodeAt(j))) j++;
      const k = j;
      while (j < n && s.charCodeAt(j) === SP) j++;
      if (s.charCodeAt(j) !== BAR) return false;
      T = parseSecs(s, p, k);
      p = j + 1;
      while (p < n && s.charCodeAt(p) === SP) p++;
      i = p;
      while (i < n && isDigit(s.charCodeAt(i))) i++;
      if (i === p) return false;
    }
    if (s.charCodeAt(i) !== 41) return false; // ')'
    const cpu = parseNum(s, p, i);
    const slot = cpu + 1;
    p = i + 1;
    const o = this.b.meta.options;
    o.cpu = true;
    let bar = s.indexOf('|', p);
    if (bar < 0) {
      const arrow = s.indexOf(' => ', p);
      if (arrow < 0) return false;
      const [pc, pp] = splitTask(s.slice(p, arrow));
      const [nc, np] = splitTask(s.slice(arrow + 4));
      if (pp !== pp || np !== np) return false;
      const prev = this.task(pp, pc, cpu);
      const next = this.task(np, nc, cpu);
      this.claim(slot, prev);
      if (!this.sawSchedSwitch) this.b.switch(this.cursor[slot] ?? 0, cpu, prev, next);
      this.curTask[slot] = next;
      this.sawGraph = true;
      return true;
    }
    let task = -1;
    let dur = NaN;
    let durCol = false;
    // up to three columns before the text: proc, latency flags, duration
    for (let col = 0; col < 3 && bar >= 0; col++) {
      let a = p;
      while (a < bar && s.charCodeAt(a) === SP) a++;
      let z = bar;
      while (z > a && s.charCodeAt(z - 1) === SP) z--;
      const c = s.charCodeAt(a);
      if ((c === 61 || c === 60) && s.charCodeAt(a + 1) === 61) {
        // older kernels: `==========> |` / `<========== |` around hard interrupts
        const mk = s.slice(a, z);
        if (mk !== '==========>' && mk !== '<==========') return false;
        this.irqMark[cpu + 1] = mk === '==========>';
        this.sawGraph = true;
        return true;
      }
      if (a === z) {
        durCol = true; // empty duration column of an entry line
      } else if (s.charCodeAt(z - 1) === 115 && s.charCodeAt(z - 2) === 117) {
        // `us`: duration, maybe after an overhead mark
        let q = a;
        if (!isDigit(c)) q++;
        while (q < z && s.charCodeAt(q) === SP) q++;
        let e = q;
        while (e < z && s.charCodeAt(e) !== SP) e++;
        dur = parseNum(s, q, e);
        durCol = true;
      } else if (z - a === 1 && '+!#*@$'.indexOf(s[a]) >= 0) {
        durCol = true;
      } else if (task < 0 && col === 0 && isDigit(s.charCodeAt(z - 1)) && s.lastIndexOf('-', z) > a) {
        const [comm, pid] = splitTask(s.slice(a, z));
        if (pid !== pid) return false;
        task = this.task(pid, comm, cpu);
        o.proc = true;
      } else if (z - a <= 6 && /^[.0-9a-zA-Z]+$/.test(s.slice(a, z))) {
        o.latency = true;
      } else return false;
      p = bar + 1;
      if (durCol) break;
      bar = s.indexOf('|', p);
    }
    if (durCol) o.duration = true;
    if (T === T) o.abstime = true;
    if (task < 0) task = this.slotTask(slot, cpu);
    else {
      this.claim(slot, task);
      this.curTask[slot] = task;
    }
    this.sawGraph = true;
    return this.graphText(s, p, true, T === T ? this.rel(T) : NaN, cpu, task, dur, ln, bs, be);
  }

  private bareGraph(s: string, p: number, ln: number, bs: number, be: number): boolean {
    const t = s.trimEnd();
    const last = t.charCodeAt(t.length - 1);
    const c = s.charCodeAt(p);
    if (!(c === 125 || last === 59 || last === 123 || (t.endsWith('*/') && /^[\w.$]+\(/.test(s.slice(p)))))
      return false;
    this.sawGraph = true;
    return this.graphText(s, 0, false, NaN, -1, this.slotTask(0, -1), NaN, ln, bs, be);
  }

  /** The function text of a graph line, starting at `p` (just after the last column bar). */
  private graphText(
    s: string, p: number, bar: boolean, T: number, cpu: number, task: number, D: number,
    ln: number, bs: number, be: number,
  ): boolean {
    const b = this.b;
    const n = s.length;
    let q = p;
    while (q < n && s.charCodeAt(q) === SP) q++;
    if (q === n) return false;
    const indent = Math.max(0, (q - p - (bar ? 2 : 0)) >> 1);
    const slot = cpu + 1;
    const o = b.meta.options;
    if (this.pendingGap[slot]) {
      this.gapObjs[this.pendingGap[slot] - 1].ts = T === T ? T : (this.cursor[slot] ?? 0);
      this.pendingGap[slot] = 0;
    }
    const cur = this.cursor[slot] ?? 0;
    const fl = this.floor[task] ?? 0;
    let t = T === T ? Math.min(Math.max(cur, T), T + 0.999) : cur;
    if (t < fl) t = fl;
    const c = s.charCodeAt(q);

    if (c === 47 && s.charCodeAt(q + 1) === 42) {
      // `/* event: fields */`
      const colon = s.indexOf(':', q);
      if (colon < 0) return false;
      const name = s.slice(q + 2, colon).trim();
      let endc = s.lastIndexOf('*/');
      if (endc < colon) endc = n;
      this.emitEvent(name, s.slice(colon + 1, endc).trim(), t, cpu, task, ln, bs, be);
      return true;
    }
    if (c === 61 || c === 60) {
      // ==========> / <========== (older kernels)
      if (s.startsWith('==========>', q)) this.irqMark[slot] = true;
      else if (s.startsWith('<==========', q)) this.irqMark[slot] = false;
      else return false;
      return true;
    }

    // close any open calls this line's indentation says have ended
    const closing = c === 125;
    let top = b.top(task);
    while (top >= 0 && (closing ? b.indentOf(top) > indent : b.indentOf(top) >= indent)) {
      b.truncate(task, b.stackDepth(task) - 1);
      top = b.top(task);
    }
    this.lastInd[task] = indent;

    if (closing) {
      const ci = s.indexOf('/*', q);
      let info: CommentInfo | null = null;
      if (ci >= 0) {
        const ce = s.indexOf('*/', ci + 2);
        info = readComment(s.slice(ci + 2, ce < 0 ? n : ce));
        if (info.ret === info.ret) o.retval = true;
        if (info.retaddr) o.retaddr = true;
      }
      const func = info && info.name ? this.fid(info.name) : 0;
      const ret = info ? info.ret : NaN;
      let end: number;
      let id: number;
      if (top >= 0 && b.indentOf(top) === indent) {
        // interrupt runs that cannot be inside its printed duration move out of it
        const shedEnd = D === D ? b.shed(top, D) : NaN;
        const st = b.startOf(top);
        // the printed duration is exact; children are slid to fit inside it
        let d = D === D ? D : Math.max(t, fl) - st;
        if (d < 0) d = 0;
        id = b.exit({ ts: st + d, dur: d, cpu, task, line: ln, byteStart: bs, byteEnd: be, func, ret, indent });
        if (D === D && b.fit(id)) this.stretched++;
        end = b.endOf(id);
        if (shedEnd > end) end = shedEnd;
      } else {
        // an orphan: lay its end after what it adopts; without timestamps, a
        // childless one occupies its printed duration from here
        const prevDeeper = top < 0 ? b.spanCount > 0 : true;
        end = Math.max(t, fl);
        if (T !== T && D === D && !prevDeeper) end += D;
        id = b.exit({ ts: end, dur: D, cpu, task, line: ln, byteStart: bs, byteEnd: be, func, ret, indent });
        end = b.endOf(id);
        const p2 = b.top(task);
        if ((p2 >= 0 && b.flagsOf(p2) & F.IRQ) || this.irqFunc[func] || this.irqMark[slot]) b.addFlags(id, F.IRQ);
      }
      // with real timestamps the call's end is the best estimate of "now" on this CPU
      this.cursor[slot] = T === T && end > cur - 2 ? end : Math.max(cur, end);
      this.floor[task] = end;
      return true;
    }

    // entry or leaf: name(args) {  |  name(args);  [/* comment */]
    let e = q;
    while (e < n) {
      const ch = s.charCodeAt(e);
      if (ch === 40 || ch === SP || ch === 59 || ch === 123) break;
      e++;
    }
    if (e === q || s.charCodeAt(e) !== 40) return false;
    const func = this.fid(s.substring(q, e));
    let flags = 0;
    if (s.charCodeAt(e + 1) !== 41) {
      flags |= F.HAS_ARGS;
      o.args = true;
    }
    // the body ends where a trailing comment starts
    let ci = s.indexOf(' /*', e);
    let bodyEnd = ci < 0 ? n : ci;
    while (bodyEnd > e && s.charCodeAt(bodyEnd - 1) === SP) bodyEnd--;
    const last = s.charCodeAt(bodyEnd - 1);
    let ret = NaN;
    if (ci >= 0) {
      const ce = s.indexOf('*/', ci + 3);
      const info = readComment(s.slice(ci + 3, ce < 0 ? n : ce));
      ret = info.ret;
      if (ret === ret) o.retval = true;
      if (info.retaddr) o.retaddr = true;
    }
    if (last !== 123 && last !== 59) return false;
    if (top >= 0 && (b.flagsOf(top) & F.IRQ || indent > b.indentOf(top) + 1)) flags |= F.IRQ;
    if (this.irqFunc[func] || this.irqMark[slot]) flags |= F.IRQ;
    // a deeper run just before this line is an interrupt that hit while this
    // function was being entered: it becomes this call's first children
    if (last === 123) {
      const id = b.enter({ func, ts: t, cpu, task, line: ln, byteStart: bs, byteEnd: be, flags, indent });
      const runEnd = b.adoptDeeperBefore(id);
      const at = runEnd === runEnd ? Math.max(t, runEnd) : t;
      this.cursor[slot] = at;
      this.floor[task] = at;
    } else {
      const id = b.leaf({ func, ts: t, dur: D, cpu, task, line: ln, byteStart: bs, byteEnd: be, flags, indent, ret });
      const runEnd = b.adoptDeeperBefore(id);
      const st = b.startOf(id);
      let end = D === D ? st + D : st;
      if (runEnd === runEnd) {
        if (D === D && b.adoptedLoad(id) > D + 1e-6) {
          // too short to contain the run: the interrupt fired just before this call
          b.releaseRun(id);
          b.addFlags(id, F.LEAF);
          end = b.startOf(id) + D;
        } else {
          // an interrupt that fired inside this call: its printed duration covers the run
          if (D === D && b.fit(id)) this.stretched++;
          end = b.endOf(id);
        }
      }
      this.cursor[slot] = Math.max(cur, end);
      this.floor[task] = end;
    }
    return true;
  }

  private emitEvent(name: string, fields: string, t: number, cpu: number, task: number, ln: number, bs: number, be: number): void {
    const b = this.b;
    this.sawEvent = true;
    const ev = b.event({ name, ts: t, cpu, task, line: ln, byteStart: bs, byteEnd: be });
    if (name === 'sched_switch') {
      const m = /prev_comm=(.*?) prev_pid=(\d+).*?==> next_comm=(.*?) next_pid=(\d+)/.exec(fields);
      if (m) {
        const prev = this.task(Number(m[2]), m[1], cpu);
        const next = this.task(Number(m[4]), m[3], cpu);
        this.sawSchedSwitch = true;
        this.claim(cpu + 1, prev);
        b.switch(t, cpu, prev, next, ev);
        this.curTask[cpu + 1] = next;
      }
    }
  }

  /** `comm-pid [cpu] [flags] ts: rest` — function tracer, events, trace-cmd report. */
  private bracketLine(s: string, ln: number, bs: number, be: number): boolean {
    const br = s.indexOf(' [');
    if (br < 0) return false;
    const cb = s.indexOf(']', br);
    if (cb < 0) return false;
    const cpu = parseNum(s, br + 2, cb);
    if (cpu !== cpu || !/^\s*\d+\s*$/.test(s.slice(br + 2, cb))) return false;
    const [comm, pid] = splitTask(s.slice(0, br));
    if (pid !== pid) return false;
    const colon = s.indexOf(': ', cb);
    const colonEnd = colon < 0 && s.endsWith(':') ? s.length - 1 : colon;
    if (colonEnd < 0) return false;
    const head = s.slice(cb + 1, colonEnd).trim().split(/\s+/);
    const absT = parseSecs(head[head.length - 1], 0, head[head.length - 1].length);
    if (absT !== absT || head.length > 2) return false;
    if (head.length === 2) this.flagsCol = true;
    const rest = s.slice(colonEnd + 1).trimStart();
    return this.restOf(rest, s, this.rel(absT), cpu, this.task(pid, comm, cpu), ln, bs, be);
  }

  /** `comm-pid   3d.... 8055us : rest` (latency-format function tracer). */
  private latencyFnLine(s: string, ln: number, bs: number, be: number): boolean {
    const m = /^\s*(.*?)\s+(\d+)(\S*)\s+(\d+)us\s*: (.*)$/.exec(s);
    if (!m) return false;
    const [comm, pid] = splitTask(m[1]);
    if (pid !== pid) return false;
    const cpu = Number(m[2]);
    this.b.meta.options.latency = true;
    this.flagsCol = true;
    return this.restOf(m[5], s, this.rel(Number(m[4])), cpu, this.task(pid, comm, cpu), ln, bs, be);
  }

  private restOf(rest: string, s: string, t: number, cpu: number, task: number, ln: number, bs: number, be: number): boolean {
    const b = this.b;
    b.meta.options.abstime = true;
    const slot = cpu + 1;
    if (this.pendingGap[slot]) {
      this.gapObjs[this.pendingGap[slot] - 1].ts = t;
      this.pendingGap[slot] = 0;
    }
    this.curTask[slot] = task;
    const ev = /^([\w:.-]+?):(\s|$)/.exec(rest);
    if (ev && (ev[1] === 'funcgraph_entry' || ev[1] === 'funcgraph_exit')) {
      // trace-cmd: `funcgraph_entry:   0.961 us |  name();`
      this.traceCmd = true;
      this.sawGraph = true;
      const off = s.length - rest.length + ev[0].length;
      const bar = s.indexOf('|', off);
      if (bar < 0) return false;
      const ds = s.slice(off, bar).replace(/[+!#*@$]/g, '').trim();
      const D = ds ? parseNum(ds, 0, ds.indexOf(' ') < 0 ? ds.length : ds.indexOf(' ')) : NaN;
      if (D === D) b.meta.options.duration = true;
      // an exit's stamp is the call's end
      return this.graphText(s, bar + 1, true, t, cpu, task, D, ln, bs, be);
    }
    if (ev && ev[1] !== 'function') {
      this.emitEvent(ev[1], rest.slice(ev[0].length).trim(), t, cpu, task, ln, bs, be);
      return true;
    }
    let fn = ev ? rest.slice(ev[0].length).trim() : rest.trim();
    if (!fn || /\s/.test(fn.replace(/\s+<-+\s*\S+$/, ''))) return false;
    let caller = 0;
    const arrow = fn.indexOf(' <-');
    if (arrow >= 0) {
      caller = this.fid(fn.slice(arrow + 3).replace(/^-/, '').trim());
      fn = fn.slice(0, arrow).trim();
    }
    this.sawFunc = true;
    b.leaf({ func: this.fid(fn), ts: t, dur: NaN, cpu, task, line: ln, byteStart: bs, byteEnd: be, flags: F.NO_DUR, caller });
    return true;
  }

  // ---- finish --------------------------------------------------------------

  private done(): Trace {
    const b = this.b;
    const m = b.meta;
    m.lines = this.progress.lines;
    m.bytes = this.byte;
    m.format = this.sawGraph ? 'function_graph' : this.sawFunc ? 'function' : this.sawEvent ? 'events' : 'unknown';
    m.source = this.traceCmd ? 'trace-cmd' : this.sawHeader || this.flagsCol || m.options.cpu ? 'tracefs' : 'unknown';
    m.clock = this.t0 === this.t0 ? 'absolute' : 'reconstructed';
    m.t0Abs = this.t0 === this.t0 ? this.t0 / 1e6 : NaN;
    const tr = b.finish();
    const c = m.counts;
    const w = m.warnings;
    if (m.clock === 'reconstructed' && c.spans) w.push('The trace has no timestamps; times are laid out from the printed durations, one CPU at a time.');
    if (c.lost) w.push(`${c.lost} events were lost in ${c.gaps} gaps; calls open across a gap are incomplete.`);
    if (c.orphans && c.orphans === c.spans) w.push('Only closing lines were printed (tracing_thresh output); each call holds the slower calls printed inside it, and faster ones are missing.');
    else if (c.orphans) w.push(`${c.orphans} calls had begun before the trace started; only their ends are in it.`);
    if (c.unclosed) w.push(`${c.unclosed} calls never closed.`);
    if (c.unparsed) w.push(`${c.unparsed} lines were not understood.`);
    return tr;
  }
}

export function parseText(text: string): Trace {
  const p = new TraceParser();
  p.push(new TextEncoder().encode(text));
  return p.finish();
}
