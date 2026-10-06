// Narrow screenshots for the write-up, legible in a ~700 px text column.
//   npm run shot -- --scale 2 --script scripts/blog-shots.mjs
export default async ({ page, shot, base }) => {
  const open = async (hash, w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('about:blank');
    await page.goto(`${base}/?trace=/examples/traces/07-mystery.trace${hash}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 20000 });
    await page.waitForTimeout(700);
  };
  // the Story alone: both side panels folded away
  await open('#sel=7748&m=story', 1000, 640);
  await page.keyboard.press(',');
  await page.keyboard.press('.');
  await page.waitForTimeout(500);
  await shot('blog-story');
  // the timeline with the Inspector: the read a timer interrupt landed on
  await open('#sel=23940', 1040, 700);
  await page.keyboard.press(',');
  await page.waitForTimeout(500);
  await shot('blog-timeline');
  // the Brief beside the whole trace
  await open('', 1000, 700);
  await page.keyboard.press('.');
  await page.waitForTimeout(500);
  await shot('blog-brief');
};
