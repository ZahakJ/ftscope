// Steps for `npm run shot -- --url '/?trace=/examples/traces/07-mystery.trace' --script tests/inspector/shot-mystery.mjs`.
// SHOT_PREFIX (env) names the files, so the light run does not overwrite the dark one.
const P = process.env.SHOT_PREFIX ?? 'insp';
const name = (page) => page.locator('.insp-name').first().textContent().catch(() => '');
const scrollTo = async (page, text) => {
  await page.evaluate((tx) => {
    const insp = document.querySelector('.insp');
    const el = [...insp.querySelectorAll('.insp-label')].find((x) => x.textContent.toLowerCase().includes(tx));
    if (el) insp.scrollTop = el.offsetTop - 8;
  }, text);
  await page.waitForTimeout(200);
};
export default async ({ page, shot }) => {
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('o');
    await page.waitForTimeout(120);
    if ((await name(page)) === '__x64_sys_read') break;
  }
  await page.waitForTimeout(500);
  await shot(`${P}-a1-top`);
  await scrollTo(page, 'why this one');
  await shot(`${P}-a2-why`);
  await scrollTo(page, 'raw lines');
  await shot(`${P}-a3-raw`);
  await page.locator('.insp-mini', { hasText: 'columns' }).click().catch(() => console.log('[steps] no columns toggle'));
  await page.waitForTimeout(200);
  await shot(`${P}-a4-raw-columns`);
  if (process.env.SHOT_LIGHT) {
    // (c) walk the Story depth-first from the outlier until its sched_switch event row shows, and select it.
    await page.keyboard.press('2');
    await page.waitForTimeout(500);
    await page.locator('.story-row.is-sel').first().click().catch(() => {});
    for (let i = 0; i < 160; i++) {
      const ev = page.locator('.story-row.is-event', { hasText: 'sched_switch' }).first();
      if (await ev.count()) { await ev.click(); break; }
      await page.keyboard.press(i % 2 ? 'ArrowDown' : 'ArrowRight');
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(400);
    await shot(`${P}-c1-event`);
    return;
  }
  // (d) a function: the name links in the verdict select it (the hash is read only at load).
  await scrollTo(page, 'why this one');
  const link = page.locator('.insp-link', { hasText: /^filemap_read$/ }).first();
  if (await link.count()) await link.click();
  else await page.locator('.insp-link').first().click().catch(() => console.log('[steps] no function link'));
  await page.waitForTimeout(600);
  await shot(`${P}-d1-func`);
  await page.evaluate(() => { const i = document.querySelector('.insp'); i.scrollTop = i.scrollHeight; });
  await page.waitForTimeout(200);
  await shot(`${P}-d2-func-bottom`);
};
