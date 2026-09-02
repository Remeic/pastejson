// Plain assert-based test runner. Run: bun tests/run.ts
import assert from 'node:assert';
import { tokenize, T_STR, T_NUM, T_KEY, T_PUNCT, T_TRUE, T_FALSE, T_NULL, T_ERR } from '../src/tokenizer';
import { parseJson, parseInput } from '../src/parse';
import { emitJson } from '../src/serialize';
import { buildView, ensureMin } from '../src/viewmodel';
import { flatten, buildVisible } from '../src/tree';
import { rangeHtml } from '../src/highlight';
import { diffJson, diffAligned, OP_ADD, OP_DEL, OP_SAME, OP_MOD, MYERS_TRACE_BUDGET, type DiffResult } from '../src/diffcore';
import { diffHtml, sbsHtml } from '../src/diffview';
import { treeHtml } from '../src/render';
import { textHtml } from '../src/render';
import {
  makeWorkerPreview,
  prettyChunkAt,
  prettyChunkCount,
} from '../src/worker-preview';
import {
  findAll,
  lineOf,
  rowHtml,
  treeRowHtml,
  attachTree,
  refreshTree,
  type SearchOpts,
  type TreeHits,
} from '../src/search';
import {
  DEFAULT_BROWSER_THRESHOLDS,
  makeBrowserFixture,
  percentile,
  planBrowserSessions,
  readBrowserConfig,
  summarizeBrowserSamples,
  type BrowserSample,
} from '../scripts/bench-browser-core';

let passed = 0;
function ok(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log('  ✓', name);
}

// ---------- tokenizer ----------
ok('tokenize basic object', () => {
  const t = tokenize('{"a": 1}');
  // { key"a" : 1 }
  assert.deepStrictEqual([...t], [1, T_PUNCT, 4, T_KEY, 5, T_PUNCT, 7, T_NUM, 8, T_PUNCT]);
});

ok('tokenize escapes in strings', () => {
  const t = tokenize('"a\\"b\\u0041"');
  // string spans whole thing incl escapes -> single token end=12
  assert.strictEqual(t[0], 12);
  assert.strictEqual(t[1], T_STR);
});

ok('tokenize literals true/false/null', () => {
  const t = tokenize('[true,false,null]');
  assert.deepStrictEqual(
    [...t],
    [1, T_PUNCT, 5, T_TRUE, 6, T_PUNCT, 11, T_FALSE, 12, T_PUNCT, 16, T_NULL, 17, T_PUNCT],
  );
});

ok('tokenize numbers with exponent', () => {
  const t = tokenize('-12.34e+5');
  assert.deepStrictEqual([...t], [9, T_NUM]);
});

// ---------- parse errors ----------
ok('parse error line/col extraction', () => {
  const r = parseJson('{\n  "a": 1,\n  "b": oops\n}');
  assert.ok(!r.ok);
  if (r.ok) return;
  // V8 message contains position; compute expected line/col from it
  const m = /position\s+(\d+)/i.exec(r.message);
  if (m) {
    assert.strictEqual(r.line, 3);
    assert.ok(r.col > 0);
    assert.ok(r.lineText.includes('"b":'));
  }
});

ok('parse valid nested', () => {
  const r = parseJson('{"a":[1,{"b":null}]}');
  assert.ok(r.ok);
});

// ---------- viewmodel ----------
ok('buildView lines + lineStarts + maxLen', () => {
  const vm = buildView({ a: [1, 2], b: 'xyz' }, 2, 100);
  assert.strictEqual(vm.lines, 7); // pretty of that doc has 7 lines
  assert.strictEqual(vm.lineStarts.length, vm.lines);
  assert.ok(vm.maxLen > 0);
  assert.strictEqual(ensureMin(vm), '{"a":[1,2],"b":"xyz"}');
});

ok('buildView tab indent', () => {
  const vm = buildView({ a: 1 }, '\t', 10);
  assert.ok(vm.pretty.startsWith('{\n\t"a"'));
});

ok('emitJson matches stringify for escaped values and tokens', () => {
  const nasty = '\u0000"\\\n' + String.fromCharCode(0xd800);
  const value = { 'quote"key': nasty, n: -0, big: 1e21 };
  const r = emitJson(value, 2, 64);
  const expected = JSON.stringify(value, null, 2);
  assert.strictEqual(r.pretty, expected);
  const toks = tokenize(expected);
  const ref: number[] = [];
  for (let i = 0; i < toks.length; i += 2) {
    if (toks[i + 1] !== T_PUNCT) ref.push(toks[i], toks[i + 1]);
  }
  assert.deepStrictEqual([...r.tokens], ref);
});

ok('emitJson handles one-line roots', () => {
  const scalar = emitJson(1, 2, 8);
  assert.strictEqual(scalar.pretty, '1');
  assert.strictEqual(scalar.lines, 1);
  assert.deepStrictEqual([...scalar.tokens], [1, T_NUM]);
});

ok('emitJson publishes native pretty once before the fused walk completes', () => {
  let seen = '';
  let calls = 0;
  const result = emitJson({ a: [1, true] }, 2, 16, (pretty) => {
    seen = pretty;
    calls++;
  });
  assert.strictEqual(calls, 1);
  assert.strictEqual(seen, result.pretty);
  assert.strictEqual(seen, JSON.stringify({ a: [1, true] }, null, 2));
});

