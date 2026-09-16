// Iterative DFS flatten of parsed JSON into columnar typed arrays + interned strings.
// "All expanded" = every row present in visual order (pre-order DFS).
// Collapse is a VIEW concern: buildVisible() skips subtrees via subtreeRows.
//
// Hot path is CLOSURE-FREE (same doctrine as serialize.ts): the walk is one
// function body with true-local registers, frames come from a pooled array kept
// in a `cf` register, and leaf interning is a top-level (non-capturing) helper
// so JSC can inline it. Measured ~2× faster than the previous closure/class
// version (agent bench, 5MB payload: 27ms → 10ms; every payload shape faster,
// correctness fuzz-verified byte-identical columns/keys/vals vs the old walk).
// Columns are exact-length copies (slice) — no seed slack travels to the main
// thread; the receiver still clips to rowCount defensively.

const K_LEAF = 0;
const K_OBJ = 1;
const K_ARR = 2;

export interface FlatTree {
  depth: Uint16Array;
  kind: Int32Array; // K_* above (Int32Array: skips conversion pass)
  keyIdx: Int32Array; // index into keys[], -1 = none (empty until materializeLabels)
  valIdx: Int32Array; // index into vals[] (leaves), -1 = branch (empty until materializeLabels)
  meta: Int32Array; // branch: child count finalized on pop
  subtreeRows: Int32Array; // rows in subtree incl self
  keys: string[];
  vals: string[];
  rowCount: number;
}

class GrowInt32 {
  arr: Int32Array;
  len = 0;
  constructor(cap: number) {
    this.arr = new Int32Array(cap);
  }
  push(v: number): void {
    if (this.len === this.arr.length) {
      const g = new Int32Array(this.arr.length << 1);
      g.set(this.arr);
      this.arr = g;
    }
    this.arr[this.len++] = v;
  }
  trim(): Int32Array {
    return this.len === this.arr.length ? this.arr : this.arr.slice(0, this.len);
  }
}

