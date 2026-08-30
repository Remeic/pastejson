// Focused A/B measurement for Stage A.
// Run: bun scripts/bench-viewport.ts
// The global side models the pre-Stage-A full pretty-token table. The local
// side uses the production window painter. Both render the same three 80-row
// windows from one deterministic document and assert byte equality.
import { performance } from 'node:perf_hooks';
import { buildView } from '../src/viewmodel';
import { textHtml } from '../src/render';
import { rangeHtml } from '../src/highlight';
import { tokenize, tokenizeWindow, T_PUNCT } from '../src/tokenizer';
import { findAll, rowHtml } from '../src/search';

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

function syntaxTokens(src: string): Int32Array {
  const all = tokenize(src);
  const kept: number[] = [];
  for (let i = 0; i < all.length; i += 2) {
    if (all[i + 1] !== T_PUNCT) kept.push(all[i], all[i + 1]);
  }
  return Int32Array.from(kept);
}

function globalTextHtml(vm: ReturnType<typeof buildView>, first: number, count: number, tokens: Int32Array): string {
  const P = vm.pretty;
  const LS = vm.lineStarts;
  const last = Math.min(first + count, vm.lines);
  let h = '';
  for (let i = first; i < last; i++) {
    const s = LS[i];
    const e = i + 1 < vm.lines ? LS[i + 1] - 1 : P.length;
    h += `<div class="row"><span class="ln">${i + 1}</span><code>${rangeHtml(P, tokens, s, e)}</code></div>`;
  }
  return h;
}

const target = 5 * 1024 * 1024;
let lo = 1000;
let hi = 200000;
for (let it = 0; it < 18; it++) {
  const mid = (lo + hi) >> 1;
  const candidate = JSON.stringify(gen(mid), null, 2);
  if (candidate.length < target) lo = mid;
  else hi = mid;
}

const value = gen(lo);
const vm = buildView(value, 2, JSON.stringify(value).length);
const windows = [0, Math.floor(vm.lines / 2), Math.max(0, vm.lines - 80)];
const globalTokens = syntaxTokens(vm.pretty);

for (const first of windows) {
  const expected = globalTextHtml(vm, first, 80, globalTokens);
  const actual = textHtml(vm, first, 80);
  if (actual !== expected) throw new Error(`window mismatch at ${first}`);
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

let sink = 0;

const SAMPLE_COUNT = 31;

function samples(fn: () => void, count = SAMPLE_COUNT): number[] {
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    fn();
    values.push(performance.now() - t0);
  }
  return values;
}

// Cold paint: every sample gets a new VM and therefore cannot reuse the
// one-window cache. Build is intentionally outside this profile.
const coldVms = Array.from({ length: SAMPLE_COUNT }, () => buildView(value, 2, JSON.stringify(value).length));
const coldPaint = median(coldVms.map((coldVm) => {
  const t0 = performance.now();
  sink += textHtml(coldVm, windows[1], 80).length;
  return performance.now() - t0;
}));

// Sequential scroll: each sample visits distinct windows in order. The
// cache is a miss for every window, including the wrap to the first window.
const sequenceVms = Array.from({ length: SAMPLE_COUNT }, () => buildView(value, 2, JSON.stringify(value).length));
const sequentialPaint = median(sequenceVms.map((sequenceVm) => {
  const t0 = performance.now();
  for (const first of windows) sink += textHtml(sequenceVm, first, 80).length;
  return performance.now() - t0;
}));

const buildFirstPaint = median(samples(() => {
  const firstVm = buildView(value, 2, JSON.stringify(value).length);
  sink += textHtml(firstVm, windows[1], 80).length;
}));

const fullTokenBuild = median(samples(() => {
  sink += syntaxTokens(vm.pretty).length;
}));
const localTokenBuild = median(samples(() => {
  const last = Math.min(windows[1] + 80, vm.lines);
  sink += tokenizeWindow(vm.pretty, vm.lineStarts[windows[1]], last < vm.lines ? vm.lineStarts[last] - 1 : vm.pretty.length).length;
}));
const searchCases = [
  { name: 'zero-hit', q: 'not-present', opts: { ci: true, re: false } },
  { name: 'normal-hit', q: 'Milano', opts: { ci: true, re: false } },
  { name: 'cross-line', q: '0,\n      "guid"', opts: { ci: true, re: false } },
] as const;
for (const searchCase of searchCases) {
  const coldSearchVms = Array.from({ length: SAMPLE_COUNT }, () => buildView(value, 2, JSON.stringify(value).length));
  const coldSearchPaint = median(coldSearchVms.map((searchVm) => {
    const st = findAll(searchVm, searchCase.q, searchCase.opts);
    const t0 = performance.now();
    sink += rowHtml(searchVm, st, windows[1], 80).length;
    return performance.now() - t0;
  }));
  const sequenceSearchVms = Array.from({ length: SAMPLE_COUNT }, () => buildView(value, 2, JSON.stringify(value).length));
  const sequenceSearchPaint = median(sequenceSearchVms.map((searchVm) => {
    const st = findAll(searchVm, searchCase.q, searchCase.opts);
    const t0 = performance.now();
    for (const first of windows) sink += rowHtml(searchVm, st, first, 80).length;
    return performance.now() - t0;
  }));
  console.log(`search ${searchCase.name} cold 80-row paint ${coldSearchPaint.toFixed(2)} ms (median of ${SAMPLE_COUNT})`);
  console.log(`search ${searchCase.name} sequential 3-window paint ${sequenceSearchPaint.toFixed(2)} ms (median of ${SAMPLE_COUNT})`);
}

console.log(`pretty ${(vm.pretty.length / 1048576).toFixed(2)} MB, ${vm.lines} lines`);
console.log(`full token table ${globalTokens.length >> 1} pairs / ${globalTokens.byteLength} bytes`);
console.log(`local 3-window tables ${windows.map((first) => {
  const last = Math.min(first + 80, vm.lines);
  return tokenizeWindow(vm.pretty, vm.lineStarts[first], last < vm.lines ? vm.lineStarts[last] - 1 : vm.pretty.length).length >> 1;
}).join(',')} pairs`);
console.log(`full token construction ${fullTokenBuild.toFixed(2)} ms (median of ${SAMPLE_COUNT})`);
console.log(`local token construction ${localTokenBuild.toFixed(2)} ms (median of ${SAMPLE_COUNT})`);
console.log(`local cold first 80-row paint ${coldPaint.toFixed(2)} ms (median of ${SAMPLE_COUNT}, new VM each sample)`);
console.log(`local sequential 3-window paint ${sequentialPaint.toFixed(2)} ms (median of ${SAMPLE_COUNT}, cache miss each window)`);
console.log(`local build + first 80-row paint ${buildFirstPaint.toFixed(2)} ms (median of ${SAMPLE_COUNT})`);
console.log(`sink ${sink}`);
