// Structural JSON diff — LAZY ISLAND.
// Loaded via dynamic import on first Diff click; NEVER imported by the
// paste/hot path: zero bytes executed, zero shared state, zero allocations
// until used. Self-contained on purpose (may move to a worker later).
//
// Strategy: parallel DFS over both values.
// - deep-equal subtrees emit NOTHING (diff shows changes only)
// - changed regions emit ancestor context rows + GitHub-style del/add pairs
// - objects matched by key (O(1) hasown lookup), arrays aligned via
//   common prefix/suffix trim + Myers O(ND) over interned JSON.stringify
//   element keys (native C++ floor does the stringifying)
// - Myers D capped + trace-memory bounded; beyond that → pairwise fallback
//   (correct, just denser rows)

export const OP_SAME = 0;
export const OP_ADD = 1;
export const OP_DEL = 2;

const K_LEAF = 0;
const K_OBJ = 1;
const K_ARR = 2;

export interface DiffResult {
  op: Uint8Array; // OP_* per row
  kind: Uint8Array; // K_* per row
  depth: Uint16Array;
  keyIdx: Int32Array; // into keys[], -1 = none (array elements / root)
  valIdx: Int32Array; // into vals[] (leaves only), -1 = branch row
  meta: Int32Array; // branch rows: child count (max of both sides)
  keys: string[];
  vals: string[];
  rowCount: number;
  maxChars: number; // rough longest-row char estimate (h-scroll width)
  adds: number;
  dels: number;
}

