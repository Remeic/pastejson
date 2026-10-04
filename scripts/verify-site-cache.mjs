// bun scripts/verify-site-cache.mjs <before-dist> <after-dist> <output.json>
// Real production CSP, cached navigation, background update, offline, and Markdown.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { launchChrome, pause } from './chrome-probe.mjs';

const [beforeDir, afterDir, output] = process.argv.slice(2);
if (!beforeDir || !afterDir || !output) throw new Error('Pass before-dist, after-dist, and output.json');
const sides = {};
for (const [side, dir] of Object.entries({ before: beforeDir, after: afterDir })) {
  const root = resolve(dir);
  const source = readFileSync(join(root, 'index.html'));
  const worker = readFileSync(join(root, 'sw.js'));
  const config = JSON.parse(readFileSync(join(root, '../vercel.json'), 'utf8'));
  const csp = config.headers.find((rule) => rule.source === '/(.*)').headers
    .find((header) => header.key === 'Content-Security-Policy').value;
  const documents = Object.fromEntries(['v1', 'v2'].map((version) => [version,
    Buffer.from(source.toString().replace('</head>', '<!--cache-probe-' + version + '--></head>'))]));
  const bodies = Object.fromEntries(Object.entries(documents).map(([version, html]) => [version, gzipSync(html, { level: 9 })]));
  const state = { version: 'v1', source, documents, worker, csp };
  state.server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/sw.js') return new Response(worker, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp } });
    if (path !== '/') return new Response(null, { status: 404 });
    if (req.headers.get('Accept')?.includes('text/markdown')) {
      return new Response('# Markdown probe\n', { headers: { 'Content-Type': 'text/markdown', 'Vary': 'Accept', 'Content-Security-Policy': csp } });
    }
    return new Response(bodies[state.version], { headers: { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip',
      'Cache-Control': 'no-store', 'Content-Security-Policy': csp, 'Vary': 'Accept' } });
  } });
  sides[side] = state;
}
let chrome;
try {
  chrome = await launchChrome();
  const page = await chrome.page();
  await page.send('Page.bringToFront');
  await page.send('Network.enable');
  await page.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const online = { offline: false, latency: 100, downloadThroughput: 200000, uploadThroughput: 100000 };
  await page.send('Network.emulateNetworkConditions', online);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + observe.toString() + ')()' });
  async function navigate(side) {
    const from = page.events.length;
    await page.send('Page.navigate', { url: sides[side].server.url.href });
    for (let i = 0; i < 1000; i++) {
      if (page.events.slice(from).some((event) => event.method === 'Page.loadEventFired')) break;
      if (i === 999) throw new Error('Cache navigation timeout');
      await pause(10);
    }
    await pause(100);
    return page.evaluate(`({ fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
      lcpMs: cacheProbe.lcpMs, readyMs: performance.getEntriesByType('navigation')[0].domContentLoadedEventEnd,
      controlled: Boolean(navigator.serviceWorker.controller), violations: cacheProbe.violations,
      v2: document.documentElement.outerHTML.includes('cache-probe-v2') })`);
  }
  const initial = {};
  for (const side of ['before', 'after']) {
    initial[side] = await navigate(side);
    if (side === 'after') {
      await page.evaluate(`(async () => { for(let i=0;i<200;i++) {
        if(navigator.serviceWorker.controller) return;
        await new Promise(r=>setTimeout(r,25));
      } throw Error('Service Worker did not take control'); })()`);
    }
  }
  for (let i = 0; i < 3; i++) for (const side of ['before', 'after']) await navigate(side);
  const loads = { before: [], after: [] };
  for (let i = 0; i < 11; i++) {
    for (const side of i % 2 ? ['after', 'before'] : ['before', 'after']) loads[side].push(await navigate(side));
  }
  if (loads.before.some((load) => load.controlled || !load.violations.some((v) => v.directive === 'worker-src' && v.uri.endsWith('/sw.js')))) {
    throw new Error('Baseline CSP fault was not reproduced');
  }
  if (loads.after.some((load) => !load.controlled || load.violations.length)) throw new Error('Candidate cache or CSP failed');
  if ([...loads.before, ...loads.after].some((load) => !load.fcpMs || !load.lcpMs)) throw new Error('Missing cache paint timing');
  await navigate('after');
  const markdown = await page.evaluate(`fetch('/', {headers:{Accept:'text/markdown'}}).then(async r=>({type:r.headers.get('Content-Type'),body:await r.text()}))`);
  if (markdown.type !== 'text/markdown' || markdown.body !== '# Markdown probe\n') throw new Error('Cache replaced Markdown with HTML');
  sides.after.version = 'v2';
  await navigate('after');
  await page.evaluate(`(async () => {for(let i=0;i<200;i++) {
    const response=await caches.match('/');
    if(response&&(await response.text()).includes('cache-probe-v2')) return;
    await new Promise(r=>setTimeout(r,25));
  } throw Error('Background cache update timed out');})()`);
  const update = await navigate('after');
  if (!update.v2) throw new Error('Updated HTML was not served');
  await page.send('Network.emulateNetworkConditions', { ...online, offline: true });
  const offline = await navigate('after');
  if (!offline.controlled || !offline.v2 || offline.violations.length) throw new Error('Offline shell failed');
  const offlineInput = await page.evaluate(`(async () => {
    const raw=JSON.stringify({offline:'x'.repeat(300000)});
    const data=new DataTransfer(); data.setData('text/plain',raw);
    document.querySelector('#in').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    for(let i=0;i<200;i++) {
      if(document.body.dataset.mode==='loaded'&&document.querySelector('#view .row')) {
        document.querySelector('#btn-edit').click();
        return document.querySelector('#in').value===raw&&cacheProbe.violations.length===0;
      }
      await new Promise(r=>setTimeout(r,25));
    }
    throw Error('Offline Worker input timed out');
  })()`);
  if (!offlineInput) throw new Error('Offline Worker lost input');
  const exceptions = page.events.filter((event) => event.method === 'Runtime.exceptionThrown');
  if (exceptions.length) throw new Error('Cache runtime exceptions');
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const summary = Object.fromEntries(['before', 'after'].map((side) => [side,
    Object.fromEntries(['fcpMs', 'lcpMs', 'readyMs'].map((key) => [key, median(loads[side].map((load) => load[key]))]))]));
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const result = { measuredAt: new Date().toISOString(), browser: chrome.version,
    conditions: { cpuRate: 4, latencyMs: 100, downloadBytesPerSecond: 200000, encoding: 'gzip', httpCache: 'disabled', serviceWorker: 'enabled' },
    samples: 11, warmup: 3, order: 'alternating AB/BA', statistic: 'median',
    beforeHtmlSha256: hash(sides.before.source), afterHtmlSha256: hash(sides.after.source),
    beforeServedHtmlSha256: hash(sides.before.documents.v1), afterServedHtmlSha256: hash(sides.after.documents.v1),
    probe: 'HTML comments mark v1 and v2 for cache update checks',
    beforeWorkerSha256: hash(sides.before.worker), afterWorkerSha256: hash(sides.after.worker),
    beforeCsp: sides.before.csp, afterCsp: sides.after.csp,
    initial, loads, summary, checks: { markdown, update, offline, offlineWorkerInput: offlineInput }, exceptions };
  writeFileSync(resolve(output), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(summary));
  console.log('Cached navigation, Markdown, cache update, offline, and CSP checks passed');
} finally {
  await chrome?.close();
  for (const side of Object.values(sides)) side.server.stop(true);
}

function observe() {
  globalThis.cacheProbe = { lcpMs: 0, violations: [] };
  document.addEventListener('securitypolicyviolation', (event) => cacheProbe.violations.push({ directive: event.effectiveDirective, uri: event.blockedURI }));
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) cacheProbe.lcpMs = entry.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
}