// ---------- tree flatten ----------
ok('flatten counts + subtreeRows', () => {
  const ft = flatten({ a: 1, b: [2, 3], c: { d: null } });
  // nodes: root, a, b, 2, 3, c, d = 7
  assert.strictEqual(ft.rowCount, 7);
  assert.strictEqual(ft.subtreeRows[0], 7);
  assert.strictEqual(ft.kind[2], 2); // b is array branch
  assert.strictEqual(ft.kind[5], 1); // c is obj branch
  assert.strictEqual(ft.meta[2], 2);
  assert.strictEqual(ft.meta[5], 1);
  // pre-order visual check
  assert.deepStrictEqual([...ft.depth], [0, 1, 1, 2, 2, 1, 2]);
});

ok('flatten arrays at root', () => {
  const ft = flatten([1, [2]]);
  assert.strictEqual(ft.rowCount, 4);
  assert.strictEqual(ft.kind[0], 2);
});

ok('buildVisible all-expanded = identity', () => {
  const ft = flatten({ a: { b: 1 }, c: 2 });
  const vis = buildVisible(ft, new Uint8Array(ft.rowCount).fill(1));
  assert.deepStrictEqual([...vis], [0, 1, 2, 3]);
});

ok('buildVisible collapse skips subtrees', () => {
  const ft = flatten({ a: { b: 1 }, c: 2 });
  const exp = new Uint8Array(ft.rowCount).fill(1);
  exp[1] = 0; // collapse node 1 (a's inner obj) — subtreeRows[1]=2 → skip node 2
  const vis = buildVisible(ft, exp);
  assert.deepStrictEqual([...vis], [0, 1, 3]);
});

ok('flatten columns stay aligned: leaf valIdx resolves, branch valIdx = -1', () => {
  // regression: emit() used to push -1 into valIdxA unconditionally AND again
  // for leaves — columns drifted by one per leaf (latent until flatten became
  // the only tree source)
  const ft = flatten({ a: 1, b: [2, 3], c: { d: null } });
  for (let r = 0; r < ft.rowCount; r++) {
    if (ft.kind[r] === 0) {
      assert.ok(ft.valIdx[r] >= 0, `leaf valIdx @${r}`);
      assert.strictEqual(typeof ft.vals[ft.valIdx[r]], 'string', `val @${r}`);
    } else {
      assert.strictEqual(ft.valIdx[r], -1, `branch valIdx @${r}`);
    }
    assert.ok(ft.keyIdx[r] >= -1);
  }
  // spot: row 1 is leaf "a": 1
  assert.strictEqual(ft.keys[ft.keyIdx[1]], 'a');
  assert.strictEqual(ft.vals[ft.valIdx[1]], '1');
});

ok('flatten interns repeated leaf previews', () => {
  const ft = flatten({ a: 'same', b: 'same', c: 1 });
  assert.strictEqual(ft.valIdx[1], ft.valIdx[2]);
  assert.strictEqual(ft.vals.length, 2);
});

// ---------- highlighter ----------
ok('rangeHtml wraps token classes + escapes html', () => {
  const src = '{"a<b": "<i>"}';
  const r = parseJson(src);
  assert.ok(r.ok);
  if (!r.ok) return;
  const vm = buildView(r.value, 2, src.length);
  const html = rangeHtml(vm.pretty, vm.tokP, 0, Math.min(40, vm.pretty.length));
  assert.ok(html.includes('<i class=k>') || html.includes('<i class=s>'));
  assert.ok(html.includes('&lt;')); // escaped
  assert.ok(!html.includes('<b')); // raw < never leaks unescaped as tag
});

// ---------- JSONL ----------
ok('parseInput: single JSON stays json', () => {
  const r = parseInput('{"a":1}');
  assert.strictEqual(r.kind, 'json');
  if (r.kind === 'json') assert.deepStrictEqual(r.value, { a: 1 });
});

ok('parseInput: pretty multi-line JSON stays json (not jsonl)', () => {
  const r = parseInput('{\n  "a": 1\n}');
  assert.strictEqual(r.kind, 'json');
});

ok('parseInput: two docs → jsonl', () => {
  const r = parseInput('{"a":1}\n{"b":2}\n');
  assert.strictEqual(r.kind, 'jsonl');
  if (r.kind === 'jsonl') {
    assert.strictEqual(r.docs, 2);
    assert.deepStrictEqual(r.value, [{ a: 1 }, { b: 2 }]);
  }
});

ok('parseInput: blank/whitespace lines skipped', () => {
  const r = parseInput('1\n\n   \n"x"\n\n');
  assert.strictEqual(r.kind, 'jsonl');
  if (r.kind === 'jsonl') assert.strictEqual(r.docs, 2);
});

ok('parseInput: jsonl scalars', () => {
  const r = parseInput('1\n"x"\nnull\ntrue');
  assert.strictEqual(r.kind, 'jsonl');
  if (r.kind === 'jsonl') assert.deepStrictEqual(r.value, [1, 'x', null, true]);
});

ok('parseInput: bad line after good → error with line/offset', () => {
  const raw = '{"a":1}\n{"b":\n{"c":3}';
  const r = parseInput(raw);
  assert.strictEqual(r.kind, 'error');
  if (r.kind === 'error') {
    assert.strictEqual(r.line, 2); // second line is broken
    assert.ok(r.offset >= raw.indexOf('{"b":'), 'offset points into raw');
    assert.ok(r.lineText.includes('"b"'));
  }
});

ok('parseInput: all-broken input → plain error (not jsonl)', () => {
  const r = parseInput('{oops}\n{also bad}');
  assert.strictEqual(r.kind, 'error');
});

// ---------- paste sanitize (invisible clipboard junk) ----------
ok('parseInput: BOM/NBSP/zero-width prefix strips to json', () => {
  for (const junk of ['\uFEFF', '\u00A0', '\u200B', '\u200E', '\u2028', '\uFEFF\uFEFF']) {
    const r = parseInput(junk + '{"a":1}');
    assert.strictEqual(r.kind, 'json', `junk ${JSON.stringify(junk)}`);
    if (r.kind === 'json') assert.deepStrictEqual(r.value, { a: 1 });
  }
});