const MAX_PREVIEW = 120;
const NEEDS_ESC = /[\\"\u0000-\u001f]/;
// stringify-key budget for Myers alignment (~64MB of intermediate strings);
// beyond it alignment falls back to pairwise — bounded, deterministic
const KEY_BUDGET = 64 << 20;
const MYERS_D_CAP = 2048;

function preview(v: unknown): string {
  const t = typeof v;
  if (t === 'string') {
    const s = v as string;
    if (s.length > MAX_PREVIEW - 2) return truncJson(JSON.stringify(s));
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

const isBr = (v: unknown): boolean => v !== null && v !== undefined && typeof v === 'object';

// cheap-then-native deep equality: ref/prim fast path, native stringify floor
function sameDeep(x: unknown, y: unknown): boolean {
  if (x === y) return true;
  if (!isBr(x) || !isBr(y)) return false;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  return JSON.stringify(x) === JSON.stringify(y);
}

class I32 {
  arr: Int32Array<ArrayBuffer>;
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
}

interface Frame {
  o: unknown;
  isArr: boolean;
  ks: string[] | null;
  len: number;
  i: number;
  d: number;
  row: number;
}

// Myers O(ND) over int-keyed sequences. Returns false when D exceeds the
// cap or trace memory bound → caller falls back to pairwise.
// Shared by the focus engine and the aligned engine. outSame is optional:
// focus ignores equal pairs, aligned mirrors them.
function myers(
  a: Int32Array,
  b: Int32Array,
  outDel: (i: number) => void,
  outAdd: (j: number) => void,
  outSame?: (i: number, j: number) => void,
): boolean {
  const n = a.length;
  const m = b.length;
  if (n === 0) {
    for (let j = 0; j < m; j++) outAdd(j);
    return true;
  }
  if (m === 0) {
    for (let i = 0; i < n; i++) outDel(i);
    return true;
  }
  const maxD = n + m;
  const w = 2 * maxD + 1;
  const off = maxD;
  // trace memory bound: (d+1)*w cells ≤ 8M ints (32MB) hard stop
  const dCap = Math.min(MYERS_D_CAP, Math.floor((8 << 23) / w), maxD);
  const v = new Int32Array(w);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let dd = 0; dd <= dCap; dd++) {
    trace.push(v.slice());
    for (let k = -dd; k <= dd; k += 2) {
      let x: number;
      if (k === -dd || (k !== dd && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = dd;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return false;
  // backtrack: edits collected in REVERSE document order, then flushed
  // forward — single stream keeps row order natural
  // op tags: 0 same, 1 add(b), 2 del(a)
  const rev: number[] = []; // triples [tag, i, j]
  let x = n;
  let y = m;
  const pushOp = (t: number, i: number, j: number): void => {
    rev.push(t, i, j);
  };
  for (let dd = found; dd > 0; dd--) {
    const vp = trace[dd];
    const k = x - y;
    let pk: number;
    if (k === -dd || (k !== dd && vp[off + k - 1] < vp[off + k + 1])) pk = k + 1;
    else pk = k - 1;
    const px = vp[off + pk];
    const py = px - pk;
    while (x > px && y > py) {
      pushOp(0, x - 1, y - 1);
      x--;
      y--;
    }
    if (pk === k - 1) {
      pushOp(2, x - 1, -1);
      x--;
    } else {
      pushOp(1, -1, y - 1);
      y--;
    }
  }
  while (x > 0 && y > 0) {
    pushOp(0, x - 1, y - 1);
    x--;
    y--;
  }
  while (x > 0) {
    pushOp(2, x - 1, -1);
    x--;
  }
  while (y > 0) {
    pushOp(1, -1, y - 1);
    y--;
  }
  for (let r = rev.length - 3; r >= 0; r -= 3) {
    const t = rev[r];
    if (t === 0) outSame?.(rev[r + 1], rev[r + 2]);
    else if (t === 1) outAdd(rev[r + 2]);
    else outDel(rev[r + 1]);
  }
  return true;
}

export function diffJson(a: unknown, b: unknown): DiffResult {
  const colOp = new I32(256);
  const colKind = new I32(256);
  const colDepth = new I32(256);
  const colKey = new I32(256);
  const colVal = new I32(256);
  const colMeta = new I32(256);
  const keys: string[] = [];
  const keyIntern = new Map<string, number>();
  const vals: string[] = [];
  let adds = 0;
  let dels = 0;
  let maxChars = 0;

  let strBudget = KEY_BUDGET;

  const keyId = (k: string): number => {
    let id = keyIntern.get(k);
    if (id === undefined) {
      id = keys.length;
      keys.push(k);
      keyIntern.set(k, id);
    }
    return id;
  };

  function row(
    op: number,
    kind: number,
    depth: number,
    kId: number,
    vId: number,
    meta: number,
  ): void {
    colOp.push(op);
    colKind.push(kind);
    colDepth.push(depth);
    colKey.push(kId);
    colVal.push(vId);
    colMeta.push(meta);
    let chars = depth * 2 + 6;
    if (kId >= 0) chars += keys[kId].length + 2;
    if (vId >= 0) chars += vals[vId].length;
    else chars += 8;
    if (chars > maxChars) maxChars = chars;
    if (op === OP_ADD) adds++;
    else if (op === OP_DEL) dels++;
  }

  function leafRow(v: unknown, op: number, d: number, kId: number): void {
    vals.push(preview(v));
    row(op, K_LEAF, d, kId, vals.length - 1, 0);
  }

  // whole-subtree flatten carrying one op (removed/added subtree)
  const pool: Frame[] = [];
  let top = 0;
  const getF = (): Frame => {
    let f = pool[top];
    if (f === undefined) {
      f = { o: null, isArr: false, ks: null, len: 0, i: 0, d: 0, row: -1 };
      pool.push(f);
    }
    top++;
    return f;
  };

  function subtree(v: unknown, op: number, d: number, kId: number): void {
    if (!isBr(v)) {
      leafRow(v, op, d, kId);
      return;
    }
    const isArr = Array.isArray(v);
    const r = colOp.len;
    row(op, isArr ? K_ARR : K_OBJ, d, kId, -1, 0);
    let f = getF();
    f.o = v;
    f.isArr = isArr;
    f.ks = isArr ? null : Object.keys(v as Record<string, unknown>);
    f.len = isArr ? (v as unknown[]).length : f.ks!.length;
    f.i = 0;
    f.d = d + 1;
    f.row = r;
    while (top > 0) {
      const cf = pool[top - 1];
      if (cf.i >= cf.len) {
        colMeta.arr[cf.row] = cf.len;
        top--;
        continue;
      }
      const ck = cf.isArr ? cf.i : cf.ks![cf.i];
      const cv = cf.isArr
        ? (cf.o as unknown[])[cf.i]
        : (cf.o as Record<string, unknown>)[ck as string];
      cf.i++;
      const cid = cf.isArr ? -1 : keyId(ck as string);
      if (!isBr(cv)) {
        leafRow(cv, op, cf.d, cid);
        continue;
      }
      const cIsArr = Array.isArray(cv);
      const cr = colOp.len;
      row(op, cIsArr ? K_ARR : K_OBJ, cf.d, cid, -1, 0);
      const nf = getF();
      nf.o = cv;
      nf.isArr = cIsArr;
      nf.ks = cIsArr ? null : Object.keys(cv as Record<string, unknown>);
      nf.len = cIsArr ? (cv as unknown[]).length : nf.ks!.length;
      nf.i = 0;
      nf.d = cf.d + 1;
      nf.row = cr;
    }
  }

  // both sides exist and are NOT deep-equal → decide how to present
  function walkInto(av: unknown, bv: unknown, d: number, kId: number): void {
    const ba = isBr(av);
    const bb = isBr(bv);
    if (!ba && !bb) {
      leafRow(av, OP_DEL, d, kId);
      leafRow(bv, OP_ADD, d, kId);
      return;
    }
    if (ba !== bb || Array.isArray(av) !== Array.isArray(bv)) {
      subtree(av, OP_DEL, d, kId);
      subtree(bv, OP_ADD, d, kId);
      return;
    }
    // container pair: context skeleton row, then descend to the differences
    const isArr = Array.isArray(av);
    const oa = av as unknown[];
    const ob = bv as unknown[];
    const ka = isArr ? null : Object.keys(av as Record<string, unknown>);
    const kb = isArr ? null : Object.keys(bv as Record<string, unknown>);
    const na = isArr ? oa.length : ka!.length;
    const nb = isArr ? ob.length : kb!.length;
    const cr = colOp.len;
    row(OP_SAME, isArr ? K_ARR : K_OBJ, d, kId, -1, na > nb ? na : nb);
    if (isArr) walkArr(oa, ob, d + 1);
    else walkObj(av as Record<string, unknown>, bv as Record<string, unknown>, d + 1);
    colMeta.arr[cr] = na > nb ? na : nb;
  }

  const hasOwn = (o: Record<string, unknown>, k: string): boolean =>
    Object.prototype.hasOwnProperty.call(o, k);

  function walkObj(a: Record<string, unknown>, b: Record<string, unknown>, d: number): void {
    const bKeys = Object.keys(b);
    for (const k of Object.keys(a)) {
      const kId = keyId(k);
      if (!hasOwn(b, k)) {
        subtree(a[k], OP_DEL, d, kId);
        continue;
      }
      const av = a[k];
      const bv = b[k];
      if (sameDeep(av, bv)) continue;
      walkInto(av, bv, d, kId);
    }
    for (const k of bKeys) {
      if (!hasOwn(a, k)) subtree(b[k], OP_ADD, d, keyId(k));
    }
  }

  const eqQuick = (x: unknown, y: unknown): boolean => x === y;

  function walkArr(a: unknown[], b: unknown[], d: number): void {
    const n = a.length;
    const m = b.length;
    let p = 0;
    while (p < n && p < m && eqQuick(a[p], b[p])) p++;
    let s = 0;
    while (s < n - p && s < m - p && eqQuick(a[n - 1 - s], b[m - 1 - s])) s++;
    const en = n - s;
    const em = m - s;
    const mn = en - p;
    const mm = em - p;
    if (mn === 0) {
      for (let j = 0; j < mm; j++) subtree(b[p + j], OP_ADD, d, -1);
      return;
    }
    if (mm === 0) {
      for (let i = 0; i < mn; i++) subtree(a[p + i], OP_DEL, d, -1);
      return;
    }
    // ONE intern map across BOTH middles — separate maps would collapse
    // different elements to the same int and mask real changes
    const intern = new Map<string, number>();
    let used = 0;
    const keyIdOf = (el: unknown): number => {
      let k: string;
      if (el === null || typeof el !== 'object') {
        k = typeof el + ':' + String(el); // primitives: no stringify needed
      } else {
        k = JSON.stringify(el); // native floor
        used += k.length;
        if (used > strBudget) return -1; // budget out
      }
      let id = intern.get(k);
      if (id === undefined) {
        id = intern.size;
        intern.set(k, id);
      }
      return id;
    };
    const ia = new Int32Array(mn);
    const ib = new Int32Array(mm);
    let okB = true;
    for (let i = 0; i < mn && okB; i++) {
      const id = keyIdOf(a[p + i]);
      if (id < 0) okB = false;
      else ia[i] = id;
    }
    if (okB) {
      for (let j = 0; j < mm && okB; j++) {
        const id = keyIdOf(b[p + j]);
        if (id < 0) okB = false;
        else ib[j] = id;
      }
    }
    if (!okB) return pairwise(a, b, p, en, em, d);
    if (
      !myers(
        ia,
        ib,
        (i) => subtree(a[p + i], OP_DEL, d, -1),
        (j) => subtree(b[p + j], OP_ADD, d, -1),
      )
    ) {
      pairwise(a, b, p, en, em, d);
    }
    // equal pairs emit nothing (stringify-equal ⇒ structurally identical)
  }

  function pairwise(
    a: unknown[],
    b: unknown[],
    p: number,
    en: number,
    em: number,
    d: number,
  ): void {
    let i = p;
    let j = p;
    while (i < en && j < em) {
      const av = a[i];
      const bv = b[j];
      if (!sameDeep(av, bv)) walkInto(av, bv, d, -1);
      i++;
      j++;
    }
    while (i < en) subtree(a[i++], OP_DEL, d, -1);
    while (j < em) subtree(b[j++], OP_ADD, d, -1);
  }

  // ---- root ----
  if (!sameDeep(a, b)) walkInto(a, b, 0, -1);

  const n = colOp.len;
  const op = new Uint8Array(n);
  const kind = new Uint8Array(n);
  const depth = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    op[i] = colOp.arr[i];
    kind[i] = colKind.arr[i];
    depth[i] = colDepth.arr[i];
  }
  const trim = (c: I32): Int32Array => (c.len === c.arr.length ? c.arr : c.arr.slice(0, c.len));
  return {
    op,
    kind,
    depth,
    keyIdx: trim(colKey),
    valIdx: trim(colVal),
    meta: trim(colMeta),
    keys,
    vals,
    rowCount: n,
    maxChars,
    adds,
    dels,
  };
}

// ---------- aligned builder (side-by-side) ----------
// Full synchronized emission: EVERY node of both docs becomes a visual pair
// (left cell / right cell). Computed only when the user switches to
// side-by-side — the focus path above stays the cheap default.
// Soundness shortcuts (no comparisons needed):
// - ref/primitive-equal pairs → mirror emit
// - Myers "same" ⇒ stringify-equal ⇒ mirror emit
export const OP_MOD = 3;

export interface AlignedResult {
  op: Uint8Array; // OP_* per pair
  lRow: Int32Array; // row id in left columns, -1 = empty cell
  rRow: Int32Array; // row id in right columns, -1 = empty cell
  lKind: Uint8Array;
  lDepth: Uint16Array;
  lKey: Int32Array;
  lVal: Int32Array;
  lMeta: Int32Array;
  rKind: Uint8Array;
  rDepth: Uint16Array;
  rKey: Int32Array;
  rVal: Int32Array;
  rMeta: Int32Array;
  lKeys: string[];
  lVals: string[];
  rKeys: string[];
  rVals: string[];
  rowCount: number;
}

interface AFrame {
  o: unknown;
  isArr: boolean;
  ks: string[] | null;
  len: number;
  i: number;
  d: number;
  li: number;
  ri: number;
}

export function diffAligned(a: unknown, b: unknown): AlignedResult {
  // ONE intern table shared by both columns: same int ⇒ same key text;
  // keys[] filled in lockstep at registration so ints stay valid per side
  const keyMap = new Map<string, number>();
  const lKeys: string[] = [];
  const rKeys: string[] = [];
  const keyOf = (k: string): number => {
    let id = keyMap.get(k);
    if (id === undefined) {
      id = keyMap.size;
      keyMap.set(k, id);
      lKeys.push(k);
      rKeys.push(k);
    }
    return id;
  };

  const mkCols = () => {
    const kind = new I32(256);
    const depth = new I32(256);
    const key = new I32(256);
    const val = new I32(256);
    const meta = new I32(256);
    const vals: string[] = [];
    return {
      kind,
      depth,
      key,
      val,
      meta,
      vals,
      leaf(pv: string, d: number, kId: number): number {
        vals.push(pv);
        kind.push(K_LEAF);
        depth.push(d);
        key.push(kId);
        val.push(vals.length - 1);
        meta.push(0);
        return kind.len - 1;
      },
      branch(brKind: number, d: number, kId: number, m: number): number {
        kind.push(brKind);
        depth.push(d);
        key.push(kId);
        val.push(-1);
        meta.push(m); // child count known upfront — no post-patch pass
        return kind.len - 1;
      },
    };
  };
  const L = mkCols();
  const R = mkCols();

  const opC = new I32(1024);
  const lrC = new I32(1024);
  const rrC = new I32(1024);
  const pair = (o: number, li: number, ri: number): void => {
    opC.push(o);
    lrC.push(li);
    rrC.push(ri);
  };

  const childCount = (v: unknown, isArr: boolean): number =>
    isArr ? (v as unknown[]).length : Object.keys(v as Record<string, unknown>).length;

  const pool: AFrame[] = [];
  let top = 0;
  const getF = (): AFrame => {
    let f = pool[top];
    if (f === undefined) {
      f = { o: null, isArr: false, ks: null, len: 0, i: 0, d: 0, li: -1, ri: -1 };
      pool.push(f);
    }
    top++;
    return f;
  };

  // whole subtree into ONE column; opposite cell stays empty (-1)
  function flatSide(v: unknown, d: number, kId: number, right: boolean): void {
    const op = right ? OP_ADD : OP_DEL;
    const C = right ? R : L;
    const put = (node: unknown, dd: number, kk: number): number => {
      if (!isBr(node)) return C.leaf(preview(node), dd, kk);
      const ia = Array.isArray(node);
      return C.branch(ia ? K_ARR : K_OBJ, dd, kk, childCount(node, ia));
    };
    const row = put(v, d, kId);
    pair(op, right ? -1 : row, right ? row : -1);
    if (!isBr(v)) return;
    let f = getF();
    f.o = v;
    f.isArr = Array.isArray(v);
    f.ks = f.isArr ? null : Object.keys(v as Record<string, unknown>);
    f.len = f.isArr ? (v as unknown[]).length : f.ks!.length;
    f.i = 0;
    f.d = d + 1;
    while (top > 0) {
      const cf = pool[top - 1];
      if (cf.i >= cf.len) {
        top--;
        continue;
      }
      const ck = cf.isArr ? cf.i : cf.ks![cf.i];
      const cv = cf.isArr
        ? (cf.o as unknown[])[cf.i]
        : (cf.o as Record<string, unknown>)[ck as string];
      cf.i++;
      const kid = cf.isArr ? -1 : keyOf(ck as string);
      const crow = put(cv, cf.d, kid);
      pair(op, right ? -1 : crow, right ? crow : -1);
      if (isBr(cv)) {
        const nf = getF();
        nf.o = cv;
        nf.isArr = Array.isArray(cv);
        nf.ks = nf.isArr ? null : Object.keys(cv as Record<string, unknown>);
        nf.len = nf.isArr ? (cv as unknown[]).length : nf.ks!.length;
        nf.i = 0;
        nf.d = cf.d + 1;
        nf.li = -1;
        nf.ri = -1;
      }
    }
  }

  // identical subtree mirrored into BOTH columns — zero comparisons
  function flatBoth(v: unknown, d: number, kId: number): void {
    const put = (node: unknown, dd: number, kk: number): [number, number] => {
      if (!isBr(node)) {
        const pv = preview(node);
        return [L.leaf(pv, dd, kk), R.leaf(pv, dd, kk)];
      }
      const ia = Array.isArray(node);
      const bk = ia ? K_ARR : K_OBJ;
      const n = childCount(node, ia);
      return [L.branch(bk, dd, kk, n), R.branch(bk, dd, kk, n)];
    };
    const [li0, ri0] = put(v, d, kId);
    pair(OP_SAME, li0, ri0);
    if (!isBr(v)) return;
    let f = getF();
    f.o = v;
    f.isArr = Array.isArray(v);
    f.ks = f.isArr ? null : Object.keys(v as Record<string, unknown>);
    f.len = f.isArr ? (v as unknown[]).length : f.ks!.length;
    f.i = 0;
    f.d = d + 1;
    f.li = li0;
    f.ri = ri0;
    while (top > 0) {
      const cf = pool[top - 1];
      if (cf.i >= cf.len) {
        top--;
        continue;
      }
      const ck = cf.isArr ? cf.i : cf.ks![cf.i];
      const cv = cf.isArr
        ? (cf.o as unknown[])[cf.i]
        : (cf.o as Record<string, unknown>)[ck as string];
      cf.i++;
      const kid = cf.isArr ? -1 : keyOf(ck as string);
      const [cli, cri] = put(cv, cf.d, kid);
      pair(OP_SAME, cli, cri);
      if (isBr(cv)) {
        const nf = getF();
        nf.o = cv;
        nf.isArr = Array.isArray(cv);
        nf.ks = nf.isArr ? null : Object.keys(cv as Record<string, unknown>);
        nf.len = nf.isArr ? (cv as unknown[]).length : nf.ks!.length;
        nf.i = 0;
        nf.d = cf.d + 1;
        nf.li = cli;
        nf.ri = cri;
      }
    }
  }

  // synchronized walk; true = anything non-SAME emitted below this node
  function walkSync(av: unknown, bv: unknown, d: number, kId: number): boolean {
    const ba = isBr(av);
    const bb = isBr(bv);
    if (!ba && !bb) {
      if (av === bv) {
        // primitives only here — === is exact (post-parse, no NaN)
        const pv = preview(av);
        pair(OP_SAME, L.leaf(pv, d, kId), R.leaf(pv, d, kId));
        return false;
      }
      pair(OP_MOD, L.leaf(preview(av), d, kId), R.leaf(preview(bv), d, kId));
      return true;
    }
    if (ba !== bb || Array.isArray(av) !== Array.isArray(bv)) {
      flatSide(av, d, kId, false);
      flatSide(bv, d, kId, true);
      return true;
    }
    const isArr = Array.isArray(av);
    const na = childCount(av, isArr);
    const nb = childCount(bv, isArr);
    const pc = opC.len; // patch to MOD if a descendant changes
    const bk = isArr ? K_ARR : K_OBJ;
    pair(OP_SAME, L.branch(bk, d, kId, na), R.branch(bk, d, kId, nb));
    let changed: boolean;
    if (isArr) changed = arrSync(av as unknown[], bv as unknown[], d + 1);
    else
      changed = objSync(
        av as Record<string, unknown>,
        bv as Record<string, unknown>,
        d + 1,
      );
    if (changed) opC.arr[pc] = OP_MOD;
    return changed;
  }

  const hasOwn = (o: Record<string, unknown>, k: string): boolean =>
    Object.prototype.hasOwnProperty.call(o, k);

  function objSync(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
    d: number,
  ): boolean {
    let ch = false;
    for (const k of Object.keys(a)) {
      const kid = keyOf(k);
      if (!hasOwn(b, k)) {
        flatSide(a[k], d, kid, false);
        ch = true;
        continue;
      }
      if (walkSync(a[k], b[k], d, kid)) ch = true;
    }
    for (const k of Object.keys(b)) {
      if (!hasOwn(a, k)) {
        flatSide(b[k], d, keyOf(k), true);
        ch = true;
      }
    }
    return ch;
  }

  function arrSync(x: unknown[], y: unknown[], d: number): boolean {
    const n = x.length;
    const m = y.length;
    let p = 0;
    while (p < n && p < m && x[p] === y[p]) p++;
    let s = 0;
    while (s < n - p && s < m - p && x[n - 1 - s] === y[m - 1 - s]) s++;
    for (let i = 0; i < p; i++) flatBoth(x[i], d, -1);
    const en = n - s;
    const em = m - s;
    for (let i = en; i < n; i++) flatBoth(x[i], d, -1);
    const mn = en - p;
    const mm = em - p;
    let ch = false;
    if (mn === 0 || mm === 0) {
      for (let i = p; i < en; i++) {
        flatSide(x[i], d, -1, false);
        ch = true;
      }
      for (let j = p; j < em; j++) {
        flatSide(y[j], d, -1, true);
        ch = true;
      }
      return ch;
    }
    const pairwiseMid = (): void => {
      const lim = en < em ? en : em;
      for (let i = p; i < lim; i++) if (walkSync(x[i], y[i], d, -1)) ch = true;
      for (let i = lim; i < en; i++) {
        flatSide(x[i], d, -1, false);
        ch = true;
      }
      for (let j = lim; j < em; j++) {
        flatSide(y[j], d, -1, true);
        ch = true;
      }
    };
    // shared intern across BOTH middles (same rule as focus path)
    const intern = new Map<string, number>();
    let used = 0;
    const keyIdOf = (el: unknown): number => {
      let k: string;
      if (el === null || typeof el !== 'object') k = typeof el + ':' + String(el);
      else {
        k = JSON.stringify(el); // native floor
        used += k.length;
        if (used > KEY_BUDGET) return -1;
      }
      let id = intern.get(k);
      if (id === undefined) {
        id = intern.size;
        intern.set(k, id);
      }
      return id;
    };
    const ia = new Int32Array(mn);
    const ib = new Int32Array(mm);
    let okB = true;
    for (let i = 0; i < mn && okB; i++) {
      const id = keyIdOf(x[p + i]);
      if (id < 0) okB = false;
      else ia[i] = id;
    }
    if (okB) {
      for (let j = 0; j < mm && okB; j++) {
        const id = keyIdOf(y[p + j]);
        if (id < 0) okB = false;
        else ib[j] = id;
      }
    }
    if (
      !okB ||
      !myers(
        ia,
        ib,
        (i) => {
          flatSide(x[p + i], d, -1, false);
          ch = true;
        },
        (j) => {
          flatSide(y[p + j], d, -1, true);
          ch = true;
        },
        // Myers "same" ⇒ stringify-equal ⇒ mirrored emission, zero compares
        (i, j) => flatBoth(x[p + i], d, -1),
      )
    ) {
      pairwiseMid();
    }
    return ch;
  }

  // ---- root ----
  walkSync(a, b, 0, -1);

  const u8 = (c: I32): Uint8Array => {
    const t = new Uint8Array(c.len);
    for (let i = 0; i < c.len; i++) t[i] = c.arr[i];
    return t;
  };
  const u16 = (c: I32): Uint16Array => {
    const t = new Uint16Array(c.len);
    for (let i = 0; i < c.len; i++) t[i] = c.arr[i];
    return t;
  };
  const trim = (c: I32): Int32Array => (c.len === c.arr.length ? c.arr : c.arr.slice(0, c.len));
  return {
    op: u8(opC),
    lRow: trim(lrC),
    rRow: trim(rrC),
    lKind: u8(L.kind),
    lDepth: u16(L.depth),
    lKey: trim(L.key),
    lVal: trim(L.val),
    lMeta: trim(L.meta),
    rKind: u8(R.kind),
    rDepth: u16(R.depth),
    rKey: trim(R.key),
    rVal: trim(R.val),
    rMeta: trim(R.meta),
    lKeys,
    lVals: L.vals,
    rKeys,
    rVals: R.vals,
    rowCount: opC.len,
  };
}
