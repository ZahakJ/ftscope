// Open the deployed site and check that the demo trace loads.
//   npm run shot -- --script scripts/live-check.mjs
export default async ({ page, shot }) => {
  const url = process.env.LIVE_URL ?? 'https://zahakj.github.io/ftscope/?trace=demo/mystery.trace.gz';
  await page.goto('about:blank');
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  console.log('[live] title:', await page.title());
  console.log('[live] brief:', (await page.locator('body').innerText()).split('\n').filter((l) => /went to disk|interrupt/i.test(l)).slice(0, 3).join(' | '));
  await shot('live-check');
};
