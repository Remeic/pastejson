// Search ISLAND — dynamically imported on first ⌘F / Find click.
// Zero paste-path cost: nothing here evaluates until the bar opens, and the
// closed-bar painter branch costs two falsy checks per WINDOW paint.
//
// Core = native floor again: repeated String.indexOf over a cached lowercase
// copy (SIMD memmem), no JS per-char loops. Offset safety: toLowerCase maps
// each char to >=1 chars, so total-length-preserved => strict 1:1 index
// mapping. Length mismatch (exotic folds) => case-sensitive fallback on raw.
//
// Regex mode compiles user pattern with g(+i) flags; exec loop aborts past a
// time budget (partial results, flagged) — a single pathological exec can
// still stall (accepted; worker escape hatch exists if it ever bites).
//
// Tree search scans the INTERNED key/value string pools once per query, so
// cost tracks unique strings + leaves, not visible rows. Painter contract:
// zero-hit outputs are byte-equal to the plain painters (tests enforce).

import { esc, rangeHtml } from './highlight';
import { valCls } from './render';
import type { FlatTree } from './tree';
import type { ViewModel } from './viewmodel';

export interface SearchOpts {
  ci: boolean; // case-insensitive
  re: boolean; // query is a regex
}

export interface SearchState {
  q: string;
  opts: SearchOpts;
  starts: Int32Array; // match start offsets in vm.pretty (sorted)
  ends: Int32Array; // match end offsets (variable length under regex)
  cur: number; // current index in ACTIVE view's sequence, -1 = none
  ms: number; // doc findAll build time
  partial: boolean; // budget abort — results are a prefix
  bad: string; // regex compile error ('' = ok)
  tree: TreeHits | null; // lazy: built when tree view meets an open bar
}

export interface TreeHits {
  keyHit: (Int32Array | null)[]; // per interned key id: [s0,e0,s1,e1…] or null
  valHit: (Int32Array | null)[]; // per interned value id
  nodeHit: Uint8Array; // per node: 1 = key or value matches
  visNodeIds: Int32Array; // matching nodes in VISUAL order
  pos: Int32Array; // nodeId -> visual sequence idx, -1 = none
  visCount: number;
}

const BUDGET_MS = 100;
const MAX_HITS = 250_000;

class GrowInt32 {
  arr: Int32Array;
  len = 0;
  constructor() {
    this.arr = new Int32Array(256);
  }
  push(v: number): void {
    if (this.len === this.arr.length) this.grow();
    this.arr[this.len++] = v;
  }
  push2(a: number, b: number): void {
    if (this.len + 2 > this.arr.length) this.grow();
    this.arr[this.len++] = a;
    this.arr[this.len++] = b;
  }
  private grow(): void {
    const g = new Int32Array(this.arr.length << 1);
    g.set(this.arr);
    this.arr = g;
  }
  trim(): Int32Array {
    return this.len === this.arr.length ? this.arr : this.arr.slice(0, this.len);
  }
}

// lowered pretty copy, cached per ViewModel (vm is recreated per doc/indent
// change → auto-invalidation). Unusable fold degrades to the raw string;
// caller checks ci to know whether case-insensitive search is safe.
const lowerCache = new WeakMap<ViewModel, { h: string; ci: boolean }>();
function foldedHay(vm: ViewModel): { h: string; ci: boolean } {
  let e = lowerCache.get(vm);
  if (e === undefined) {
    const l = vm.pretty.toLowerCase();
    const ci = l.length === vm.pretty.length;
    e = { h: ci ? l : vm.pretty, ci };
    lowerCache.set(vm, e);
  }
  return e;
}

function baseState(q: string, opts: SearchOpts): SearchState {
  return { q, opts, starts: new Int32Array(0), ends: new Int32Array(0), cur: -1, ms: 0, partial: false, bad: '', tree: null };
}

export function findAll(vm: ViewModel, q: string, opts: SearchOpts): SearchState {
  if (!q) return baseState(q, opts);
  if (opts.re) return findAllRe(vm, q, opts);
  const t0 = performance.now();
  const nl = q.toLowerCase();
  const needleOk = nl.length === q.length;
  const hay = foldedHay(vm);
  // case-insensitive only when BOTH folds are index-exact
  const H = opts.ci && needleOk && hay.ci ? hay.h : vm.pretty;
  const N = opts.ci && needleOk ? nl : q;
  const g = new GrowInt32();
  const ml = N.length;
  if (ml <= H.length) {
    let pos = 0;
    for (;;) {
      const i = H.indexOf(N, pos);
      if (i < 0 || g.len >= MAX_HITS) break;
      g.push(i);
      pos = i + ml;
    }
  }
  const starts = g.trim();
  const ends = new Int32Array(starts.length);
  for (let i = 0; i < ends.length; i++) ends[i] = starts[i] + ml;
  const st = baseState(q, opts);
  st.starts = starts;
  st.ends = ends;
  st.cur = starts.length > 0 ? 0 : -1;
  st.ms = performance.now() - t0;
  return st;
}

