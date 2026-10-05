// Fuzz: emitJson output must be byte-identical to JSON.stringify,
// tokens identical to tokenize(pretty), lazy tree (flatten) row count exact
// AND columns/keys/vals byte-identical to a single preview-keyed reference walk.
// Run: bun tests/fuzz.ts
import assert from 'node:assert';
import { emitJson } from '../src/serialize';
import { tokenize, T_PUNCT } from '../src/tokenizer';
import { flatten, buildVisible, type FlatTree } from '../src/tree';

// deterministic xorshift
let seed = 0x9e3779b9;
function rnd(): number {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
}

const NASTY = [
  '', '"', '\\', '\\"', '\n', '\r\t', '\u0000', '\u001f', '\b\f',
  '😀', 'a\u0301', '  ', '__proto__', 'constructor', 'length',
  '\ud800', 'x\ud800y', '\udfff', 'a\ud800\udc00b', // lone + paired surrogates
  'quote"inside', 'back\\slash', 'line\nbreak\n\nx',
  'true', 'false', 'null', // collide with booleans/null if literal map is shared
  'a'.repeat(200),
];
const NUMS = [0, -0, 1, -1, 0.1, -123.456, 1e21, 1e-7, 123456789012345680000, 3.5e300, -2.2250738585072014e-308];
const KEYS = ['', 'a', 'key', '__proto__', 'x y', '"q"', ...NASTY];

function leaf(): unknown {
  const r = rnd();
  if (r < 0.45) {
    const s = NASTY[(rnd() * NASTY.length) | 0];
    return rnd() < 0.5 ? s : s + 'tail' + ((rnd() * 100) | 0);
  }
  if (r < 0.75) return NUMS[(rnd() * NUMS.length) | 0];
  if (r < 0.9) return rnd() < 0.5;
  return null;
}

function genVal(depth: number): unknown {
  const r = rnd();
  if (depth >= 5 || r < 0.4) return leaf();
  if (r < 0.7) {
    const o: Record<string, unknown> = {};
    const n = (rnd() * 6) | 0;
    for (let i = 0; i < n; i++) {
      o[KEYS[(rnd() * KEYS.length) | 0] + (rnd() < 0.3 ? i : '')] = genVal(depth + 1);
    }
    return o;
  }
  const a: unknown[] = [];
  const n = (rnd() * 6) | 0;
  for (let i = 0; i < n; i++) a.push(genVal(depth + 1));
  return a;
}

function countNodes(v: unknown): number {
  if (v === null || typeof v !== 'object') return 1;
  let c = 1;
  for (const k of Array.isArray(v) ? v : Object.values(v)) c += countNodes(k);
  return c;
}

