# About json

json ([json.justgiulio.dev](https://json.justgiulio.dev/)) is a free, single-purpose JSON tool: paste JSON, see it formatted instantly. It handles multi-megabyte documents in milliseconds because it is built directly on the browser's native JSON parser with a hand-tuned rendering pipeline — no frameworks on the hot path, no network round-trips, no server.

## Principles

- **100% local.** Your JSON never leaves the browser. No uploads, no storage, no telemetry.
- **Speed is the product.** The 5 MB paste pipeline completes in ~30 ms on commodity hardware, measured on every commit by an automated performance gate.
- **One file.** The whole app ships as a single ~74 KB HTML file. It loads fast, works offline after first load, and asks for nothing.

## Features

Pretty-print with configurable indent, collapsible tree view, minification, diff between two documents (focused changes or side by side), regex find, JSONL support.

## The author

Built by Giulio Fagioli — [justgiulio.dev](https://justgiulio.dev). Source code: [github.com/Remeic/pastejson](https://github.com/Remeic/pastejson).
