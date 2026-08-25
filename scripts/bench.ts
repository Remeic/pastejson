// Perf smoke: synthetic ~5MB payload through the FULL pipeline.
// Run: bun scripts/bench.ts
import { buildView, buildMinTokens } from '../src/viewmodel';
import { buildVisible } from '../src/tree';
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

// warm + measured runs (median of 3)
const runs: { parse: number; buildView: number; visible: number; paint: number; total: number }[] = [];
for (let run = 0; run < 3; run++) {
  let t0 = performance.now();
  const value: unknown = JSON.parse(raw);
  const tParse = performance.now() - t0;

  t0 = performance.now();
  const vm = buildView(value, 2, raw.length);
  const tView = performance.now() - t0;

  t0 = performance.now();
  const ft = vm.tree!;
  const vis = buildVisible(ft, new Uint8Array(ft.rowCount).fill(1));
  const tVisible = performance.now() - t0;
  if (vis.length !== ft.rowCount) throw new Error('visible mismatch');

  t0 = performance.now();
  rangeHtml(vm.pretty, vm.tokP, 0, 20000);
  const tPaint = performance.now() - t0;

  runs.push({ parse: tParse, buildView: tView, visible: tVisible, paint: tPaint, total: tParse + tView + tVisible + tPaint });

  if (run === 0) {
    console.log(
      `pretty ${(vm.pretty.length / 1048576).toFixed(2)} MB, ${vm.lines} lines, tokens ${vm.tokP.length >> 1}, nodes ${ft.rowCount}`,
    );
    const t1 = performance.now();
    buildMinTokens(vm);
    console.log(`lazy min+tokens (on demand): ${(performance.now() - t1).toFixed(1)} ms`);
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
const p = {
  parse: median(runs.map((r) => r.parse)),
  buildView: median(runs.map((r) => r.buildView)),
  visible: median(runs.map((r) => r.visible)),
  paint: median(runs.map((r) => r.paint)),
};
const total = median(runs.map((r) => r.total));
console.log(`parse            ${p.parse.toFixed(1)} ms`);
console.log(`buildView(fused) ${p.buildView.toFixed(1)} ms  ← native stringify + zero-string length walk`);
console.log(`buildVisible     ${p.visible.toFixed(1)} ms`);
console.log(`window paint 20k ${p.paint.toFixed(1)} ms`);
console.log(`pipeline total   ${total.toFixed(1)} ms (median of 3)`);

const budgetMs = 44; // ≥40% under the 73.5ms baseline
if (total > budgetMs) {
  console.warn(`FAIL: pipeline ${total.toFixed(0)}ms > ${budgetMs}ms target (−40% vs 73.5ms baseline)`);
  process.exit(1);
}
console.log(`PASS: ${total.toFixed(0)}ms ≤ ${budgetMs}ms target (≥40% vs 73.5ms baseline)`);
