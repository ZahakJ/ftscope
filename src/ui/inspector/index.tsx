import './inspector.css';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { Analysis, Explanation, FuncDetail, ProfileNode, Selection } from '../../core/api';
import { CATEGORIES, F, type Trace } from '../../core/model';
import { explain, funcDetail, profile } from '../../core/analyze';
import { analysis, colorMode, file, hover, mode, select, selectSpan, revealSpan, selection, trace } from '../state';
import { fmtCount, fmtDur, fmtTime } from '../format';
import { Compare } from './compare-view';
import {
  ancestors, bucketUs, graphCells, collapseCrumbs, eventFields, fmtPct, histGeom, irqParts, offWhere, parseRaw, peerDurs, rawWindow,
  readRaw, isNoise, sharedCut, slowerThan, stripTicks, taskWord, timeSplit, topChildren, type RawWindow,
} from './logic';

const fname = (t: Trace, f: number) => t.funcs.name[f] ?? '?';
const catName = (t: Trace, f: number) => CATEGORIES[t.funcs.cat[f]] ?? 'other';
const selFunc = (f: number) => select({ kind: 'func', id: f });

export function Swatch({ t, f }: { t: Trace; f: number }) {
  return <span class="insp-swatch" style={{ background: `var(--cat-${catName(t, f)})` }} />;
}

function Label({ children }: { children: preact.ComponentChildren }) {
  return <div class="insp-label">{children}</div>;
}

