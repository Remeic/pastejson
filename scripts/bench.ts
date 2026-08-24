// Perf smoke: synthetic ~5MB payload through the FULL pipeline.
// Run: bun scripts/bench.ts
import { buildView } from '../src/viewmodel';
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
let payload!: ReturnType<typeof gen>;
let lo = 1000;
let hi = 200000;
// bisect row count to land near 5MB pretty size
for (let it = 0; it < 18; it++) {
  const mid = (lo + hi) >> 1;
  const cand = JSON.stringify(gen(mid), null, 2);
  if (cand.length < target) lo = mid;
  else hi = mid;
}
payload = gen(lo);
const raw = JSON.stringify(payload);
console.log(`payload minified: ${(raw.length / 1048576).toFixed(2)} MB, items: ${lo}`);

const tParse0 = performance.now();
const value: unknown = JSON.parse(raw);
const tParse = performance.now() - tParse0;

const tView0 = performance.now();
const vm = buildView(value, 2, raw.length);
const tView = performance.now() - tView0;

const tFlat0 = performance.now();
const ft = flatten(value);
const vis = buildVisible(ft, new Uint8Array(ft.rowCount).fill(1));
const tFlat = performance.now() - tFlat0;
if (vis.length !== ft.rowCount) throw new Error('visible mismatch');

const tPaint0 = performance.now();
const sample = rangeHtml(vm.pretty, vm.tokP, 0, 20000);
const tPaint = performance.now() - tPaint0;

console.log(`parse            ${tParse.toFixed(1)} ms`);
console.log(`buildView        ${tView.toFixed(1)} ms  (pretty ${(vm.pretty.length / 1048576).toFixed(2)} MB, ${vm.lines} lines, tokens ${(vm.tokP.length >> 1)})`);
console.log(`flatten+visible  ${tFlat.toFixed(1)} ms  (${ft.rowCount} nodes)`);
console.log(`window paint 20k ${tPaint.toFixed(1)} ms  (sample ${sample.length} chars)`);

const budgetMs = 400;
const total = tParse + tView + tFlat;
if (total > budgetMs) {
  console.warn(`WARN: pipeline ${total.toFixed(0)}ms > ${budgetMs}ms budget`);
} else {
  console.log(`pipeline OK: ${total.toFixed(0)}ms <= ${budgetMs}ms budget`);
}