const MAX_PREVIEW = 120;
const NEEDS_ESC = /[\\"\u0000-\u001f]/;

function previewStr(s: string): string {
  if (s.length > MAX_PREVIEW - 2) {
    const j = JSON.stringify(s);
    return j.length <= MAX_PREVIEW ? j : j.slice(0, MAX_PREVIEW - 1) + '…"';
  }
  // fast path: concat when no escaping needed (common case)
  return NEEDS_ESC.test(s) ? JSON.stringify(s) : '"' + s + '"';
}

// Intern a leaf preview. Plain, no-escape SHORT strings key on the RAW value
// (repeats like "Milano"/"common" never re-quote); numbers key on the number
// itself (no String() on repeats); literals use their own map (a JSON string
// "true" must not collide with boolean true). Everything else — escaped short
// strings, long strings, truncated previews — keys on the PREVIEW string, the
// original scheme, so shared/truncated previews still dedupe exactly.
// A short string whose escaped preview reaches MAX_PREVIEW+1 can equal a long
// string's truncated preview; keying both in `sl` is what keeps `vals` unique.
// Top-level (captures nothing) → inlinable.
function internLeaf(
  v: unknown,
  vals: string[],
  si: Map<string, number>,
  sl: Map<string, number>,
  ni: Map<number, number>,
  li: Map<string, number>,
): number {
  const t = typeof v;
  if (t === 'string') {
    const raw = v as string;
    if (raw.length <= MAX_PREVIEW - 2 && !NEEDS_ESC.test(raw)) {
      const hit = si.get(raw);
      if (hit !== undefined) return hit;
      const id = vals.length;
      vals.push('"' + raw + '"');
      si.set(raw, id);
      return id;
    }
    const s = previewStr(raw);
    const hit = sl.get(s);
    if (hit !== undefined) return hit;
    const id = vals.length;
    vals.push(s);
    sl.set(s, id);
    return id;
  }
  if (t === 'number') {
    const n = v as number;
    const hit = ni.get(n);
    if (hit !== undefined) return hit;
    const id = vals.length;
    vals.push(String(n));
    ni.set(n, id);
    return id;
  }
  const s = t === 'boolean' ? ((v as boolean) ? 'true' : 'false') : 'null';
  const hit = li.get(s);
  if (hit !== undefined) return hit;
  const id = vals.length;
  vals.push(s);
  li.set(s, id);
  return id;
}

interface Frame {
  obj: Record<string, unknown> | unknown[] | null;
  isArr: boolean;
  keysList: string[] | null; // obj mode
  len: number;
  idx: number;
  depth: number;
  rowId: number;
}

export function flatten(value: unknown, capHint = 1024): FlatTree {
  // seed columns from a cheap proxy (pretty line count ≈ node count) → no doubling copies
  let cap = capHint > 1024 ? capHint : 1024;
  let depthA = new Uint16Array(cap);
  let kindA = new Int32Array(cap);
  let keyIdxA = new Int32Array(cap);
  let valIdxA = new Int32Array(cap);
  let metaA = new Int32Array(cap);
  let subtreeA = new Int32Array(cap);
  let rc = 0;

  const keys: string[] = [];
  const vals: string[] = [];
  const keyIntern = new Map<string, number>();
  const si = new Map<string, number>();
  const sl = new Map<string, number>();
  const ni = new Map<number, number>();
  const li = new Map<string, number>();

  // stack of frames — pooled, zero alloc per push/pop after warmup
  const framePool: Frame[] = [];
  let frameTop = 0;
  let cf: Frame | undefined;

  // ---- root row ----
  {
    const row = rc++;
    depthA[row] = 0;
    keyIdxA[row] = -1;
    metaA[row] = 0;
    if (value !== null && typeof value === 'object') {
      const arr = Array.isArray(value);
      kindA[row] = arr ? K_ARR : K_OBJ;
      valIdxA[row] = -1;
      subtreeA[row] = -1; // pending finalize
      let f = framePool[0];
      if (f === undefined) {
        f = { obj: null, isArr: false, keysList: null, len: 0, idx: 0, depth: 0, rowId: 0 };
        framePool.push(f);
      }
      f.obj = value as Record<string, unknown>;
      f.isArr = arr;
      f.keysList = arr ? null : Object.keys(value as Record<string, unknown>);
      f.len = arr ? (value as unknown[]).length : f.keysList!.length;
      f.idx = 0;
      f.depth = 1;
      f.rowId = row;
      frameTop = 1;
      cf = f;
    } else {
      kindA[row] = K_LEAF;
      subtreeA[row] = 1;
      valIdxA[row] = internLeaf(value, vals, si, sl, ni, li);
    }
  }

  while (frameTop > 0) {
    const f = cf!;
    if (f.idx >= f.len) {
      subtreeA[f.rowId] = rc - f.rowId; // rows in subtree incl self
      frameTop--;
      cf = framePool[frameTop - 1];
      continue;
    }
    if (rc >= cap) {
      cap <<= 1;
      const d = new Uint16Array(cap); d.set(depthA); depthA = d;
      const k = new Int32Array(cap); k.set(kindA); kindA = k;
      const ki = new Int32Array(cap); ki.set(keyIdxA); keyIdxA = ki;
      const vi = new Int32Array(cap); vi.set(valIdxA); valIdxA = vi;
      const m = new Int32Array(cap); m.set(metaA); metaA = m;
      const sb = new Int32Array(cap); sb.set(subtreeA); subtreeA = sb;
    }

    const arr = f.isArr;
    let child: unknown;
    let keyIdx = -1;
    if (arr) {
      child = (f.obj as unknown[])[f.idx];
    } else {
      const k = (f.keysList as string[])[f.idx];
      child = (f.obj as Record<string, unknown>)[k];
      let id = keyIntern.get(k);
      if (id === undefined) {
        id = keys.length;
        keys.push(k);
        keyIntern.set(k, id);
      }
      keyIdx = id;
    }
    f.idx++;
    metaA[f.rowId]++; // child count (safe: parent row already emitted)

    const row = rc++;
    depthA[row] = f.depth;
    keyIdxA[row] = keyIdx;
    metaA[row] = 0;
    if (child !== null && typeof child === 'object') {
      const carr = Array.isArray(child);
      kindA[row] = carr ? K_ARR : K_OBJ;
      valIdxA[row] = -1;
      subtreeA[row] = -1;
      let nf = framePool[frameTop];
      if (nf === undefined) {
        nf = { obj: null, isArr: false, keysList: null, len: 0, idx: 0, depth: 0, rowId: 0 };
        framePool.push(nf);
      }
      frameTop++;
      nf.obj = child as Record<string, unknown>;
      nf.isArr = carr;
      nf.keysList = carr ? null : Object.keys(child as Record<string, unknown>);
      nf.len = carr ? (child as unknown[]).length : nf.keysList!.length;
      nf.idx = 0;
      nf.depth = f.depth + 1;
      nf.rowId = row;
      cf = nf;
    } else {
      kindA[row] = K_LEAF;
      subtreeA[row] = 1;
      valIdxA[row] = internLeaf(child, vals, si, sl, ni, li);
    }
  }

  const n = rc;
  return {
    depth: depthA.slice(0, n),
    kind: kindA.slice(0, n),
    keyIdx: keyIdxA.slice(0, n),
    valIdx: valIdxA.slice(0, n),
    meta: metaA.slice(0, n),
    subtreeRows: subtreeA.slice(0, n),
    keys,
    vals,
    rowCount: n,
  };
}

// Visual order when some branches collapsed: skip whole subtrees.
export function buildVisible(t: FlatTree, expanded: Uint8Array): Int32Array {
  const out = new GrowInt32(t.rowCount);
  let i = 0;
  while (i < t.rowCount) {
    out.push(i);
    if (t.kind[i] !== K_LEAF && !expanded[i]) {
      i += t.subtreeRows[i]; // skip descendants (self already pushed)
    } else {
      i++;
    }
  }
  return out.trim();
}
