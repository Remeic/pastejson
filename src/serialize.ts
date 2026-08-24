// Fused JSON view-model builder — v3.
// Text comes from NATIVE JSON.stringify (unbeatable C++).
// A parallel ZERO-STRING walk over the value computes exact layout lengths,
// emitting: token table + line index + tree structure columns — all Int32.
// Labels (keys/vals) are lazy: rows store token indices; materializeLabels()
// slices pretty on first Tree open (off the paste hot path).
// Fuzz-verified: emitted token spans === tokenize(JSON.stringify(...)).
import {
  T_BOUND,
  T_FALSE,
  T_KEY,
  T_NULL,
  T_NUM,
  T_PUNCT,
  T_STR,
  T_TRUE,
} from './tokenizer';
import type { FlatTree } from './tree';
import { GrowInt32 } from './tree';

export interface EmitResult {
  pretty: string;
  tokens: Int32Array;
  lineStarts: Uint32Array;
  lines: number;
  maxLen: number;
  tree: FlatTree;
}

const MAX_PREVIEW = 120;

// escaped length of s as JSON.stringify would emit it (with quotes excluded)
function escLen(s: string): number {
  const n = s.length;
  let extra = 0;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 34 || c === 92) extra++; // \" \\
    else if (c < 32) {
      if (c === 8 || c === 9 || c === 10 || c === 12 || c === 13) extra++; // \b \t \n \f \r
      else extra += 5; // \u00XX
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const isHigh = c <= 0xdbff;
      const next = i + 1 < n ? s.charCodeAt(i + 1) : 0;
      if (isHigh && next >= 0xdc00 && next <= 0xdfff) {
        i++; // valid pair: emitted raw
      } else {
        extra += 5; // lone surrogate → \uXXXX
      }
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

  let pos = 0;

  // ---- tokens ----
  let tcap = rawLenHint / 2 > 4096 ? (rawLenHint / 2) | 0 : 4096;  // incl. boundary pairs
  let tlen = 0;
  let tok = new Int32Array(tcap);
  let lastTokEnd = 0;
  const pushTok = (end: number, type: number): void => {
    if (tlen + 2 > tcap) {
      tcap <<= 1;
      const g = new Int32Array(tcap);
      g.set(tok);
      tok = g;
    }
    tok[tlen++] = end;
    tok[tlen++] = type;
    lastTokEnd = end;
  };
  const boundary = (): void => {
    if (pos > lastTokEnd) pushTok(pos, T_BOUND);
  };

  // ---- line index (fused) ----
  let lcap = rawLenHint / 9 > 1024 ? (rawLenHint / 9) | 0 : 1024;
  let llen = 0;
  let ls = new Uint32Array(lcap);
  ls[llen++] = 0;
  let nl = 0;
  let lineStart = 0;
  let maxLen = 0;

  // ---- tree structure columns ----
  const cap = rawLenHint / 11 > 1024 ? (rawLenHint / 11) | 0 : 1024;
  const depthA = new GrowInt32(cap);
  const kindA = new GrowInt32(cap);
  const keyTokA = new GrowInt32(cap);
  const valTokA = new GrowInt32(cap);
  const metaA = new GrowInt32(cap);
  const subtreeA = new GrowInt32(cap);
  let rowCount = 0;

  const isBranch = (v: unknown): boolean => v !== null && typeof v === 'object';

  const emitRow = (v: unknown, keyTok: number, depth: number, valTok: number): number => {
    const row = rowCount++;
    depthA.push(depth);
    kindA.push(isBranch(v) ? (Array.isArray(v) ? 2 : 1) : 0);
    keyTokA.push(keyTok);
    valTokA.push(valTok);
    metaA.push(0);
    subtreeA.push(isBranch(v) ? -1 : 1);
    return row;
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
    const nf: Frame = {
      obj: null,
      isArr: false,
      keysList: null,
      len: 0,
      idx: 0,
      childDepth: 0,
      rowId: -1,
      first: true,
    };
    framePool.push(nf);
    frameTop++;
    return nf;
  };

  // '{' / '[' + frame push. true = non-empty
  const openContainer = (v: unknown, keyTok: number, depth: number): boolean => {
    boundary();
    const row = emitRow(v, keyTok, depth, -1);
    const isArr = Array.isArray(v);
    pos += 1;
    pushTok(pos, T_PUNCT);
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
      pushTok(pos, T_PUNCT);
      subtreeA.arr[row] = rowCount - row;
      frameTop--;
      return false;
    }
    return true;
  };

  const writeScalar = (v: unknown): number => {
    boundary();
    const t = typeof v;
    if (t === 'string') {
      pos += escLen(v as string) + 2;
      pushTok(pos, T_STR);
    } else if (t === 'number') {
      pos += (v as number).toString().length;
      pushTok(pos, T_NUM);
    } else if (t === 'boolean') {
      if (v) {
        pos += 4;
        pushTok(pos, T_TRUE);
      } else {
        pos += 5;
        pushTok(pos, T_FALSE);
      }
    } else {
      pos += 4;
      pushTok(pos, T_NULL);
    }
    return (tlen >> 1) - 1;
  };

  const newlineIndent = (d: number): void => {
    const seg = pos - lineStart;
    if (seg > maxLen) maxLen = seg;
    nl++;
    if (llen === lcap) {
      lcap <<= 1;
      const g = new Uint32Array(lcap);
      g.set(ls);
      ls = g;
    }
    pos += 1 + (d > 0 ? d * indLen : 0);
    ls[llen++] = pos;
    lineStart = pos;
  };

  // ---- root ----
  if (!isBranch(value)) {
    writeScalar(value);
    emitRow(value, -1, 0, (tlen >> 1) - 1);
    const tail = pos - lineStart;
    if (tail > maxLen) maxLen = tail;
    return finish();
  }
  {
    const pushed = openContainer(value, -1, 0);
    if (!pushed) {
      const tail = pos - lineStart;
      if (tail > maxLen) maxLen = tail;
      return finish();
    }
    newlineIndent(1);
  }

  // ---- iterative walk ----
  while (frameTop > 0) {
    const f = framePool[frameTop - 1];
    if (f.idx >= f.len) {
      newlineIndent(f.childDepth - 1);
      boundary();
      pos += 1;
      pushTok(pos, T_PUNCT);
      subtreeA.arr[f.rowId] = rowCount - f.rowId;
      frameTop--;
      continue;
    }

    if (!f.first) {
      pos += 1;
      pushTok(pos, T_PUNCT);
      newlineIndent(f.childDepth);
    }
    f.first = false;

    let child: unknown;
    let keyTok = -1;
    if (f.isArr) {
      child = (f.obj as unknown[])[f.idx];
    } else {
      const k = (f.keysList as string[])[f.idx];
      child = (f.obj as Record<string, unknown>)[k];
      boundary();
      pos += escLen(k) + 2;
      pushTok(pos, T_KEY);
      keyTok = (tlen >> 1) - 1;
      pos += 1; // ':'
      pushTok(pos, T_PUNCT);
      pos += 1; // ' '
    }
    f.idx++;
    metaA.arr[f.rowId]++;

    if (isBranch(child)) {
      if (openContainer(child, keyTok, f.childDepth)) {
        newlineIndent(f.childDepth + 1);
      }
    } else {
      const valTok = writeScalar(child);
      emitRow(child, keyTok, f.childDepth, valTok);
    }
  }

  {
    const tail2 = pos - lineStart;
    if (tail2 > maxLen) maxLen = tail2;
  }
  return finish();

  function finish(): EmitResult {
    const n = rowCount;
    const depthU = new Uint16Array(n);
    for (let i = 0; i < n; i++) depthU[i] = depthA.arr[i];
    return {
      pretty,
      tokens: tlen === tok.length ? tok : tok.slice(0, tlen),
      lineStarts: llen === ls.length ? ls : ls.slice(0, llen),
      lines: nl + 1,
      maxLen,
      tree: {
        depth: depthU,
        kind: kindA.trim(),
        keyIdx: new Int32Array(0), // materialized on demand
        valIdx: new Int32Array(0),
        keyTokIdx: keyTokA.trim(),
        valTokIdx: valTokA.trim(),
        meta: metaA.trim(),
        subtreeRows: subtreeA.trim(),
        keys: [],
        vals: [],
        rowCount: n,
      },
    };
  }
}

