import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { FuncStat } from '../../core/api';
import { CATEGORIES } from '../../core/model';
import { ellipsizeMiddle, fmtCount, fmtDur } from '../format';
import { analysis, matches, select, selection, trace } from '../state';

type Key = 'name' | 'count' | 'self' | 'total' | 'p50' | 'max';
const COLS: { key: Key; label: string; title: string }[] = [
  { key: 'name', label: 'Function', title: 'Function name' },
  { key: 'count', label: 'Calls', title: 'Number of calls' },
  { key: 'self', label: 'Self', title: 'Time in the function itself, not its children' },
  { key: 'total', label: 'Total', title: 'Wall time including children' },
  { key: 'p50', label: 'Typical', title: 'Median call duration' },
  { key: 'max', label: 'Max', title: 'Slowest call' },
];
const ROW = 22;

/**
 * A log-duration histogram as one SVG path, drawn over buckets [lo, hi] — the
 * range every function shares, so a bar at the same x is the same duration in
 * every row. Heights are sqrt-scaled so rare slow calls stay visible.
 */
function sparkPath(h: Uint32Array, lo: number, hi: number, w: number, ht: number): string {
  let max = 0;
  for (let i = lo; i <= hi; i++) if (h[i] > max) max = h[i];
  if (!max) return '';
  const bw = w / (hi - lo + 1);
  let d = '';
  for (let i = lo; i <= hi; i++) {
    const v = h[i] ?? 0;
    if (!v) continue;
    const y = Math.max(1, Math.round(Math.sqrt(v / max) * ht));
    d += `M${((i - lo) * bw).toFixed(1)} ${ht}v-${y}h${Math.max(1, bw - 0.5).toFixed(1)}v${y}z`;
  }
  return d;
}

/** Width of one character of the table's monospace face, measured once. */
let monoW = 0;
function charWidth(el: Element): number {
  if (monoW) return monoW;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return 7.2;
  const cs = getComputedStyle(el);
  ctx.font = `${cs.fontSize} ${cs.fontFamily}`;
  monoW = ctx.measureText('0123456789abcdef').width / 16 || 7.2;
  return monoW;
}

const SPARK_W = 64;
const SPARK_H = 14;

