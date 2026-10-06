import { describe, expect, it } from 'vitest';
import { parseHash } from '../../src/ui/shell/url';

describe('parseHash', () => {
  it('reads every field', () => {
    expect(parseHash('#sel=42&v=1.5,20&m=story&c=surprise&f=vfs_read')).toEqual({
      sel: 42,
      v: [1.5, 20],
      m: 'story',
      c: 'surprise',
      f: 'vfs_read',
    });
  });
  it('ignores malformed values', () => {
    expect(parseHash('#sel=-1&v=5,2&m=nope&c=x')).toEqual({});
    expect(parseHash('')).toEqual({});
    expect(parseHash('#v=a,b&sel=1.5')).toEqual({});
  });
  it('decodes function names', () => {
    expect(parseHash('#f=' + encodeURIComponent('__x64_sys_read.cold')).f).toBe('__x64_sys_read.cold');
  });
});
