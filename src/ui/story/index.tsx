import './story.css';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { CATEGORIES, F, type Trace } from '../../core/model';
import type { Analysis, Selection } from '../../core/api';
import { profile, storyChildren } from '../../core/analyze';
import { analysis, hover, matches, select, selection, trace } from '../state';
import { fmtCount, fmtDur } from '../format';
import { StoryTree, isIdleTrack, trackOrder, type RNode, type Row } from './rows';
import { distBins, nodeFunc, nodeSelection, rowIsSelected } from './view';

const OVERSCAN = 12;

function MidName({ name }: { name: string }) {
  // Middle ellipsis: the head shrinks, the last characters (usually the distinguishing ones) stay.
  if (name.length <= 18) return <span class="story-name">{name}</span>;
  const cut = name.length - 10;
  return <span class="story-name"><span class="story-name-head">{name.slice(0, cut)}</span><span class="story-name-tail">{name.slice(cut)}</span></span>;
}

export function Story(): JSX.Element {
  const t = trace.value, a = analysis.value;
  if (!t || !a) return <div class="story story-empty">No trace loaded.</div>;
  return <StoryBody key={t.spans.n + ':' + t.meta.bytes} t={t} a={a} />;
}

function StoryBody({ t, a }: { t: Trace; a: Analysis }) {
  const tree = useMemo(() => new StoryTree({ trace: t, analysis: a, storyChildren: (p, k) => storyChildren(t, a, p, k), profile: (s) => profile(t, a, s) }), [t, a]);
  const [open, setOpen] = useState<Set<string>>(() => {
    const first = trackOrder(t).find((i) => !isIdleTrack(t, i));
    return new Set(first === undefined ? [] : ['t' + first]);
  });
  const [cursor, setCursor] = useState<string | null>(null);
  const rows = useMemo(() => tree.flatten(open), [tree, open]);
  const index = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows]);
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const [rowH, setRowH] = useState(22);

  useLayoutEffect(() => {
    const el = box.current!;
    const v = parseFloat(getComputedStyle(el).getPropertyValue('--row'));
    if (v > 0) setRowH(v + 4);
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const scrollTo = (i: number) => {
    const el = box.current;
    if (!el || i < 0) return;
    const y = i * rowH;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + rowH > el.scrollTop + el.clientHeight) el.scrollTop = y - el.clientHeight * 0.4;
  };

  // Follow the selection from elsewhere (timeline, brief, `o`): open the path to it.
  const sel = selection.value;
  useEffect(() => {
    if (sel?.kind !== 'span') return;
    const cur = cursor !== null ? rows[index.get(cursor) ?? -1] : undefined;
    if (cur?.node.kind === 'span' && cur.node.span === sel.id) return;
    const p = tree.revealPath(sel.id);
    if (!p) return;
    const next = new Set(open);
    let changed = false;
    for (const k of p.open) if (!next.has(k)) { next.add(k); changed = true; }
    if (changed) setOpen(next);
    setCursor(p.target);
  }, [sel]);
  useEffect(() => { if (cursor) scrollTo(index.get(cursor) ?? -1); }, [cursor, index]);
  // While the Story is hidden (Timeline showing) scrolling does nothing, so a reveal made
  // then (`o` in the Timeline) is applied when it is shown again and gets its height back.
  const shown = height > 0;
  useEffect(() => {
    const el = box.current;
    if (!shown || !el || !cursor) return;
    const i = index.get(cursor) ?? -1;
    if (i >= 0 && (i * rowH < el.scrollTop || i * rowH + rowH > el.scrollTop + el.clientHeight)) el.scrollTop = Math.max(0, i * rowH - el.clientHeight * 0.4);
    setScroll(el.scrollTop);
  }, [shown]);

  const toggle = (r: Row, want?: boolean) => {
    if (!r.hasKids) return;
    const on = want ?? !r.open;
    if (on === r.open) return;
    const next = new Set(open);
    if (on) next.add(r.key);
    else for (const k of next) if (k === r.key || k.startsWith(r.key + '/')) next.delete(k);
    setOpen(next);
  };

  const activate = (r: Row, reveal: boolean) => {
    setCursor(r.key);
    const s = nodeSelection(r.node);
    if (s) {
      if (reveal) select(s);
      else selection.value = s;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let i = cursor !== null ? index.get(cursor) ?? 0 : 0;
    const r = rows[i];
    if (!r) return;
    const go = (j: number) => { const n = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (n) { setCursor(n.key); const s = nodeSelection(n.node); if (s && s.kind !== 'group') selection.value = s; } };
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i - 1); break;
      case 'PageDown': go(i + Math.floor(height / rowH)); break;
      case 'PageUp': go(i - Math.floor(height / rowH)); break;
      case 'ArrowRight': if (r.hasKids && !r.open) toggle(r, true); else if (r.open) go(i + 1); break;
      case 'ArrowLeft':
        if (r.open) toggle(r, false);
        else { const pk = r.key.slice(0, r.key.lastIndexOf('/')); const j = index.get(pk); if (j !== undefined) go(j); }
        break;
      case 'Enter': activate(r, true); break;
      default: return;
    }
    e.preventDefault();
  };

  const first = Math.max(0, Math.floor(scroll / rowH) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / rowH) + OVERSCAN);
  const m = matches.value;
  const selKey = cursor;
  // A span can appear twice (pinned outlier and in "all N calls"); the cursor's copy wins.
  const curRow = cursor !== null ? rows[index.get(cursor) ?? -1] : undefined;
  const cursorSel = !!curRow && rowIsSelected(curRow, sel);
  const vis: JSX.Element[] = [];
  for (let i = first; i < last; i++) {
    const r = rows[i];
    const f = nodeFunc(t, r.node);
    const dim = m !== null && f >= 0 && !m[f];
    vis.push(
      <RowView key={r.key} t={t} a={a} r={r} top={i * rowH} dim={dim}
        selected={cursorSel ? r.key === selKey : rowIsSelected(r, sel)}
        focused={r.key === selKey}
        onClick={(e) => { box.current?.focus(); if ((e.target as HTMLElement).closest('.story-tri')) toggle(r); else activate(r, false); }}
        onDbl={() => toggle(r)} />,
    );
  }
  return (
    <div class="story" ref={box} tabIndex={0} onKeyDown={onKey} onScroll={(e) => setScroll((e.currentTarget as HTMLElement).scrollTop)} onMouseLeave={() => (hover.value = -1)}>
      <div class="story-canvas" style={{ height: rows.length * rowH + 'px' }}>{vis}</div>
    </div>
  );
}

