// Screenshot the app without leaving anything running.
//
//   npm run shot -- --url '/?trace=/examples/traces/07-mystery.trace' --out shots/mystery.png
//   npm run shot -- --url /dev/timeline.html --script scripts/my-steps.mjs
//
// Starts a Vite dev server on a free port, opens headless Chromium, waits for
// `window.__ready` (or --wait ms), saves a PNG, and shuts both down. Page
// console errors are printed. `npm run shot` wraps this in a machine-wide
// lock so only one browser runs at a time; do not call this file directly.
//
// --script: a module whose default export is `async ({ page, shot, base }) => {}`;
// call `await shot('name')` to save shots/name.png at any point.

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']);
    return acc;
  }, []),
);
const width = Number(args.width ?? 1600);
const height = Number(args.height ?? 950);
const out = resolve(args.out ?? 'shots/shot.png');

// The lock this runs under is shared by everything that screenshots on this
// machine: never hold it for long. A stuck page or script ends the run.
const budget = Number(args.budget ?? 150) * 1000;
setTimeout(() => {
  console.log(`[shot] gave up after ${budget / 1000} s (a step never finished); pass --budget <seconds> for a long script`);
  process.exit(2);
}, budget).unref();

const server = await createServer({ server: { port: 0, strictPort: false, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium', headless: true });
let failed = false;
try {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: Number(args.scale ?? 1),
    colorScheme: args.light ? 'light' : 'dark',
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[page ${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    failed = true;
    console.log(`[page exception] ${e.stack ?? e.message}`);
  });
  await page.goto(base + (args.url ?? '/'), { waitUntil: 'load' });
  await page
    .waitForFunction(() => window.__ready === true, null, { timeout: Number(args.timeout ?? 20000) })
    .catch(() => console.log('[shot] window.__ready never became true; shooting anyway'));
  await page.waitForTimeout(Number(args.wait ?? 300));
  const shot = async (name) => {
    const p = resolve('shots', name.endsWith('.png') ? name : `${name}.png`);
    mkdirSync(dirname(p), { recursive: true });
    await page.screenshot({ path: p });
    console.log(`[shot] ${p}`);
  };
  if (args.script) {
    const mod = await import(pathToFileURL(resolve(args.script)).href);
    await mod.default({ page, shot, base });
  } else {
    mkdirSync(dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    console.log(`[shot] ${out}`);
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
