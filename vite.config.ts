import { createHash } from 'node:crypto';
import preact from '@preact/preset-vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build` makes the hosted site (dist/). `npm run build:single` runs
// `SINGLE=1 vite build`, which inlines every script, style and the worker into
// dist-single/index.html, then renames it to dist-single/ftscope.html: one file
// that works from file://, worker and all.
const single = process.env.SINGLE === '1';

// A Content-Security-Policy for the built pages. The hosted site shares its
// origin with other sites, and a trace is untrusted input, so the page may run
// only its own scripts. The single file's scripts are inline; they are allowed
// by hash. Remote traces are fetched over https after the reader agrees.
function csp(): Plugin {
  const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
  return {
    name: 'ftscope-csp',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      for (const out of Object.values(bundle)) {
        if (out.type !== 'asset' || !out.fileName.endsWith('.html')) continue;
        const html = String(out.source);
        const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
          .filter((m) => !/\ssrc=/.test(m[0].slice(0, m[0].indexOf('>'))))
          .map((m) => sha(m[1]));
        const policy = [
          "default-src 'self'",
          `script-src 'self' ${inline.join(' ')}`.trim(),
          "worker-src 'self' blob:",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'self' https:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ');
        const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
        if (!html.includes('<meta charset="utf-8" />')) throw new Error(`ftscope-csp: no charset meta in ${out.fileName}`);
        out.source = html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    ${meta}`);
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [preact(), ...(single ? [viteSingleFile()] : []), csp()],
  // From file:// the page's origin is opaque, and Chromium refuses a *module*
  // worker from a blob: URL there (module loads are CORS-checked); a classic
  // worker from the same blob loads fine. So the single file uses an IIFE worker.
  worker: { format: single ? 'iife' : 'es' },
  build: {
    target: 'es2022',
    outDir: single ? 'dist-single' : 'dist',
    ...(single ? { assetsInlineLimit: 100_000_000 } : {}),
  },
  server: { port: 5990, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5991, strictPort: true, host: '127.0.0.1' },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
});
