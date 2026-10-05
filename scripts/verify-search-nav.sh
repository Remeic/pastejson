#!/usr/bin/env bash
# Browser guard for SEARCH NAVIGATION — unit tests can't reach gotoMatch's
# DOM/virtual-scroll orchestration. On a worker-path doc it asserts:
#   1. Text: searching an off-window string paints a mark (jump works)
#   2. Text: Next near the document bottom MOVES the current match — the
#      target scroll clamps to the current scrollTop, so no scroll event fires
#      and only a forced repaint updates the highlight (regression guard)
#   3. Tree: searching an off-window node scrolls to and marks it
#   4. Text: a near-end match in a doc taller than the browser scroll cap
#      (compressed scroll space) stays reachable
# Needs Google Chrome. Run: bash scripts/verify-search-nav.sh
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "no Chrome" >&2; exit 1; }

bun run build >/dev/null

TMP="$(mktemp -d -t pj-searchnav.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/driver.mjs" <<'JS'
import { rmSync } from 'node:fs';
const CHROME = process.env.CHROME;
const PORT = 9351;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = Bun.serve({
  port: 8146,
  fetch(req) {
    const u = new URL(req.url);
    return new Response(Bun.file('./dist/' + (u.pathname === '/' ? 'index.html' : u.pathname.slice(1))));
  },
});
const profile = '/tmp/pj-searchnav-prof';
rmSync(profile, { recursive: true, force: true });
const chrome = Bun.spawn(
  [CHROME, '--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`,
   `--user-data-dir=${profile}`, '--window-size=1200,800', 'about:blank'],
  { stdout: 'ignore', stderr: 'ignore' },
);
let code = 1;
try {
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/version`); up = true; break; } catch { await sleep(100); }
  }
  if (!up) throw new Error('devtools did not start');
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?http://127.0.0.1:8146/`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); const f = pending.get(m.id); if (f) { f(m); pending.delete(m.id); } };
  await new Promise((r) => { ws.onopen = () => r(); });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  await sleep(1800);
  const expr = `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (p, t = 20000) => { for (let i = 0; i < t / 50; i++) { if (p()) return true; await wait(50); } return p(); };
    const input = document.querySelector('#in');
    const N = 3000;
    const items = [];
    for (let i = 0; i < N; i++) items.push({ id: i, val: i >= N - 3 ? 'XNEEDLE' + i : 'x' + i });
    input.value = JSON.stringify({ items, pad: 'z'.repeat(270000) });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => document.body.dataset.mode === 'loaded');
    const view = document.querySelector('#view');
    const mc = () => { const m = document.querySelector('#view mark.mc'); return m ? m.closest('.row').textContent : ''; };
    document.querySelector('#btn-find').click(); await wait(250);
    const si = document.querySelector('#search-in');
    // 1. Text: far match from the bottom paints a mark
    si.value = 'x1'; si.dispatchEvent(new Event('input', { bubbles: true })); await wait(500);
    view.scrollTop = view.scrollHeight; await wait(200);
    si.value = 'XNEEDLE'; si.dispatchEvent(new Event('input', { bubbles: true })); await wait(500);
    const textMarks = document.querySelectorAll('#view mark').length;
    // 2. Text: Next near the bottom (clamped scroll) must move the current match
    view.scrollTop = view.scrollHeight; await wait(200);
    const m0 = mc();
    si.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await wait(350);
    const m1 = mc();
    // 3. Tree: far node
    document.querySelector('[data-view=tree]').click();
    await waitFor(() => document.querySelector('#statusbar').textContent.includes('nodes'));
    await wait(200);
    si.value = 'XNEEDLE'; si.dispatchEvent(new Event('input', { bubbles: true })); await wait(800);
    const treeMarks = document.querySelectorAll('#view mark').length;
    // 4. Text: a near-end match in a doc taller than the browser scroll cap
    //    (compressed scroll space) must still be reachable
    document.querySelector('[data-view=text]').click(); await wait(300);
    const big = [];
    for (let i = 0; i < 550000; i++) big.push(i);
    big.push('ZENDNEEDLE');
    input.value = JSON.stringify(big); input.dispatchEvent(new Event('input', { bubbles: true }));
    // input is debounced (140ms) and the old doc is still 'loaded' — wait for
    // the NEW doc via its line count, then reopen Find (load closes search)
    await waitFor(() => document.querySelector('#statusbar').textContent.includes('550,003 lines'));
    await waitFor(() => document.body.dataset.mode === 'loaded');
    document.querySelector('#btn-find').click(); await wait(300);
    si.value = 'ZENDNEEDLE'; si.dispatchEvent(new Event('input', { bubbles: true })); await wait(1500);
    const endReach = document.querySelectorAll('#view mark').length >= 1;
    return JSON.stringify({ textMarks, nextMoved: m0 !== m1, m0, m1, treeMarks, endReach });
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const out = String(r.result?.result?.value ?? '');
  console.log('probe: ' + out);
  const p = JSON.parse(out);
  const ok = p.textMarks >= 1 && p.nextMoved && p.treeMarks >= 1 && p.endReach;
  console.log(ok ? 'search nav OK' : 'search nav FAIL');
  code = ok ? 0 : 1;
  ws.close();
} catch (err) {
  console.error('search nav ERROR', err);
  code = 1;
} finally {
  chrome.kill();
  srv.stop(true);
}
process.exit(code);
JS
CHROME="$CHROME" bun "$TMP/driver.mjs"
