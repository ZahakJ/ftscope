// The screenshots used by README.md and the write-up, from the real example trace.
//   npm run shot -- --scale 2 --script scripts/readme-shots.mjs
// Span ids are those of examples/traces/07-mystery.trace: 7748 is the slowest
// read (went to disk), 23940 the read a timer interrupt landed on.
export default async ({ page, shot, base }) => {
  const open = async (hash) => {
    await page.goto('about:blank');
    await page.goto(`${base}/?trace=/examples/traces/07-mystery.trace${hash}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await page.waitForTimeout(700);
  };
  await open('');
  await shot('readme-brief');
  await page.keyboard.press('c');
  await page.waitForTimeout(400);
  await shot('readme-surprise');
  await open('#sel=7748');
  await shot('readme-timeline');
  await open('#sel=7748&m=story');
  await shot('readme-story');
  await open('#sel=23940');
  await shot('readme-irq');
};
