# pastejson

Paste JSON. See it formatted. Instantly.

- **Zero friction**: whole page is a paste target — ⌘V / Ctrl+V anywhere, or drop a `.json` file
- **Instant**: single-file app (~20 KB gz), no framework, no runtime deps
- **Scales**: Web Worker pipeline for >256 KB; virtualized rendering handles multi-MB docs with zero main-thread freeze
- **Views**: Text (syntax-highlighted), Tree (all-expanded, collapsible), Minified — plus copy formatted/minified, indent toggle
- **100% local**: nothing ever leaves the browser. No analytics, no network calls after load.

## Stack

Vite + TypeScript (vanilla). Hand-rolled charCode tokenizer → flat `Int32Array` token tables.
Flattened typed-array tree model + fixed-row virtual scroller. Inline worker via `?worker&inline`.
Service worker precache = instant repeat visits / offline.

## Dev

```sh
bun install
bun run dev      # vite dev server
bun test         # tests/run.ts
bun run bench    # 5MB perf smoke
bun run build    # typecheck + single-file dist/
```

## Deploy

Single static file → Cloudflare Pages: build command `bun run build`, output `dist`.
