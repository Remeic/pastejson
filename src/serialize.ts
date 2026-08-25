// Fused JSON view-model builder — v4 (golfed hot core).
// Text from NATIVE JSON.stringify; parallel ZERO-STRING length walk emits
// tokens + line index + tree rows (interleaved stride-6 Int32Array).
// Labels lazy: rows store token indices; materializeLabels() slices pretty.
// Token pairs are EXACTLY tokenize(JSON.stringify(...)) — fuzz-verified.
import {
  T_FALSE,
  T_KEY,
  T_NULL,
  T_NUM,
  T_STR,
  T_TRUE,
} from './tokenizer';
import type { FlatTree } from './tree';

export interface EmitResult {
  pretty: string;
  tokens: Int32Array;
  lineStarts: Uint32Array;
  lines: number;
  maxLen: number;
  tree: FlatTree;
}

const MAX_PREVIEW = 128;
const STRIDE = 6; // depth, kind, keyTok, valTok, meta, subtree

// escaped length of s as JSON.stringify would emit it (quotes excluded)
// fast path: one native regex scan proves the string is escape-free (~90% of real data)
const NEEDS_ESC_LEN = /[\u0000-\u001f"\\\ud800-\udfff]/;
function escLen(s: string): number {
  if (!NEEDS_ESC_LEN.test(s)) return s.length;
  const n = s.length;
  let extra = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 92) extra++; // \" \\
    else if (c < 32) {
      if (c === 8 || c === 9 || c === 10 || c === 12 || c === 13) extra++;
      else extra += 5; // \u00XX
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const next = i + 1 < n ? s.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) i++; // valid pair: raw
      else extra += 5; // lone surrogate → \uXXXX
    }
  }
  return n + extra;
}

interface Frame {
  obj: Record<string, unknown> | unknown[] | null;
  isArr: boolean;
  keysList: string[] | null;
  len: number;
  idx: number;
  childDepth: number;
  rowId: number;
  first: boolean;
}

