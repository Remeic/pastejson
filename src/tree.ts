// Iterative DFS flatten of parsed JSON into columnar typed arrays + interned strings.
// "All expanded" = every row present in visual order (pre-order DFS).
// Collapse is a VIEW concern: buildVisible() skips subtrees via subtreeRows.

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

interface Frame {
  obj: Record<string, unknown> | unknown[] | null;
  isArr: boolean;
  keysList: string[] | null; // obj mode
  len: number;
  idx: number;
  depth: number;
  keyIdx: number;
  rowId: number;
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

function preview(v: unknown): string {
  const t = typeof v;
  if (t === 'string') {
    const s = v as string;
    if (s.length > MAX_PREVIEW - 2) return truncJson(JSON.stringify(s));
    // fast path: concat when no escaping needed (common case)
    return NEEDS_ESC.test(s) ? JSON.stringify(s) : '"' + s + '"';
  }
  if (t === 'number') return String(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  return 'null';
}

function truncJson(s: string): string {
  if (s.length <= MAX_PREVIEW) return s;
  return s.slice(0, MAX_PREVIEW - 1) + '…"';
}

export function flatten(value: unknown, capHint = 1024): FlatTree {
  // seed columns from a cheap proxy (pretty line count ≈ node count) → no doubling copies
  const cap = capHint > 1024 ? capHint : 1024;
  const depthA = new GrowInt32(cap);
  const kindA = new GrowInt32(cap);
  const keyIdxA = new GrowInt32(cap);
  const valIdxA = new GrowInt32(cap);
  const metaA = new GrowInt32(cap);
  const subtreeA = new GrowInt32(cap);

  const keys: string[] = [];
  const vals: string[] = [];
  const keyIntern = new Map<string, number>();
  const valIntern = new Map<string, number>();

  let rowCount = 0;

  const internKey = (k: string): number => {
    let id = keyIntern.get(k);
    if (id === undefined) {
      id = keys.length;
      keys.push(k);
      keyIntern.set(k, id);
    }
    return id;
  };

  const internVal = (v: unknown): number => {
    const s = preview(v);
    let id = valIntern.get(s);
    if (id === undefined) {
      id = vals.length;
      vals.push(s);
      valIntern.set(s, id);
    }
    return id;
  };

  // stack of frames — pooled, zero alloc per push/pop after warmup
  const framePool: Frame[] = [];
  let frameTop = 0;
  const getFrame = (): Frame => {
    const f = framePool[frameTop];
    if (f !== undefined) {
      frameTop++;
      return f;
    }
    const nf = {
      obj: null,
      isArr: false,
      keysList: null,
      len: 0,
      idx: 0,
      depth: 0,
      keyIdx: -1,
      rowId: -1,
    };
    framePool.push(nf);
    frameTop++;
    return nf;
  };

  const isBranch = (v: unknown): boolean => v !== null && typeof v === 'object';

  const pushFrame = (v: Record<string, unknown> | unknown[], isArr: boolean, depth: number, keyIdx: number, rowId: number): void => {
    const f = getFrame();
    f.obj = v;
    f.isArr = isArr;
    f.keysList = isArr ? null : Object.keys(v as Record<string, unknown>);
    f.len = isArr ? (v as unknown[]).length : (f.keysList as string[]).length;
    f.idx = 0;
    f.depth = depth;
    f.keyIdx = keyIdx;
    f.rowId = rowId;
  };

  // emit root row first
  const emit = (v: unknown, keyIdx: number, depth: number): number => {
    const row = rowCount++;
    depthA.push(depth);
    keyIdxA.push(keyIdx);
    metaA.push(0);
    if (isBranch(v)) {
      kindA.push(Array.isArray(v) ? K_ARR : K_OBJ);
      valIdxA.push(-1);
      subtreeA.push(-1); // pending finalize
    } else {
      kindA.push(K_LEAF);
      valIdxA.push(internVal(v));
      subtreeA.push(1);
    }
    return row;
  };

  const rootRow = emit(value, -1, 0);
  if (isBranch(value)) {
    pushFrame(value as Record<string, unknown>, Array.isArray(value), 1, -1, rootRow);
  }

  while (frameTop > 0) {
    const f = framePool[frameTop - 1];
    if (f.idx >= f.len) {
      // finalize branch
      subtreeA.arr[f.rowId] = rowCount - f.rowId;
      frameTop--;
      continue;
    }
    const childKey = f.isArr ? f.idx : (f.keysList as string[])[f.idx];
    const childVal = f.isArr
      ? (f.obj as unknown[])[f.idx]
      : (f.obj as Record<string, unknown>)[childKey as string];
    f.idx++;

    const kId = f.isArr ? -1 : internKey(childKey as string);
    metaA.arr[f.rowId]++; // child count (safe: parent row already emitted)
    const childRow = emit(childVal, kId, f.depth);
    if (isBranch(childVal)) {
      pushFrame(
        childVal as Record<string, unknown>,
        Array.isArray(childVal),
        f.depth + 1,
        kId,
        childRow,
      );
    }
  }

  const n = rowCount;
  const depthU = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    depthU[i] = depthA.arr[i];
  }

  return {
    depth: depthU,
    kind: kindA.trim(),
    keyIdx: keyIdxA.trim(),
    valIdx: valIdxA.trim(),
    meta: metaA.trim(),
    subtreeRows: subtreeA.trim(),
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