ok('parseInput: trailing junk strips too', () => {
  const r = parseInput('{"a":1}\uFEFF\u00A0\u200B');
  assert.strictEqual(r.kind, 'json');
  if (r.kind === 'json') assert.deepStrictEqual(r.value, { a: 1 });
});

ok('parseInput: mid-string BOM survives (legal inside JSON strings)', () => {
  const r = parseInput('{"a":"x\uFEFFy"}');
  assert.strictEqual(r.kind, 'json');
  if (r.kind === 'json') assert.strictEqual((r.value as { a: string }).a, 'x\uFEFFy');
});

ok('parseInput: junk-only input → clean error', () => {
  const r = parseInput('\uFEFF\u00A0\u200B');
  assert.strictEqual(r.kind, 'error');
});

ok('parseJson: junk prefix keeps line/col consistent with error position', () => {
  const r = parseJson('\uFEFF{"a": oops}');
  assert.ok(!r.ok);
  if (r.ok) return;
  const m = /position\s+(\d+)/i.exec(r.message);
  if (m) {
    // V8 gives a position (0-based, after junk strip → still line 1);
    // JSC does not — line/col stay 0, nothing to check
    assert.strictEqual(r.line, 1);
    assert.strictEqual(r.col, Number(m[1]) + 1); // col = offset - lastNl, lastNl = -1
    assert.ok(r.lineText.includes('"a"'));
  }
});

ok('parseInput: leading BOM + newline is one clean doc (not jsonl)', () => {
  const r = parseInput('\uFEFF\n{"a":1}\n');
  assert.strictEqual(r.kind, 'json');
  if (r.kind === 'json') assert.deepStrictEqual(r.value, { a: 1 });
});

ok('parseInput: junk between JSONL docs → per-line trim eats it', () => {
  const r = parseInput('{"a":1}\n\uFEFF\u00A0{"b":2}\n');
  assert.strictEqual(r.kind, 'jsonl');
  if (r.kind === 'jsonl') {
    assert.strictEqual(r.docs, 2);
    assert.deepStrictEqual(r.value, [{ a: 1 }, { b: 2 }]);
  }
});

// ---------- diff (lazy island core) ----------
function ops(d: DiffResult): string[] {
  const out: string[] = [];
  for (let i = 0; i < d.rowCount; i++) {
    out.push(d.op[i] === OP_ADD ? '+' : d.op[i] === OP_DEL ? '-' : '=');
  }
  return out;
}

ok('diff: identical → zero rows', () => {
  const d = diffJson({ a: 1, b: [1, { c: 'x' }] }, { a: 1, b: [1, { c: 'x' }] });
  assert.strictEqual(d.rowCount, 0);
  assert.strictEqual(d.adds + d.dels, 0);
});

ok('diff: leaf change → context + del/add pair', () => {
  const d = diffJson({ a: 1, b: 'old' }, { a: 1, b: 'new' });
  assert.strictEqual(d.rowCount, 3);
  assert.deepStrictEqual(ops(d), ['=', '-', '+']);
  assert.ok(d.vals.some((v) => v === '"old"'));
  assert.ok(d.vals.some((v) => v === '"new"'));
  const ki = [...d.keyIdx].filter((k) => k >= 0 && d.op[d.keyIdx.indexOf(k)] !== OP_SAME);
  assert.strictEqual(new Set(ki).size, 1); // both rows share interned key
});

ok('diff: key removed → del subtree; key added → add subtree', () => {
  const d = diffJson({ keep: 1, gone: { deep: true } }, { keep: 1, fresh: [7] });
  assert.deepStrictEqual(ops(d), ['=', '-', '-', '+', '+']);
  assert.strictEqual(d.kind[1], 1); // gone: removed obj branch
  assert.strictEqual(d.kind[3], 2); // fresh: added arr branch
});

ok('diff: nested change keeps full context chain with depth', () => {
  const d = diffJson({ o: { p: { q: 1 } } }, { o: { p: { q: 2 } } });
  assert.deepStrictEqual(ops(d), ['=', '=', '=', '-', '+']);
  assert.deepStrictEqual([...d.depth], [0, 1, 2, 3, 3]);
  assert.strictEqual(d.meta[0], 1);
});

ok('diff: array insert middle — myers minimal', () => {
  const d = diffJson([1, 2, 3], [1, 9, 2, 3]);
  // identical elements emit nothing; only the inserted subtree shows
  assert.strictEqual(d.adds, 1);
  assert.strictEqual(d.dels, 0);
  assert.ok(d.vals.includes('9'));
});

ok('diff: array element changed → del+add subtrees', () => {
  const d = diffJson([1, { x: 1 }, 3], [1, { x: 2 }, 3]);
  assert.strictEqual(d.dels >= 1 && d.adds >= 1, true);
  assert.ok(JSON.stringify([...d.op]).includes(String(OP_DEL)));
});

ok('diff: array removal middle', () => {
  const d = diffJson([1, 2, 3, 4], [1, 4]);
  assert.strictEqual(d.dels, 2);
  assert.strictEqual(d.adds, 0);
});

ok('diff: type swap obj↔arr → del+add subtree pair', () => {
  const d = diffJson({ v: { a: 1 } }, { v: [1] });
  assert.strictEqual(d.rowCount, 5); // ctx, -obj -leaf, +arr +leaf
  assert.deepStrictEqual(ops(d), ['=', '-', '-', '+', '+']);
});