// Materialize keys[]/vals[]/keyIdx[]/valIdx[] by slicing pretty at token spans.
// Called once, lazily, on first Tree open (or in worker for getTree).
export function materializeLabels(t: FlatTree, pretty: string, tokens: Int32Array): void {
  if (t.keyIdx.length === t.rowCount) return; // already done
  const n = t.rowCount;
  const keyIdx = new Int32Array(n).fill(-1);
  const valIdx = new Int32Array(n).fill(-1);
  const keyIntern = new Map<string, number>();
  const keys: string[] = [];
  const vals: string[] = [];
  const spanStart = (pairIdx: number): number => (pairIdx > 0 ? tokens[(pairIdx - 1) * 2] : 0);
  for (let r = 0; r < n; r++) {
    const kt = t.keyTokIdx[r];
    if (kt >= 0) {
      const ks = pretty.slice(spanStart(kt), tokens[kt * 2]);
      let id = keyIntern.get(ks);
      if (id === undefined) {
        id = keys.length;
        keys.push(ks.length >= 2 ? ks.slice(1, -1) : ks);
        keyIntern.set(ks, id);
      }
      keyIdx[r] = id;
    }
    const vt = t.valTokIdx[r];
    if (vt >= 0) {
      let s = pretty.slice(spanStart(vt), tokens[vt * 2]);
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
