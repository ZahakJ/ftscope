// Steps for `npm run shot -- --url '/?trace=/examples/traces/07-mystery.trace' --script tests/inspector/shot-compare.mjs`.
// "Beside a typical call" on two slow reads, then an event picked off the timeline. SHOT_PREFIX names the files.
const P = process.env.SHOT_PREFIX ?? 'cmp';
const name = (page) => page.locator('.insp-name').first().textContent().catch(() => '');
const scrollTo = async (page, text) => {
  await page.evaluate((tx) => {
    const insp = document.querySelector('.insp');
    const el = [...insp.querySelectorAll('.insp-label')].find((x) => x.textContent.toLowerCase().includes(tx));
    if (el) insp.scrollTop = el.offsetTop - 8;
  }, text);
  await page.waitForTimeout(200);
};
const nextRead = async (page) => {
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('o');
    await page.waitForTimeout(100);
    if ((await name(page)) === '__x64_sys_read') return true;
  }
  return false;
};
/** Sweeps the big timeline canvas for an event mark (the cursor turns to a pointer over one). */
const findMark = async (page) => {
  const box = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const r = cs[0].getBoundingClientRect();
    cs[0].dataset.big = '1';
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  // Sweep in the page with synthetic moves: one round trip instead of thousands.
  return page.evaluate((box) => {
    const cv = document.querySelector('canvas[data-big]');
    for (let y = box.y + 30; y < box.y + Math.min(box.h, 420); y += 3) {
      for (let x = box.x + 4; x < box.x + box.w - 4; x += 2) {
        cv.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
        const c = cv.style.cursor;
        if (c !== 'pointer' && c !== 'zoom-in') continue;
        const tip = [...document.querySelectorAll('div')].find((d) => d.style.position === 'absolute' && d.style.display === 'block' && d.innerHTML.includes('event'))?.textContent ?? '';
        if (tip.includes('sched_switch')) return { x, y, kind: c };
      }
    }
    return null;
  }, box);
};

export default async ({ page, shot }) => {
  await nextRead(page);
  await page.waitForTimeout(400);
  await scrollTo(page, 'beside a typical');
  await shot(`${P}-1-read-a`);
  // Hover the deepest-looking part of this call.
  const cv = page.locator('.insp-cmp-cv');
  const bb = await cv.boundingBox({ timeout: 5000 }).catch(() => (console.log('[steps] no compare canvas'), null));
  if (bb) {
    await page.mouse.move(bb.x + bb.width * 0.5, bb.y + 14 + 3 * 4);
    await page.waitForTimeout(150);
    await shot(`${P}-2-hover`);
  }
  await page.locator('.insp-mini', { hasText: 'each to fit' }).click({ timeout: 5000 }).catch(() => console.log('[steps] toggle click timed out'));
  await page.waitForTimeout(200);
  await shot(`${P}-3-fit`);
  await page.locator('.insp-mini', { hasText: 'same scale' }).click({ timeout: 5000 }).catch(() => console.log('[steps] toggle click timed out'));
  if (!process.env.SHOT_SKIP_EVENTS) {
  // Events: zoom to the selected read, then click a mark.
  await page.locator('canvas').first().hover({ timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('f');
  await page.waitForTimeout(600);
  for (let pass = 0; pass < 3; pass++) {
    const m = await findMark(page);
    if (!m) { console.log('[steps] no event mark found'); break; }
    await page.mouse.move(m.x, m.y);
    await page.waitForTimeout(120);
    await shot(`${P}-5-mark-tip`);
    await page.mouse.click(m.x, m.y);
    await page.waitForTimeout(500);
    if (m.kind === 'pointer') break;
  }
  await shot(`${P}-6-event`);
  }
  await page.keyboard.press('0');
  await page.waitForTimeout(300);
  await nextRead(page);
  await page.waitForTimeout(400);
  await scrollTo(page, 'beside a typical');
  await shot(`${P}-4-read-b`);
};