ok('diff: root scalar change', () => {
  const d = diffJson(42, '42');
  assert.deepStrictEqual(ops(d), ['-', '+']);
});

ok('diff: empty vs populated', () => {
  const d = diffJson({}, { a: 1 });
  assert.strictEqual(d.adds, 1);
  assert.strictEqual(d.dels, 0);
  const e = diffJson([], [1, 2]);
  assert.strictEqual(e.adds, 2);
});

// shared seeded fuzz machinery (focus + aligned suites)
let seed = 0x1234abcd;
const rnd = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 4294967296;
};
const clone = structuredClone;
const mutate = (v: unknown): unknown => {
  if (v !== null && typeof v === 'object') {
    if (Array.isArray(v)) {
      const r = rnd();
      if (r < 0.33) return [...v, 'added'];
      if (r < 0.66 && v.length > 0) return v.slice(0, -1);
      const c = clone(v) as unknown[];
      if (c.length > 0) c[(rnd() * c.length) | 0] = mutate(c[(rnd() * c.length) | 0]);
      return c;
    }
    const o = clone(v) as Record<string, unknown>;
    const ks = Object.keys(o);
    const r = rnd();
    if (r < 0.25) o['newKey'] = 1;
    else if (r < 0.5 && ks.length > 0) delete o[ks[0]];
    else if (ks.length > 0) o[ks[(rnd() * ks.length) | 0]] = mutate(o[ks[(rnd() * ks.length) | 0]]);
    else o['x'] = 1;
    return o;
  }
  return typeof v === 'string' ? v + '!' : 999;
};
const gen = (depth: number): unknown => {
  const r = rnd();
  if (depth > 3 || r < 0.35)
    return r < 0.15 ? 's' + ((rnd() * 100) | 0) : (rnd() * 100) | 0;
  if (r < 0.7) {
    const o: Record<string, unknown> = {};
    const n = 1 + ((rnd() * 4) | 0);
    for (let i = 0; i < n; i++) o['k' + i] = gen(depth + 1);
    return o;
  }
  const a: unknown[] = [];
  const n = 1 + ((rnd() * 4) | 0);
  for (let i = 0; i < n; i++) a.push(gen(depth + 1));
  return a;
};

ok('diff: seeded fuzz invariants', () => {
  for (let it = 0; it < 200; it++) {
    const a = gen(0);
    const bSame = structuredClone(a);
    const d0 = diffJson(a, bSame);
    assert.strictEqual(d0.rowCount, 0, `identical @${it}`);
    const bMut = mutate(structuredClone(a));
    const d = diffJson(a, bMut);
    assert.ok(d.adds + d.dels >= 1, `changed @${it}`);
    assert.strictEqual(d.keyIdx.length, d.rowCount, `cols @${it}`);
    for (let r = 0; r < d.rowCount; r++) {
      const k = d.kind[r];
      assert.strictEqual(
        (d.valIdx[r] >= 0) === (k === 0),
        true,
        `kind/val @${it}:${r}`,
      );
      if (k !== 0) assert.ok(d.meta[r] >= 0);
    }
  }
});

// ---------- aligned / side-by-side ----------
function countNodes(v: unknown): number {
  if (v === null || typeof v !== 'object') return 1;
  let c = 1;
  for (const k of Array.isArray(v) ? v : Object.values(v)) c += countNodes(k);
  return c;
}

ok('aligned: identical docs → all-SAME mirrored pairs', () => {
  const v = { a: 1, b: [1, { c: 'x' }], n: null };
  const d = diffAligned(v, structuredClone(v));
  assert.strictEqual(d.rowCount, countNodes(v));
  for (let i = 0; i < d.rowCount; i++) {
    assert.strictEqual(d.op[i], OP_SAME, `op @${i}`);
    assert.ok(d.lRow[i] >= 0 && d.rRow[i] >= 0, `rows @${i}`);
  }
});

ok('aligned: leaf change → leaf MOD pair with both previews', () => {
  const d = diffAligned({ a: 1, b: 'old' }, { a: 1, b: 'new' });
  let mi = -1;
  let mods = 0;
  for (let i = 0; i < d.rowCount; i++) {
    if (
      d.op[i] === OP_MOD &&
      d.lKind[d.lRow[i]] === 0 &&
      d.rKind[d.rRow[i]] === 0
    ) {
      mods++;
      mi = i;
    }
  }
  assert.strictEqual(mods, 1); // exactly one changed leaf; ancestors are MOD too but are branches
  assert.ok(mi >= 0);
  assert.strictEqual(d.lVals[d.lVal[d.lRow[mi]]], '"old"');
  assert.strictEqual(d.rVals[d.rVal[d.rRow[mi]]], '"new"');
});

ok('aligned: removed subtree → DEL run with empty right cells', () => {
  const d = diffAligned({ keep: 1, gone: { deep: 2 } }, { keep: 1 });
  let dels = 0;
  let adds = 0;
  for (let i = 0; i < d.rowCount; i++) {
    if (d.op[i] === OP_DEL) {
      dels++;
      assert.ok(d.lRow[i] >= 0 && d.rRow[i] < 0, `del cell @${i}`);
    }
    if (d.op[i] === OP_ADD) adds++;
  }
  assert.strictEqual(dels, 2); // gone + deep
  assert.strictEqual(adds, 0);
});

ok('aligned: added array element → ADD pair only', () => {
  const d = diffAligned([1, 2, 3], [1, 9, 2, 3]);
  let adds = 0;
  for (let i = 0; i < d.rowCount; i++) if (d.op[i] === OP_ADD) adds++;
  assert.strictEqual(adds, 1);
  // prefix/suffix mirrored
  assert.strictEqual(d.rowCount, countNodes([1, 2, 3]) + 1);
});

