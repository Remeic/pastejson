#!/bin/bash
# DOM hit-test regression: footer links must be the top-most targets at their
# own coordinates (the landing paste surface #in is fixed inset-0 z-40 and
# historically swallowed every click — audit bug, keep this guard).
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "no Chrome" >&2; exit 1; }

bun run build >/dev/null
rm -rf /tmp/pj-dom && cp -r dist /tmp/pj-dom
cat >> /tmp/pj-dom/index.html <<'EOF'
<script>
  addEventListener('load', () => {
    const out = [];
    for (const sel of ['#foot a[href="/privacy"]', '#foot a[href="/about"]']) {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      out.push(sel + '=' + (hit === el || el.contains(hit) ? 'OK' : 'BLOCKED_BY_' + (hit.id || hit.tagName)));
    }
    const d = document.createElement('pre');
    d.id = 'dom-probe';
    d.textContent = out.join(' ');
    document.body.appendChild(d);
  });
</script>
EOF

bun -e "Bun.serve({ port: 8129, fetch(req) { const u = new URL(req.url); return new Response(Bun.file('/tmp/pj-dom' + (u.pathname === '/' ? '/index.html' : u.pathname))); } })" &
SRV=$!
sleep 1
set +e
RESULT=$("$CHROME" --headless=new --disable-gpu --virtual-time-budget=4000 --dump-dom http://localhost:8129/ 2>/dev/null | grep -o 'dom-probe">[^<]*' | cut -d'"' -f2)
kill $SRV 2>/dev/null
echo "probe: $RESULT"
[ -n "$RESULT" ] && ! echo "$RESULT" | grep -q "BLOCKED" && echo "DOM OK: footer links clickable" || { echo "DOM FAIL"; exit 1; }
