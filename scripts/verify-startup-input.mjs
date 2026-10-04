// bun scripts/verify-startup-input.mjs [dist-dir]
// Split the real built page at its module and delay that module by 300 ms.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launchChrome } from './chrome-probe.mjs';

const dir = resolve(process.argv[2] ?? 'dist');
const html = readFileSync(join(dir, 'index.html'));
const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const csp = config.headers.find((rule) => rule.source === '/(.*)')?.headers
  .find((header) => header.key === 'Content-Security-Policy')?.value;
if (!csp) throw new Error('Missing production CSP');
const split = html.indexOf(Buffer.from('<script type="module"'));
if (split < html.indexOf(Buffer.from('<body'))) throw new Error('The shell must precede the application module');
const large = JSON.stringify({ tail: 'final-' + 'x'.repeat(300000) });
const cases = [
  { type: 'input', raw: '{"early":[null,true,"\\u0130"]}', mode: 'loaded' },
  { type: 'input', raw: large, mode: 'loaded' },
  { type: 'input', raw: '{"invalid":"' + 'x'.repeat(300000), mode: 'error' },
  { type: 'paste', raw: large, mode: 'loaded' },
  { type: 'paste', raw: JSON.stringify({ tail: 'x'.repeat(1100000) }), mode: 'loaded', inputCap: 1000002 },
  { type: 'drop', raw: large, mode: 'loaded' },
  { type: 'latest', raw: '{"latest":true}', mode: 'loaded' },
  { type: 'input', raw: '  \n\t', mode: 'landing' },
  { type: 'paste', raw: '  \n\t', mode: 'error' },
];
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/sw.js') return new Response(readFileSync(join(dir, 'sw.js')), { headers: { 'Content-Type': 'text/javascript' } });
    if (path !== '/') return new Response(null, { status: 404 });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(html.subarray(0, split));
        setTimeout(() => { controller.enqueue(html.subarray(split)); controller.close(); }, 300);
      },
    }), { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp } });
  },
});
let chrome;
try {
  chrome = await launchChrome();
  const page = await chrome.page();
  await page.send('Network.enable');
  await page.send('Network.setBypassServiceWorker', { bypass: true });
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'globalThis.earlyCase=' + JSON.stringify(cases)
      + '[Number(new URL(location.href).searchParams.get("case"))];(' + injectInput.toString() + ')()',
  });
  for (let i = 0; i < cases.length; i++) {
    await page.send('Page.navigate', { url: server.url.href + '?case=' + i });
    const result = await page.evaluate('(' + verifyInput.toString() + ')()');
    if (!result.exact || !result.prevented || result.mode !== cases[i].mode || result.parses !== (cases[i].mode === 'landing' ? 0 : 1)
      || result.cspViolations.length || (cases[i].inputCap && result.initialInputLength > cases[i].inputCap)) {
      throw new Error('Startup input failed: ' + JSON.stringify({ case: i, ...result }));
    }
    console.log('Startup ' + i + ' ' + cases[i].type + ': exact source, ' + result.parses + ' load request');
  }
  const documentRef = await page.send('Runtime.evaluate', { expression: 'document' });
  const { listeners } = await page.send('DOMDebugger.getEventListeners', { objectId: documentRef.result.objectId });
  if (listeners.some((listener) => listener.type === 'input') || listeners.filter((listener) => listener.type === 'paste').length !== 1) {
    throw new Error('Startup capture listeners were not removed');
  }
  if (page.events.some((event) => event.method === 'Runtime.exceptionThrown')) throw new Error('Startup runtime exception');
  console.log(cases.length + ' startup input checks passed; zero CSP violations');
} finally {
  await chrome?.close();
  server.stop(true);
}

function injectInput() {
  globalThis.cspViolations = [];
  document.addEventListener('securitypolicyviolation', (event) => cspViolations.push({ directive: event.effectiveDirective, uri: event.blockedURI }));
  globalThis.earlyApplied = false;
  globalThis.earlyPrevented = true;
  globalThis.workerParses = 0;
  globalThis.mainParses = 0;
  const NativeWorker = Worker;
  globalThis.Worker = class extends NativeWorker {
    postMessage(message, ...args) {
      if (message.type === 'parse') workerParses++;
      return super.postMessage(message, ...args);
    }
  };
  const parse = JSON.parse;
  JSON.parse = function (raw, ...args) {
    if (raw === earlyCase.raw) mainParses++;
    return parse.call(JSON, raw, ...args);
  };
  const paste = (raw) => {
    const data = new DataTransfer();
    data.setData('text/plain', raw);
    return !document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  };
  const drop = (raw) => {
    const data = new DataTransfer();
    data.items.add(new File([raw], 'early.json', { type: 'application/json' }));
    return !window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  };
  const observer = new MutationObserver(() => {
    const input = document.getElementById('in');
    if (!input || earlyApplied) return;
    earlyApplied = true;
    if (earlyCase.type === 'paste') earlyPrevented = paste(earlyCase.raw);
    else if (earlyCase.type === 'drop') earlyPrevented = drop(earlyCase.raw);
    else if (earlyCase.type === 'latest') earlyPrevented = drop('{"old":true}') && paste(earlyCase.raw);
    else {
      input.value = earlyCase.raw;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    globalThis.initialInputLength = input.value.length;
    observer.disconnect();
  });
  observer.observe(document, { subtree: true, childList: true });
}
async function verifyInput() {
  for (let i = 0; i < 1000; i++) {
    if (document.readyState === 'complete' && earlyApplied && document.body.dataset.mode === earlyCase.mode) break;
    if (i === 999) throw new Error('Startup input timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const mode = document.body.dataset.mode;
  if (mode === 'loaded') document.querySelector('#btn-edit').click();
  return { mode, exact: document.querySelector('#in').value === earlyCase.raw, prevented: earlyPrevented,
    parses: mainParses + workerParses, initialInputLength, cspViolations };
}
