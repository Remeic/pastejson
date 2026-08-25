# AGENTS.md — pastejson

Paste → paint. The product IS the speed: every feature competes with milliseconds, and every byte ships to the user in one 38KB HTML file.

## The floor

`JSON.parse` + `JSON.stringify` are native C++ and own ~18ms of the 5MB pipeline. A JS streaming formatter that skips them measured 2× slower and was deleted — trust the floor, optimize the JS around it. Reintroducing a bypass requires beating `bun run bench` first.

## Invariants

Breaking one is a regression even with green tests:

- **Single pass** — `emitJson` walks the value once, emitting pretty + tokens + lines + tree together. Labels are lazy (`materializeLabels` slices `pretty` on first Tree open). No second scan of the value, no re-stringify on toggle.
- **No rope** — JSC punishes `out +=` piece-chains and closure-captured state in per-char paths at ~19ns/char (measured). Hot writers keep state as true locals; a helper closure inside the per-char path is a measured regression.
- **Punct tokens dropped by design** — braces/colons/commas render via base `code` color, which equals the punct color. Fuzz therefore compares token pairs against `tokenize(pretty)` **filtered to non-punct**. Re-adding them re-bloats the table.
- **lineStarts point after the `\n`, before the indent** — recording them later leaks each line's indent into the previous row: the flush-left bug. `textHtml` ends line *i* at `LS[i+1] - 1`.
- **Diff is a lazy island** — `src/diffcore.ts` + `src/diffview.ts` load via dynamic `import()` on first Diff click. Never import them (directly or transitively) from `main.ts`'s static graph, `worker.ts`, `render.ts`, or anything on the paste path. Self-contained on purpose: own preview/intern/Myers code instead of shared helpers, so it can move to a worker without touching hot files. In the singlefile build Rollup inlines the chunk — that's fine: only trivial top-level consts evaluate at boot; all work stays behind the click. Deep-equal subtrees emit nothing; array alignment = prefix/suffix trim + Myers over interned `JSON.stringify` keys (the native floor again), D-capped with a pairwise fallback.

## Contracts (fuzz enforces, keep byte-exact)

- `emitJson().pretty` ≡ `JSON.stringify(v, null, indent)`.
- token pairs ≡ `tokenize(pretty)` minus punct.
- Worker replies: fixed key order, buffers transferred, never HTML strings.

## Red gate

`bun run build` (tsc + singlefile build), `bun test`, `bun tests/fuzz.ts`, `bun run bench` — bench exits non-zero on a 5MB pipeline regression. A feature ships only with the gate green; a perf change ships only with the bench number attached.

## Platform edges (measured; not fixable in code)

- Silent clipboard reads on page load: Chrome allows only with a prior grant; Firefox/Safari require a gesture **per read** and never persist it. Retry on every activation is the ceiling — no UI hint requested.
- iOS Safari drops `paste` on non-editable targets — the hidden focused textarea is the paste surface.
- Firefox needs `readText` called during the gesture; old engines lack it entirely.

## Flow

Stacked branches, one concern per commit, PR per stage, base-first merges. `wrangler.jsonc` drives the CF Pages deploy (build `bun run build`, output `dist`).