export function Functions() {
  const a = analysis.value;
  const t = trace.value;
  const m = matches.value;
  const [sort, setSort] = useState<{ key: Key; desc: boolean }>({ key: 'self', desc: true });
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const [cursor, setCursor] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const nameHead = useRef<HTMLButtonElement>(null);
  // Characters that fit in the name column; the name is the content, so it gets all the room the numbers leave.
  const [nameChars, setNameChars] = useState(24);

  const rows = useMemo(() => {
    if (!a || !t) return [] as FuncStat[];
    const out = a.funcStats.filter((s) => s && s.count > 0 && (!m || m[s.func]));
    const k = sort.key;
    const dir = sort.desc ? -1 : 1;
    if (k === 'name') out.sort((x, y) => dir * t.funcs.name[x.func].localeCompare(t.funcs.name[y.func]));
    else out.sort((x, y) => dir * ((x[k] || 0) - (y[k] || 0)) || x.func - y.func);
    return out;
  }, [a, t, m, sort]);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => setCursor(0), [m]);
  useEffect(() => {
    const el = nameHead.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // 14 px for the swatch and its gap; the body may also lose a scrollbar's width that the header does not.
      const b = body.current;
      const cw = charWidth(b ?? el);
      const bar = b && el.parentElement ? Math.max(0, el.parentElement.clientWidth - b.clientWidth) : 0;
      setNameChars(Math.max(4, Math.floor((el.clientWidth - 14 - bar) / cw)));
    });
    ro.observe(el);
    if (body.current) ro.observe(body.current);
    return () => ro.disconnect();
  }, []);

  // The bucket range any function uses, shared by every sparkline.
  const range = useMemo(() => {
    let lo = 40;
    let hi = -1;
    for (const s of a?.funcStats ?? []) {
      if (!s || !s.count) continue;
      for (let i = 0; i < s.hist.length; i++)
        if (s.hist[i]) {
          if (i < lo) lo = i;
          if (i > hi) hi = i;
        }
    }
    if (hi < lo) return [0, 39] as const;
    // At least 12 buckets wide, so a function with one duration is a bar and not a block.
    while (hi - lo < 11) {
      if (lo > 0) lo--;
      if (hi - lo < 11 && hi < 39) hi++;
      if (lo === 0 && hi === 39) break;
    }
    return [lo, hi] as const;
  }, [a]);

  if (!a || !t) return null;
  const selFunc = selection.value?.kind === 'func' ? selection.value.id : -1;
  const first = Math.max(0, Math.floor(scroll / ROW) - 4);
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 4);

  const moveTo = (i: number) => {
    const c = Math.max(0, Math.min(rows.length - 1, i));
    setCursor(c);
    const el = body.current;
    if (!el) return;
    if (c * ROW < el.scrollTop) el.scrollTop = c * ROW;
    else if ((c + 1) * ROW > el.scrollTop + el.clientHeight) el.scrollTop = (c + 1) * ROW - el.clientHeight;
  };
  const onKey = (e: KeyboardEvent) => {
    const page = Math.max(1, Math.floor(height / ROW) - 1);
    const k = e.key;
    if (k === 'ArrowDown') moveTo(cursor + 1);
    else if (k === 'ArrowUp') moveTo(cursor - 1);
    else if (k === 'PageDown') moveTo(cursor + page);
    else if (k === 'PageUp') moveTo(cursor - page);
    else if (k === 'Home') moveTo(0);
    else if (k === 'End') moveTo(rows.length - 1);
    else if (k === 'Enter' && rows[cursor]) select({ kind: 'func', id: rows[cursor].func });
    else return;
    e.preventDefault();
  };

  return (
    <div class="functions">
      <div class="ft-row ft-head" role="row">
        {COLS.map((c) => (
          <button
            key={c.key}
            ref={c.key === 'name' ? nameHead : undefined}
            class={'ft-cell ft-' + c.key + (sort.key === c.key ? ' sorted' : '')}
            title={c.title}
            aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined}
            onClick={() => setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.key !== 'name' }))}
          >
            {c.label}
            {sort.key === c.key && <span class="arrow">{sort.desc ? '↓' : '↑'}</span>}
          </button>
        ))}
        <span class="ft-cell ft-hist" title="Durations of its calls, on one log scale shared by every row">
          Spread
        </span>
      </div>
      <div
        class="ft-body"
        ref={body}
        tabIndex={0}
        role="grid"
        aria-label="Functions"
        onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}
        onKeyDown={onKey}
      >
        {!rows.length && <div class="ft-empty">No function matches the search.</div>}
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(first, last).map((s, k) => {
            const i = first + k;
            const name = t.funcs.name[s.func];
            const cls =
              'ft-row' + (s.func === selFunc ? ' selected' : '') + (i === cursor ? ' cursor' : '');
            return (
              <div
                key={s.func}
                class={cls}
                role="row"
                style={{ top: i * ROW }}
                onClick={() => {
                  setCursor(i);
                  select({ kind: 'func', id: s.func });
                }}
              >
                <span class="ft-cell ft-name mono" title={name}>
                  <i class="swatch" style={{ background: `var(--cat-${CATEGORIES[t.funcs.cat[s.func]] ?? 'other'})` }} />
                  <span class="ft-label">{ellipsizeMiddle(name, nameChars - (s.outliers > 0 ? 3 + String(s.outliers).length : 0))}</span>
                  {s.outliers > 0 && (
                    <span class="badge" title={`${s.outliers} call${s.outliers === 1 ? '' : 's'} slow among peers`}>
                      {s.outliers}
                    </span>
                  )}
                </span>
                <span class="ft-cell ft-count mono">{fmtCount(s.count)}</span>
                <span class="ft-cell ft-self mono">{s.timed ? fmtDur(s.self) : '—'}</span>
                <span class="ft-cell ft-total mono">{s.timed ? fmtDur(s.total) : '—'}</span>
                <span class="ft-cell ft-p50 mono">{s.timed ? fmtDur(s.p50) : '—'}</span>
                <span class="ft-cell ft-max mono">{s.timed ? fmtDur(s.max) : '—'}</span>
                <span class="ft-cell ft-hist">
                  <svg viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} aria-hidden="true">
                    <path d={sparkPath(s.hist, range[0], range[1], SPARK_W, SPARK_H)} />
                  </svg>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