ok('aligned: type swap → DEL run + ADD run at same key', () => {
  const d = diffAligned({ v: { a: 1 } }, { v: [1] });
  let sawDelObj = false;
  let sawAddArr = false;
  for (let i = 0; i < d.rowCount; i++) {
    if (d.op[i] === OP_DEL && d.lKind[d.lRow[i]] === 1) sawDelObj = true;
    if (d.op[i] === OP_ADD && d.rKind[d.rRow[i]] === 2) sawAddArr = true;
  }
  assert.ok(sawDelObj && sawAddArr);
});

ok('aligned: seeded fuzz pair invariants', () => {
  for (let it = 0; it < 200; it++) {
    const x = gen(0);
    // identical case
    const same = diffAligned(x, structuredClone(x));
    assert.strictEqual(same.rowCount, countNodes(x), `identical @${it}`);
    const y = mutate(structuredClone(x));
    const d = diffAligned(x, y);
    for (let r = 0; r < d.rowCount; r++) {
      const o = d.op[r];
      const l = d.lRow[r];
      const rr = d.rRow[r];
      if (o === OP_SAME) assert.ok(l >= 0 && rr >= 0, `same @${it}:${r}`);
      else if (o === OP_MOD) assert.ok(l >= 0 && rr >= 0, `mod @${it}:${r}`);
      else if (o === OP_DEL) assert.ok(l >= 0 && rr < 0, `del @${it}:${r}`);
      else if (o === OP_ADD) assert.ok(rr >= 0 && l < 0, `add @${it}:${r}`);
      else assert.fail(`bad op ${o} @${it}:${r}`);
    }
    // at least one non-SAME pair when inputs differ
    let nonSame = 0;
    for (let r = 0; r < d.rowCount; r++) if (d.op[r] !== OP_SAME) nonSame++;
    assert.ok(nonSame >= 1, `changed @${it}`);
  }
});

// ---------- painters (lazy island views) ----------
ok('painters: treeHtml renders flatten output end-to-end', () => {
  // regression guard: the valIdx drift crash surfaced here first (valCls(undefined))
  const ft = flatten({ a: 1, b: [2, 'x'], c: { d: null } });
  const expanded = new Uint8Array(ft.rowCount).fill(1);
  const vis = buildVisible(ft, expanded);
  const html = treeHtml(ft, expanded, vis, 0, vis.length);
  assert.ok(html.includes('>a<') && html.includes('>1<'), 'key + leaf value render');
  assert.ok(!html.includes('undefined'), 'no undefined leaks');
  assert.strictEqual(html.split('trow').length - 1, ft.rowCount);
});

ok('painters: focus + sbs emit escaped html with cells/gutters', () => {
  const f = diffJson({ k: '<x>' }, { k: 'y>' });
  const fh = diffHtml(f, 0, f.rowCount);
  assert.ok(fh.includes('d-del') && fh.includes('d-add'));
  assert.ok(fh.includes('&lt;x&gt;'), 'focus escapes');
  const a = diffAligned({ k: '<x>' }, { k: 'y>' });
  const ah = sbsHtml(a, 0, a.rowCount);
  assert.ok(ah.includes('<div class="sc sl">') && ah.includes('<div class="sc sr">'));
  assert.ok(ah.includes('d-mod'), 'mod row class');
  const empty = sbsHtml(diffAligned({ z: 1 }, {}), 1, 1); // a removed-subtree row
  assert.ok(empty.includes('<span class="dg"></span>'), 'empty spacer cell');
});

// ---------- search (lazy island core) ----------
const CI: SearchOpts = { ci: true, re: false };
const CS: SearchOpts = { ci: false, re: false };
const RE_CI: SearchOpts = { ci: true, re: true };

// independent ASCII-fold oracle — ground truth for the native-floor scan
function naiveCi(hay: string, q: string): number[] {
  const out: number[] = [];
  if (!q) return out;
  const fold = (c: number): number => (c >= 65 && c <= 90 ? c + 32 : c);
  const n = hay.length;
  const m = q.length;
  for (let i = 0; i + m <= n; i++) {
    let j = 0;
    while (j < m) {
      if (fold(hay.charCodeAt(i + j)) !== fold(q.charCodeAt(j))) break;
      j++;
    }
    if (j === m) out.push(i);
  }
  return out;
}

ok('search: findAll case-insensitive, exact offsets, non-overlapping', () => {
  const vm = buildView({ find: 'find me FIND', x: 'finder' }, 2, 10);
  const st = findAll(vm, 'find', CI);
  assert.deepStrictEqual([...st.starts], naiveCi(vm.pretty, 'find'));
  assert.ok(st.starts.length >= 3, 'hits incl uppercase');
  assert.strictEqual(st.ends[0] - st.starts[0], 4);
  assert.strictEqual(st.cur, 0);
  // non-overlapping scan: "aaa" / "aa" → only [0]
  const vm2 = buildView({ v: 'aaa' }, 2, 4);
  assert.deepStrictEqual([...findAll(vm2, 'aa', CI).starts], [vm2.pretty.indexOf('aa')]);
});

ok('search: case toggle — cs finds strictly fewer on mixed-case doc', () => {
  const vm = buildView({ k: 'Ab aB AB ab' }, 2, 10);
  assert.strictEqual(findAll(vm, 'ab', CI).starts.length, 4);
  assert.strictEqual(findAll(vm, 'ab', CS).starts.length, 1);
});

