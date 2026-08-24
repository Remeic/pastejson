// Iterative DFS flatten of parsed JSON into columnar typed arrays + interned strings.
// "All expanded" = every row present in visual order (pre-order DFS).
// Collapse is a VIEW concern: buildVisible() skips subtrees via subtreeRows.

const K_LEAF = 0;
const K_OBJ = 1;
const K_ARR = 2;

export interface FlatTree {
  depth: Uint16Array;
  kind: Uint8Array; // K_* above
  keyIdx: Int32Array; // index into keys[], -1 = none
  valIdx: Int32Array; // index into vals[] (leaves), -1 = branch
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

function preview(v: unknown): string {
  const t = typeof v;
  if (t === 'string') return truncJson(JSON.stringify(v));
  if (t === 'number') return String(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  return 'null';
}

function truncJson(s: string): string {
  if (s.length <= MAX_PREVIEW) return s;
  return s.slice(0, MAX_PREVIEW - 1) + '…"';
}

export function flatten(value: unknown): FlatTree {
  const capHint = 1024;
  const depthA = new GrowInt32(capHint);
  const kindA = new GrowInt32(capHint); // store as int, expose Uint8 later
  const keyIdxA = new GrowInt32(capHint);
  const valIdxA = new GrowInt32(capHint);
  const metaA = new GrowInt32(capHint);

  const keys: string[] = [];
  const vals: string[] = [];
  const keyIntern = new Map<string, number>();

  let rowCount = 0;
  const subtreeRows: number[] = []; // plain array, converted at end

  const internKey = (k: string): number => {
    let id = keyIntern.get(k);
    if (id === undefined) {
      id = keys.length;
      keys.push(k);
      keyIntern.set(k, id);
    }
    return id;
  };

  // stack of frames
  const stack: Frame[] = [];

  const isBranch = (v: unknown): boolean =>
    v !== null && (typeof v === 'object' || Array.isArray(v));

  const pushFrame = (v: Record<string, unknown> | unknown[], isArr: boolean, depth: number, keyIdx: number, rowId: number): void => {
    if (isArr) {
      stack.push({ obj: v, isArr, keysList: null, len: (v as unknown[]).length, idx: 0, depth, keyIdx, rowId });
    } else {
      stack.push({ obj: v, isArr, keysList: Object.keys(v as Record<string, unknown>), len: 0, idx: 0, depth, keyIdx, rowId });
      (stack[stack.length - 1].len = (stack[stack.length - 1].keysList as string[]).length);
    }
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
      subtreeRows[row] = -1; // pending finalize
    } else {
      kindA.push(K_LEAF);
      valIdxA.push(vals.length);
      vals.push(preview(v));
      subtreeRows[row] = 1;
    }
    return row;
  };

  const rootRow = emit(value, -1, 0);
  if (isBranch(value)) {
    pushFrame(value as Record<string, unknown>, Array.isArray(value), 1, -1, rootRow);
  }

  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    if (f.idx >= f.len) {
      // finalize branch
      subtreeRows[f.rowId] = rowCount - f.rowId;
      stack.pop();
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
  const kindU = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    depthU[i] = depthA.arr[i];
    kindU[i] = kindA.arr[i];
  }

  return {
    depth: depthU,
    kind: kindU,
    keyIdx: keyIdxA.trim(),
    valIdx: valIdxA.trim(),
    meta: metaA.trim(),
    subtreeRows: Int32Array.from(subtreeRows),
    keys,
    vals,
    rowCount: n,
  };
}

export const KIND_LEAF = K_LEAF;

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