function findAllRe(vm: ViewModel, q: string, opts: SearchOpts): SearchState {
  const t0 = performance.now();
  const st = baseState(q, opts);
  let re: RegExp;
  try {
    re = new RegExp(q, opts.ci ? 'gi' : 'g');
  } catch (err) {
    st.bad = err instanceof Error ? err.message : String(err);
    return st;
  }
  const H = vm.pretty;
  const starts = new GrowInt32();
  const ends = new GrowInt32();
  while (starts.len < MAX_HITS) {
    const m = re.exec(H);
    if (m === null) break;
    starts.push(m.index);
    ends.push(m.index + m[0].length);
    if (m[0].length === 0) re.lastIndex++; // zero-length match — advance
    if (performance.now() - t0 > BUDGET_MS) {
      st.partial = true;
      break;
    }
  }
  st.starts = starts.trim();
  st.ends = ends.trim();
  st.cur = st.starts.length > 0 ? 0 : -1;
  st.ms = performance.now() - t0;
  return st;
}

// scan one SHORT string (interned key/val preview). `re` is compiled once per
// QUERY by attachTree and passed in — compiling per row was 17k compiles for
// 17k keys (audit F-06).
function scanStr(s: string, q: string, opts: SearchOpts, re: RegExp | null): Int32Array | null {
  if (!q) return null;
  if (!opts.re) {
    const N = opts.ci ? q.toLowerCase() : q;
    if (N.length !== q.length) return null; // exotic needle fold — skip pool
    const H = opts.ci ? s.toLowerCase() : s;
    if (H.length !== s.length && opts.ci) return null; // exotic string fold
    const ml = N.length;
    if (ml > s.length) return null;
    const g = new GrowInt32();
    let pos = 0;
    for (;;) {
      const i = H.indexOf(N, pos);
      if (i < 0) break;
      g.push2(i, i + ml);
      pos = i + ml;
    }
    return g.len > 0 ? g.trim() : null;
  }
  if (re === null) return null; // regex mode with unparseable pattern
  const g = new GrowInt32();
  for (;;) {
    const m = re.exec(s);
    if (m === null || g.len >= 512) break; // per-string cap: previews are short
    g.push2(m.index, m.index + m[0].length);
    if (m[0].length === 0) re.lastIndex++;
  }
  return g.len > 0 ? g.trim() : null;
}

// per-string hit tables over the interned pools + per-node flags — one-time
// O(unique keys + leaves + nodes) per query
export function attachTree(
  st: SearchState,
  ft: FlatTree,
  visibleRows: Int32Array | null,
): void {
  let re: RegExp | null = null;
  if (st.opts.re) {
    try {
      re = new RegExp(st.q, st.opts.ci ? 'gi' : 'g');
    } catch {
      re = null; // bad pattern — pools scan to all-null, matches text-path behavior
    }
  }
  const keyHit: (Int32Array | null)[] = new Array(ft.keys.length);
  for (let i = 0; i < ft.keys.length; i++) keyHit[i] = scanStr(ft.keys[i], st.q, st.opts, re);
  const valHit: (Int32Array | null)[] = new Array(ft.vals.length);
  for (let i = 0; i < ft.vals.length; i++) valHit[i] = scanStr(ft.vals[i], st.q, st.opts, re);
  const nodeHit = new Uint8Array(ft.rowCount);
  const KEYIDX = ft.keyIdx;
  const VALIDX = ft.valIdx;
  for (let n = 0; n < ft.rowCount; n++) {
    const ki = KEYIDX[n];
    if ((ki >= 0 && keyHit[ki] !== null) || (ft.kind[n] === 0 && valHit[VALIDX[n]] !== null))
      nodeHit[n] = 1;
  }
  st.tree = { keyHit, valHit, nodeHit, visNodeIds: new Int32Array(0), pos: new Int32Array(0), visCount: 0 };
  refreshTree(st, ft, visibleRows);
}

// recompute the visible matching-node sequence (attach / collapse / view
// switch). visibleRows=null ⇒ every node is visible (all-expanded).
export function refreshTree(st: SearchState, ft: FlatTree, visibleRows: Int32Array | null): void {
  const t = st.tree;
  if (t === null) return;
  const seq = visibleRows ?? allRows(ft.rowCount);
  const NODEHIT = t.nodeHit;
  const vis = new GrowInt32();
  const pos = new Int32Array(ft.rowCount).fill(-1);
  for (let v = 0; v < seq.length; v++) {
    const n = seq[v];
    if (NODEHIT[n]) {
      pos[n] = vis.len;
      vis.push(n);
    }
  }
  t.visNodeIds = vis.trim();
  t.pos = pos;
  t.visCount = vis.len;
  if (vis.len === 0) st.cur = -1;
  else if (st.cur < 0 || st.cur >= vis.len) st.cur = 0;
}