ok('search: regex mode — variable-length ends + anchors + flags', () => {
  const vm = buildView({ a: [12, 7, 345] }, 2, 10);
  const st = findAll(vm, '\\d+', RE_CI);
  assert.strictEqual(st.starts.length, 3);
  for (let i = 0; i < st.starts.length; i++) {
    const slice = vm.pretty.slice(st.starts[i], st.ends[i]);
    assert.ok(/^\d+$/.test(slice), `digits @${i}: ${slice}`);
  }
  assert.ok(st.ends[2] - st.starts[2] > st.ends[1] - st.starts[1], 'variable lengths');
  const anchored = findAll(vm, '^\{', { ci: false, re: true });
  assert.strictEqual(anchored.starts.length, 1);
  assert.strictEqual(anchored.starts[0], 0);
  const vm2 = buildView({ k: 'aBc x AbC' }, 2, 8);
  assert.strictEqual(findAll(vm2, 'abc', RE_CI).starts.length, 2);
  assert.strictEqual(findAll(vm2, 'abc', { ci: false, re: true }).starts.length, 0);
});

ok('search: bad regex → flagged, zero hits, no throw', () => {
  const vm = buildView({ a: 1 }, 2, 4);
  const st = findAll(vm, '(unclosed', RE_CI);
  assert.ok(st.bad.length > 0);
  assert.strictEqual(st.starts.length, 0);
  assert.strictEqual(st.cur, -1);
});

ok('search: zero-length regex terminates and emits no empty marks', () => {
  const vm = buildView({ k: 'aab' }, 2, 6);
  const st = findAll(vm, 'b*', RE_CI);
  assert.ok(st.starts.length > 0 && st.starts.length < 50, 'bounded scan');
  const html = rowHtml(vm, st, 0, vm.lines);
  assert.ok(!html.includes('<mark class="m"></mark>'), 'no empty marks');
});

