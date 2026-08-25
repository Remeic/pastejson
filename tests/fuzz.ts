// Fuzz: emitJson output must be byte-identical to JSON.stringify,
// tokens identical to tokenize(pretty), tree row count exact.
// Run: bun tests/fuzz.ts
import assert from 'node:assert';
import { emitJson, materializeLabels } from '../src/serialize';
import { tokenize, T_BOUND } from '../src/tokenizer';
import { buildVisible } from '../src/tree';

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

const INDENTS: (number | '\t')[] = [2, 4, '\t'];
let docs = 0;
for (let it = 0; it < 500; it++) {
  const v = genVal(0);
  const ind = INDENTS[it % 3];
  const r = emitJson(v, ind, 1000);
  const expected = JSON.stringify(v, null, ind);
  assert.strictEqual(r.pretty, expected, `pretty mismatch @${it}`);
  // filter boundary markers, then compare with tokenize()
  const mine: number[] = [];
  {
    for (let i = 0; i < r.tokens.length; i += 2) {
      if (r.tokens[i + 1] !== T_BOUND) {
        mine.push(r.tokens[i], r.tokens[i + 1]);
      }
    }
  }
  const toks = tokenize(r.pretty);
  assert.deepStrictEqual(mine, [...toks], `tokens mismatch @${it}`);
  assert.strictEqual(r.tree.rowCount, countNodes(v), `rowCount mismatch @${it}`);
  assert.strictEqual(r.lines, r.lineStarts.length, `lines mismatch @${it}`);
  const vis = buildVisible(r.tree, new Uint8Array(r.tree.rowCount).fill(1));
  assert.strictEqual(vis.length, r.tree.rowCount, `visible mismatch @${it}`);
  // label materialization spot-check on every 50th doc
  if (it % 50 === 0) {
    materializeLabels(r.tree, r.pretty, r.tokens);
    assert.strictEqual(r.tree.keyIdx.length, r.tree.rowCount, `keyIdx @${it}`);
    let leafRows = 0;
    for (let r2 = 0; r2 < r.tree.rowCount; r2++) if (r.tree.valTokIdx[r2] >= 0) leafRows++;
    assert.strictEqual(r.tree.vals.length, leafRows, `vals @${it}`);
  }
  docs++;
}

// edge roots
for (const v of [{}, [], '', 0, -0, null, true, { a: {} }, [[[[[]]]]], { '': { '': '' } }]) {
  for (const ind of INDENTS) {
    const r = emitJson(v, ind, 100);
    assert.strictEqual(r.pretty, JSON.stringify(v, null, ind));
  }
  docs++;
}

console.log(`fuzz OK: ${docs} docs byte-identical to JSON.stringify`);
