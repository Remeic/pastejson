// Perf smoke: synthetic ~5MB payload through the FULL pipeline.
// Run: bun scripts/bench.ts
// Gate = PASTE PATH (parse → buildView → window paint): the product promise.
// Tree is lazy (flatten on demand, same philosophy as lazy min) and is
// REPORTED separately, not gated.
import { buildView, buildMinTokens } from '../src/viewmodel';
import { flatten, buildVisible } from '../src/tree';
import { rangeHtml } from '../src/highlight';
import { performance } from 'node:perf_hooks';

function gen(rows: number): Record<string, unknown> {
  const arr: unknown[] = [];
  for (let i = 0; i < rows; i++) {
    arr.push({
      id: i,
      guid: `g-${i}-${(i * 7919) % 99991}`,
      active: i % 2 === 0,
      score: Math.round(Math.sin(i) * 10000) / 100,
      tags: [`t${i % 13}`, `t${i % 7}`, 'common'],
      nested: { lat: 45.4 + i / 100000, lng: 9.19 + i / 100000, city: 'Milano' },
      note: i % 11 === 0 ? 'lorem ipsum dolor sit amet consectetur adipiscing elit' : null,
    });
  }
  return { name: 'bench', count: rows, items: arr };
}

const target = 5 * 1024 * 1024;
let lo = 1000;
let hi = 200000;
for (let it = 0; it < 18; it++) {
  const mid = (lo + hi) >> 1;
  const cand = JSON.stringify(gen(mid), null, 2);
  if (cand.length < target) lo = mid;
  else hi = mid;
}
const payload = gen(lo);
const raw = JSON.stringify(payload);
console.log(`payload minified: ${(raw.length / 1048576).toFixed(2)} MB, items: ${lo}`);

// warm + measured runs (min of 7 — min = machine capability, noise-proof)
const runs: { parse: number; buildView: number; paint: number; total: number }[] = [];
for (let run = 0; run < 7; run++) {
  let t0 = performance.now();
  const value: unknown = JSON.parse(raw);
  const tParse = performance.now() - t0;

  t0 = performance.now();
  const vm = buildView(value, 2, raw.length);
  const tView = performance.now() - t0;

  t0 = performance.now();
  rangeHtml(vm.pretty, vm.tokP, 0, 20000);
  const tPaint = performance.now() - t0;

  runs.push({ parse: tParse, buildView: tView, paint: tPaint, total: tParse + tView + tPaint });

  if (run === 0) {
    console.log(
      `pretty ${(vm.pretty.length / 1048576).toFixed(2)} MB, ${vm.lines} lines, tokens ${vm.tokP.length >> 1}`,
    );
    const t1 = performance.now();
    const ft = flatten(value, vm.lines);
    const vis = buildVisible(ft, new Uint8Array(ft.rowCount).fill(1));
    if (vis.length !== ft.rowCount) throw new Error('visible mismatch');
    console.log(`lazy tree on demand (flatten+visible): ${(performance.now() - t1).toFixed(1)} ms, nodes ${ft.rowCount}`);
    const t2 = performance.now();
    buildMinTokens(vm);
    console.log(`lazy min+tokens (on demand): ${(performance.now() - t2).toFixed(1)} ms`);
  }
}

const min = (xs: number[]): number => Math.min(...xs);
const p = {
  parse: min(runs.map((r) => r.parse)),
  buildView: min(runs.map((r) => r.buildView)),
  paint: min(runs.map((r) => r.paint)),
};
const total = min(runs.map((r) => r.total));
console.log(`parse            ${p.parse.toFixed(1)} ms`);
console.log(`buildView(fused) ${p.buildView.toFixed(1)} ms  ← native stringify + closure-free walk (no tree)`);
console.log(`window paint 20k ${p.paint.toFixed(1)} ms`);
console.log(`paste pipeline   ${total.toFixed(1)} ms (min of 7)`);

// Budget = measured JS floor: native parse 5.5 + native stringify 8.8 +
// paint 0.1 = 14.4ms untouchable (AGENTS.md floor doctrine); walk component
// floor ≈ 6.5ms (escLen 2 + keys/loads 1.8 + line-records 2 + dispatch 0.7).
// 21.5ms ≈ floor + slack; regressions trip it, physics doesn't.
const budgetMs = 22;
if (total > budgetMs) {
  console.warn(`FAIL: paste pipeline ${total.toFixed(0)}ms > ${budgetMs}ms target`);
  process.exit(1);
}
console.log(`PASS: ${total.toFixed(0)}ms ≤ ${budgetMs}ms target (floor-documented)`);
