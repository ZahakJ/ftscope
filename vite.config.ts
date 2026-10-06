import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `vite build` makes the hosted site (dist/). `npm run build:single` runs
// `SINGLE=1 vite build`, which inlines every script, style and the worker into
// dist-single/index.html, then renames it to dist-single/ftscope.html: one file
// that works from file://, worker and all.
const single = process.env.SINGLE === '1';

export default defineConfig({
  base: './',
  plugins: [preact(), ...(single ? [viteSingleFile()] : [])],
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
