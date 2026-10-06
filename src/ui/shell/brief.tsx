import type { Insight } from '../../core/api';
import type { Selection } from '../../core/api';
import { analysis, select, selection, trace, zoomTo } from '../state';

/** Level and kind decide the glyph: outliers are critical, warnings warn, interrupts and off-CPU get a quiet ring. */
function Glyph({ ins }: { ins: Insight }) {
  if (ins.kind === 'outlier') return <span class="glyph g-critical" aria-label="outlier">▲</span>;
  if (ins.level === 'warn') return <span class="glyph g-warn" aria-label="warning">▲</span>;
  if (ins.kind === 'irq' || ins.kind === 'offcpu') return <span class="glyph g-ring" aria-hidden="true" />;
  return <span class="glyph" aria-hidden="true" />;
}

function sameTarget(a: Selection | undefined, b: Selection | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'group' || b.kind === 'group') return a.kind === 'group' && b.kind === 'group' && a.func === b.func;
  return a.id === b.id;
}

function selectFuncByName(name: string): void {
  const t = trace.value;
  if (!t) return;
  const id = t.funcs.name.indexOf(name);
  if (id > 0) select({ kind: 'func', id });
}

/** `detail` with backticked names as clickable code. */
export function Detail({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  // An arrow belongs to the name it points at: it wraps with that chip, never alone at a line end.
  const arrow = parts.map((p, i) => (i % 2 === 0 && i + 1 < parts.length ? /\s*→\s*$/.exec(p)?.[0] ?? '' : ''));
  const chip = (p: string, i: number) => (
    <code
      key={i}
      class="fn-link"
      role="link"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        selectFuncByName(p);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          e.preventDefault();
          selectFuncByName(p);
        }
      }}
    >
      {p}
    </code>
  );
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          arrow[i - 1] ? <span key={i} class="fn-arrow">→{'\u00a0'}{chip(p, i)}</span> : chip(p, i)
        ) : (
          arrow[i] ? p.slice(0, p.length - arrow[i].length) + (/^\s/.test(arrow[i]) ? ' ' : '') : p
        ),
      )}
    </>
  );
}

function go(ins: Insight) {
  if (ins.target) select(ins.target);
  if (ins.range) zoomTo(ins.range[0], ins.range[1]);
}

export function Brief() {
  const a = analysis.value;
  if (!a) return null;
  const head = a.insights[0]?.kind === 'summary' ? a.insights[0] : null;
  const rest = head ? a.insights.slice(1) : a.insights;
  const actionable = (i: Insight) => !!(i.target || i.range);
  const sel = selection.value;
  return (
    <div class="brief">
      {head && (
        <div class="brief-head">
          <h2>{head.title}</h2>
          {head.value && <div class="brief-value mono">{head.value}</div>}
          <p>
            <Detail text={head.detail} />
          </p>
        </div>
      )}
      <ol class="brief-list">
        {rest.map((ins) => (
          <li
            key={ins.id}
            class={
              `brief-item lvl-${ins.level}` +
              (actionable(ins) ? ' clickable' : '') +
              (sameTarget(ins.target, sel) ? ' current' : '')
            }
            tabIndex={actionable(ins) ? 0 : undefined}
            role={actionable(ins) ? 'button' : undefined}
            onClick={() => actionable(ins) && go(ins)}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && actionable(ins)) {
                e.preventDefault();
                go(ins);
              }
            }}
          >
            <Glyph ins={ins} />
            <div class="brief-body">
              <div class="brief-title">
                <span>{ins.title}</span>
                {ins.value && <span class="brief-value mono">{ins.value}</span>}
              </div>
              <p>
                <Detail text={ins.detail} />
              </p>
            </div>
            {actionable(ins) && (
              <span class="go" aria-hidden="true">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
