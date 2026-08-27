# AGENTS.md — pastejson

Paste → paint. The product IS the speed: every feature competes with milliseconds, and every byte ships to the user in one 38KB HTML file.

## The floor

`JSON.parse` + `JSON.stringify` are native C++ and own ~18ms of the 5MB pipeline. A JS streaming formatter that skips them measured 2× slower and was deleted — trust the floor, optimize the JS around it. Reintroducing a bypass requires beating `bun run bench` first.

Post walk-diet split (2.76MB-minified / 5MB-pretty paste payload, min-of-7): parse 5.5 + stringify 8.8 = **14.3ms native floor (67%)**; the JS walk is the only optimizable slice and sits within ~0.5ms of its measured component floor (escLen regex 2ms — charCode loops measured slower on JSC; Object.keys 0.8 + keyed loads 1.0; line-records ~2; dispatch ~0.7). Captured-scope writes cost ~40% over true locals (5.4 vs 3.9 ns/token, agent-measured) — the per-child path stays closure-free; token capacity is mathematically bounded (token ints ≤ plen+2) so pushes are branch-free plain stores.

## Invariants

Breaking one is a regression even with green tests:

- **Single pass** — `JSON.stringify` creates the pretty source once; `emitJson` walks the value once to emit tokens + line index. Tree is LAZY: `flatten()` rebuilds it on demand (first Tree open / worker `getTree`), same philosophy as lazy labels/min. No second value walk or pretty rebuild on the paste path, no re-stringify on toggle.
- **No rope** — JSC punishes `out +=` piece-chains and closure-captured state in per-char paths at ~19ns/char (measured). Hot writers keep state as true locals; a helper closure inside the per-char path is a measured regression.
- **Punct tokens dropped by design** — braces/colons/commas render via base `code` color, which equals the punct color. Fuzz therefore compares token pairs against `tokenize(pretty)` **filtered to non-punct**. Re-adding them re-bloats the table.
- **lineStarts point after the `\n`, before the indent** — recording them later leaks each line's indent into the previous row: the flush-left bug. `textHtml` ends line *i* at `LS[i+1] - 1`.
- **Diff is a lazy island** — `src/diffcore.ts` + `src/diffview.ts` load via dynamic `import()` on first Diff click. Never import them (directly or transitively) from `main.ts`'s static graph, `worker.ts`, `render.ts`, or anything on the paste path. Self-contained on purpose: own preview/intern/Myers code instead of shared helpers, so it can move to a worker without touching hot files. In the singlefile build Rollup inlines the chunk — that's fine: only trivial top-level consts evaluate at boot; all work stays behind the click. Deep-equal subtrees emit nothing; array alignment = prefix/suffix trim + Myers over interned `JSON.stringify` keys (the native floor again), D-capped with a pairwise fallback. Side-by-side mode runs `diffAligned` (full paired emission) lazily and only when that toggle is used — focus mode stays the cheap default.
- **Search is the second island** — `src/search.ts`, same dynamic-`import()` rules as diff (first ⌘F/Find). Painter swap costs two falsy checks per WINDOW paint (`searchOpen && searchSt && searchMod` in both text and tree painters); zero-match rows are byte-equal to the plain painters (`textHtml`/`treeHtml`, test-enforced). `findAll` (Text view only — Min is excluded from search) = repeated native `indexOf` over a per-vm cached lowercase fold; the fold is trusted only when length-preserving (1:1 index proof) — otherwise case-sensitive fallback on raw. Regex mode compiles `g(+i)` and aborts past a 100 ms budget (partial results flagged; a single pathological exec can still stall — accepted, worker escape hatch exists). Matches are starts+ends pairs (`firstEndAfter` over ends for line overlap — regex spans are unbounded). Tree mode scans the INTERNED key/value pools once per query (`attachTree`), navigation walks visible matching nodes (`refreshTree` after every collapse/expand). Match state is doc-scoped: every invalidation point that clears diffs also closes search.

## Contracts (fuzz enforces, keep byte-exact)

- `emitJson().pretty` ≡ `JSON.stringify(v, null, indent)`.
- token pairs ≡ `tokenize(pretty)` minus punct.
- Worker replies: fixed key order, buffers transferred, never HTML strings.

## Red gate

`bun run build` (tsc + singlefile build), `bun test`, `bun tests/fuzz.ts`, `bun run bench` — bench gates the PASTE PATH via the **walk/native ratio** (per-run: (total − parse − stringify) / (parse + stringify), min-of-7, trip at 0.75): absolute ms flake with machine heat/load (observed 21→40ms with zero path changes), but native floor and pipeline drift TOGETHER, so only real walk regressions move the ratio. Tree/min are lazy and reported on-demand, not gated. A feature ships only with the gate green; a perf change ships only with the bench number attached.

## Platform edges (measured; not fixable in code)

- Silent clipboard reads on page load: Chrome allows only with a prior grant; Firefox/Safari require a gesture **per read** and never persist it. Retry on every activation is the ceiling — no UI hint requested.
- iOS Safari drops `paste` on non-editable targets — the hidden focused textarea is the paste surface.
- Firefox needs `readText` called during the gesture; old engines lack it entirely.

## Flow

Stacked branches, one concern per commit, PR per stage, base-first merges. `vercel.json` drives the Vercel deploy (build `bun run build`, output `dist`).
