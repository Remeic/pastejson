// bun scripts/verify-scroll.mjs
// Real browser checks for row reuse, invalidation, and compressed scroll space.
import { launchChrome, pause } from './chrome-probe.mjs';

const build = await Bun.build({ entrypoints: [new URL('../src/vscroll.ts', import.meta.url).pathname], target: 'browser' });
if (!build.success) throw new Error('Could not build VScroll: ' + build.logs.join('\n'));
const module = await build.outputs[0].text();
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === '/vscroll.js') return new Response(module, { headers: { 'Content-Type': 'text/javascript' } });
    return new Response('<style>#host{height:200px;width:600px;overflow:auto;position:relative}'
      + '.vs-win{position:absolute;left:0;top:0;contain:content}.r{height:20px;white-space:pre}</style>'
      + '<div id="host"></div><script type="module">import {VScroll} from "/vscroll.js";window.VScroll=VScroll;</script>',
    { headers: { 'Content-Type': 'text/html' } });
  },
});
let chrome;
try {
  chrome = await launchChrome();
  const page = await chrome.page();
  await page.send('Page.bringToFront');
  await page.send('Page.navigate', { url: server.url.href });
  for (let i = 0; i < 100; i++) {
    if (await page.evaluate('Boolean(window.VScroll)')) break;
    if (i === 99) throw new Error('VScroll fixture timeout');
    await pause(20);
  }
  const checks = await page.evaluate('(' + runChecks.toString() + ')()');
  if (page.events.some((event) => event.method === 'Runtime.exceptionThrown')) throw new Error('Scroll runtime exception');
  for (const check of checks) console.log('  ✓ ' + check);
  console.log(checks.length + ' browser scroll checks passed');
} finally {
  await chrome?.close();
  server.stop(true);
}

async function runChecks() {
  const host = document.querySelector('#host');
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const settle = async () => { await frame(); await frame(); };
  const checks = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  let version = 0;
  let rows = 1000;
  const scroller = new VScroll(host, { rowH: 20, paint(first, count) {
    return Array.from({ length: count }, (_, i) => '<div class="r" data-row="' + (first + i)
      + '" data-version="' + version + '">row ' + (first + i) + '</div>').join('');
  } });
  const win = host.querySelector('.vs-win');
  const nodes = () => [...win.children];
  const verify = () => {
    const current = nodes();
    if (!rows) return assert(!current.length, 'Empty content retained rows');
    assert(current.length > 0, 'No rendered rows');
    const first = Number(current[0].dataset.row);
    current.forEach((row, i) => {
      assert(Number(row.dataset.row) === first + i && row.textContent === 'row ' + (first + i), 'Row order or text changed');
      assert(Number(row.dataset.version) === version, 'Stale row state');
    });
    if (rows * 20 > host.clientHeight) {
      const top = host.getBoundingClientRect().top;
      assert(current[0].getBoundingClientRect().top <= top + 1, 'Blank space above visible rows');
      assert(current.at(-1).getBoundingClientRect().bottom >= top + host.clientHeight - 1, 'Blank space below visible rows');
    }
  };
  scroller.setRowCount(rows);
  await settle();
  scroller.scrollToRow(500);
  await settle();
  for (const delta of [20, 20, -20, -20]) {
    const old = new Set(nodes());
    const target = host.scrollTop + delta;
    host.scrollTop = target;
    await settle();
    assert(host.scrollTop === target, 'Scroll anchoring changed the requested offset');
    assert(nodes().filter((row) => old.has(row)).length >= old.size - 2, 'Small scroll rebuilt overlapping rows');
    verify();
  }
  checks.push('Small scrolls retain rows in both directions without moving the scroll offset');
  for (const [name, action] of [
    ['Explicit repaint', () => scroller.repaint()],
    ['Same-count data update', () => scroller.setRowCount(rows)],
    ['Same-position navigation', () => scroller.scrollToRow(500)],
  ]) {
    const old = new Set(nodes());
    version++;
    action();
    await settle();
    verify();
    assert(nodes().every((row) => !old.has(row)), name + ' retained stale nodes');
    checks.push(name + ' updates every visible row');
  }
  for (const count of [0, 4, 1000]) {
    rows = count;
    scroller.setRowCount(rows);
    await settle();
    verify();
  }
  checks.push('Empty, short, and restored content renders correctly');
  rows = 600000;
  scroller.setRowCount(rows);
  await settle();
  assert(host.scrollHeight === 10000000, 'Compressed scroll height changed');
  scroller.scrollToRow(rows - 1);
  await settle();
  verify();
  assert(Number(nodes().at(-1).dataset.row) === rows - 1, 'Last compressed row is unreachable');
  checks.push('The final row stays reachable in compressed scroll space');
  scroller.scrollToRow(rows / 2);
  await settle();
  for (const delta of [20, -20]) {
    const old = new Set(nodes());
    const target = host.scrollTop + delta;
    host.scrollTop = target;
    await settle();
    verify();
    assert(Math.abs(host.scrollTop - target) < 1, 'Compressed scroll anchoring changed the offset');
    assert(nodes().filter((row) => old.has(row)).length >= old.size - 3, 'Compressed scroll lost overlapping rows');
  }
  checks.push('Compressed small scrolls retain correct rows and position');
  const old = new Set(nodes());
  host.scrollTop += 1000000;
  await settle();
  verify();
  assert(nodes().every((row) => !old.has(row)), 'Large jump retained old rows');
  checks.push('Large jumps replace the window');
  host.style.height = '320px';
  await settle();
  await settle();
  verify();
  assert(nodes().length >= 28, 'Resize did not extend the visible window');
  checks.push('Resize covers the new viewport');
  scroller.destroy();
  const fallback = new VScroll(host, { rowH: 20, paint(first, count) {
    return Array.from({ length: count }, (_, i) => '<span>' + (first + i) + '</span><div class="r"></div>').join('');
  } });
  fallback.setRowCount(1000);
  fallback.scrollToRow(500);
  await settle();
  const oldFallback = new Set(host.querySelector('.vs-win').children);
  host.scrollTop += 20;
  await settle();
  assert([...host.querySelector('.vs-win').children].every((row) => !oldFallback.has(row)), 'Non-row markup entered the reuse path');
  checks.push('Painters with multiple elements per row use the full-window fallback');
  fallback.destroy();
  let latePaints = 0;
  const disposed = new VScroll(host, { rowH: 20, paint() { latePaints++; return ''; } });
  disposed.setRowCount(1000);
  disposed.destroy();
  await settle();
  assert(latePaints === 0, 'A destroyed scroller ran its queued paint');
  checks.push('Destroy cancels queued paints');
  return checks;
}
