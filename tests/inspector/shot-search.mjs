// Steps: search for SEARCH (env), Enter, shoot the Inspector top and its raw lines; MODE=2 then also the Story.
const P = process.env.SHOT_PREFIX ?? 'search';
export default async ({ page, shot }) => {
  if (process.env.SEARCH) {
    await page.keyboard.press('/');
    await page.keyboard.type(process.env.SEARCH);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    console.log('[steps] insp:', await page.locator('.insp-name, .insp-body h2').first().textContent().catch(() => '-'));
  }
  if (process.env.MODE) { await page.keyboard.press('Escape'); await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {}); await page.keyboard.press(process.env.MODE); await page.waitForTimeout(600); }
  await shot(`${P}-1`);
  await page.evaluate(() => { const i = document.querySelector('.insp'); if (i) i.scrollTop = i.scrollHeight; });
  await page.waitForTimeout(200);
  await shot(`${P}-2`);
};