function allRows(n: number): Int32Array {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

// line containing offset — binary search over lineStarts (greatest LS[i] <= off)
export function lineOf(LS: Uint32Array, off: number): number {
  let lo = 0;
  let hi = LS.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (LS[m] <= off) {
      ans = m;
      lo = m + 1;
    } else {
      hi = m - 1;
    }
  }
  return ans;
}

// first index with E[i] > x (E sorted non-decreasing — matches never overlap)
function firstEndAfter(E: Int32Array, x: number): number {
  let lo = 0;
  let hi = E.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (E[m] <= x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

// ---------- painters ----------

function markWrap(cur: boolean, slice: string): string {
  return cur ? `<mark class="mc">${esc(slice)}</mark>` : `<mark class="m">${esc(slice)}</mark>`;
}

// Row painter for Text view with match marks. Same row markup as textHtml;
// lines without matches take the byte-identical fast path.
export function rowHtml(
  vm: ViewModel,
  st: SearchState,
  first: number,
  count: number,
): string {
  const P = vm.pretty;
  const LS = vm.lineStarts;
  const TOK = vm.tokP;
  const L = vm.lines;
  const S = st.starts;
  const E = st.ends;
  const nm = S.length;
  const last = Math.min(first + count, L);
  let h = '';
  for (let i = first; i < last; i++) {
    const s = LS[i];
    const e = i + 1 < L ? LS[i + 1] - 1 : P.length;
    // candidates may start before s when the match spans the newline —
    // first match whose END is past the line start (exact, any span length)
    let k = firstEndAfter(E, s);
    if (k >= nm || S[k] >= e) {
      h += `<div class="row"><span class="ln">${i + 1}</span><code>${rangeHtml(P, TOK, s, e)}</code></div>`;
      continue;
    }
    let c = s;
    let body = '';
    while (k < nm && S[k] < e && c < e) {
      const me = Math.min(E[k], e); // clip cross-line tail to this row
      const ms = S[k] > c ? S[k] : c;
      if (S[k] > c) body += rangeHtml(P, TOK, c, S[k]);
      if (me > ms) {
        // zero-length matches never open a mark (regex edge)
        body += markWrap(k === st.cur, P.slice(ms, me));
        c = me;
      }
      k++;
    }
    if (c < e) body += rangeHtml(P, TOK, c, e);
    h += `<div class="row"><span class="ln">${i + 1}</span><code>${body}</code></div>`;
  }
  return h;
}

// wrap matched ranges of one short string; plain-esc fallback keeps output
// byte-equal to the plain painter when ranges is null
function markedStr(s: string, ranges: Int32Array | null, cls: string): string {
  if (ranges === null) return `<span class="${cls}">${esc(s)}</span>`;
  let h = '';
  let c = 0;
  for (let r = 0; r < ranges.length; r += 2) {
    const ms = ranges[r];
    const me = ranges[r + 1];
    if (ms > c) h += `<span class="${cls}">${esc(s.slice(c, ms))}</span>`;
    h += markWrap(false, s.slice(ms, me));
    c = me;
  }
  if (c < s.length) h += `<span class="${cls}">${esc(s.slice(c))}</span>`;
  return h;
}

// Row painter for Tree view with marks on keys/values + current-node tint.
// Zero-hit state produces byte-identical markup to render.treeHtml.
export function treeRowHtml(
  ft: FlatTree,
  expanded: Uint8Array,
  visible: Int32Array,
  st: SearchState,
  first: number,
  count: number,
): string {
  const t = st.tree!;
  const last = Math.min(first + count, visible.length);
  const KIND = ft.kind;
  const DEPTH = ft.depth;
  const KEYIDX = ft.keyIdx;
  const META = ft.meta;
  const VALIDX = ft.valIdx;
  const KEYS = ft.keys;
  const VALS = ft.vals;
  const POS = t.pos;
  let h = '';
  for (let v = first; v < last; v++) {
    const n = visible[v];
    const exp = expanded[n];
    const kind = KIND[n];
    const isBranch = kind !== 0;
    const curNode = POS[n] === st.cur && POS[n] >= 0;
    const caret = isBranch
      ? `<button class="car${exp ? ' open' : ''}" data-n="${n}" aria-expanded="${exp ? 'true' : 'false'}" aria-label="toggle"></button>`
      : '<span class="carsp"></span>';
    const ki = KEYIDX[n];
    const keyPart =
      ki >= 0 ? `${markedStr(KEYS[ki], t.keyHit[ki], 'tk')}<i class="p">:</i> ` : '';
    let body: string;
    if (isBranch) {
      body =
        `<i class="p">${kind === 2 ? '[' : '{'}</i>` +
        `<span class="meta">${META[n]}</span>`;
    } else {
      const vi = VALIDX[n];
      body = markedStr(VALS[vi], t.valHit[vi], valCls(VALS[vi]));
    }
    h += `<div class="trow${curNode ? ' smc' : ''}" data-n="${n}" style="padding-left:${8 + DEPTH[n] * 14}px">${caret}${keyPart}${body}</div>`;
  }
  return h;
}
