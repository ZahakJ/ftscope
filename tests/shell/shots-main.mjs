// Shell screenshot walk: npm run shot -- --script tests/shell/shots-main.mjs [--light 1] [--width 960]
// Covers the empty state, both demos, Brief/Functions/search, a drop, a paste, a not-a-trace file and help.
const P = process.env.SHOT_PREFIX ?? 'shell';
const settle = (page) => page.waitForTimeout(400);
const ready = async (page) => {
  await page.waitForSelector('.app.phase-ready, .app.phase-error', { timeout: 30000 });
  console.log(`[phase] ${await page.getAttribute('.app', 'class')}`);
  await settle(page);
};
const home = async (page, base) => {
  await page.goto(base + '/');
  await page.waitForFunction(() => window.__ready === true);
};
const title = async (page, what) => console.log(`[title ${what}] ${await page.title()}`);

async function drop(page, make, highlight) {
  await page.evaluate(async (make) => {
    let file;
    if (make.url) file = new File([await (await fetch(make.url)).blob()], make.url.split('/').pop());
    else file = new File([make.text], make.name, { type: 'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    window.__dt = dt;
    for (const type of ['dragenter', 'dragover'])
      window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, make);
  if (highlight) await highlight();
  await page.evaluate(() => window.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true })));
  await ready(page);
}

export default async ({ page, shot, base }) => {
  await title(page, 'empty');
  await shot(`${P}-empty`);

  await page.getByText('A slow read', { exact: false }).click();
  await ready(page);
  await title(page, 'mystery');
  await shot(`${P}-mystery-brief`);
  // Focus the first clickable brief row by keyboard and activate it.
  await page.focus('.brief-item.clickable');
  await page.keyboard.press('Enter');
  await settle(page);
  await shot(`${P}-brief-activated`);

  await page.getByRole('tab', { name: 'Functions' }).click();
  await settle(page);
  await shot(`${P}-functions`);
  await page.locator('.ft-head .ft-count').click();
  await settle(page);
  await shot(`${P}-functions-calls`);
  await page.locator('body').click({ position: { x: 800, y: 500 } });
  await page.keyboard.press('/');
  await page.keyboard.type('filemap');
  await settle(page);
  await shot(`${P}-functions-search`);
  if (process.env.SHOT_SHORT) return;

  await home(page, base);
  await page.getByText('A whole system', { exact: false }).click();
  await ready(page);
  await shot(`${P}-system`);

  await home(page, base);
  await drop(page, { url: '/examples/traces/04-graph-rich.trace' }, () => shot(`${P}-drop-highlight`));
  await title(page, 'dropped');
  await shot(`${P}-drop-result`);

  await home(page, base);
  await page.evaluate(async () => {
    const text = await (await fetch('/examples/traces/03-graph-default.trace')).text();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return { len: ev.clipboardData?.getData('text/plain').length ?? -1, handled: ev.defaultPrevented };
  }).then((r) => console.log('[paste]', JSON.stringify(r)));
  await ready(page);
  await shot(`${P}-paste`);

  await home(page, base);
  await drop(page, { text: 'hello\nworld\n', name: 'notes.txt' });
  await title(page, 'not-a-trace');
  await shot(`${P}-not-trace`);

  await page.keyboard.press('?');
  await settle(page);
  await shot(`${P}-help`);

  // The single-file build from file://: empty state, no console errors, and a dropped file loads.
  if (process.env.SHOT_SINGLE) {
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const traceText = await page.evaluate(async () => (await fetch('/examples/traces/04-graph-rich.trace')).text());
    await page.goto(new URL('../../dist-single/ftscope.html', import.meta.url).href);
    await page.waitForFunction(() => window.__ready === true);
    await title(page, 'single empty');
    await shot(`${P}-single-empty`);
    await drop(page, { text: traceText, name: '04-graph-rich.trace' });
    await title(page, 'single dropped');
    await shot(`${P}-single-dropped`);
    console.log(`[single] console errors: ${errors.length ? errors.join(' | ') : 'none'}`);
  }
};
