// Number formatting shared by every view. Three significant digits and a unit
// that fits, so columns of durations read at a glance.

const THIN = ' ';

/** Three significant digits, without trailing exponent noise. */
function sig3(x: number): string {
  if (x === 0) return '0';
  const a = Math.abs(x);
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return x.toFixed(digits);
}

/** A duration given in µs: `812 ns`, `8.21 µs`, `194 µs`, `2.10 ms`, `1.25 s`. */
export function fmtDur(us: number): string {
  if (!Number.isFinite(us)) return '—';
  const a = Math.abs(us);
  if (a === 0) return '0 ns';
  // Round first so 999.6 ns becomes `1.00 µs`, not `1000 ns`.
  const units: [number, string][] = [
    [1e-3, 'ns'],
    [1, 'µs'],
    [1e3, 'ms'],
    [1e6, 's'],
  ];
  for (let i = 0; i < units.length; i++) {
    const [scale, unit] = units[i];
    const v = us / scale;
    const s = sig3(v);
    if (Math.abs(Number(s)) < 1000 || i === units.length - 1) {
      if (i === units.length - 1 && Math.abs(v) >= 1000) return `${fmtCount(Math.round(v))} s`;
      return `${s} ${unit}`;
    }
  }
  return `${us} µs`;
}

/** An integer count with thin-space thousands: `51 830`. */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0;
  const s = String(Math.round(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += THIN;
    out += s[i];
  }
  return neg ? '-' + out : out;
}

/**
 * A point in time (µs from trace start), precise enough to tell apart two
 * points within a visible window `span` µs wide, never more.
 */
export function fmtTime(us: number, span: number): string {
  if (!Number.isFinite(us)) return '—';
  const w = Math.max(Math.abs(span), 1e-6);
  // Show about four digits below the window's own order of magnitude.
  const step = Math.pow(10, Math.floor(Math.log10(w)) - 3);
  const units: [number, string][] = [
    [1e6, 's'],
    [1e3, 'ms'],
    [1, 'µs'],
    [1e-3, 'ns'],
  ];
  const a = Math.max(Math.abs(us), w);
  for (const [scale, unit] of units) {
    if (a >= scale || unit === 'ns') {
      const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(step / scale) - 1e-9)));
      return `${(us / scale).toFixed(decimals)} ${unit}`;
    }
  }
  return `${us} µs`;
}

/** Bytes in binary units: `812 B`, `4.00 KiB`, `38.2 MiB`. */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1024) return `${Math.round(n)} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  for (let i = 0; i < units.length; i++) {
    v /= 1024;
    const s = sig3(v);
    if (Math.abs(Number(s)) < 1024 || i === units.length - 1) return `${s} ${units[i]}`;
  }
  return `${n} B`;
}

/**
 * Cut `s` to at most `max` characters by replacing its middle with `…`.
 * Kernel names differ at both ends (`__zap_vma_range`, `unmap_vmas`), so the
 * prefix and the suffix are both kept, the prefix getting the extra character.
 */
export function ellipsizeMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return max === 1 ? '…' : '';
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return s.slice(0, head) + '…' + s.slice(s.length - (keep - head));
}
