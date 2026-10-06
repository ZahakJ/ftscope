import { describe, expect, it } from 'vitest';
import { StoryTree, trackOrder } from '../../src/ui/story/rows';
import { distBins, nodeSelection, rowIsSelected } from '../../src/ui/story/view';
import { makeTrace, spansOf, stubAnalysis, stubQ } from './fixture';

describe('story rows', () => {
  const t = makeTrace(20, [7]);
  const reads = spansOf(t, 'read');
  const a = stubAnalysis(t, [reads[7]]);
  const tree = new StoryTree(stubQ(t, a));

  it('orders tracks by traced time, busiest first', () => {
    expect(t.tracks[trackOrder(t)[0]].name).toContain('cat');
  });

  it('shows only tracks when nothing is open, and folds the reads when opened', () => {
    expect(tree.flatten(new Set()).length).toBe(t.tracks.length);
    const top = tree.tops()[0].key;
    const main = tree.children(top, tree.tops()[0].node)[0];
    const rows = tree.flatten(new Set([top, main.key]));
    const group = rows.find((r) => r.node.kind === 'group')!;
    expect(group.node.kind === 'group' && group.node.spans.length).toBe(20);
    expect(rows.find((r) => r.node.kind === 'span' && r.depth === 2)).toBeTruthy(); // write()
  });

  it('opens a group into pinned outliers, a typical call and all members', () => {
    const top = tree.tops()[0];
    const main = tree.children(top.key, top.node)[0];
    const g = tree.children(main.key, main.node).find((c) => c.node.kind === 'group')!;
    const rows = tree.flatten(new Set([top.key, main.key, g.key, g.key + '/all']));
    const under = rows.filter((r) => r.key.startsWith(g.key + '/'));
    expect(under[0].node).toMatchObject({ kind: 'span', span: reads[7], pinned: true });
    expect(under[1].node.kind).toBe('typical');
    expect(under[2].node.kind).toBe('all');
    expect(under.length).toBe(3 + 20);
    // members are measured against the slowest: the outlier is the long bar
    expect(under[0].share).toBe(1);
  });

  it('reveals a typical member through "all N calls"', () => {
    const p = tree.revealPath(spansOf(t, 'copy')[3])!;
    expect(p).not.toBeNull();
    const rows = tree.flatten(new Set(p.open));
    const hit = rows.find((r) => r.key === p.target)!;
    expect(hit.node).toMatchObject({ kind: 'span', span: spansOf(t, 'copy')[3] });
    expect(p.open.some((k) => k.endsWith('/all'))).toBe(true);
  });

  it('reveals an outlier through its pinned row, down to its deepest child', () => {
    const io = spansOf(t, 'io')[0];
    const p = tree.revealPath(io)!;
    expect(p.open.some((k) => k.endsWith('/all'))).toBe(false);
    expect(p.open.some((k) => /\/o\d+$/.test(k))).toBe(true);
    const rows = tree.flatten(new Set(p.open));
    expect(rows.find((r) => r.key === p.target)?.node).toMatchObject({ kind: 'span', span: io });
  });

  it('flattens 100 000 open rows quickly', () => {
    const big = makeTrace(100_000, []);
    const bt = new StoryTree(stubQ(big, stubAnalysis(big)));
    const p = bt.revealPath(spansOf(big, 'read')[5])!;
    const t0 = performance.now();
    const rows = bt.flatten(new Set(p.open));
    expect(rows.length).toBeGreaterThan(100_000);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('maps rows to selections and back', () => {
    const r = { key: 'x', depth: 0, node: { kind: 'span' as const, span: 3 }, time: 1, share: 1, hasKids: false, open: false };
    expect(nodeSelection(r.node)).toEqual({ kind: 'span', id: 3 });
    expect(rowIsSelected(r, { kind: 'span', id: 3 })).toBe(true);
    expect(rowIsSelected(r, { kind: 'func', id: 3 })).toBe(false);
  });

  it('bins a group around its median, slow members to the right', () => {
    const bins = distBins(t, Int32Array.from(reads), t.spans.dur[reads[0]]);
    expect(bins[2]).toBe(1);
    expect(bins[7] + bins[6] + bins[5] + bins[4]).toBeGreaterThan(0);
  });
});
