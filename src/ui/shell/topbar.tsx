import { useComputed } from '@preact/signals';
import type { RefObject } from 'preact';
import { CATEGORIES } from '../../core/model';
import { fmtCount, fmtDur } from '../format';
import { analysis, colorMode, file, helpOpen, matches, mode, search, selectSpan, selection, trace } from '../state';
import { pickFile } from './load';

export function Mark() {
  // A brace over a pulse: a call, seen on a scope.
  return (
    <svg class="mark" viewBox="0 0 20 16" width="20" height="16" aria-hidden="true">
      <path d="M1 4 Q1 1 4 1 H8 L10 0 L12 1 H16 Q19 1 19 4" fill="none" stroke="var(--accent)" stroke-width="1.4" />
      <path d="M1 12 H6 L8 6 L10 15 L12 9 L13.5 12 H19" fill="none" stroke="var(--text-2)" stroke-width="1.4" stroke-linejoin="round" />
    </svg>
  );
}

let matchCache: { key: Uint8Array | null; ids: Int32Array } = { key: null, ids: new Int32Array(0) };
function matchingCalls(): Int32Array {
  const m = matches.value;
  const t = trace.value;
  if (!m || !t) return new Int32Array(0);
  if (matchCache.key !== m) {
    const ids: number[] = [];
    for (let i = 0; i < t.spans.n; i++) if (m[t.spans.func[i]]) ids.push(i);
    const st = t.spans.start;
    ids.sort((a, b) => st[a] - st[b] || a - b);
    matchCache = { key: m, ids: Int32Array.from(ids) };
  }
  return matchCache.ids;
}

function step(dir: 1 | -1) {
  const ids = matchingCalls();
  if (!ids.length) return;
  const t = trace.value!;
  const s = selection.value;
  let i: number;
  if (s?.kind === 'span') {
    const at = t.spans.start[s.id];
    const cur = ids.indexOf(s.id);
    if (cur >= 0) i = cur + dir;
    else {
      i = 0;
      while (i < ids.length && t.spans.start[ids[i]] <= at) i++;
      if (dir < 0) i--;
    }
  } else i = dir > 0 ? 0 : ids.length - 1;
  i = (i + ids.length) % ids.length;
  selectSpan(ids[i]);
}

export function TopBar({ searchRef }: { searchRef: RefObject<HTMLInputElement> }) {
  const t = trace.value;
  const a = analysis.value;
  const summary = useComputed(() => {
    const m = matches.value;
    const an = analysis.value;
    if (!m || !an) return '';
    let funcs = 0;
    let calls = 0;
    for (let i = 1; i < m.length; i++) if (m[i]) {
      const c = an.funcStats[i]?.count ?? 0;
      if (c > 0) {
        funcs++;
        calls += c;
      }
    }
    return `${fmtCount(funcs)} function${funcs === 1 ? '' : 's'} · ${fmtCount(calls)} call${calls === 1 ? '' : 's'}`;
  });
  const meta = t?.meta;
  const reconstructed = meta?.clock === 'reconstructed';
  const lost = meta?.counts.lost ?? 0;
  const warnTitle = [
    lost > 0 ? `${fmtCount(lost)} events were lost by the kernel; calls open across a gap are incomplete.` : '',
    reconstructed ? 'No timestamps in this file: time is laid out from the printed durations, per CPU. Order is true; gaps between calls are not.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <header class="topbar">
      <span class="wordmark">
        <Mark />
        ftscope
      </span>
      {t && (
        <>
          <span class="filename mono" title={file.value?.name}>{file.value?.name}</span>
          <span class="chips">
            <span class="chip mono" title="Trace duration">{fmtDur(meta!.duration)}</span>
            <span class="chip" title="CPUs seen"><b class="mono">{t.cpus.length}</b> CPU{t.cpus.length === 1 ? '' : 's'}</span>
            <span class="chip" title="Tasks (threads)"><b class="mono">{fmtCount(t.tracks.length)}</b> task{t.tracks.length === 1 ? '' : 's'}</span>
            <span class="chip" title="Function calls"><b class="mono">{fmtCount(meta!.counts.spans)}</b> calls</span>
            {meta!.tracer && <span class="chip mono" title="Tracer">{meta!.tracer}</span>}
            {warnTitle && (
              <span class="chip warn" title={warnTitle} tabIndex={0}>
                <span aria-hidden="true">▲</span> {lost > 0 ? `${fmtCount(lost)} lost` : ''}
                {lost > 0 && reconstructed ? ' · ' : ''}
                {reconstructed ? 'time reconstructed' : ''}
              </span>
            )}
          </span>
        </>
      )}
      <span class="spacer" />
      {t && (
        <>
          <label class="search">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5" />
              <path d="M10.5 10.5 L14 14" stroke="currentColor" stroke-width="1.5" />
            </svg>
            <input
              ref={searchRef}
              class="mono"
              type="search"
              placeholder="Search functions"
              title="Search functions (/). Plain text, or /regex/. Enter steps through matching calls."
              aria-label="Search functions"
              spellcheck={false}
              value={search.value}
              onInput={(e) => (search.value = (e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  search.value = '';
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  step(e.shiftKey ? -1 : 1);
                }
              }}
            />
            {summary.value ? <span class="search-count">{summary.value}</span> : !search.value && <kbd class="hint">/</kbd>}
          </label>
          <div class="seg" role="group" aria-label="Main view">
            <button aria-pressed={mode.value === 'timeline'} onClick={() => (mode.value = 'timeline')} title="Timeline (1)">
              Timeline
            </button>
            <button aria-pressed={mode.value === 'story'} onClick={() => (mode.value = 'story')} title="Story (2)">
              Story
            </button>
          </div>
          <span class="colormode">
            <button
              class="ghost"
              onClick={() => (colorMode.value = colorMode.value === 'surprise' ? 'subsystem' : 'surprise')}
              title="Colour mode (c)"
              aria-describedby="legend"
            >
              <span class={'cm-glyph ' + colorMode.value} aria-hidden="true" />
              {colorMode.value === 'surprise' ? 'Surprise' : 'Subsystem'}
            </button>
            <div class="legend" id="legend" role="tooltip">
              {colorMode.value === 'subsystem' ? (
                CATEGORIES.map((c) => (
                  <span key={c} class="legend-item">
                    <i class="swatch" style={{ background: `var(--cat-${c})` }} />
                    {c}
                  </span>
                ))
              ) : (
                <span class="legend-item heat">
                  typical
                  {[0, 1, 2, 3, 4].map((i) => (
                    <i key={i} class="swatch" style={{ background: `var(--heat-${i})` }} />
                  ))}
                  slow among peers
                </span>
              )}
            </div>
          </span>
          <button class="ghost" onClick={pickFile} title="Open another file">
            Open…
          </button>
        </>
      )}
      <button class="ghost key" onClick={() => (helpOpen.value = !helpOpen.value)} title="Keyboard and legend (?)" aria-label="Help">
        ?
      </button>
      {a && null}
    </header>
  );
}
