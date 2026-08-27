#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "no Chrome" >&2; exit 1; }

bun run build >/dev/null
probe_dir="$(mktemp -d -t pastejson-view-status.XXXXXX)"
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
  setTimeout(() => {
    const input = document.querySelector("#in");
    input.value = "1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    setTimeout(() => {
      const statusBefore = document.querySelector("#statusbar").textContent.trim();
      document.querySelector("[data-view=tree]").click();
      const statusTree = document.querySelector("#statusbar").textContent.trim();
      document.querySelector("[data-view=text]").click();
      const statusAfter = document.querySelector("#statusbar").textContent.trim();
      const ok = statusBefore.includes("1 B") && statusTree === "1 nodes" && statusAfter === statusBefore;
      const out = document.createElement("pre");
      out.id = "view-status-probe";
      out.textContent = ok
        ? "OK before=" + statusBefore + " tree=" + statusTree + " after=" + statusAfter
        : "FAIL before=" + statusBefore + " tree=" + statusTree + " after=" + statusAfter;
      document.body.appendChild(out);
    }, 220);
  }, 20);
});
</script>`;
await Bun.write(path, html.replace("</body>", probe + "</body>"));
'

PROBE_DIR="$probe_dir" bun -e '
const base = process.env.PROBE_DIR;
Bun.serve({
  port: 8130,
  fetch(req) {
    const pathname = new URL(req.url).pathname;
    const file = pathname === "/" ? "/index.html" : pathname;
    return new Response(Bun.file(base + file));
  },
});
' &
server_pid=$!
sleep 1

result=$("$CHROME" --headless=new --disable-gpu --virtual-time-budget=4000 \
  --dump-dom http://127.0.0.1:8130/ 2>/dev/null |
  sed -n 's/.*id="view-status-probe">\([^<]*\).*/\1/p' | tail -1)
echo "probe: $result"

case "$result" in
  OK\ *) echo "view status OK" ;;
  *) echo "view status FAIL" >&2; exit 1 ;;
esac
