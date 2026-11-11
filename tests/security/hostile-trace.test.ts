// A trace is untrusted input: it may come from a `?trace=` link to anywhere.
// Names in it (functions, events, tasks) must reach the page as text only.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseText } from '../../src/core/parse';
import { traceSource } from '../../src/ui/shell/trace-source';
import { eventTip, line, mono, renderTip } from '../../src/ui/timeline/tip';

const HOSTILE = '<img src=x onerror="window.__pwned=1">';

const trace = () =>
  parseText(
    [
      '   1.000001 |   3)  ls-249   |               |  f() {',
      `   1.000002 |   3)  ls-249   |               |    /* ${HOSTILE}: x=1 */`,
      '   1.000009 |   3)  ls-249   |   9.0 us    |  }',
    ].join('\n'),
  );

/** Just enough of a DOM to render a tooltip; any HTML parsing throws. */
class FakeNode {
  children: FakeNode[] = [];
  style: Record<string, string> = {};
  text = '';
  constructor(readonly ownerDocument: FakeDoc, readonly tag: string) {}
  set textContent(v: string) {
    this.text = v;
  }
  get textContent(): string {
    return this.tag === '#text' ? this.text : this.text + this.children.map((c) => c.textContent).join('');
  }
  appendChild(c: FakeNode) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: FakeNode[]) {
    this.children = c;
  }
  set innerHTML(_: string) {
    throw new Error('innerHTML used');
  }
  insertAdjacentHTML() {
    throw new Error('insertAdjacentHTML used');
  }
}
class FakeDoc {
  createElement(tag: string) {
    return new FakeNode(this, tag);
  }
  createTextNode(s: string) {
    const n = new FakeNode(this, '#text');
    n.text = s;
    return n;
  }
}

describe('a hostile trace', () => {
  it('keeps the event name as it was written', () => {
    const t = trace();
    expect(t.events.n).toBe(1);
    expect(t.eventNames[t.events.name[0]]).toBe(HOSTILE);
  });

  it('shows the event name in a tooltip as text, never as markup', () => {
    const t = trace();
    for (const evs of [[0], [0, 0]]) {
      const tip = new FakeDoc().createElement('div');
      renderTip(tip as unknown as HTMLElement, eventTip(t, evs, 10));
      expect(tip.textContent).toContain(HOSTILE);
      const tags = (n: FakeNode): string[] => [n.tag, ...n.children.flatMap(tags)];
      expect(new Set(tags(tip))).toEqual(new Set(['div', 'span', '#text']));
    }
  });

  it('renders every kind of segment through text nodes', () => {
    const tip = new FakeDoc().createElement('div');
    renderTip(tip as unknown as HTMLElement, [line('critical', HOSTILE, mono(HOSTILE, 'text-2'))]);
    expect(tip.textContent).toBe(HOSTILE + HOSTILE);
  });
});

describe('the page has no HTML sinks', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  it('src/ never parses strings as HTML', () => {
    const bad = files(join(__dirname, '../../src')).filter((f) =>
      /\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|createContextualFragment|document\.write)\b/.test(readFileSync(f, 'utf8')),
    );
    expect(bad).toEqual([]);
  });
});

describe('?trace= links', () => {
  const base = 'https://example.github.io/ftscope/?trace=x';
  it('open files on this site directly', () => {
    expect(traceSource('demo/mystery.trace.gz', base)).toBe('same');
    expect(traceSource('/ftscope/demo/a.trace', base)).toBe('same');
  });
  it('name the other site for files elsewhere', () => {
    expect(traceSource('https://gist.example.com/raw/a.trace', base)).toBe('https://gist.example.com');
    expect(traceSource('//other.example/a.trace', base)).toBe('https://other.example');
  });
  it('refuse anything that is not http(s)', () => {
    expect(traceSource('javascript:alert(1)', base)).toBeNull();
    expect(traceSource('data:text/plain,x', base)).toBeNull();
    expect(traceSource('blob:https://example.github.io/abc', base)).toBeNull();
  });
  it('from file:// every http(s) link is another site', () => {
    expect(traceSource('https://example.com/a.trace', 'file:///home/user/ftscope.html')).toBe('https://example.com');
  });
});
