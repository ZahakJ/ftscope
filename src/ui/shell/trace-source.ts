// Where a `?trace=` link points. Kept apart from load.ts so it can be tested without a worker.

/**
 * Where a `?trace=` value points, seen from the page at `base`: `'same'` for
 * this site, the other site's origin for anywhere else, `null` for anything
 * that is not an http(s) URL.
 */
export function traceSource(url: string, base: string): 'same' | string | null {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const here = new URL(base);
  return u.origin === here.origin && here.origin !== 'null' ? 'same' : u.origin;
}
