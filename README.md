# <img src="public/icon.svg" width="28" align="top" alt="" /> json

**Paste JSON. See it formatted. Instantly.** The fastest JSON viewer and differ on the web — multi-MB documents render in milliseconds, 100% in your browser.

- **Zero friction** — the whole page is a paste target: <kbd>⌘V</kbd>/<kbd>Ctrl+V</kbd> anywhere, drop a `.json` file, or let clipboard auto-load on visit
- **Instant** — one ~58 KB HTML file (~20 KB gzipped), no framework, zero runtime dependencies
- **Scales** — Web Worker pipeline above 256 KB, fixed-row virtualized rendering: multi-MB docs with no main-thread freeze
- **Views** — Text (syntax-highlighted), Tree (collapsible), Minified, **Diff** (changes-only or side-by-side), and **Find** (<kbd>⌘F</kbd>/<kbd>Ctrl+F</kbd>) with match-case + regex toggles, in Text *and* Tree views
- **JSONL** — newline-delimited documents are detected and handled automatically
- **100% local** — no analytics, no network calls after load, works offline

> [!NOTE]
> Your data never leaves the browser. Everything — parsing, formatting, diffing — happens on your machine.

## Using it

1. Open the app, paste JSON anywhere (or drop a file)
2. Switch views: **Text**, **Tree**, **Minified**, **Diff**
3. **Diff**: click Diff, paste the second JSON into the side panel — changes-only focus view by default, or flip to side-by-side with `−`/`+` highlighting

Error messages point at the exact line and column, with the offending snippet highlighted — paste, fix, re-paste.

## Why it's fast

The product *is* the speed. Every design decision competes with milliseconds:

- **Native floor first** — `JSON.parse` + `JSON.stringify` are native C++ and own the heavy lifting; a JS streaming formatter measured 2× slower and was deleted
- **One fused pass** — the walk emits pretty text, token tables, and the line index together; tokens live in flat `Int32Array` pairs, no string churn
- **Closure-free hot path** — captured-scope writes measured ~40% slower than true locals, so the per-child walk is fully inlined with branch-free, capacity-proven token pushes
- **Lazy everything else** — tree, minified form, diff, and search load/build only when asked; each is a dynamic-import island that costs zero until used (search: ~2 ms per query on 5 MB, regex included)
- **Worker above 256 KB** — parse + format happen off the main thread with zero-copy buffer transfer
- **Benchmarked, not vibes** — `bun run bench` gates the 5 MB paste pipeline (~21 ms, min-of-7) on every change; fuzz tests prove byte-exact output against `JSON.stringify`

## Development

```sh
bun install
bun run dev      # vite dev server
bun run test     # tests/run.ts
bun tests/fuzz.ts  # byte-exact fuzz vs JSON.stringify
bun run bench    # 5MB perf gate (exits non-zero on regression)
bun run bench:browser  # 100 MiB real-Chrome 100–1–2 gate
bun run build    # typecheck + single-file dist/
```

The browser gate runs the production artifact in Chrome Stable for 30 samples
across five fresh browser sessions. It requires a correct syntax-colored first
viewport at ≤750 ms p50 / ≤1,000 ms p95, p95 paste-to-paint time ≤2× the
same-run native `JSON.parse` + `JSON.stringify` floor, no main-thread task over
50 ms, and ≤1.5 GiB retained Chrome process-tree RSS. The report includes the
fixture SHA-256, browser/hardware identity, every raw sample, and the aggregate
decision. Set `PASTEJSON_CHROME_PATH` when Chrome is not in its standard install
location; for a plumbing smoke test, explicitly reduce `PASTEJSON_BENCH_MIB`,
`PASTEJSON_BENCH_RUNS`, and `PASTEJSON_BENCH_SESSIONS`.

## Deploy

Single static file → Vercel (`vercel.json`): build command `bun run build`, output `dist`.
