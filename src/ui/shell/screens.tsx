// The screens shown instead of the workspace: empty, loading, error, a link's confirmation; and the help sheet.

import { useState } from 'preact/hooks';
import { fmtBytes } from '../format';
import { helpOpen, load } from '../state';
import { version } from '../../../package.json';
import { declineTraceParam, loadUrl, notTrace, pickFile } from './load';
import { Mark } from './topbar';
import { BLOG_URL, REPO_URL } from './links';

const RECORD = `cd /sys/kernel/tracing
echo function_graph > current_tracer
echo funcgraph-abstime > trace_options
echo funcgraph-proc > trace_options
echo 1 > events/sched/sched_switch/enable
echo > trace; echo 1 > tracing_on
your-command-here
echo 0 > tracing_on
cat trace > ~/my.trace`;

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      class="ghost small"
      onClick={() =>
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function Empty() {
  return (
    <main class="screen empty">
      <div class="drop-target" role="button" tabIndex={0} onClick={pickFile} onKeyDown={(e) => e.key === 'Enter' && pickFile()}>
        <Mark />
        <h1>Drop an ftrace here</h1>
        <p class="muted">
          or <span class="link">choose a file</span>, or paste trace text. Plain text or <code>.gz</code>.
        </p>
      </div>
      {/* From file:// the browser will not fetch the example files beside the page, so they are not offered. */}
      {location.protocol !== 'file:' && (
        <div class="demos">
          <span class="label">Or open an example</span>
          <button onClick={() => loadUrl('demo/mystery.trace.gz')}>A slow read, hiding among a thousand</button>
          <button onClick={() => loadUrl('demo/system.trace.gz')}>A whole system for 80 ms, 4 CPUs</button>
        </div>
      )}
      <section class="howto">
        <div class="howto-head">
          <h2>How to record a trace</h2>
          <Copy text={RECORD} />
        </div>
        <pre class="mono">{RECORD}</pre>
        <p class="muted">
          Or: <code>sudo tools/</code>
          <a class="link mono" href={`${REPO_URL}/blob/main/tools/ftscope-record`} target="_blank" rel="noopener">
            ftscope-record
          </a>
          <code> -- your-command</code>
        </p>
        <p class="muted">
          <a class="quiet-link" href={BLOG_URL} target="_blank" rel="noopener">
            How ftrace works →
          </a>
        </p>
      </section>
    </main>
  );
}

export function Loading() {
  const s = load.value;
  if (s.phase !== 'loading') return null;
  const frac = s.total > 0 ? Math.min(1, s.bytes / s.total) : 0;
  return (
    <main class="screen loading" aria-busy="true">
      <div class="loading-box">
        <div class="mono name">{s.name}</div>
        <div class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}>
          <i style={{ transform: `scaleX(${frac})` }} />
        </div>
        <div class="muted note">
          {s.note}
          {s.total > 0 && <span class="mono"> · {fmtBytes(s.total)}</span>}
        </div>
      </div>
    </main>
  );
}

export function Failed() {
  const s = load.value;
  if (s.phase !== 'error') return null;
  const lines = notTrace.value;
  return (
    <main class="screen failed">
      <div class="loading-box">
        <div class="mono name">{s.name}</div>
        <p>
          <span class="glyph-warn" aria-hidden="true">▲</span> {s.message}
        </p>
        {lines && lines.length > 0 && (
          <>
            <p class="failed-note">It begins:</p>
            <pre class="failed-lines mono">
              {lines.map((l) => (
                <div key={l.line}>
                  {/* The parser counts lines from 0; people count from 1. */}
                  <span class="ln">{l.line + 1}</span>
                  {l.text}
                </div>
              ))}
            </pre>
          </>
        )}
        <button onClick={pickFile}>Try another file</button>
      </div>
    </main>
  );
}

export function Confirm() {
  const s = load.value;
  if (s.phase !== 'confirm') return null;
  return (
    <main class="screen failed">
      <div class="loading-box">
        <div class="mono name">{s.name}</div>
        <p>
          This link opens a trace from another site, <span class="mono">{s.origin}</span>. Open it if you trust where
          the link came from; the file is read in your browser and goes nowhere.
        </p>
        <button onClick={() => loadUrl(s.url)}>Open it</button>{' '}
        <button class="ghost" onClick={declineTraceParam}>
          Cancel
        </button>
      </div>
    </main>
  );
}

const KEYS: [string, string][] = [
  ['/', 'Search functions; Enter / Shift+Enter step through matching calls'],
  ['1  2', 'Timeline · Story'],
  ['w  s', 'Zoom in · out'],
  ['a  d', 'Pan left · right'],
  ['f', 'Fit the selection'],
  ['0', 'Fit the whole trace'],
  ['[  ]', 'Previous · next call of the same function'],
  ['o', 'Next outlier'],
  ['c', 'Colour by subsystem · by surprise'],
  [',  .', 'Hide or show the left · right panel'],
  ['Esc', 'Clear search, then selection'],
  ['?', 'This sheet'],
];

export function Help() {
  if (!helpOpen.value) return null;
  return (
    <div class="help-backdrop" onClick={() => (helpOpen.value = false)}>
      <div class="help" role="dialog" aria-modal="true" aria-label="Help" onClick={(e) => e.stopPropagation()}>
        <div class="help-head">
          <h2>Keys</h2>
          <button class="ghost" onClick={() => (helpOpen.value = false)} aria-label="Close help">
            <kbd>Esc</kbd>
          </button>
        </div>
        <table>
          <tbody>
            {KEYS.map(([k, v]) => (
              <tr key={k}>
                <td class="keys">
                  {k.split('  ').map((x) => (
                    <kbd key={x}>{x}</kbd>
                  ))}
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>Colours and marks</h2>
        <p>
          Subsystem mode: colour is the kernel subsystem; grey is entry glue or unknown. Surprise mode: grey except calls slow
          against other calls of the same function, warmer the slower. Hollow: task switched out. Hatched: lost events.
          ▲: unreliable trace or outlier. Gold outline: selection.
        </p>
        <footer class="help-foot">
          <span class="mono">ftscope {version}</span>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </footer>
      </div>
    </div>
  );
}
