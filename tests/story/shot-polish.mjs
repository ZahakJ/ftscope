// Steps for `npm run shot -- --url '/?trace=/examples/traces/07-mystery.trace' --script tests/story/shot-polish.mjs`:
// folded reads, typical call two levels deep, "all N calls…", the keyboard, an event, and `o` from the Timeline.
const P = process.env.SHOT_PREFIX ?? 'sp';
const focusText = (page) => page.evaluate(() => document.querySelector('.story-row.is-focus')?.textContent?.slice(0, 60) ?? '(none)');
const tri = async (page, re) => {
  const row = page.locator('.story-row', { hasText: re }).first();
  if (!(await row.count())) return console.log('[steps] no row', re), false;
  await row.locator('.story-tri').click();
  await page.waitForTimeout(250);
  return true;
};
export default async ({ page, shot }) => {
  await page.keyboard.press('2');
  await page.waitForTimeout(300);
  await page.getByText('Slow: went to disk').first().click();
  await page.waitForTimeout(600);
  await shot(`${P}-e1-disk`);
  if (await tri(page, /typical call/)) {
    // open two levels below "typical call"
    for (let k = 0; k < 2; k++) {
      const n = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.story-row')].sort((a, b) => a.offsetTop - b.offsetTop);
        const i = rows.findIndex((r) => r.textContent.includes('typical call'));
        const r = rows.slice(i + 1).find((x) => x.querySelector('.story-tri')?.textContent === '▸');
        r?.querySelector('.story-tri').click();
        return !!r;
      });
      await page.waitForTimeout(250);
      if (!n) console.log('[steps] nothing to open at level', k + 1);
    }
  }
  await page.evaluate(() => {
    const st = document.querySelector('.story'), r = [...st.querySelectorAll('.story-row')].find((x) => x.textContent.includes('typical call'));
    if (r) st.scrollTop = r.offsetTop - 80;
  });
  await page.waitForTimeout(250);
  await shot(`${P}-e2-typical`);
  if (await tri(page, /all [\d  ]+ calls/)) {
    await page.locator('.story-row', { hasText: /all [\d  ]+ calls/ }).first().scrollIntoViewIfNeeded();
    await page.locator('.story').evaluate((el) => (el.scrollTop += 300));
    await page.waitForTimeout(250);
  }
  await shot(`${P}-e3-all`);
  // keyboard after a click
  const row = page.locator('.story-row.is-span').nth(2);
  await row.click();
  console.log('[keys] after click:', await focusText(page));
  for (const k of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'Enter']) {
    await page.keyboard.press(k);
    await page.waitForTimeout(120);
    console.log(`[keys] ${k}:`, await focusText(page), '| insp:', await page.locator('.insp-name').first().textContent().catch(() => '-'));
  }
  await shot(`${P}-k1-keys`);
  // an event row
  const ev = page.locator('.story-row.is-event', { hasText: 'sched_switch' }).first();
  if (await ev.count()) { await ev.click(); await page.waitForTimeout(300); await shot(`${P}-c1-event`); }
  else console.log('[steps] no sched_switch row rendered');
  // `o` from the Timeline, then `2`
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  await page.waitForTimeout(300);
  await page.keyboard.press('o');
  await page.keyboard.press('o');
  await page.waitForTimeout(300);
  await page.keyboard.press('2');
  await page.waitForTimeout(600);
  const vis = await page.evaluate(() => {
    const st = document.querySelector('.story'), r = st.querySelector('.story-row.is-sel');
    if (!r) return 'no selected row';
    const a = r.getBoundingClientRect(), b = st.getBoundingClientRect();
    return `selected row "${r.textContent.slice(0, 40)}" visible=${a.top >= b.top && a.bottom <= b.bottom}`;
  });
  console.log('[o→2]', vis, '| insp:', await page.locator('.insp-name').first().textContent().catch(() => '-'));
  await shot(`${P}-k2-outlier`);
};
