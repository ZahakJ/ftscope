import { describe, expect, it } from 'vitest';
import { ellipsizeMiddle, fmtBytes, fmtCount, fmtDur, fmtTime } from '../../src/ui/format';

describe('fmtDur', () => {
  it('uses three significant digits and a fitting unit', () => {
    expect(fmtDur(0.812)).toBe('812 ns');
    expect(fmtDur(8.2149)).toBe('8.21 µs');
    expect(fmtDur(194.4)).toBe('194 µs');
    expect(fmtDur(2100)).toBe('2.10 ms');
    expect(fmtDur(1.25e6)).toBe('1.25 s');
    expect(fmtDur(0.0405)).toBe('40.5 ns');
  });
  it('carries rounding into the next unit', () => {
    expect(fmtDur(0.9996)).toBe('1.00 µs');
    expect(fmtDur(999.7)).toBe('1.00 ms');
  });
  it('handles zero and missing values', () => {
    expect(fmtDur(0)).toBe('0');
    expect(fmtDur(0.00088)).toBe('<1 ns');
    expect(fmtDur(0.0012)).toBe('1.20 ns');
    expect(fmtDur(NaN)).toBe('—');
  });
  it('keeps very long durations in seconds', () => {
    expect(fmtDur(4_500_000_000)).toBe('4 500 s');
  });
});

describe('fmtCount', () => {
  it('groups thousands with thin spaces', () => {
    expect(fmtCount(51830)).toBe('51 830');
    expect(fmtCount(999)).toBe('999');
    expect(fmtCount(1000000)).toBe('1 000 000');
    expect(fmtCount(-1234)).toBe('-1 234');
  });
});

describe('fmtTime', () => {
  it('fits precision to the visible span', () => {
    expect(fmtTime(12345.678, 100_000)).toBe('12.3 ms');
    expect(fmtTime(12345.678, 10)).toBe('12.34568 ms');
    expect(fmtTime(2_500_000, 3_000_000)).toBe('2.500 s');
  });
});

describe('fmtBytes', () => {
  it('uses binary units', () => {
    expect(fmtBytes(812)).toBe('812 B');
    expect(fmtBytes(4096)).toBe('4.00 KiB');
    expect(fmtBytes(40 * 1024 * 1024)).toBe('40.0 MiB');
  });
});

describe('ellipsizeMiddle', () => {
  it('keeps short names whole', () => {
    expect(ellipsizeMiddle('lru_add', 12)).toBe('lru_add');
    expect(ellipsizeMiddle('exactly_12ch', 12)).toBe('exactly_12ch');
  });
  it('keeps both the prefix and the suffix', () => {
    expect(ellipsizeMiddle('__zap_vma_range', 10)).toBe('__zap…ange');
    expect(ellipsizeMiddle('__zap_vma_range', 10)).toHaveLength(10);
    expect(ellipsizeMiddle('abcdef', 4)).toBe('ab…f');
  });
  it('degrades to an ellipsis or nothing when there is no room', () => {
    expect(ellipsizeMiddle('abcdef', 1)).toBe('…');
    expect(ellipsizeMiddle('abcdef', 0)).toBe('');
  });
});
