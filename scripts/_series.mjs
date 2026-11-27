export default async ({ page, shot }) => {
  const B = 'http://127.0.0.1:6871';
  await page.setViewportSize({ width: 1280, height: 1000 });
  const go = async (u, name, lang) => {
    await page.goto('about:blank');
    if (lang) await page.setExtraHTTPHeaders({ 'X-Astrolabe-Lang': lang });
    await page.goto(B + u, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    await shot(name);
  };
  await go('/', 'series-home', 'en');
  await go('/topic/perf', 'series-topic', 'en');
  await go('/Tracing%20from%20first%20principles', 'series-page', 'en');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  await shot('series-page-bottom');
  await go('/strace', 'series-part', 'en');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  await shot('series-part-bottom');
  await go('/', 'series-home-ar', 'ar');
  // admin view of the series page
  const r = await page.request.post(B + '/api/login', { data: { password: 'scratchpw' } });
  console.log('[series] login', r.status());
  await go('/Tracing%20from%20first%20principles', 'series-page-admin', 'en');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(800);
  await shot('series-page-admin-bottom');
};
