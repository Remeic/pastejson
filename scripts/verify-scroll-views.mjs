// bun scripts/verify-scroll-views.mjs <before-dist> <after-dist> [artifacts-dir]
// Compare real built-app windows across Text, Search, Tree, Min, and both Diff modes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { launchChrome, pause } from './chrome-probe.mjs';

const [beforeDir, afterDir, outputDir] = process.argv.slice(2);
if (!beforeDir || !afterDir) throw new Error('Pass the baseline and candidate dist directories');
const roots = { before: resolve(beforeDir), after: resolve(afterDir) };
if (outputDir) mkdirSync(outputDir, { recursive: true });
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const side = path === '/before' ? 'before' : 'after';
    return new Response(Bun.file(join(roots[side], path === '/' || path === '/before' || path === '/after' ? 'index.html' : path)));
  },
});
let chrome;
try {
  chrome = await launchChrome();
  const page = await chrome.page();
  await page.send('Page.bringToFront');
  await page.send('Network.enable');
  await page.send('Network.setBypassServiceWorker', { bypass: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const all = {};
  const screenshot = async (name) => {
    if (!outputDir) return;
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(outputDir, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  for (const side of ['before', 'after']) {
    await page.send('Page.navigate', { url: server.url.href + side });
    await pause(350);
    all[side] = await page.evaluate('(' + appChecks.toString() + ')()');
    await screenshot(side + '-diff');
  }
  for (const key of Object.keys(all.before)) {
    if (all.before[key] !== all.after[key]) throw new Error('View HTML changed: ' + key);
  }
  if (outputDir) {
    for (const size of [{ width: 1200, height: 800, mobile: false }, { width: 390, height: 844, mobile: true }]) {
      for (const color of ['light', 'dark']) {
        await page.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1 });
        await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: color }] });
        for (const side of ['before', 'after']) {
          await page.send('Page.navigate', { url: server.url.href + side });
          await pause(350);
          await screenshot(side + '-' + size.width + '-' + color);
        }
      }
    }
  }
  const errors = page.events.filter((event) => event.method === 'Runtime.exceptionThrown').map((event) => event.params.exceptionDetails);
  const beforeErrors = errors.filter((error) => error.url === server.url.href + 'before');
  const afterErrors = errors.filter((error) => error.url !== server.url.href + 'before');
  // The baseline retains queued paints after destroy. Only this known race is
  // allowed in the before run; the candidate must have no runtime exceptions.
  if (afterErrors.length || beforeErrors.some((error) =>
    !/Cannot read properties of null \(reading '(pretty|length)'\)/.test(error.exception?.description ?? '')
    || !error.stackTrace?.callFrames.some((frame) => frame.functionName === 'paintNow'))) {
    throw new Error('Unexpected view runtime exceptions: ' + JSON.stringify(errors));
  }
  const hash = (side) => createHash('sha256').update(readFileSync(join(roots[side], 'index.html'))).digest('hex');
  const result = { measuredAt: new Date().toISOString(), beforeHtmlSha256: hash('before'), afterHtmlSha256: hash('after'),
    browser: chrome.version, snapshots: Object.keys(all.before).filter((key) => !key.endsWith('Check')),
    checks: ['Footer link targets', 'Scalar view status'], byteEqual: true,
    baselineQueuedPaintErrors: beforeErrors.map((error) => error.exception.description.split('\n')[0]), exceptions: afterErrors };
  if (outputDir) writeFileSync(join(outputDir, 'views.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(result.snapshots.length + ' view snapshots byte equal; zero runtime exceptions');
} finally {
  await chrome?.close();
  server.stop(true);
}

async function appChecks() {
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  const settle = async () => { await frame(); await frame(); };
  const waitFor = async (predicate) => {
    for (let i = 0; i < 500; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('View check timeout');
  };
  const input = document.querySelector('#in');
  const view = document.querySelector('#view');
  for (const path of ['/privacy', '/about']) {
    const link = document.querySelector('#foot a[href="' + path + '"]');
    const rect = link.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (hit !== link && !link.contains(hit)) throw new Error('Footer link blocked: ' + path);
  }
  input.value = '1';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => document.body.dataset.mode === 'loaded');
  await settle();
  const status = document.querySelector('#statusbar');
  const scalarStatus = status.textContent;
  document.querySelector('[data-view=tree]').click();
  await waitFor(() => status.textContent === '1 nodes');
  document.querySelector('[data-view=text]').click();
  if (!scalarStatus.includes('1 B') || status.textContent !== scalarStatus) throw new Error('Scalar view status changed');
  document.querySelector('#btn-new').click();
  await settle();
  const original = { items: Array.from({ length: 5000 }, (_, i) => ({ id: i, label: 'x' + i, nested: { i, empty: {} } })) };
  const data = new DataTransfer();
  data.setData('text/plain', JSON.stringify(original));
  input.focus();
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  await waitFor(() => document.body.dataset.mode === 'loaded');
  await settle();
  const results = { footerTargetCheck: 'OK', scalarStatusCheck: 'OK' };
  const save = (name) => { results[name] = view.querySelector('.vs-win').innerHTML; };
  async function scroll(name) {
    view.scrollTop = Math.min(10000, (view.scrollHeight - view.clientHeight) / 2);
    await settle();
    save(name + '-jump');
    for (const [label, delta] of [['down', 20], ['up', -20]]) {
      const target = Math.max(0, Math.min(view.scrollHeight - view.clientHeight, view.scrollTop + delta));
      view.scrollTop = target;
      await settle();
      if (view.scrollTop !== target) throw new Error(name + ' scroll position changed during paint');
      save(name + '-' + label);
    }
  }
  save('text-top');
  await scroll('text');
  document.querySelector('#btn-find').click();
  await waitFor(() => document.activeElement.id === 'search-in');
  await settle();
  const search = document.querySelector('#search-in');
  const query = async (value) => {
    search.value = value;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  };
  await query('x4');
  save('search');
  document.querySelector('#btn-search-next').click();
  await settle();
  save('search-next');
  document.querySelector('#btn-search-re').click();
  await query('x4[0-9]{2}');
  save('regex');
  await query('[');
  save('bad-regex');
  document.querySelector('#btn-search-close').click();
  await settle();
  save('search-closed');
  document.querySelector('[data-view=tree]').click();
  await waitFor(() => view.querySelector('.trow'));
  await settle();
  save('tree-top');
  await scroll('tree');
  const branch = [...view.querySelectorAll('.car')].find((element) => element.closest('.trow').querySelector('.meta').textContent !== '0');
  const node = branch.dataset.n;
  branch.click();
  await settle();
  save('tree-collapse');
  view.querySelector('.car[data-n="' + node + '"]').click();
  await settle();
  save('tree-expand');
  document.querySelector('[data-view=min]').click();
  await waitFor(() => view.querySelector('.row') && !document.querySelector('#statusbar').textContent.includes('preparing'));
  await settle();
  save('min-top');
  await scroll('min');
  document.querySelector('[data-view=diff]').click();
  await waitFor(() => !document.querySelector('#diffpanel').hidden);
  const changed = JSON.parse(JSON.stringify(original));
  for (let i = 0; i < 5000; i += 3) changed.items[i].label = 'changed-' + i;
  document.querySelector('#diff-in').value = JSON.stringify(changed);
  document.querySelector('#btn-diff-run').click();
  await waitFor(() => view.querySelector('.drow'));
  await settle();
  save('diff-top');
  await scroll('diff');
  document.querySelector('#btn-dp-sbs').click();
  await waitFor(() => view.querySelector('.sb'));
  await settle();
  save('sbs-top');
  await scroll('sbs');
  return results;
}