function RowView({ t, a, r, top, dim, selected, focused, onClick, onDbl }: {
  t: Trace; a: Analysis; r: Row; top: number; dim: boolean; selected: boolean; focused: boolean;
  onClick: (e: MouseEvent) => void; onDbl: () => void;
}) {
  const n = r.node;
  const cls = ['story-row', 'is-' + n.kind, selected && 'is-sel', focused && 'is-focus', dim && 'is-dim'].filter(Boolean).join(' ');
  const guides = [];
  for (let d = 0; d < r.depth; d++) guides.push(<i class="story-guide" style={{ left: `${10 + d * 14}px` }} />);
  const pad = 4 + r.depth * 14;
  const sw = (f: number) => <span class="story-swatch" style={{ background: `var(--cat-${CATEGORIES[t.funcs.cat[f]] ?? 'other'})` }} />;
  let label: JSX.Element, num: JSX.Element | string = '', marks: JSX.Element | null = null, extra: JSX.Element | null = null;
  const onHover = n.kind === 'span' ? () => (hover.value = n.span) : undefined;
  switch (n.kind) {
    case 'track': {
      const k = t.tracks[n.track];
      label = <span class="story-track">{k.name}</span>;
      num = <><span class="story-q">{fmtCount(k.spans)} calls · </span>{fmtDur(n.time)}</>;
      break;
    }
    case 'span': {
      const fl = t.spans.flags[n.span], f = t.spans.func[n.span];
      label = <>{sw(f)}<MidName name={t.funcs.name[f]} /></>;
      const cal = t.spans.caller[n.span];
      // The function tracer has no durations; its caller is the useful fact.
      num = !Number.isNaN(t.spans.dur[n.span]) ? fmtDur(t.spans.dur[n.span]) : cal ? <span class="story-q">← {t.funcs.name[cal]}</span> : '—';
      marks = (
        <span class="story-marks">
          {a.outlier[n.span] ? <span class="story-mark is-out" title="outlier">▲{n.pinned ? ` ×${(t.spans.dur[n.span] / Math.max(1e-9, a.funcStats[f].p50)).toFixed(0)}` : ''}</span> : null}
          {a.off[n.span] > 0.05 * t.spans.dur[n.span] ? <span class="story-mark is-off" title={`off-CPU ${fmtDur(a.off[n.span])}`} aria-label="off-CPU" /> : null}
          {fl & F.IRQ || a.irq[n.span] > 0.05 * t.spans.dur[n.span] ? <span class="story-mark" title="interrupt">↯</span> : null}
          {fl & (F.ORPHAN | F.UNCLOSED | F.GAP) ? <span class="story-mark is-warn" title="cut off or events lost">≋</span> : null}
        </span>
      );
      break;
    }
    case 'group': {
      label = <><span class="story-badge">×{fmtCount(n.spans.length)}</span>{sw(n.func)}<MidName name={t.funcs.name[n.func]} /></>;
      num = <><span class="story-q">median </span>{fmtDur(n.median)}<span class="story-q"> · max </span>{fmtDur(n.max)}</>;
      extra = <Dist t={t} spans={n.spans} med={n.median} />;
      if (n.outliers.length) marks = <span class="story-marks"><span class="story-mark is-out">▲{n.outliers.length}</span></span>;
      break;
    }
    case 'loop':
      label = <><span class="story-badge">×{fmtCount(n.reps)}</span><span class="story-name story-loop">{n.unit.map((f) => t.funcs.name[f]).join(' → ')}</span></>;
      num = fmtDur(n.total);
      break;
    case 'typical':
      label = <span class="story-quiet">typical call</span>;
      num = <><span class="story-q">mean </span>{fmtDur(r.time)}</>;
      break;
    case 'prof':
      label = <>{sw(n.node.func)}<MidName name={t.funcs.name[n.node.func]} /></>;
      {
        // Per typical call: how many times it runs, or "rare" when most members never get here.
        const mult = n.node.calls / n.per;
        num = <>{n.node.calls !== n.per && <span class="story-q" title={`in ${n.node.members} of ${n.per} calls`}>{n.node.members < n.per / 2 ? 'rare ' : `×${mult >= 10 ? Math.round(mult) : mult.toFixed(1)} `}</span>}{fmtDur(r.time)}</>;
      }
      break;
    case 'all':
      label = <span class="story-quiet">all {fmtCount(n.spans.length)} calls…</span>;
      break;
    case 'event':
      label = <span class="story-quiet">· {t.eventNames[t.events.name[n.event]]}</span>;
      break;
    case 'gap':
      label = <span class="story-warn">≋ {fmtCount(t.gaps[n.gap]?.lost ?? 0)} events lost on CPU {t.gaps[n.gap]?.cpu}</span>;
      break;
  }
  return (
    <div class={cls} style={{ top: top + 'px' }} onClick={onClick} onDblClick={onDbl} onMouseEnter={onHover}>
      {guides}
      <span class="story-lead" style={{ paddingLeft: pad + 'px' }}>
        <span class="story-tri">{r.hasKids ? (r.open ? '▾' : '▸') : ''}</span>
        {label}
        {marks}
      </span>
      {extra ?? <span />}
      <span class="story-num">{num}</span>
      <span class="story-barcell">{r.share > 0 && <span class="story-bar" style={{ width: `${Math.max(1, r.share * 100)}%` }} />}</span>
    </div>
  );
}

function Dist({ t, spans, med }: { t: Trace; spans: Int32Array; med: number }) {
  const bins = useMemo(() => distBins(t, spans, med), [spans, med]);
  return <span class="story-dist" title="durations relative to the median">{Array.from(bins, (h, i) => <i class={i >= 4 && h > 0 ? 'is-slow' : ''} style={{ height: `${h * 100}%` }} />)}</span>;
}

export type { RNode, Selection };
