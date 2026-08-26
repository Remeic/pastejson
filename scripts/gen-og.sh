#!/bin/bash
# Regenerates public/og.png from scripts/og.html via headless Chrome.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || CHROME="$(ls /Applications/Chromium.app/Contents/MacOS/Chromium 2>/dev/null || true)"
[ -n "${CHROME:-}" ] || { echo "no Chrome/Chromium found" >&2; exit 1; }
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1200,630 --force-device-scale-factor=1 \
  --screenshot="$PWD/public/og.png" "file://$PWD/scripts/og.html" 2>/dev/null
ls -la public/og.png
