// Plain assert-based test runner. Run: bun tests/run.ts
import assert from 'node:assert';
import { tokenize, T_STR, T_NUM, T_KEY, T_PUNCT, T_TRUE, T_FALSE, T_NULL } from '../src/tokenizer';
import { parseJson } from '../src/parse';
import { buildView } from '../src/viewmodel';
import { flatten, buildVisible } from '../src/tree';
import { rangeHtml } from '../src/highlight';

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
  assert.strictEqual(vm.min, '{"a":[1,2],"b":"xyz"}');
});

ok('buildView tab indent', () => {
  const vm = buildView({ a: 1 }, '\t', 10);
  assert.ok(vm.pretty.startsWith('{\n\t"a"'));
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

console.log(`\n${passed} tests passed`);
