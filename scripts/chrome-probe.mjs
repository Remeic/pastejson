// Isolated Chrome and CDP transport for the site performance and startup probes.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const events = [];
  let id = 0;
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return void events.push(message);
    const call = pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(message.id);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Chrome socket failed'));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    const timer = setTimeout(() => {
      pending.delete(next);
      reject(new Error('Chrome timeout: ' + method));
    }, 60000);
    pending.set(next, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  return {
    ready, send, events,
    async evaluate(expression) {
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
      return reply.result.value;
    },
    close() {
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('Chrome closed'));
      }
      pending.clear();
      ws.close();
    },
  };
}

export async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'pastejson-site-chrome-'));
  const child = Bun.spawn([
    process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '--headless=new', '--disable-gpu', '--no-first-run', '--use-mock-keychain',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--window-size=1200,800', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdout: 'ignore', stderr: 'pipe' });
  const diagnostic = new Response(child.stderr).text();
  const clients = [];
  const close = async () => {
    for (const client of clients) client.close();
    child.kill();
    await child.exited;
    rmSync(profile, { recursive: true, force: true });
  };
  try {
    let port = 0;
    for (let i = 0; i < 300 && !port; i++) {
      try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
      if (!port) await pause(100);
    }
    if (!port) throw new Error('Chrome debugging port unavailable');
    const version = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
    return {
      version: version.Browser, close,
      async page() {
        const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
        const client = connect(target.webSocketDebuggerUrl);
        clients.push(client);
        await client.ready;
        await client.send('Page.enable');
        await client.send('Runtime.enable');
        return client;
      },
    };
  } catch (error) {
    await close();
    throw new Error(error.message + '\n' + (await diagnostic).slice(-4000));
  }
}