// Independent reference: the ORIGINAL single-map (preview-keyed) interning
// scheme, recursive for clarity. flatten()'s split maps must be byte-identical
// to this — columns, keys[], vals[] — and keep vals unique.
const REF_MAX = 120;
const REF_ESC = /[\\"\u0000-\u001f]/;
function refPreview(v: unknown): string {
  const t = typeof v;
  if (t === 'string') {
    const s = v as string;
    if (s.length > REF_MAX - 2) {
      const j = JSON.stringify(s);
      return j.length <= REF_MAX ? j : j.slice(0, REF_MAX - 1) + '…"';
    }
    return REF_ESC.test(s) ? JSON.stringify(s) : '"' + s + '"';
  }
  if (t === 'number') return String(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  return 'null';
}
function flattenRef(value: unknown): FlatTree {
  const depth: number[] = [];
  const kind: number[] = [];
  const keyIdxA: number[] = [];
  const valIdxA: number[] = [];
  const meta: number[] = [];
  const subtree: number[] = [];
  const keys: string[] = [];
  const vals: string[] = [];
  const ki = new Map<string, number>();
  const vi = new Map<string, number>();
  const internKey = (k: string): number => {
    let id = ki.get(k);
    if (id === undefined) {
      id = keys.length;
      keys.push(k);
      ki.set(k, id);
    }
    return id;
  };
  const internVal = (v: unknown): number => {
    const s = refPreview(v);
    let id = vi.get(s);
    if (id === undefined) {
      id = vals.length;
      vals.push(s);
      vi.set(s, id);
    }
    return id;
  };
  const rec = (v: unknown, d: number, keyId: number): number => {
    const row = depth.length;
    depth.push(d);
    keyIdxA.push(keyId);
    meta.push(0);
    if (v === null || typeof v !== 'object') {
      kind.push(0);
      valIdxA.push(internVal(v));
      subtree.push(1);
      return 1;
    }
    const isArr = Array.isArray(v);
    kind.push(isArr ? 2 : 1);
    valIdxA.push(-1);
    subtree.push(-1);
    const list = isArr ? (v as unknown[]) : Object.keys(v as Record<string, unknown>);
    const n = list.length;
    let count = 1;
    for (let i = 0; i < n; i++) {
      const kId = isArr ? -1 : internKey(list[i] as string);
      const cv = isArr
        ? (v as unknown[])[i]
        : (v as Record<string, unknown>)[list[i] as string];
      count += rec(cv, d + 1, kId);
    }
    meta[row] = n;
    subtree[row] = count;
    return count;
  };
  rec(value, 0, -1);
  return {
    depth: Uint16Array.from(depth),
    kind: Int32Array.from(kind),
    keyIdx: Int32Array.from(keyIdxA),
    valIdx: Int32Array.from(valIdxA),
    meta: Int32Array.from(meta),
    subtreeRows: Int32Array.from(subtree),
    keys,
    vals,
    rowCount: depth.length,
  };
}

function assertSameTree(ft: FlatTree, ref: FlatTree, label: string): void {
  assert.strictEqual(ft.rowCount, ref.rowCount, `${label} rowCount`);
  for (const c of ['depth', 'kind', 'keyIdx', 'valIdx', 'meta', 'subtreeRows'] as const) {
    assert.deepStrictEqual([...ft[c]], [...ref[c]], `${label} ${c}`);
  }
  assert.deepStrictEqual(ft.keys, ref.keys, `${label} keys`);
  assert.deepStrictEqual(ft.vals, ref.vals, `${label} vals`);
  assert.strictEqual(new Set(ft.vals).size, ft.vals.length, `${label} vals unique`);
}

const INDENTS: (number | '\t')[] = [2, 4, '\t'];
let docs = 0;
for (let it = 0; it < 500; it++) {
  const v = genVal(0);
  const ind = INDENTS[it % 3];
  const r = emitJson(v, ind, 1000);
  const expected = JSON.stringify(v, null, ind);
  assert.strictEqual(r.pretty, expected, `pretty mismatch @${it}`);
  // punct tokens dropped by design (rendered via base code color)
  const toks = tokenize(r.pretty);
  const ref: number[] = [];
  for (let i = 0; i < toks.length; i += 2) {
    if (toks[i + 1] !== T_PUNCT) ref.push(toks[i], toks[i + 1]);
  }
  assert.deepStrictEqual([...r.tokens], ref, `tokens mismatch @${it}`);
  const ft = flatten(v);
  assert.strictEqual(ft.rowCount, countNodes(v), `rowCount mismatch @${it}`);
  assertSameTree(ft, flattenRef(v), `flatten vs reference @${it}`);
  assert.strictEqual(r.lines, r.lineStarts.length, `lines mismatch @${it}`);
  const vis = buildVisible(ft, new Uint8Array(ft.rowCount).fill(1));
  assert.strictEqual(vis.length, ft.rowCount, `visible mismatch @${it}`);
  docs++;
}

// edge roots
for (const v of [{}, [], '', 0, -0, null, true, { a: {} }, [[[[[]]]]], { '': { '': '' } }]) {
  for (const ind of INDENTS) {
    const r = emitJson(v, ind, 100);
    assert.strictEqual(r.pretty, JSON.stringify(v, null, ind));
  }
  assert.strictEqual(flatten(v).rowCount, countNodes(v));
  assertSameTree(flatten(v), flattenRef(v), 'edge root');
  docs++;
}

console.log(`fuzz OK: ${docs} docs byte-identical to JSON.stringify`);
