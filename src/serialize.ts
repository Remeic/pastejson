// Fused JSON view-model builder — v6 (closure-free hot path).
// Text from NATIVE JSON.stringify; zero-string length walk emits the line
// index. TREE and Text tokens are lazy: flatten() rebuilds the tree on demand
// and the Text painter tokenizes only its visible window.
//
// Measured invariants (see AGENTS.md "The floor" + bench):
// - stringify (native) + parse (native) are the floor; the JS walk is the
//   only optimizable slice.
// - Captured-scope writes cost ~40% over true locals on JSC (agent bench,
//   5.4 vs 3.9 ns/token): pos stays an uncontextualized local and the
//   per-child path is FULLY INLINED — no closure calls per token/line.
// - escLen regex fast path beats charCode loops on JSC (agent bench);
//   scanString-over-pretty measured slower — do not reintroduce.
export interface EmitResult {
  pretty: string;
  lineStarts: Uint32Array;
  lines: number;
  maxLen: number;
}

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
}

export function emitJson(
  value: unknown,
  indent: number | '\t',
  _rawLenHint: number,
): EmitResult {
  const pretty = JSON.stringify(value, null, indent) ?? 'null';
  const indLen = typeof indent === 'number' ? indent : 1;
  const plen = pretty.length;

  // ---- hot registers (true locals — never captured by closures) ----
  let pos = 0;

  // line index
  // lines: each line except the last is >=2 chars (content + '\n') —
  // capacity proven, no growth; llen IS the line count
  let llen = 0;
  const ls = new Uint32Array((plen >> 1) + 16);
  ls[llen++] = 0;
  let lineStart = 0;
  let maxLen = 0;

  // frame pool — pooled objects, zero alloc per push after warmup
  const framePool: Frame[] = [];
  let frameTop = 0;

  let cf: Frame | undefined; // current frame register

  // ---- root ----
  if (value === null || typeof value !== 'object') {
    // inline emitLeafVal
    {
      const t = typeof value;
      if (t === 'number') {
        const num = value as number;
        if (Number.isInteger(num) && num < 1e9 && num > -1e9) {
          // Balanced comparisons avoid the JSC integer-division loop.
          const a = num < 0 ? -num : num;
          let d: number;
          if (a < 10) {
            d = 1;
          } else if (a < 100) {
            d = 2;
          } else if (a < 10000) {
            d = a < 1000 ? 3 : 4;
          } else if (a < 1000000) {
            d = a < 100000 ? 5 : 6;
          } else {
            d = a < 10000000 ? 7 : a < 100000000 ? 8 : 9;
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
      } else if (t === 'string') {
        pos += escLen(value as string) + 2;
      } else if (t === 'boolean') {
        pos += value ? 4 : 5;
      } else {
        pos += 4;
      }
    }
    {
      const seg = pos - lineStart;
      if (seg > maxLen) maxLen = seg;
    }
    return finish();
  }

  // inline openContainer(root, depth 0)
  {
    const isArr = Array.isArray(value);
    pos += 1;
    let f = framePool[frameTop];
    if (f === undefined) {
      f = { obj: null, isArr: false, keysList: null, len: 0, idx: 0, childDepth: 0 };
      framePool.push(f);
    }
    frameTop++;
    f.isArr = isArr;
    f.obj = value as Record<string, unknown>;
    f.keysList = isArr ? null : Object.keys(value as Record<string, unknown>);
    f.len = isArr ? (value as unknown[]).length : f.keysList!.length;
    f.idx = 0;
    f.childDepth = 1;
    if (f.len === 0) {
      pos += 1;
      frameTop--;
      {
        const seg = pos - lineStart;
        if (seg > maxLen) maxLen = seg;
      }
      return finish();
    }
    cf = f;
  }
  {
    const d = 1;
    {
      const seg = pos - lineStart;
      if (seg > maxLen) maxLen = seg;
    }
    pos += 1; // the '\n'
    ls[llen++] = pos;
    lineStart = pos;
    if (d > 0) pos += d * indLen; // indent AFTER line-start record
  }

  // ---- iterative walk (closure-free per-child path) ----
  while (frameTop > 0) {
    const f = cf!;
    if (f.idx >= f.len) {
      {
        const d = f.childDepth - 1;
        {
          const seg = pos - lineStart;
          if (seg > maxLen) maxLen = seg;
        }
        pos += 1; // the '\n'
        ls[llen++] = pos;
        lineStart = pos;
        if (d > 0) pos += d * indLen; // indent AFTER line-start record
      }
      pos += 1;
      frameTop--;
      cf = framePool[frameTop - 1];
      continue;
    }

    if (f.idx > 0) {
      // comma precedes every child except the first (idx is pre-increment)
      pos += 1;
      {
        const d = f.childDepth;
        {
          const seg = pos - lineStart;
          if (seg > maxLen) maxLen = seg;
        }
        pos += 1; // the '\n'
        ls[llen++] = pos;
        lineStart = pos;
        if (d > 0) pos += d * indLen; // indent AFTER line-start record
      }
    }

    let child: unknown;
    if (f.isArr) {
      child = (f.obj as unknown[])[f.idx];
    } else {
      const k = (f.keysList as string[])[f.idx];
      child = (f.obj as Record<string, unknown>)[k];
      pos += escLen(k) + 2; // quoted key
      pos += 2; // '": '
    }
    f.idx++;

    if (child !== null && typeof child === 'object') {
      // inline openContainer(child, f.childDepth)
      const isArr = Array.isArray(child);
      pos += 1;
      let nf = framePool[frameTop];
      if (nf === undefined) {
        nf = { obj: null, isArr: false, keysList: null, len: 0, idx: 0, childDepth: 0 };
        framePool.push(nf);
      }
      frameTop++;
      nf.isArr = isArr;
      nf.obj = child as Record<string, unknown>;
      nf.keysList = isArr ? null : Object.keys(child as Record<string, unknown>);
      nf.len = isArr ? (child as unknown[]).length : nf.keysList!.length;
      nf.idx = 0;
      nf.childDepth = f.childDepth + 1;
      if (nf.len === 0) {
        pos += 1;
        frameTop--;
      } else {
        cf = nf;
        {
          const d = f.childDepth + 1;
          {
            const seg = pos - lineStart;
            if (seg > maxLen) maxLen = seg;
          }
          pos += 1; // the '\n'
          ls[llen++] = pos;
          lineStart = pos;
          if (d > 0) pos += d * indLen; // indent AFTER line-start record
        }
        continue;
      }
    } else {
      // inline emitLeafVal
      const t = typeof child;
      if (t === 'number') {
        const num = child as number;
        if (Number.isInteger(num) && num < 1e9 && num > -1e9) {
          // Balanced comparisons avoid the JSC integer-division loop.
          const a = num < 0 ? -num : num;
          let d: number;
          if (a < 10) {
            d = 1;
          } else if (a < 100) {
            d = 2;
          } else if (a < 10000) {
            d = a < 1000 ? 3 : 4;
          } else if (a < 1000000) {
            d = a < 100000 ? 5 : 6;
          } else {
            d = a < 10000000 ? 7 : a < 100000000 ? 8 : 9;
          }
          pos += d + (num < 0 ? 1 : 0);
        } else {
          if (f.isArr) {
            // Native newline search wins for arrays; mixed object values regress.
            const lineEnd = pretty.indexOf('\n', pos);
            pos = lineEnd < 0
              ? plen
              : lineEnd - (pretty.charCodeAt(lineEnd - 1) === 44 ? 1 : 0);
          } else {
            let jN = pos;
            while (jN < plen) {
              const cN = pretty.charCodeAt(jN);
              if (cN === 44 || cN === 10 || cN === 125 || cN === 93) break;
              jN++;
            }
            pos = jN;
          }
        }
      } else if (t === 'string') {
        if (f.isArr) {
          // JSON.stringify escapes embedded newlines, so the next raw newline
          // is the end of this array element. Native search beats escLen on JSC.
          const lineEnd = pretty.indexOf('\n', pos);
          pos = lineEnd < 0
            ? plen
            : lineEnd - (pretty.charCodeAt(lineEnd - 1) === 44 ? 1 : 0);
        } else {
          pos += escLen(child as string) + 2;
        }
      } else if (t === 'boolean') {
        pos += child ? 4 : 5;
      } else {
        pos += 4;
      }
    }
  }

  {
    const seg = pos - lineStart;
    if (seg > maxLen) maxLen = seg;
  }
  return finish();

  function finish(): EmitResult {
    return {
      pretty,
      lineStarts: ls.subarray(0, llen),
      lines: llen,
      maxLen,
    };
  }
}
