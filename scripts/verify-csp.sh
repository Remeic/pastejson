#!/bin/bash
# Verifies the CSP in vercel.json against the real built app in headless Chrome.
# Serves dist/ with the production headers, injects a synthetic paste so the
# blob worker + inline module + styles all execute, fails on any violation.
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "no Chrome" >&2; exit 1; }

bun run build >/dev/null
SMOKE=$(mktemp -d)/site
cp -r dist "$SMOKE"
cat >> "$SMOKE/index.html" <<'EOF'
<script>
  // smoke: exercise parse→worker→paint paths (CSP violations surface on load)
  addEventListener('load', () => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '{"smoke":[1,2,{"k":"v"}],"ok":true}');
    document.getElementById('in').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
</script>
EOF

bun -e '
const CSP = `default-src \x27none\x27; script-src \x27self\x27 \x27unsafe-inline\x27; style-src \x27self\x27 \x27unsafe-inline\x27; img-src \x27self\x27 data:; worker-src blob:; connect-src \x27self\x27; base-uri \x27none\x27; form-action \x27none\x27; frame-ancestors \x27none\x27`;
const root = process.argv[2];
const mime: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", xml: "application/xml", txt: "text/plain", md: "text/markdown", webmanifest: "application/manifest+json" };
Bun.serve({
  port: 8123,
  async fetch(req) {
    const p = root + new URL(req.url).pathname.split("?")[0].replace(/\/$/, "/index").replace(/\.(?!html\/index)[^.]*$/, m => m);
    let f = p.endsWith("/") ? p + "index.html" : p;
    if (!(await Bun.file(f).exists())) f = root + new URL(req.url).pathname + (new URL(req.url).pathname.endsWith("/") ? "index.html" : "");
    const file = Bun.file(f.endsWith(".html/index.html") ? f.replace(".html/index.html", ".html") : f);
    if (!(await file.exists())) return new Response("nf", { status: 404 });
    const ext = f.split(".").pop() ?? "";
    return new Response(file, { headers: { "Content-Type": mime[ext] ?? "application/octet-stream", "Content-Security-Policy": CSP } });
  },
});
' "$SMOKE" &
SRV=$!
sleep 1
set +e
"$CHROME" --headless=new --disable-gpu --virtual-time-budget=6000 \
  --enable-logging=stderr --v=0 --no-first-run \
  --dump-dom http://localhost:8123/ >/dev/null 2>/tmp/pj-csp.log
CHROME_RC=$?
kill $SRV 2>/dev/null
VIOLATIONS=$(grep -ci "Refused to\|Content Security Policy" /tmp/pj-csp.log || true)
echo "chrome rc=$CHROME_RC violations=$VIOLATIONS"
grep -i "Refused to\|Content Security Policy" /tmp/pj-csp.log | head -5 || true
[ "$VIOLATIONS" -eq 0 ] && echo "CSP OK: zero violations" || exit 1
