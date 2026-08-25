// Plain assert-based test runner. Run: bun tests/run.ts
import assert from 'node:assert';
import { tokenize, T_STR, T_NUM, T_KEY, T_PUNCT, T_TRUE, T_FALSE, T_NULL } from '../src/tokenizer';
import { parseJson, parseInput } from '../src/parse';
import { buildView, ensureMin } from '../src/viewmodel';
import { flatten, buildVisible } from '../src/tree';
import { rangeHtml } from '../src/highlight';
import { diffJson, OP_ADD, OP_DEL, OP_SAME, type DiffResult } from '../src/diffcore';

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

ok('diff: seeded fuzz invariants', () => {
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

console.log(`\n${passed} tests passed`);
