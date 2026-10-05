// bun scripts/bench-site-response.mjs <before-dist> <after-dist> <output.json> [odd samples] [gzip|br]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cpus, release } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { launchChrome, pause } from './chrome-probe.mjs';

const [beforeDir, afterDir, output, count = '11', encoding = 'gzip'] = process.argv.slice(2);
const samples = Number(count);
if (!beforeDir || !afterDir || !output || !Number.isInteger(samples) || samples < 7 || samples % 2 !== 1 || !['gzip', 'br'].includes(encoding)) {
  throw new Error('Usage: bun scripts/bench-site-response.mjs <before-dist> <after-dist> <output.json> [odd samples >= 7] [gzip|br]');
}
const roots = { before: resolve(beforeDir), after: resolve(afterDir) };
const html = Object.fromEntries(Object.entries(roots).map(([side, dir]) => [side, readFileSync(join(dir, 'index.html'))]));
const compress = (bytes) => encoding === 'gzip' ? gzipSync(bytes, { level: 9 })
  : brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
const bodies = Object.fromEntries(Object.entries(html).map(([side, bytes]) => [side, compress(bytes)]));
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    const side = path === '/before' ? 'before' : 'after';
    if (path === '/' || path === '/before' || path === '/after') {
      return new Response(bodies[side], { headers: {
        'Content-Type': 'text/html', 'Content-Encoding': encoding, 'Cache-Control': 'no-store',
      } });
    }
    return new Response(Bun.file(join(roots.after, path)));
  },
});
let chrome;
try {
  chrome = await launchChrome();
  const page = await chrome.page();
  await page.send('Network.enable');
  await page.send('Performance.enable');
  await page.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.send('Network.setBypassServiceWorker', { bypass: true });
  await page.send('Network.emulateNetworkConditions', {
    offline: false, latency: 100, downloadThroughput: 200000, uploadThroughput: 100000, connectionType: 'cellular3g',
  });
  await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + observeLoad.toString() + ')()' });
  const loads = { before: [], after: [] };
  async function navigate(side, index) {
    const from = page.events.length;
    await page.send('Page.navigate', { url: server.url.href + side + '?sample=' + index });
    for (let i = 0; i < 1000; i++) {
      if (page.events.slice(from).some((event) => event.method === 'Page.loadEventFired')) break;
      if (i === 999) throw new Error('Page load timeout');
      await pause(10);
    }
    await pause(120);
    const metrics = (await page.send('Performance.getMetrics')).metrics;
    return page.evaluate('(' + loadResult.toString() + ')()').then((result) => ({
      ...result,
      scriptMs: 1000 * metrics.find((m) => m.name === 'ScriptDuration').value,
      layoutMs: 1000 * metrics.find((m) => m.name === 'LayoutDuration').value,
    }));
  }
  for (let i = 0; i < 3; i++) for (const side of ['before', 'after']) await navigate(side, 'warm-' + i);
  for (let i = 0; i < samples; i++) {
    for (const side of i % 2 ? ['after', 'before'] : ['before', 'after']) loads[side].push(await navigate(side, i));
  }
  const pages = { before: await chrome.page(), after: await chrome.page() };
  for (const [side, tab] of Object.entries(pages)) {
    await tab.send('Page.bringToFront');
    await tab.send('Network.enable');
    await tab.send('Performance.enable');
    await tab.send('Network.setBypassServiceWorker', { bypass: true });
    await tab.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await tab.send('Page.navigate', { url: server.url.href + side });
    await pause(600);
    await tab.evaluate('(' + prepareInput.toString() + ')()');
    for (let i = 0; i < 3; i++) await tab.evaluate('runResponseProbe()');
  }
  const responses = { before: [], after: [] };
  const scrolls = { before: [], after: [] };
  for (let i = 0; i < samples; i++) {
    for (const side of i % 2 ? ['after', 'before'] : ['before', 'after']) {
      await pages[side].send('Page.bringToFront');
      responses[side].push(await pages[side].evaluate('runResponseProbe()'));
      await pages[side].evaluate('prepareScrollProbe()');
      const begin = (await pages[side].send('Performance.getMetrics')).metrics;
      const observations = await pages[side].evaluate('runScrollProbe()');
      const end = (await pages[side].send('Performance.getMetrics')).metrics;
      const delta = (name) => 1000 * (end.find((m) => m.name === name).value - begin.find((m) => m.name === name).value) / observations.steps;
      scrolls[side].push({ ...observations, scriptMsPerStep: delta('ScriptDuration'), layoutMsPerStep: delta('LayoutDuration') });
    }
  }
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const summary = {};
  for (const side of ['before', 'after']) {
    const load = {};
    for (const key of ['fcpMs', 'lcpMs', 'readyMs', 'responseEndMs', 'scriptMs', 'layoutMs', 'cls']) {
      load[key] = median(loads[side].map((sample) => sample[key]));
    }
    const response = {};
    for (const phase of ['paste', 'first-search', 'case-toggle', 'next-search', 'tree', 'min']) {
      response[phase] = {
        handlerMs: median(responses[side].map((sample) => sample[phase].handlerMs)),
        frameMs: median(responses[side].map((sample) => sample[phase].frameMs)),
      };
    }
    summary[side] = { load, response, scroll: {
      scriptMsPerStep: median(scrolls[side].map((s) => s.scriptMsPerStep)),
      layoutMsPerStep: median(scrolls[side].map((s) => s.layoutMsPerStep)),
      retainedRowsPerStep: median(scrolls[side].map((s) => s.retainedRowsPerStep)),
    } };
  }
  const exceptions = [page, ...Object.values(pages)].flatMap((tab) => tab.events.filter((e) => e.method === 'Runtime.exceptionThrown'));
  const result = {
    beforeHtmlSha256: createHash('sha256').update(html.before).digest('hex'),
    afterHtmlSha256: createHash('sha256').update(html.after).digest('hex'),
    measuredAt: new Date().toISOString(), browser: chrome.version, machine: cpus()[0].model, os: release(),
    conditions: { cpuRate: 4, latencyMs: 100, downloadBytesPerSecond: 200000, encoding,
      compressedBytes: { before: bodies.before.length, after: bodies.after.length }, cache: 'disabled', serviceWorker: 'bypassed' },
    samples, warmup: 3, order: 'alternating AB/BA', statistic: 'median', summary, loads, responses, scrolls, exceptions,
  };
  writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  if (exceptions.length) throw new Error('Browser runtime exceptions');
  if (loads.before.some((s) => !s.fcpMs) || loads.after.some((s) => !s.fcpMs)) throw new Error('Missing paint timing');
  // Keep baseline shifts in the data; only the candidate is required to be shift-free.
  if (loads.after.some((s) => s.cls !== 0)) throw new Error('Candidate landing shifted during load');
} finally {
  await chrome?.close();
  server.stop(true);
}

