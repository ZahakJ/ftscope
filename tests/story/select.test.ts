import { describe, expect, it } from 'vitest';
import { rowIsSelected } from '../../src/ui/story/view';
import type { Row } from '../../src/ui/story/rows';

const group = (func: number, spans: number[]): Row => ({
  key: 'g', depth: 0, time: 0, share: NaN, hasKids: true, open: false,
  node: { kind: 'group', func, spans: Int32Array.from(spans), total: 0, median: 0, max: 0, outliers: [] },
} as Row);
const loop = (spans: number[]): Row => ({
  key: 'l', depth: 0, time: 0, share: NaN, hasKids: true, open: false,
  node: { kind: 'loop', unit: [1, 2], reps: spans.length / 2, spans: Int32Array.from(spans), total: 0 },
} as unknown as Row);

describe('group selection matches by content', () => {
  it('matches a fresh array with the same function, length and ends', () => {
    const r = group(5, [10, 11, 12, 13]);
    expect(rowIsSelected(r, { kind: 'group', func: 5, spans: Int32Array.from([10, 11, 12, 13]) })).toBe(true);
    expect(rowIsSelected(r, { kind: 'group', func: 5, spans: (r.node as { spans: Int32Array }).spans })).toBe(true);
  });
  it('rejects another function, length or end', () => {
    const r = group(5, [10, 11, 12, 13]);
    expect(rowIsSelected(r, { kind: 'group', func: 6, spans: Int32Array.from([10, 11, 12, 13]) })).toBe(false);
    expect(rowIsSelected(r, { kind: 'group', func: 5, spans: Int32Array.from([10, 11, 13]) })).toBe(false);
    expect(rowIsSelected(r, { kind: 'group', func: 5, spans: Int32Array.from([10, 11, 12, 14]) })).toBe(false);
    expect(rowIsSelected(r, { kind: 'group', func: 5, spans: Int32Array.from([9, 11, 12, 13]) })).toBe(false);
  });
  it('never matches empty runs or non-group rows', () => {
    expect(rowIsSelected(group(5, []), { kind: 'group', func: 5, spans: new Int32Array(0) })).toBe(false);
    const span = { key: 's', depth: 0, time: 0, share: NaN, hasKids: false, open: false, node: { kind: 'span', span: 10 } } as Row;
    expect(rowIsSelected(span, { kind: 'group', func: 5, spans: Int32Array.from([10]) })).toBe(false);
    expect(rowIsSelected(span, { kind: 'span', id: 10 })).toBe(true);
  });
  it('matches a loop by its members, whatever function the selection names', () => {
    const r = loop([1, 2, 3, 4]);
    expect(rowIsSelected(r, { kind: 'group', func: 99, spans: Int32Array.from([1, 2, 3, 4]) })).toBe(true);
    expect(rowIsSelected(r, { kind: 'group', func: 99, spans: Int32Array.from([1, 2, 3]) })).toBe(false);
  });
});
