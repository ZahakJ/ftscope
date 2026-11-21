// Tooltip content. Names in a tooltip come from the trace file (function,
// event and task names), and a trace can come from anywhere, so a tooltip is
// described as plain lines of text and built with text nodes: nothing in it
// is ever parsed as HTML.

import type { Trace } from '../../core/model';
import { fmtCount, fmtTime } from '../format';

export type Tone = 'text-2' | 'text-3' | 'warn' | 'critical';
/** A run of text; `mono` sets it in the monospace face. */
export type Seg = string | { mono: string; tone?: Tone };
export type TipLine = { tone?: Tone; segs: Seg[] };

export const line = (tone: Tone | undefined, ...segs: Seg[]): TipLine => ({ tone, segs });
export const mono = (text: string, tone?: Tone): Seg => ({ mono: text, tone });

/** Replace the tooltip's content with `lines`, as text only. */
export function renderTip(tip: HTMLElement, lines: TipLine[]): void {
  const doc = tip.ownerDocument;
  const rows = lines.map((l) => {
    const row = doc.createElement('div');
    if (l.tone) row.style.color = `var(--${l.tone})`;
    for (const s of l.segs) {
      if (typeof s === 'string') {
        row.appendChild(doc.createTextNode(s));
      } else {
        const span = doc.createElement('span');
        span.style.font = 'var(--fs-mono) var(--font-mono)';
        if (s.tone) span.style.color = `var(--${s.tone})`;
        span.textContent = s.mono;
        row.appendChild(span);
      }
    }
    return row;
  });
  tip.replaceChildren(...rows);
}

/** The tooltip over one or more event marks. */
export function eventTip(t: Trace, evs: number[], span: number): TipLine[] {
  if (evs.length > 1) {
    const names = [...new Set(evs.map((e) => t.eventNames[t.events.name[e]]))].slice(0, 4).join(', ');
    return [line(undefined, mono(`${fmtCount(evs.length)} events`)), line('text-3', `${names} · click to zoom in`)];
  }
  const e0 = evs[0];
  return [line(undefined, mono(t.eventNames[t.events.name[e0]])), line('text-2', mono(fmtTime(t.events.ts[e0], span)), ' · event')];
}
