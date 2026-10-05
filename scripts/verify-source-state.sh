#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "no Chrome" >&2; exit 1; }

bun run build >/dev/null
probe_dir="$(mktemp -d -t pastejson-source-state.XXXXXX)"
server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$probe_dir"
}
trap cleanup EXIT

cp -R dist/. "$probe_dir/"
PROBE_DIR="$probe_dir" bun -e '
const path = process.env.PROBE_DIR + "/index.html";
const html = await Bun.file(path).text();
const probe = String.raw`<script>
addEventListener("load", () => {
  setTimeout(async () => {
    let phase = "init";
    try {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const settle = (ms) => wait(ms);
    const waitFor = async (predicate, timeout = 10000) => {
      const attempts = Math.ceil(timeout / 50);
      for (let i = 0; i < attempts; i++) {
        if (predicate()) return true;
        await wait(50);
      }
      if (!predicate()) throw new Error("Timed out in " + phase);
      return true;
    };
    const input = document.querySelector("#in");
    const status = document.querySelector("#statusbar");
    const preview = document.querySelector("#rawprev");
    const spacerWidth = () => document.querySelector("#view .vs-spacer")?.style.width ?? "";
    const setDoc = async (raw) => {
      input.value = raw;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle(raw.length > 262144 ? 900 : 300);
    };
    const choose = async (name) => {
      document.querySelector("[data-view=" + name + "]").click();
      await settle(300);
    };
    const largeValue = {
      marker: "large",
      payload: "x".repeat(3000),
      extra: true,
    };
    const large = JSON.stringify(largeValue) + " ".repeat(270000);
    const largeLines = JSON.stringify(largeValue, null, 4).split("\n").length;
    const largeNodes = 1 + Object.keys(largeValue).length;
    const largeLinesLabel = largeLines.toLocaleString("en-US") + " lines";
    phase = "small";
    await setDoc(JSON.stringify({ marker: "small", value: 1 }));
    await choose("tree");
    phase = "large";
    await setDoc(large);
    const largeInputLen = input.value.length;
    await waitFor(
      () => document.body.dataset.mode === "loaded" && preview.hidden && input.value.length === large.length,
      30000,
    );
    phase = "large text";
    await choose("text");
    await waitFor(() => status.textContent.includes(largeLinesLabel));
    phase = "large tree";
    await choose("tree");
    await waitFor(() => status.textContent === largeNodes + " nodes");
    const largeTreeStatus = status.textContent.trim();
    phase = "large min";
    await choose("min");
    await waitFor(() => spacerWidth() === "20000px");
    const largeMinWidth = spacerWidth();
    phase = "large indent";
    await choose("text");
    const indent = document.querySelector("#sel-indent");
    indent.value = "4";
    indent.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => status.textContent.includes(largeLinesLabel));
    const largeIndentStatus = status.textContent.trim();

    phase = "null";
    document.querySelector("#btn-new").click();
    await wait(50);
    await setDoc("null");
    phase = "null tree";
    await choose("tree");
    await waitFor(() => status.textContent === "1 nodes");
    const nullTreeStatus = status.textContent.trim();
    phase = "null min";
    await choose("min");
    await waitFor(() => spacerWidth() !== "100%" && spacerWidth() !== "");
    const nullMinWidth = spacerWidth();

    const checks = {
      largeTree: largeInputLen === large.length && largeTreeStatus === largeNodes + " nodes",
      largeMin: largeMinWidth === "20000px",
      largeIndent: largeIndentStatus.includes(largeLinesLabel),
      nullTree: nullTreeStatus === "1 nodes",
      nullMin: nullMinWidth !== "20000px" && nullMinWidth !== "100%" && nullMinWidth !== "",
    };
    const ok = Object.values(checks).every(Boolean);
    const out = document.createElement("pre");
    out.id = "source-state-probe";
    out.textContent = (ok ? "OK" : "FAIL") + " " + JSON.stringify(checks) +
      " largeLines=" + largeLines +
      " largeInputLen=" + largeInputLen +
      " largeTreeStatus=" + JSON.stringify(largeTreeStatus) +
      " largeMinWidth=" + JSON.stringify(largeMinWidth) +
      " largeIndentStatus=" + JSON.stringify(largeIndentStatus) +
      " nullTreeStatus=" + JSON.stringify(nullTreeStatus) +
      " nullMinWidth=" + JSON.stringify(nullMinWidth);
    document.body.appendChild(out);
    } catch (err) {
      const out = document.createElement("pre");
      out.id = "source-state-probe";
      out.textContent = "ERROR phase=" + phase + " " + (err instanceof Error ? err.stack : String(err));
      document.body.appendChild(out);
    }
  }, 20);
});
</script>`;
await Bun.write(path, html.replace("</body>", probe + "</body>"));
'

PROBE_DIR="$probe_dir" bun -e '
const base = process.env.PROBE_DIR;
Bun.serve({
  port: 8131,
  fetch(req) {
    const pathname = new URL(req.url).pathname;
    const file = pathname === "/" ? "/index.html" : pathname;
    return new Response(Bun.file(base + file));
  },
});
' &
server_pid=$!
sleep 1

# Worker delivery uses real time. Virtual time can exhaust the probe's waits
# before the Worker reply arrives, then read the previous document's state.
cat > "$probe_dir/driver.mjs" <<'JS'
import { readFileSync } from 'node:fs';
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const profile = process.env.PROBE_DIR + '/chrome-profile';
const chrome = Bun.spawn([
  process.env.CHROME, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdout: 'ignore', stderr: 'ignore' });
let ws;
try {
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number(readFileSync(profile + '/DevToolsActivePort', 'utf8').split('\n')[0]); } catch {}
    if (!port) await pause(100);
  }
  if (!port) throw new Error('Chrome debugging port unavailable');
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  let loaded = false;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Page.loadEventFired') loaded = true;
    const callback = pending.get(message.id);
    if (callback) { pending.delete(message.id); callback(message); }
  };
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const next = ++id;
    const timer = setTimeout(() => { pending.delete(next); fail(new Error('Chrome timeout: ' + method)); }, 120000);
    pending.set(next, (message) => { clearTimeout(timer); done(message); });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  await send('Page.enable');
  loaded = false;
  const navigation = await send('Page.navigate', { url: 'http://127.0.0.1:8131/' });
  if (navigation.error || navigation.result?.errorText) throw new Error(JSON.stringify(navigation));
  for (let i = 0; i < 100 && !loaded; i++) await pause(100);
  if (!loaded) throw new Error('Probe page did not load');
  await send('Runtime.enable');
  const reply = await send('Runtime.evaluate', {
    expression: `(async () => {
      for (let i = 0; i < 2200; i++) {
        const probe = document.querySelector('#source-state-probe');
        if (probe) return probe.textContent;
        await new Promise((done) => setTimeout(done, 50));
      }
      throw new Error('Source state probe did not complete');
    })()`, awaitPromise: true, returnByValue: true,
  });
  if (reply.error || reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply));
  console.log(reply.result.result.value);
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
}
process.exit(0);
JS
result=$(CHROME="$CHROME" PROBE_DIR="$probe_dir" bun "$probe_dir/driver.mjs")
echo "probe: $result"

case "$result" in
  OK\ *) echo "source state OK" ;;
  *) echo "source state FAIL" >&2; exit 1 ;;
esac