/** Backticked names become clickable code. */
function Prose({ text, t }: { text: string; t: Trace }) {
  const parts = text.split(/`([^`]+)`/);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return p;
        const f = t.funcs.name.indexOf(p);
        return f > 0 ? <code class="insp-link" onClick={() => selFunc(f)}>{p}</code> : <code>{p}</code>;
      })}
    </>
  );
}

function copy(s: string) {
  void navigator.clipboard?.writeText(s).catch(() => {});
}

export function Inspector(): JSX.Element {
  const t = trace.value, a = analysis.value, sel = selection.value;
  let body: JSX.Element;
  if (!t || !a || !sel) body = <Empty />;
  else if (sel.kind === 'span') body = <SpanView key={'s' + sel.id} t={t} a={a} id={sel.id} />;
  else if (sel.kind === 'func') body = <FuncView key={'f' + sel.id} t={t} a={a} f={sel.id} />;
  else if (sel.kind === 'group') body = <GroupView t={t} a={a} sel={sel} />;
  else body = <EventView key={'e' + sel.id} t={t} id={sel.id} />;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.scrollTo(0, 0); }, [sel]);
  return <aside class="insp" ref={ref}>{body}</aside>;
}

function Empty() {
  const cm = colorMode.value;
  return (
    <div class="insp-empty">
      <p>Select a call to see where its time went.</p>
      <Label>{cm === 'subsystem' ? 'Colour is subsystem' : 'Colour is surprise'}</Label>
      {cm === 'subsystem' ? (
        <ul class="insp-legend">
          {CATEGORIES.map((c) => <li><span class="insp-swatch" style={{ background: `var(--cat-${c})` }} />{c}</li>)}
        </ul>
      ) : (
        <ul class="insp-legend">
          {[0, 1, 2, 3, 4].map((h) => <li><span class="insp-swatch" style={{ background: `var(--heat-${h})` }} />{['typical', '2× typical', '4×', '8×', '16× or more'][h]}</li>)}
        </ul>
      )}
    </div>
  );
}

// ---- a call ------------------------------------------------------------------

function flagWords(t: Trace, a: Analysis, id: number): string[] {
  const f = t.spans.flags[id], out: string[] = [];
  if (f & F.IRQ) out.push('↯ interrupt');
  if (f & F.ORPHAN) out.push('⇤ cut off at start');
  if (f & F.UNCLOSED) out.push('⇥ never returned');
  if (f & F.GAP) out.push('≋ events lost inside');
  if (a.outlier[id]) out.push('▲ outlier');
  return out;
}

function SpanView({ t, a, id }: { t: Trace; a: Analysis; id: number }) {
  const s = t.spans, f = s.func[id], dur = s.dur[id];
  const task = t.tasks[s.task[id]];
  const stat = a.funcStats[f];
  const detail = useMemo(() => funcDetail(t, a, f), [t, a, f]);
  const ex = useMemo<Explanation | null>(() => (Number.isNaN(dur) ? null : explain(t, a, id)), [t, a, id]);
  const pos = detail.spans.indexOf(id);
  const step = (d: number) => {
    const n = detail.spans[pos + d];
    if (n !== undefined) selectSpan(n);
  };
  // `[` and `]` are global keys owned by the shell; the buttons here do the same.
  const crumbs = collapseCrumbs(ancestors(t, id));
  const split = timeSplit(dur, a.self[id], a.off[id], a.irq[id]);
  const kids = topChildren(t, id);
  const raw = useRaw(t, id);
  const info = raw ? parseRaw(raw.head[0]?.text ?? '', raw.tail.length ? raw.tail[raw.tail.length - 1].text : raw.head.length > 1 ? raw.head[raw.head.length - 1].text : null, fname(t, f)) : null;
  const durText = Number.isNaN(dur) ? (s.flags[id] & F.NO_DUR ? 'no duration' : 'unknown') : fmtDur(dur);
  return (
    <div class="insp-body">
      <div class="insp-actions">
        <button title="Previous call of this function  [" disabled={pos <= 0} onClick={() => step(-1)}>‹</button>
        <button title="Next call of this function  ]" disabled={pos < 0 || pos >= detail.spans.length - 1} onClick={() => step(1)}>›</button>
        <button title="Zoom to this call" onClick={() => revealSpan(id)}>zoom</button>
        <button title="Show in the other view" onClick={() => (mode.value = mode.value === 'story' ? 'timeline' : 'story')}>{mode.value === 'story' ? 'timeline' : 'story'}</button>
        <button title="Copy name" onClick={() => copy(fname(t, f))}>copy</button>
      </div>
      <h2 class="insp-name">{fname(t, f)}</h2>
      <div class="insp-sub">
        <span class="insp-cat"><Swatch t={t} f={f} />{catName(t, f)}</span>
        <span class="insp-dur">{durText}</span>
        {flagWords(t, a, id).map((w) => <span class={'insp-flag' + (w.startsWith('▲') ? ' is-out' : '')}>{w}</span>)}
      </div>
      {crumbs.length > 0 && (
        <div class="insp-crumbs">
          {crumbs.map((c) => (c < 0 ? <span class="insp-crumb-gap">…</span> : <a class="insp-crumb" onClick={() => selectSpan(c)} onMouseEnter={() => (hover.value = c)} onMouseLeave={() => (hover.value = -1)}>{fname(t, s.func[c])}</a>))}
        </div>
      )}
      <dl class="insp-facts">
        <dt>task</dt><dd>{task.comm} <span class="insp-q">{task.pid >= 0 ? task.pid : ''}</span></dd>
        <dt>cpu</dt><dd>{s.cpu[id] >= 0 ? s.cpu[id] : '?'}</dd>
        <dt>start</dt><dd>{fmtTime(s.start[id], Math.max(dur || 0, 1))}{t.meta.clock === 'reconstructed' && <span class="insp-q"> reconstructed</span>}</dd>
        <dt>line</dt><dd>{fmtCount(s.line[id] + 1)}</dd>
        {info?.args.map((x) => <><dt class="insp-arg">{x.name || 'arg'}</dt><dd>{x.value}</dd></>)}
        {info?.ret != null && <><dt>returned</dt><dd>{info.ret}{info.errno && <span class="insp-q"> ({info.errno})</span>}</dd></>}
        {info?.retaddr && <><dt>return to</dt><dd>{info.retaddr}</dd></>}
      </dl>

      {dur > 0 && (
        <section>
          <Label>Where the time went</Label>
          {/* grow factors are scaled to the duration: factors summing below 1 would leave the bar short */}
          <div class="insp-split">
            {(['self', 'children', 'off', 'irq'] as const).map((k) => split[k] > 0 && <span class={'insp-seg is-' + k} style={{ flex: `${(1000 * split[k]) / dur} 1 0` }} />)}
          </div>
          <div class="insp-split-legend">
            {(['self', 'children', 'off', 'irq'] as const).map((k) => (
              <span class={split[k] > 0 ? '' : 'is-zero'}><i class={'insp-key is-' + k} />{{ self: 'self', children: 'children', off: 'off-CPU', irq: 'interrupts' }[k]} <b>{fmtDur(split[k])}</b></span>
            ))}
          </div>
          <Causes t={t} a={a} id={id} />
          {kids.length > 0 && (
            <ul class="insp-bars">
              {kids.map((k) => (
                <li onClick={() => selectSpan(k.span)} title={'Select the slowest of these'}>
                  <span class="insp-bar-name"><Swatch t={t} f={k.func} />{fname(t, k.func)}</span>
                  <span class="insp-bar-num"><span class="insp-q insp-cnt">{k.calls > 1 ? '×' + fmtCount(k.calls) : ''}</span><span class="insp-tot">{fmtDur(k.total)}</span></span>
                  <span class="insp-bar" style={{ width: `${(100 * k.total) / dur}%` }} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {stat && stat.timed > 1 && !Number.isNaN(dur) && (
        <section>
          <Label>Among its peers</Label>
          <Hist hist={stat.hist} mark={dur} p50={stat.p50} p99={stat.p99} max={stat.max} onClick={() => selFunc(f)} />
          <PeerLine t={t} spans={detail.spans} pos={pos} dur={dur} />
        </section>
      )}

      {ex && <Why t={t} ex={ex} />}
      {stat && stat.timed > 1 && !Number.isNaN(dur) && <Compare t={t} id={id} peers={detail.spans} />}

      <RawLines t={t} raw={raw} />
    </div>
  );
}

/** Names the interrupt that landed inside the call and what it slept in. */
function Causes({ t, a, id }: { t: Trace; a: Analysis; id: number }) {
  const irqs = useMemo(() => (a.irq[id] > 0 ? irqParts(t, id).slice(0, 3) : []), [t, a, id]);
  const off = useMemo(() => (a.off[id] > 0 ? offWhere(t, a, id) : null), [t, a, id]);
  if (!irqs.length && !off) return null;
  const go = (sp: number) => ({ onClick: () => selectSpan(sp), onMouseEnter: () => (hover.value = sp), onMouseLeave: () => (hover.value = -1) });
  return (
    <ul class="insp-causes">
      {off && (
        <li {...go(off.span)} title="Select the call it slept in">
          <i class="insp-key is-off" />
          <span class="insp-cause-what">
            <span class="insp-cause-fix">off-CPU{off.span !== id && ' in'}</span>
            {off.span !== id && <code class="insp-cause-name">{fname(t, t.spans.func[off.span])}</code>}
            {off.ranTask >= 0 && <span class="insp-q insp-cause-fix">· {taskWord(t, off.ranTask)} ran</span>}
          </span>
          <b>{fmtDur(a.off[id])}</b>
        </li>
      )}
      {irqs.map((q) => (
        <li {...go(q.span)} title="Select the longest of these">
          <i class="insp-key is-irq" />
          <span class="insp-cause-what">
            {q.label.includes('interrupt') || q.label === 'IPI' ? <span class="insp-cause-fix">{q.label}</span> : <code class="insp-cause-name">{q.label}</code>}
            {q.count > 1 && <span class="insp-q insp-cause-fix">×{fmtCount(q.count)}</span>}
          </span>
          <b>{fmtDur(q.total)}</b>
        </li>
      ))}
    </ul>
  );
}

function PeerLine({ t, spans, pos, dur }: { t: Trace; spans: Int32Array; pos: number; dur: number }) {
  const r = useMemo(() => slowerThan(peerDurs(t, spans), dur, pos), [t, spans, pos, dur]);
  return <p class="insp-line">slower than <b>{fmtPct(r.frac, r.of)}</b> of {fmtCount(r.of)} other calls</p>;
}

function Hist({ hist, mark, p50, p99, max, onClick, big }: { hist: Uint32Array; mark?: number; p50: number; p99: number; max: number; onClick?: () => void; big?: boolean }) {
  const g = histGeom(hist);
  // Labels are laid out in label-widths (≈ 0.02 of the panel per character) so p99 never lands on typical or max.
  const W = big ? 0.019 : 0.02;
  type T = { v: number; label: string; x: number; l: number; r: number };
  const mk = (v: number, label: string, anchor: number): T => {
    const x = g.x(v), w = label.length * W;
    return { v, label, x, l: x - w * anchor, r: x + w * (1 - anchor) };
  };
  const ticks: T[] = [];
  if (p50 > 0) ticks.push(mk(p50, 'typical ' + fmtDur(p50), 0.1));
  const mx = max > p99 * 1.2 && max > 0 ? mk(max, 'max ' + fmtDur(max), 0.9) : null;
  if (p99 > p50 * 1.5) {
    const q = mk(p99, 'p99', 0.5);
    if ((!ticks[0] || q.l > ticks[0].r + 0.04) && (!mx || q.r < mx.l - 0.04)) ticks.push(q);
  }
  if (mx && (!ticks[0] || mx.l > ticks[0].r + 0.01)) ticks.push(mx);
  else if (mx) ticks.push({ ...mx, label: 'max', l: mx.x - 3 * W, r: mx.x });
  const tick = (k: T, i: number) => (
    <span class="insp-hist-tick" style={{ left: `${k.l * 100}%` }} key={i}><i style={{ left: `${((k.x - k.l) / Math.max(1e-6, k.r - k.l)) * 100}%` }} />{k.label}</span>
  );
  return (
    <div class={'insp-hist' + (big ? ' is-big' : '')} onClick={onClick} title={`buckets from ${fmtDur(bucketUs(g.lo))} to ${fmtDur(bucketUs(g.hi + 1))}`}>
      <div class="insp-hist-bars">
        {g.bars.map((h) => <span style={{ height: `${h * 100}%` }} class={h > 0 ? '' : 'is-empty'} />)}
        {mark !== undefined && <em class="insp-hist-mark" style={{ left: `${g.x(mark) * 100}%` }} />}
      </div>
      <div class="insp-hist-axis">
        {ticks.map(tick)}
      </div>
    </div>
  );
}

function presence(p: number, peers: number): string {
  if (p <= 0) return 'never in other calls';
  if (p >= 0.995) return 'in every call';
  return `in ${fmtCount(Math.round(p * peers))} of ${fmtCount(peers)}`;
}

const KIND: Record<string, string> = { self: 'self', 'new-path': 'new path', 'more-calls': 'more calls', slower: 'slower', 'off-cpu': 'off-CPU', irq: 'interrupt' };

function Why({ t, ex }: { t: Trace; ex: Explanation }) {
  // "Only 0 other timed calls" reads as a glitch; a lone call simply has nothing to be compared with.
  const verdict = ex.peers === 0 && /^Only 0 other/.test(ex.verdict) ? `The only timed call of \`${fname(t, t.spans.func[ex.span])}\` in the trace: nothing to compare it with.` : ex.verdict;
  if (!ex.slow) return <p class="insp-verdict is-quiet"><Prose t={t} text={verdict} /></p>;
  return (
    <section>
      <Label>Why this one was slow</Label>
      <p class="insp-verdict"><Prose t={t} text={ex.verdict} /></p>
      <ol class="insp-blame">
        {ex.blame.map((b, i) => (
          <li style={{ paddingLeft: `${i * 12}px` }} onClick={() => selectSpan(b.span)}>
            <span class="insp-blame-name">{i > 0 && <i class="insp-elbow">└</i>}<Swatch t={t} f={b.func} />{fname(t, b.func)}</span>
            <span class="insp-blame-num">{fmtDur(b.dur)} <span class="insp-q">vs {b.typical > 0 ? fmtDur(b.typical) : '—'} · {presence(b.presence, ex.peers)}</span></span>
          </li>
        ))}
      </ol>
      {ex.contributors.length > 0 && (
        <ul class="insp-contrib">
          {ex.contributors.slice(0, 6).map((c) => (
            <li onClick={() => c.span >= 0 && selectSpan(c.span)}>
              <span class="insp-kind">{KIND[c.kind] ?? c.kind}</span>
              <span class="insp-contrib-name">{c.path.length ? fname(t, c.path[c.path.length - 1]) : fname(t, t.spans.func[ex.span])}</span>
              <span class="insp-contrib-num" title={`${fmtCount(c.calls)} calls here, ${c.typicalCalls.toFixed(1)} typically`}>+{fmtDur(c.excess)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function useRaw(t: Trace, id: number): RawWindow | null {
  const [w, setW] = useState<RawWindow | null>(null);
  const f = file.value;
  useEffect(() => {
    let live = true;
    setW(null);
    if (!f) return;
    const a = t.spans.byteStart[id], b = t.spans.byteEnd[id];
    if (!(b > a)) return;
    readRaw(f.text, a, b).then((r) => live && setW(rawWindow(t.spans.line[id] + 1, r.head, r.tail)), () => {});
    return () => { live = false; };
  }, [t, id, f]);
  return w;
}

function RawText({ text }: { text: string }) {
  // Trailers (`/* ret=0x0 */`, events as comments) are quieter than the call itself.
  const parts = text.split(/(\/\*.*?\*\/)/);
  return <span class="insp-raw-t">{parts.map((p, i) => (i % 2 ? <span class="insp-raw-c">{p}</span> : p))}</span>;
}

function RawLines({ raw }: { t: Trace; raw: RawWindow | null }) {
  const [full, setFull] = useState(false);
  const all = raw ? [...raw.head, ...raw.tail] : [];
  const cut = useMemo(() => sharedCut(all.map((r) => r.text)), [raw]);
  if (!raw) return null;
  const c = full ? 0 : cut;
  const row = (r: RawWindow['head'][number]) => {
    const cells = full ? null : graphCells(r.text);
    return (
      <div class={'insp-raw-row' + (r.mark ? ' is-mark' : '')}>
        <span class="insp-raw-n">{r.n ?? ''}</span>
        {cells ? <><span class="insp-raw-d">{cells.dur}</span><RawText text={cells.body} /></> : <RawText text={c && !isNoise(r.text) ? r.text.slice(c) : r.text} />}
      </div>
    );
  };
  return (
    <section>
      <div class="insp-label-row">
        <Label>Raw lines</Label>
        <span>
          {(cut > 0 || all.some((r) => graphCells(r.text))) && <button class={'insp-mini' + (full ? ' is-on' : '')} title="Show the timestamp, CPU and task columns" onClick={() => setFull(!full)}>columns</button>}
          <button class="insp-mini" onClick={() => copy(all.map((r) => r.text).join('\n'))}>copy</button>
        </span>
      </div>
      <div class="insp-raw">
        <div class="insp-raw-inner">
          {raw.head.map(row)}
          {raw.gap && <div class="insp-raw-gap">{raw.gap}</div>}
          {raw.tail.map(row)}
        </div>
      </div>
    </section>
  );
}

// ---- a function ----------------------------------------------------------------

function BarList({ t, rows, onPick }: { t: Trace; rows: { func: number; calls: number; total: number }[]; onPick: (f: number) => void }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.total));
  return (
    <ul class="insp-bars">
      {rows.slice(0, 10).map((r) => (
        <li onClick={() => onPick(r.func)}>
          <span class="insp-bar-name"><Swatch t={t} f={r.func} />{fname(t, r.func)}</span>
          <span class="insp-bar-num"><span class="insp-q insp-cnt">×{fmtCount(r.calls)}</span><span class="insp-tot">{fmtDur(r.total)}</span></span>
          <span class="insp-bar" style={{ width: `${(100 * r.total) / max}%` }} />
        </li>
      ))}
    </ul>
  );
}

function FuncView({ t, a, f }: { t: Trace; a: Analysis; f: number }) {
  const d = useMemo<FuncDetail>(() => funcDetail(t, a, f), [t, a, f]);
  const st = d.stat;
  const cell = (k: string, v: string) => <div><span>{k}</span><b>{v}</b></div>;
  return (
    <div class="insp-body">
      <div class="insp-actions"><button onClick={() => copy(fname(t, f))}>copy</button></div>
      <h2 class="insp-name">{fname(t, f)}</h2>
      <div class="insp-sub"><span class="insp-cat"><Swatch t={t} f={f} />{catName(t, f)}</span>{st.outliers > 0 && <span class="insp-flag is-out">▲ {fmtCount(st.outliers)} outliers</span>}</div>
      <div class="insp-grid">
        {cell('calls', fmtCount(st.count))}{cell('total', fmtDur(st.total))}{cell('self', fmtDur(st.self))}
        {cell('typical', fmtDur(st.p50))}{cell('p90', fmtDur(st.p90))}{cell('p99', fmtDur(st.p99))}
        {cell('min', fmtDur(st.min))}{cell('max', fmtDur(st.max))}{cell('timed', fmtCount(st.timed))}
      </div>
      {st.timed > 0 && <section><Label>Durations</Label><Hist big hist={st.hist} p50={st.p50} p99={st.p99} max={st.max} /></section>}
      {d.callers.length > 0 && <section><Label>Called by</Label><BarList t={t} rows={d.callers} onPick={selFunc} /></section>}
      {d.callees.length > 0 && <section><Label>Calls</Label><BarList t={t} rows={d.callees} onPick={selFunc} /></section>}
      {d.slowest.length > 0 && (
        <section>
          <Label>Slowest calls</Label>
          <ul class="insp-slow">
            {d.slowest.map((s) => (
              <li onClick={() => selectSpan(s)} class={a.outlier[s] ? 'is-out' : ''}>
                <i title={a.outlier[s] ? 'outlier' : undefined}>{a.outlier[s] ? '▲' : ''}</i>
                <span>{fmtDur(t.spans.dur[s])}</span>
                <span class="insp-q">×{st.p50 > 0 ? (t.spans.dur[s] / st.p50).toFixed(1) : '—'}</span>
                <span class="insp-q">{t.tasks[t.spans.task[s]].comm} · {fmtTime(t.spans.start[s], t.meta.duration)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---- a folded group -------------------------------------------------------------

function GroupView({ t, a, sel }: { t: Trace; a: Analysis; sel: Extract<Selection, { kind: 'group' }> }) {
  const spans = sel.spans;
  const stats = useMemo(() => {
    const d = Array.from(spans, (s) => t.spans.dur[s]).filter((x) => !Number.isNaN(x)).sort((x, y) => x - y);
    const total = d.reduce((x, y) => x + y, 0);
    return { total, med: d.length ? d[d.length >> 1] : NaN, max: d.length ? d[d.length - 1] : NaN };
  }, [spans]);
  const ticks = useMemo(() => stripTicks(t, spans, stats.med), [spans, stats.med]);
  const prof = useMemo(() => profile(t, a, spans), [t, a, spans]);
  return (
    <div class="insp-body">
      <h2 class="insp-name"><span class="insp-q">×{fmtCount(spans.length)}</span> {fname(t, sel.func)}</h2>
      <div class="insp-sub"><span class="insp-cat"><Swatch t={t} f={sel.func} />{catName(t, sel.func)}</span></div>
      <div class="insp-grid">
        {[['total', stats.total], ['median', stats.med], ['max', stats.max]].map(([k, v]) => <div><span>{k}</span><b>{fmtDur(v as number)}</b></div>)}
      </div>
      <section>
        <Label>Every call, in order</Label>
        <div class="insp-strip" style={{ gap: spans.length < 150 ? '1px' : '0' }}>
          {Array.from(spans, (s, i) => (
            <span class={a.outlier[s] ? 'is-out' : ''} style={{ height: `${ticks[i] * 100}%` }} title={fmtDur(t.spans.dur[s])} onClick={() => selectSpan(s)} />
          ))}
        </div>
      </section>
      <section>
        <Label>Typical call</Label>
        <ul class="insp-prof">{prof.children.map((c) => <ProfRow t={t} n={c} per={spans.length} depth={0} />)}</ul>
      </section>
    </div>
  );
}

function ProfRow({ t, n, per, depth }: { t: Trace; n: ProfileNode; per: number; depth: number }) {
  const [open, setOpen] = useState(false);
  const mult = n.calls / per;
  const kids = n.children.length > 0;
  return (
    <li>
      <div class="insp-prof-row" style={{ paddingLeft: `${depth * 12}px` }} title={`in ${n.members} of ${per} calls`} onClick={() => (kids ? setOpen(!open) : selFunc(n.func))}>
        <span class="insp-tri">{kids ? (open ? '▾' : '▸') : ''}</span>
        <span class="insp-bar-name"><Swatch t={t} f={n.func} />{fname(t, n.func)}</span>
        <span class="insp-bar-num">{n.calls !== per && <span class="insp-q">{n.members < per / 2 ? 'rare ' : `×${mult >= 10 ? Math.round(mult) : mult.toFixed(1)} `}</span>}{fmtDur(n.total / per)}</span>
      </div>
      {open && kids && depth < 3 && <ul>{n.children.map((c) => <ProfRow t={t} n={c} per={per} depth={depth + 1} />)}</ul>}
    </li>
  );
}

// ---- an event ---------------------------------------------------------------------

function EventView({ t, id }: { t: Trace; id: number }) {
  const e = t.events, name = t.eventNames[e.name[id]] ?? '?';
  const [line, setLine] = useState<string | null>(null);
  const f = file.value;
  useEffect(() => {
    let live = true;
    if (f) f.text.slice(e.byteStart[id], Math.min(e.byteEnd[id], e.byteStart[id] + 4096)).text().then((s) => live && setLine(s.replace(/\r?\n$/, '')), () => {});
    return () => { live = false; };
  }, [id, f]);
  const task = t.tasks[e.task[id]];
  return (
    <div class="insp-body">
      <h2 class="insp-name">{name}</h2>
      <div class="insp-sub"><span class="insp-q">event</span></div>
      <dl class="insp-facts">
        <dt>time</dt><dd>{fmtTime(e.ts[id], t.meta.duration)}</dd>
        <dt>task</dt><dd>{task.comm} <span class="insp-q">{task.pid}</span></dd>
        <dt>cpu</dt><dd>{e.cpu[id]}</dd>
        <dt>line</dt><dd>{fmtCount(e.line[id] + 1)}</dd>
        {e.span[id] >= 0 && <><dt>inside</dt><dd><a class="insp-link" onClick={() => selectSpan(e.span[id])}>{fname(t, t.spans.func[e.span[id]])}</a></dd></>}
      </dl>
      {line && (
        <>
          <section><Label>Fields</Label><dl class="insp-facts">{eventFields(line, name).map((x) => <><dt class="insp-arg">{x.key}</dt><dd>{x.value}</dd></>)}</dl></section>
          <section><Label>Raw line</Label><div class="insp-raw"><div class="insp-raw-inner"><div class="insp-raw-row is-mark"><span class="insp-raw-n">{e.line[id] + 1}</span><span class="insp-raw-t">{line}</span></div></div></div></section>
        </>
      )}
    </div>
  );
}
