// Perf smoke: synthetic ~5MB payload through the FULL pipeline.
// Run: bun scripts/bench.ts
// Gate = PASTE PATH (parse → buildView → window paint): the product promise.
// Tree is lazy (flatten on demand, same philosophy as lazy min) and is
// REPORTED separately, not gated.
import { buildView, buildMinTokens } from '../src/viewmodel';
import { flatten, buildVisible } from '../src/tree';
import { textHtml } from '../src/render';
import { findAll } from '../src/search';
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
const runs: { parse: number; stringify: number; buildView: number; paint: number; total: number }[] = [];
for (let run = 0; run < 7; run++) {
  let t0 = performance.now();
  const value: unknown = JSON.parse(raw);
  const tParse = performance.now() - t0;

  t0 = performance.now();
  const pretty = JSON.stringify(value, null, 2);
  const tStringify = performance.now() - t0;

  t0 = performance.now();
  const vm = buildView(value, 2, raw.length);
  const tView = performance.now() - t0;

  t0 = performance.now();
  textHtml(vm, 0, 80);
  const tPaint = performance.now() - t0;

  runs.push({ parse: tParse, stringify: tStringify, buildView: tView, paint: tPaint, total: tParse + tView + tPaint });
  void pretty;

  if (run === 0) {
    console.log(
      `pretty ${(vm.pretty.length / 1048576).toFixed(2)} MB, ${vm.lines} lines`,
    );
    const t1 = performance.now();
    const ft = flatten(value, vm.lines);
    const vis = buildVisible(ft, new Uint8Array(ft.rowCount).fill(1));
    if (vis.length !== ft.rowCount) throw new Error('visible mismatch');
    console.log(`lazy tree on demand (flatten+visible): ${(performance.now() - t1).toFixed(1)} ms, nodes ${ft.rowCount}`);
    const t2 = performance.now();
    buildMinTokens(vm);
    console.log(`lazy min+tokens (on demand): ${(performance.now() - t2).toFixed(1)} ms`);
    // search island: first query pays the one-time lowercase fold + find-all
    const t3 = performance.now();
    const st = findAll(vm, 'Milano', { ci: true, re: false });
    console.log(
      `lazy search fold+findAll (on demand): ${(performance.now() - t3).toFixed(1)} ms, hits ${st.starts.length}`,
    );
    const t4 = performance.now();
    findAll(vm, 'g-12345', { ci: true, re: false });
    console.log(`repeat query (fold cached): ${(performance.now() - t4).toFixed(1)} ms`);
  }
}

const min = (xs: number[]): number => Math.min(...xs);
const p = {
  parse: min(runs.map((r) => r.parse)),
  stringify: min(runs.map((r) => r.stringify)),
  buildView: min(runs.map((r) => r.buildView)),
  paint: min(runs.map((r) => r.paint)),
};
const total = min(runs.map((r) => r.total));
console.log(`parse            ${p.parse.toFixed(1)} ms`);
console.log(`stringify(native) ${p.stringify.toFixed(1)} ms`);
console.log(`buildView(fused) ${p.buildView.toFixed(1)} ms  ← native stringify + closure-free walk (no tree)`);
console.log(`window paint 80 rows ${p.paint.toFixed(1)} ms`);
console.log(`paste pipeline   ${total.toFixed(1)} ms (min of 7)`);

// Drift-immune gate: absolute ms flake on warm/shared machines (observed
// 21→26.5ms across a session with ZERO bench-path changes). Gate on the
// per-run walk-to-native RATIO — GC pressure and thermal drift inflate
// total and native in the same iteration, so the ratio only moves when
// our JS actually regresses. Today's walk ≈ 0.45× native; trip at 0.75.
// Statistic = MEDIAN of per-run ratios (audit F-05): min-of-a-difference is
// biased low and moved 0.05→0.53 across identical-code runs; median is stable.
const ratios = runs.map((r) => (r.total - (r.parse + r.stringify)) / (r.parse + r.stringify));
const sorted = [...ratios].sort((a, b) => a - b);
const walkRatio = sorted[sorted.length >> 1];
console.log(
  `walk/native ratio ${walkRatio.toFixed(2)} (median of per-run ratios; min ${Math.min(...ratios).toFixed(2)})`,
);
if (walkRatio > 0.75) {
  console.warn(`FAIL: walk/native ${walkRatio.toFixed(2)} > 0.75 — walk regression`);
  process.exit(1);
}
console.log(`PASS: walk/native ${walkRatio.toFixed(2)} ≤ 0.75 (drift-immune)`);