export function emitJson(
  value: unknown,
  indent: number | '\t',
  rawLenHint: number,
): EmitResult {
  const pretty = JSON.stringify(value, null, indent);
  const indLen = typeof indent === 'number' ? indent : 1;
  const plen = pretty.length;

  let pos = 0;

  // ---- tokens ----
  // Pure-local aliasing: tk/tc/tlen stay uncontextualized (register-allocated);
  // growth goes through a pure helper, so hot pushes are plain typed-array
  // stores with one predicted compare — no closure call, no scope loads.
  let tc = rawLenHint / 2 > 4096 ? (rawLenHint / 2) | 0 : 4096;
  let tlen = 0;
  let tk: Int32Array<ArrayBuffer> = new Int32Array(tc);
  const growI32 = (old: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> => {
    const g = new Int32Array(old.length << 1);
    g.set(old);
    return g;
  };

  // ---- line index ----
  let lcap = rawLenHint / 9 > 1024 ? (rawLenHint / 9) | 0 : 1024;
  let llen = 0;
  let ls = new Uint32Array(lcap);
  ls[llen++] = 0;
  let nl = 0;
  let lineStart = 0;
  let maxLen = 0;

  // ---- tree rows: interleaved stride-6 ----
  let rcap = rawLenHint / 11 > 1024 ? (rawLenHint / 11) | 0 : 1024;
  let rowCount = 0;
  let rk: Int32Array<ArrayBuffer> = new Int32Array(rcap * STRIDE);

  const isBranch = (v: unknown): boolean => v !== null && typeof v === 'object';

  // capacity guards + hot pushes
  const ensureTok = (): void => {
    if (tlen + 2 > tc) {
      tk = growI32(tk);
      tc = tk.length;
    }
  };
  const pushTok = (end: number, type: number): void => {
    ensureTok();
    tk[tlen++] = end;
    tk[tlen++] = type;
  };

  // leaf value: advance pos over its pretty span + emit one token pair
  const emitLeafVal = (v: unknown): void => {
    const t = typeof v;
    let type: number;
    if (t === 'number') {
      const num = v as number;
      if (Number.isInteger(num) && num < 1e9 && num > -1e9) {
        // arithmetic digit count — no scan, no alloc
        let a = num < 0 ? -num : num;
        let d = 1;
        while (a >= 10) {
          a = (a / 10) | 0;
          d++;
        }
        pos += d + (num < 0 ? 1 : 0);
      } else {
        let jN = pos;
        while (jN < plen) {
          const cN = pretty.charCodeAt(jN);
          if (cN === 44 || cN === 10 || cN === 125 || cN === 93) break;
          jN++;
        }
        pos = jN;
      }
      type = T_NUM;
    } else if (t === 'string') {
      pos += escLen(v as string) + 2;
      type = T_STR;
    } else if (t === 'boolean') {
      pos += v ? 4 : 5;
      type = v ? T_TRUE : T_FALSE;
    } else {
      pos += 4;
      type = T_NULL;
    }
    pushTok(pos, type);
  };

  // frame pool
  const framePool: Frame[] = [];
  let frameTop = 0;
  const getFrame = (): Frame => {
    const f = framePool[frameTop];
    if (f !== undefined) {
      frameTop++;
      return f;
    }
    const nf: Frame = { obj: null, isArr: false, keysList: null, len: 0, idx: 0, childDepth: 0, rowId: -1, first: true };
    framePool.push(nf);
    frameTop++;
    return nf;
  };

  const openContainer = (v: unknown, keyTok: number, depth: number): boolean => {
    const isArr = Array.isArray(v);
    if (rowCount + 1 > rcap) {
      rk = growI32(rk);
      rcap = rk.length / STRIDE;
    }
    let p = rowCount * STRIDE;
    rk[p] = depth;
    rk[p + 1] = isArr ? 2 : 1;
    rk[p + 2] = keyTok;
    rk[p + 3] = -1;
    rk[p + 4] = 0; // meta
    rk[p + 5] = -1; // subtree pending (branches) — leaves set below
    const row = rowCount++;
    pos += 1;
    const f = getFrame();
    f.isArr = isArr;
    f.obj = v as Record<string, unknown>;
    f.keysList = isArr ? null : Object.keys(v as Record<string, unknown>);
    f.len = isArr ? (v as unknown[]).length : f.keysList!.length;
    f.idx = 0;
    f.childDepth = depth + 1;
    f.rowId = row;
    f.first = true;
    if (f.len === 0) {
      pos += 1;
      rk[row * STRIDE + 5] = rowCount - row;
      frameTop--;
      return false;
    }
    return true;
  };

  let cf: Frame; // current frame register (avoids per-iteration stack peek)




  // ---- root ----
  if (!isBranch(value)) {
    emitLeafVal(value);
    rk[0] = 0;
    rk[1] = 0;
    rk[2] = -1;
    rk[3] = (tlen >> 1) - 1; // valTok
    rowCount = 1; // rk[4]/rk[5] via finish defaults
    {
      const seg = pos - lineStart;
      if (seg > maxLen) maxLen = seg;
    }
    return finish();
  }
  {
    const pushed = openContainer(value, -1, 0);
    if (!pushed) {
      {
      const seg = pos - lineStart;
      if (seg > maxLen) maxLen = seg;
    }
      return finish();
    }
    cf = framePool[frameTop - 1];
    {
      const d = 1;
  {
    const seg = pos - lineStart;
    if (seg > maxLen) maxLen = seg;
  }
  nl++;
  if (llen === lcap) {
    lcap <<= 1;
    const g = new Uint32Array(lcap);
    g.set(ls);
    ls = g;
  }
  // d is always >= 0 here (childDepth-1 >= 0); d*indLen === 0 when d === 0
  pos += 1 + d * indLen;
  ls[llen++] = pos;
  lineStart = pos;
    }
  }

  // ---- iterative walk ----
  while (frameTop > 0) {
    const f = cf;
    if (f.idx >= f.len) {
      {
      const d = f.childDepth - 1;
  {
    const seg = pos - lineStart;
    if (seg > maxLen) maxLen = seg;
  }
  nl++;
  if (llen === lcap) {
    lcap <<= 1;
    const g = new Uint32Array(lcap);
    g.set(ls);
    ls = g;
  }
  // d is always >= 0 here (childDepth-1 >= 0); d*indLen === 0 when d === 0
  pos += 1 + d * indLen;
  ls[llen++] = pos;
  lineStart = pos;
    }
      pos += 1;
      rk[f.rowId * STRIDE + 5] = rowCount - f.rowId;
      frameTop--;
      cf = framePool[frameTop - 1];
      continue;
    }

    if (!f.first) {
      pos += 1;
      {
      const d = f.childDepth;
  {
    const seg = pos - lineStart;
    if (seg > maxLen) maxLen = seg;
  }
  nl++;
  if (llen === lcap) {
    lcap <<= 1;
    const g = new Uint32Array(lcap);
    g.set(ls);
    ls = g;
  }
  // d is always >= 0 here (childDepth-1 >= 0); d*indLen === 0 when d === 0
  pos += 1 + d * indLen;
  ls[llen++] = pos;
  lineStart = pos;
    }
    }
    f.first = false;

    let child: unknown;
    let keyTok = -1;
    if (f.isArr) {
      child = (f.obj as unknown[])[f.idx];
    } else {
      const k = (f.keysList as string[])[f.idx];
      child = (f.obj as Record<string, unknown>)[k];
      pos += escLen(k) + 2;
      pushTok(pos, T_KEY);
      keyTok = (tlen >> 1) - 1;
      pos += 2; // ': '
    }
    f.idx++;
    rk[f.rowId * STRIDE + 4]++; // meta: child count

    if (isBranch(child)) {
      if (openContainer(child, keyTok, f.childDepth)) {
        cf = framePool[frameTop - 1];
        {
      const d = f.childDepth + 1;
  {
    const seg = pos - lineStart;
    if (seg > maxLen) maxLen = seg;
  }
  nl++;
  if (llen === lcap) {
    lcap <<= 1;
    const g = new Uint32Array(lcap);
    g.set(ls);
    ls = g;
  }
  // d is always >= 0 here (childDepth-1 >= 0); d*indLen === 0 when d === 0
  pos += 1 + d * indLen;
  ls[llen++] = pos;
  lineStart = pos;
    }
      }
    } else {
      emitLeafVal(child);
      if (rowCount + 1 > rcap) {
        rk = growI32(rk);
        rcap = rk.length / STRIDE;
      }
      const p = rowCount * STRIDE;
      rk[p] = f.childDepth;
      rk[p + 1] = 0;
      rk[p + 2] = keyTok;
      rk[p + 3] = (tlen >> 1) - 1; // valTok; meta/subtree via finish defaults
      rowCount++;
    }
  }

  {
    const seg = pos - lineStart;
    if (seg > maxLen) maxLen = seg;
  }
  return finish();

  function finish(): EmitResult {
    const n = rowCount;
    const depthU = new Uint16Array(n);
    const keyTokIdx = new Int32Array(n);
    const valTokIdx = new Int32Array(n);
    const meta = new Int32Array(n);
    const subtreeRows = new Int32Array(n);
    const kind = new Int32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += STRIDE) {
      depthU[i] = rk[p];
      kind[i] = rk[p + 1];
      keyTokIdx[i] = rk[p + 2];
      valTokIdx[i] = rk[p + 3];
      meta[i] = rk[p + 4]; // leaves: never written → 0
      const st = rk[p + 5];
      subtreeRows[i] = st === -1 ? 1 : st; // leaves: -1 sentinel → 1
    }
    return {
      pretty,
      tokens: tlen === tk.length ? tk : tk.slice(0, tlen),
      lineStarts: llen === ls.length ? ls : ls.slice(0, llen),
      lines: nl + 1,
      maxLen,
      tree: {
        depth: depthU,
        kind,
        keyIdx: new Int32Array(0), // materialized on demand
        valIdx: new Int32Array(0),
        keyTokIdx,
        valTokIdx,
        meta,
        subtreeRows,
        keys: [],
        vals: [],
        rowCount: n,
      },
    };
  }
}

