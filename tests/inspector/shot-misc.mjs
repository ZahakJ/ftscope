// Steps for 03-graph-default (raw lines, no proc/abstime) and 04-graph-retval (search `load_misc_binary`: split bar, histogram).
// SHOT_PREFIX names the files; SHOT_SEARCH (env) types a search first instead of pressing `o`.
const P = process.env.SHOT_PREFIX ?? 'misc';
export default async ({ page, shot }) => {
  if (process.env.SHOT_SEARCH) {
    await page.keyboard.press('/');
    await page.keyboard.type(process.env.SHOT_SEARCH);
    await page.keyboard.press('Enter');
  } else await page.keyboard.press('o');
  await page.waitForTimeout(600);
  await shot(`${P}-1-top`);
  await page.evaluate(() => {
    const insp = document.querySelector('.insp');
    const el = [...insp.querySelectorAll('.insp-label')].find((x) => /raw lines/i.test(x.textContent));
    if (el) insp.scrollTop = el.offsetTop - 300;
  });
  await page.waitForTimeout(200);
  await shot(`${P}-2-raw`);
};