ok('search: empty needle, no hit, needle longer than doc', () => {
  const vm = buildView({ a: 1 }, 2, 4);
  assert.strictEqual(findAll(vm, '', CI).starts.length, 0);
  const miss = findAll(vm, 'zzzzzz', CI);
  assert.strictEqual(miss.starts.length, 0);
  assert.strictEqual(miss.cur, -1);
  assert.ok(miss.ms >= 0);
  const long = findAll(vm, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', CI);
  assert.strictEqual(long.starts.length, 0);
});

ok('search: lineOf binary search over lineStarts', () => {
  const vm = buildView({ a: [1, 2], b: 'xyz' }, 2, 100); // 7 lines
  for (let i = 0; i < vm.lines; i++) {
    assert.strictEqual(lineOf(vm.lineStarts, vm.lineStarts[i]), i, `start @${i}`);
    assert.strictEqual(lineOf(vm.lineStarts, vm.lineStarts[i] + 1), i, `mid @${i}`);
  }
  assert.strictEqual(lineOf(vm.lineStarts, vm.pretty.length), vm.lines - 1);
});

ok('search: exotic fold (length-changing toLowerCase) degrades to case-sensitive', () => {
  // İ lowercases to 2 chars → haystack fold unsafe → raw + case-sensitive
  const vm = buildView({ 'İ': 1 }, 2, 6);
  assert.notStrictEqual(vm.pretty.toLowerCase().length, vm.pretty.length);
  assert.strictEqual(findAll(vm, 'i', CI).starts.length, 0); // no silent ci match
  const hit = findAll(vm, 'İ', CI);
  assert.strictEqual(hit.starts.length, 1); // needle fold grew → cs path finds it
  assert.strictEqual(hit.ends[0] - hit.starts[0], 1); // length stays the QUERY's length
});

ok('search: rowHtml zero matches ≡ textHtml byte-for-byte', () => {
  const vm = buildView({ a: [1, '<x>'], b: null }, 2, 40);
  const st = findAll(vm, 'qqq', CI);
  assert.deepStrictEqual(rowHtml(vm, st, 0, vm.lines), textHtml(vm, 0, vm.lines));
});

ok('search: rowHtml marks, current match class, escapes inside marks', () => {
  const vm = buildView({ k: 'ab<cd ab' }, 2, 20);
  const st = findAll(vm, 'ab', CI);
  assert.strictEqual(st.starts.length, 2);
  const html = rowHtml(vm, st, 0, vm.lines);
  assert.ok(html.includes('<mark class="m">'), 'match marks present');
  // findAll seeds cur=0 → exactly one current mark
  assert.strictEqual(html.split('<mark class="mc">').length - 1, 1);
  // point cur at a match on a visible row → mc appears exactly once
  st.cur = st.starts.length - 1;
  const htmlCur = rowHtml(vm, st, 0, vm.lines);
  assert.strictEqual(htmlCur.split('<mark class="mc">').length - 1, 1);
  // needle containing < must escape inside the mark element
  const stLt = findAll(vm, 'b<', CI);
  assert.strictEqual(stLt.starts.length, 1);
  assert.ok(rowHtml(vm, stLt, 0, vm.lines).includes('<mark class="mc">b&lt;</mark>'));
});

ok('search: cross-line match renders clipped marks without leaking rows', () => {
  const vm = buildView({ a: 1, b: 2 }, 2, 20);
  const q = '1,\n  "b"'; // spans the newline between lines
  const st = findAll(vm, q, CI);
  assert.strictEqual(st.starts.length, 1);
  const html = rowHtml(vm, st, 0, vm.lines);
  assert.ok(html.split('<div class="row">').length - 1 === vm.lines);
  assert.ok(!html.includes('undefined'), 'no undefined leaks');
  // each row shows only its within-line slice of the match
  const marks = html.match(/<mark/g);
  assert.ok(marks && marks.length >= 2, 'both lines carry their slice');
});

// ---------- search: tree island ----------
function countHit(t: TreeHits): number {
  let c = 0;
  for (let i = 0; i < t.nodeHit.length; i++) if (t.nodeHit[i]) c++;
  return c;
}

ok('search tree: attach scans interned pools, node flags correct', () => {
  const value = { alpha: 1, beta: { alpha: 2 }, gamma: 'alpha' };
  const ft = flatten(value);
  const st = findAll(buildView(value, 2, 30), 'alpha', CI);
  attachTree(st, ft, null);
  const t = st.tree!;
  // key pool: 'alpha' interned once, hits BOTH key nodes; gamma's leaf
  // preview '"alpha"' also contains the needle → third node via valHit
  assert.ok(t.keyHit[ft.keyIdx[1]] !== null);
  assert.strictEqual(t.keyHit[ft.keyIdx[1]]!.length, 2); // one range pair
  assert.strictEqual(countHit(t), 3);
  assert.strictEqual(t.visCount, 3);
  assert.strictEqual(t.pos[1], 0); // visual order == node order, all expanded
});

ok('search tree: collapse hides subtree matches from nav sequence', () => {
  const value = { alpha: 1, inner: { deepAlpha: 2 } };
  const ft = flatten(value);
  const st = findAll(buildView(value, 2, 40), 'alpha', CI);
  attachTree(st, ft, null);
  // hits: key 'alpha' (node 1) + key 'deepAlpha' (node 3) — numeric vals miss
  const total = countHit(st.tree!);
  assert.strictEqual(total, 2);
  const exp = new Uint8Array(ft.rowCount).fill(1);
  exp[2] = 0; // collapse inner — subtree holds deepAlpha
  let vis = buildVisible(ft, exp);
  refreshTree(st, ft, vis);
  assert.strictEqual(st.tree!.visCount, 1);
  assert.ok(st.cur >= 0 && st.cur < 1, 'cur clamped into visible sequence');
  exp.fill(1);
  vis = buildVisible(ft, exp);
  refreshTree(st, ft, vis);
  assert.strictEqual(st.tree!.visCount, 2);
});

ok('search tree: treeRowHtml zero hits ≡ treeHtml byte-for-byte', () => {
  const value = { a: [1, '<x>'], b: null };
  const ft = flatten(value);
  const expanded = new Uint8Array(ft.rowCount).fill(1);
  const vis = buildVisible(ft, expanded);
  const st = findAll(buildView(value, 2, 40), 'zzz', CI);
  attachTree(st, ft, vis);
  assert.deepStrictEqual(
    treeRowHtml(ft, expanded, vis, st, 0, vis.length),
    treeHtml(ft, expanded, vis, 0, vis.length),
  );
});

ok('search tree: marks on keys/values + smc current-node tint', () => {
  const value = { alpha: 'alpha' };
  const ft = flatten(value);
  const expanded = new Uint8Array(ft.rowCount).fill(1);
  const vis = buildVisible(ft, expanded);
  const st = findAll(buildView(value, 2, 20), 'alpha', CI);
  attachTree(st, ft, vis);
  const html = treeRowHtml(ft, expanded, vis, st, 0, vis.length);
  // key 'alpha' + leaf preview '"alpha"' — both carry a mark
  assert.strictEqual((html.match(/<mark class="m">/g) || []).length, 2);
  assert.ok(html.includes('class="trow smc"'), 'current node tinted');
  st.cur = st.tree!.visCount - 1;
  const last = treeRowHtml(ft, expanded, vis, st, 0, vis.length);
  assert.strictEqual(last.split('smc').length - 1, 1);
});

const sAlpha = 'abAB01 \n",:{}';
function sRand(maxLen: number): string {
  const len = 1 + ((rnd() * maxLen) | 0);
  let s = '';
  for (let i = 0; i < len; i++) s += sAlpha[(rnd() * sAlpha.length) | 0];
  return s;
}

ok('search: seeded fuzz vs ASCII-fold oracle', () => {
  for (let it = 0; it < 300; it++) {
    const prettyLike = sRand(60) + '"' + sRand(30) + '"' + sRand(60);
    const q = sRand(5);
    const vm = buildView([prettyLike], 2, prettyLike.length);
    const got = [...findAll(vm, q, CI).starts];
    const want = naiveCi(vm.pretty, q);
    assert.deepStrictEqual(got, want, `offsets @${it} q=${JSON.stringify(q)}`);
  }
});

// diff: Myers trace allocation stays inside its documented 32MB budget
ok('diff: myers trace bound ≤ 8M ints at extreme widths', () => {
  for (const w of [1, 3, 4097, 40001, 2_000_001]) {
    const dCap = Math.min(2048, Math.floor(MYERS_TRACE_BUDGET / w) - 1);
    const bytes = (dCap + 1) * w * 4;
    assert.ok(bytes <= 32 << 20, `w=${w} allocates ${bytes}`);
  }
});

// ---------- browser benchmark contracts ----------
ok('browser bench: fixture is exact-size, deterministic valid JSON', () => {
  const a = makeBrowserFixture(64 * 1024);
  const b = makeBrowserFixture(64 * 1024);
  assert.strictEqual(a.raw.length, 64 * 1024);
  assert.strictEqual(a.raw, b.raw);
  const value = JSON.parse(a.raw) as { name: string; items: { id: number }[] };
  assert.strictEqual(value.name, 'bench');
  assert.ok(value.items.length > 1);
  assert.strictEqual(value.items[0].id, 0);
  assert.deepStrictEqual(a.expectedFirstLines.slice(0, 3), ['{', '  "name": "bench",', '  "items": [']);
});

ok('browser bench: fixture rejects targets too small for representative data', () => {
  assert.throws(() => makeBrowserFixture(100), RangeError);
});

ok('browser bench: sessions distribute every run deterministically', () => {
  assert.deepStrictEqual(planBrowserSessions(30, 5), [6, 6, 6, 6, 6]);
  assert.deepStrictEqual(planBrowserSessions(7, 3), [3, 2, 2]);
  assert.throws(() => planBrowserSessions(0, 1), RangeError);
  assert.throws(() => planBrowserSessions(2, 3), RangeError);
});

ok('browser bench: config defaults to the published protocol', () => {
  assert.deepStrictEqual(readBrowserConfig({}), {
    bytes: 100 * 1024 ** 2,
    runs: 30,
    sessions: 5,
    enforce: true,
  });
  assert.deepStrictEqual(readBrowserConfig({
    PASTEJSON_BENCH_MIB: '1',
    PASTEJSON_BENCH_RUNS: '3',
    PASTEJSON_BENCH_SESSIONS: '1',
    PASTEJSON_BENCH_ENFORCE: '0',
  }), {
    bytes: 1024 ** 2,
    runs: 3,
    sessions: 1,
    enforce: false,
  });
});

ok('browser bench: config rejects misleading run shapes', () => {
  assert.throws(() => readBrowserConfig({ PASTEJSON_BENCH_MIB: '0' }), RangeError);
  assert.throws(() => readBrowserConfig({ PASTEJSON_BENCH_RUNS: '1.5' }), RangeError);
  assert.throws(() => readBrowserConfig({
    PASTEJSON_BENCH_RUNS: '2',
    PASTEJSON_BENCH_SESSIONS: '3',
  }), RangeError);
});

ok('browser bench: nearest-rank percentiles do not interpolate claims', () => {
  assert.strictEqual(percentile([4, 1, 3, 2], 0.5), 2);
  assert.strictEqual(percentile([4, 1, 3, 2], 0.95), 4);
  assert.throws(() => percentile([], 0.95), RangeError);
  assert.throws(() => percentile([1], 0), RangeError);
});

const browserSample = (overrides: Partial<BrowserSample> = {}): BrowserSample => ({
  firstPaintMs: 700,
  nativeMs: 400,
  longestTaskMs: 40,
  memoryDeltaBytes: 1024 ** 3,
  correct: true,
  ...overrides,
});

ok('browser bench: 100–1–2 thresholds pass together', () => {
  const summary = summarizeBrowserSamples(
    Array.from({ length: 30 }, () => browserSample()),
    DEFAULT_BROWSER_THRESHOLDS,
  );
  assert.strictEqual(summary.pass, true);
  assert.deepStrictEqual(summary.failures, []);
  assert.strictEqual(summary.firstPaintP50Ms, 700);
  assert.strictEqual(summary.firstPaintP95Ms, 700);
  assert.strictEqual(summary.ratioP95, 1.75);
});

ok('browser bench: every failed or unmeasured contract is explicit', () => {
  const summary = summarizeBrowserSamples([
    browserSample({
      firstPaintMs: 1100,
      nativeMs: 500,
      longestTaskMs: 51,
      memoryDeltaBytes: null,
      correct: false,
    }),
  ], DEFAULT_BROWSER_THRESHOLDS);
  assert.strictEqual(summary.pass, false);
  assert.deepStrictEqual(summary.failures, [
    'paint-p50',
    'paint-p95',
    'native-ratio',
    'long-task',
    'memory-unavailable',
    'correctness',
  ]);
});

// ---------- progressive worker delivery ----------
ok('worker preview: complete first lines retain non-punct token contract', () => {
  const pretty = JSON.stringify({ items: [{ id: 1, ok: true }, { id: 2, ok: false }] }, null, 2);
  const preview = makeWorkerPreview(pretty, 6);
  assert.strictEqual(preview.pretty, pretty.split('\n').slice(0, 6).join('\n'));
  assert.strictEqual(preview.lines, 6);
  assert.deepStrictEqual([...preview.lineStarts], [0, 2, 15, 21, 36, 53]);
  const fullTokens = tokenize(preview.pretty);
  const nonPunct: number[] = [];
  for (let i = 0; i < fullTokens.length; i += 2) {
    if (fullTokens[i + 1] !== T_PUNCT) nonPunct.push(fullTokens[i], fullTokens[i + 1]);
  }
  assert.deepStrictEqual([...preview.tokens], nonPunct);
});

ok('worker preview: one-line roots and invalid limits are explicit', () => {
  const preview = makeWorkerPreview('42', 96);
  assert.strictEqual(preview.pretty, '42');
  assert.strictEqual(preview.lines, 1);
  assert.deepStrictEqual([...preview.lineStarts], [0]);
  const longScalar = makeWorkerPreview('"' + 'x'.repeat(100) + '"', 96, 16);
  assert.strictEqual(longScalar.pretty.length, 16);
  // charLimit cuts the closing quote → tokenizer flags the truncated string T_ERR
  assert.deepStrictEqual([...longScalar.tokens], [16, T_ERR]);
  assert.throws(() => makeWorkerPreview('{}', 0), RangeError);
  assert.throws(() => makeWorkerPreview('{}', 1, 0), RangeError);
});

ok('worker delivery: pretty chunks are complete and bounded', () => {
  assert.strictEqual(prettyChunkCount('abcdefghij', 4), 3);
  assert.deepStrictEqual(
    [0, 1, 2].map((i) => prettyChunkAt('abcdefghij', i, 4)),
    ['abcd', 'efgh', 'ij'],
  );
  assert.strictEqual(prettyChunkCount('', 4), 0);
  assert.throws(() => prettyChunkCount('x', 0), RangeError);
  assert.throws(() => prettyChunkAt('x', 1, 4), RangeError);
});

console.log(`\n${passed} tests passed`);
