// Steps for `npm run shot -- --script tests/story/shot-steps.mjs`: the Story and Inspector on the mystery trace.
export default async ({ page, shot }) => {
  await page.keyboard.press('2');
  await page.waitForTimeout(300);
  await page.getByText('Slow: went to disk').first().click();
  await page.waitForTimeout(600);
  await shot('story-1-disk');
  await page.locator('.story').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  await shot('story-2-collapsed');
};