// Materialize keys[]/vals[]/keyIdx[]/valIdx[] by slicing pretty at token spans.
// Implied token start = previous pair end — may include layout whitespace;
// strip it before unquoting keys / storing values.
export function materializeLabels(t: FlatTree, pretty: string, tokens: Int32Array): void {
  if (t.keyIdx.length === t.rowCount) return; // already done
  const n = t.rowCount;
  const keyIdx = new Int32Array(n).fill(-1);
  const valIdx = new Int32Array(n).fill(-1);
  const keyIntern = new Map<string, number>();
  const keys: string[] = [];
  const vals: string[] = [];
  const spanStart = (pairIdx: number): number => (pairIdx > 0 ? tokens[(pairIdx - 1) * 2] : 0);
  const isWs = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
  for (let r = 0; r < n; r++) {
    const kt = t.keyTokIdx[r];
    if (kt >= 0) {
      let ks = pretty.slice(spanStart(kt), tokens[kt * 2]);
      let a = 0;
      while (a < ks.length && isWs(ks.charCodeAt(a))) a++;
      ks = ks.slice(a + 1, -1); // strip ws + quotes
      let id = keyIntern.get(ks);
      if (id === undefined) {
        id = keys.length;
        keys.push(ks);
        keyIntern.set(ks, id);
      }
      keyIdx[r] = id;
    }
    const vt = t.valTokIdx[r];
    if (vt >= 0) {
      let s = pretty.slice(spanStart(vt), tokens[vt * 2]);
      let a = 0;
      while (a < s.length && (isWs(s.charCodeAt(a)) || s.charCodeAt(a) === 58)) a++; // ws + ':'
      s = s.slice(a);
      if (s.length > MAX_PREVIEW) {
        s = s.slice(0, MAX_PREVIEW - 1);
        if (s.endsWith('"')) s = s.slice(0, -1);
        s += '…"';
      }
      vals.push(s);
      valIdx[r] = vals.length - 1;
    }
  }
  t.keys = keys;
  t.vals = vals;
  t.keyIdx = keyIdx;
  t.valIdx = valIdx;
}