function observeLoad() {
  globalThis.bootTiming = { lcpMs: 0, cls: 0, shifts: [] };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      bootTiming.lcpMs = entry.startTime;
      bootTiming.lcpTag = entry.element?.tagName ?? '';
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) {
      bootTiming.cls += entry.value;
      bootTiming.shifts.push({ value: entry.value, at: entry.startTime, sources: entry.sources.map((source) => ({
        tag: source.node?.nodeName, id: source.node?.id, className: source.node?.className,
        before: source.previousRect.toJSON(), after: source.currentRect.toJSON(),
      })) });
    }
  }).observe({ type: 'layout-shift', buffered: true });
}
function loadResult() {
  const navigation = performance.getEntriesByType('navigation')[0];
  return { ...bootTiming, fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
    readyMs: navigation.domContentLoadedEventEnd, responseEndMs: navigation.responseEnd };
}
function prepareInput() {
  const raw = JSON.stringify({ items: Array.from({ length: 50000 }, (_, i) => ({
    id: i, label: 'UPPER-' + i, group: 'GROUP-' + i % 17, payload: 'payload'.repeat(4),
  })) });
  const data = new DataTransfer();
  const expected = JSON.stringify(JSON.parse(raw), null, 2).split('\n');
  data.setData('text/plain', raw);
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
  const waitFor = async (predicate) => {
    for (let i = 0; i < 1000; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Response probe timeout');
  };
  globalThis.runResponseProbe = async () => {
    document.querySelector('#btn-new').click();
    await frame();
    const times = {};
    let start = performance.now();
    document.querySelector('#in').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    let handlerMs = performance.now() - start;
    await waitFor(() => document.body.dataset.mode === 'loaded' && document.querySelector('#view .row'));
    await frame();
    times.paste = { handlerMs, frameMs: performance.now() - start };
    document.querySelector('#btn-find').click();
    await waitFor(() => document.activeElement.id === 'search-in');
    await frame();
    const input = document.querySelector('#search-in');
    for (const [phase, query] of [['first-search', 'payload'], ['next-search', 'UPPER-49999']]) {
      input.value = query;
      start = performance.now();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      handlerMs = performance.now() - start;
      await frame();
      times[phase] = { handlerMs, frameMs: performance.now() - start };
      if (phase === 'first-search') {
        start = performance.now();
        document.querySelector('#btn-search-case').click();
        handlerMs = performance.now() - start;
        await frame();
        times['case-toggle'] = { handlerMs, frameMs: performance.now() - start };
      }
    }
    if (!document.querySelector('#view mark.mc') || !document.querySelector('#search-count').textContent.includes('1')) {
      throw new Error('Search navigation changed');
    }
    // Restore the case-sensitive session preference for the next document.
    document.querySelector('#btn-search-case').click();
    await frame();
    document.querySelector('#btn-search-close').click();
    await frame();
    for (const name of ['tree', 'min']) {
      start = performance.now();
      document.querySelector('[data-view=' + name + ']').click();
      handlerMs = performance.now() - start;
      await waitFor(() => document.querySelector(name === 'tree' ? '#view .trow' : '#view .row')
        && !document.querySelector('#statusbar').textContent.includes('preparing'));
      await frame();
      times[name] = { handlerMs, frameMs: performance.now() - start };
    }
    return times;
  };
  globalThis.prepareScrollProbe = async () => {
    document.querySelector('[data-view=text]').click();
    await frame();
    document.querySelector('#view').scrollTop = document.querySelector('#view').scrollHeight / 2;
    await frame();
    await frame();
  };
  globalThis.runScrollProbe = async () => {
    const host = document.querySelector('#view');
    const win = host.querySelector('.vs-win');
    let retained = 0;
    const steps = 60;
    for (let i = 0; i < steps; i++) {
      const previous = new Set(win.children);
      const target = host.scrollTop + (i < steps / 2 ? 20 : -20);
      host.scrollTop = target;
      await frame();
      if (host.scrollTop !== target) throw new Error('Scroll position changed during paint');
      for (const row of win.children) {
        if (previous.has(row)) retained++;
        const index = Number(row.querySelector('.ln').textContent) - 1;
        if (row.querySelector('code').textContent !== expected[index]) throw new Error('Scroll row content changed');
      }
    }
    return { steps, retainedRowsPerStep: retained / steps, exactRows: true };
  };
}
