import { buildView, buildMinTokens } from '../src/viewmodel';
import { flatten, buildVisible } from '../src/tree';
import { rangeHtml } from '../src/highlight';
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

// Binary-search for a payload close to a target size in MB
function makePayload(targetMB: number): { value: unknown; raw: string; pretty: string; lines: number; tokens: number } {
  const target = targetMB * 1024 * 1024;
  let lo = 100;
  let hi = 300000;
  for (let it = 0; it < 20; it++) {
    const mid = (lo + hi) >> 1;
    const cand = JSON.stringify(gen(mid), null, 2);
    if (cand.length < target) lo = mid;
    else hi = mid;
  }
  const value = gen(lo);
  const raw = JSON.stringify(value);
  const pretty = JSON.stringify(value, null, 2);
  const vm = buildView(value, 2, raw.length);
  return { value, raw, pretty, lines: vm.lines, tokens: vm.tokP.length >> 1 };
}

const SIZES_MB = [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10];
const WARMUP = 2;
const MEASURED = 7;

interface Row {
  sizeMB: string;
  items: number;
  prettyMB: string;
  lines: number;
  tokens: string;
  parse: string;
  stringify: string;
  buildView: string;
  paint: string;
  paste: string;
  ratio: string;
  tree: string;
  minTokens: string;
  search: string;
  searchRepeat: string;
}

const rows: Row[] = [];

for (const targetMB of SIZES_MB) {
  const { value, raw, pretty, lines, tokens } = makePayload(targetMB);

  // warmup
  for (let w = 0; w < WARMUP; w++) {
    JSON.parse(raw);
    const p = buildView(value, 2, raw.length);
    rangeHtml(p.pretty, p.tokP, 0, Math.min(20000, p.pretty.length));
  }

  const runs: { parse: number; stringify: number; buildView: number; paint: number }[] = [];
  let treeMs = 0;
  let minTMs = 0;
  let searchMs = 0;
  let searchRepeatMs = 0;

  for (let run = 0; run < MEASURED; run++) {
    let t0 = performance.now();
    const v: unknown = JSON.parse(raw);
    const tParse = performance.now() - t0;

    t0 = performance.now();
    JSON.stringify(v, null, 2);
    const tStringify = performance.now() - t0;

    t0 = performance.now();
    const vm = buildView(v, 2, raw.length);
    const tView = performance.now() - t0;

    const paintLen = Math.min(20000, vm.pretty.length);
    t0 = performance.now();
    rangeHtml(vm.pretty, vm.tokP, 0, paintLen);
    const tPaint = performance.now() - t0;

    runs.push({ parse: tParse, stringify: tStringify, buildView: tView, paint: tPaint });

    if (run === 0) {
      const t1 = performance.now();
      const ft = flatten(v, vm.lines);
      const vis = buildVisible(ft, new Uint8Array(ft.rowCount).fill(1));
      if (vis.length !== ft.rowCount) throw new Error('visible mismatch');
      treeMs = performance.now() - t1;

      const t2 = performance.now();
      buildMinTokens(vm);
      minTMs = performance.now() - t2;

      const t3 = performance.now();
      findAll(vm, 'Milano', { ci: true, re: false });
      searchMs = performance.now() - t3;

      const t4 = performance.now();
      findAll(vm, 'g-12345', { ci: true, re: false });
      searchRepeatMs = performance.now() - t4;
    }
  }

  const min = (xs: number[]) => Math.min(...xs);
  const pParse = min(runs.map(r => r.parse));
  const pStr = min(runs.map(r => r.stringify));
  const pView = min(runs.map(r => r.buildView));
  const pPaint = min(runs.map(r => r.paint));
  const pasteMs = pParse + pView + pPaint;
  const nativeMs = pParse + pStr;
  const ratios = runs.map(r => (r.parse + r.buildView + r.paint - nativeMs) / nativeMs);
  const sorted = [...ratios].sort((a, b) => a - b);
  const ratio = sorted[sorted.length >> 1];

  const fmt = (ms: number) => ms < 1 ? `${(ms * 1000).toFixed(0)}μs` : ms < 10 ? `${ms.toFixed(1)}ms` : `${ms.toFixed(0)}ms`;

  rows.push({
    sizeMB: (raw.length / 1048576).toFixed(2),
    items: lo_count(raw),
    prettyMB: (pretty.length / 1048576).toFixed(2),
    lines: lines,
    tokens: fmtTokens(tokens),
    parse: fmt(pParse),
    stringify: fmt(pStr),
    buildView: fmt(pView),
    paint: fmt(pPaint),
    paste: fmt(pasteMs),
    ratio: ratio.toFixed(2),
    tree: fmt(treeMs),
    minTokens: fmt(minTMs),
    search: fmt(searchMs),
    searchRepeat: fmt(searchRepeatMs),
  });
}

function lo_count(raw: string): number {
  const v = JSON.parse(raw) as { items: unknown[] };
  return v.items.length;
}

function fmtTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}

// ── Print table ──
const hdr = ['Size', 'Items', 'Pretty', 'Lines', 'Tokens', 'Parse', 'Str(nat)', 'buildView', 'Paint 20K', 'Paste Total', 'Walk/Nat', 'Tree', 'Min+Tok', 'Search', 'Search2'];
const widths = [7, 8, 7, 6, 7, 7, 8, 9, 9, 11, 8, 7, 8, 8, 8];

function pad(s: string | number, w: number) {
  const str = String(s);
  return str.padStart(w);
}

const sep = widths.map(w => '─'.repeat(w)).join('┼');
console.log('┌' + widths.map(w => '─'.repeat(w)).join('┬') + '┐');
console.log('│' + hdr.map((h, i) => pad(h, widths[i])).join('│') + '│');
console.log('├' + sep + '┤');

for (const r of rows) {
  const vals = [r.sizeMB + 'MB', r.items, r.prettyMB + 'MB', r.lines, r.tokens, r.parse, r.stringify, r.buildView, r.paint, r.paste, r.ratio, r.tree, r.minTokens, r.search, r.searchRepeat];
  console.log('│' + vals.map((v, i) => pad(v, widths[i])).join('│') + '│');
}
console.log('└' + widths.map(w => '─'.repeat(w)).join('┴') + '┘');

console.log('\nAll times = min of 7 runs (ms unless prefixed μs). Walk/Nat = median ratio.');
