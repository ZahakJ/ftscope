import { describe, expect, it } from 'vitest';
import { isNoise, sharedCut } from '../../src/ui/inspector/logic';

// Each case: the first non-noise line's text from the cut should start at the duration column
// (or at the function text when that column is blank).
const after = (ls: string[]) => { const c = sharedCut(ls); return ls.map((l) => (isNoise(l) ? l : l.slice(c))); };

describe('sharedCut: the raw-line column cut', () => {
  it('cuts abstime, cpu and task columns down to the duration column', () => {
    const ls = [
      ' 26.127921 |   3)  mystery-557   |               |  __x64_sys_read() {',
      ' 26.127921 |   3)  mystery-557   |               |    ksys_read() {',
      ' 26.127922 |   3)  mystery-557   |   0.191 us    |      fdget_pos();',
      ' 26.127923 |   3)  mystery-557   | ! 194.1 us    |  }',
    ];
    const out = after(ls);
    expect(out[0].startsWith('|  __x64_sys_read')).toBe(false);
    // columns stay aligned: the `!` row sets the shared padding
    expect(out[2]).toMatch(/^ {2}0\.191 us\s+\|\s+fdget_pos\(\);$/);
    expect(out[3]).toMatch(/^! 194\.1 us/);
    expect(out[0].indexOf('|')).toBe(out[3].indexOf('|'));
    // every row keeps its function text
    expect(out[1]).toContain('ksys_read() {');
    // the padding all lines shared is gone, nothing more
    expect(out.every((l) => l.length > 0)).toBe(true);
  });

  it('leaves bare lines (duration column first) at their first shared character', () => {
    const ls = [
      ' 3)               |  vfs_read() {',
      ' 3)   0.191 us    |    rw_verify_area();',
      ' 3)   1.012 us    |  }',
    ];
    const c = sharedCut(ls);
    expect(ls[1].slice(c)).toContain('rw_verify_area();');
    expect(ls[0].slice(c)).toContain('vfs_read() {');
  });

  it('cuts nothing from duration-first lines without a cpu column, except shared padding', () => {
    const ls = ['               |  vfs_read() {', '   0.191 us    |    rw_verify_area();', '   1.012 us    |  }'];
    const c = sharedCut(ls);
    expect(c).toBe(3);
    expect(ls[1].slice(c)).toBe('0.191 us    |    rw_verify_area();');
  });

  it('ignores banners, separators and comments mixed in', () => {
    const ls = [
      ' 26.127921 |   3)  mystery-557   |               |  schedule() {',
      ' ------------------------------------------',
      '   3)  mystery-557   =>    <idle>-0   ',
      ' ------------------------------------------',
      '# a comment line',
      ' 26.127990 |   3)  mystery-557   |   54.0 us     |  }',
      '',
    ];
    const c = sharedCut(ls);
    expect(c).toBeGreaterThan(30);
    expect(ls[5].slice(c)).toMatch(/^54\.0 us\s+\|  }$/);
    expect(isNoise(ls[1]) && isNoise(ls[2]) && isNoise(ls[4]) && isNoise(ls[6])).toBe(true);
    expect(isNoise(ls[0])).toBe(false);
  });

  it('returns 0 when there is nothing safe to cut', () => {
    expect(sharedCut([])).toBe(0);
    expect(sharedCut(['# only comments'])).toBe(0);
    expect(sharedCut(['foo <-bar', 'baz <-qux'])).toBe(0);
    // bars at different columns: no shared cut
    expect(sharedCut(['a | b', 'aa | b'])).toBe(0);
  });
});
