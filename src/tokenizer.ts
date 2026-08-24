// Hand-rolled charCode FSM tokenizer.
// Single pass over the source. Output: Int32Array of PAIRS [endOffset, typeCode].
// Token start = previous pair's endOffset (first token starts at 0).
// Only ever run on JSON that already passed JSON.parse, so grammar is valid.

export const T_STR = 0;
export const T_NUM = 1;
export const T_TRUE = 2;
export const T_FALSE = 3;
export const T_NULL = 4;
export const T_KEY = 5;
export const T_PUNCT = 6;
export const T_ERR = 7;

export function tokenize(src: string): Int32Array {
  let cap = 4096;
  let len = 0;
  let out = new Int32Array(cap);
  const n = src.length;

  const push = (end: number, type: number): void => {
    if (len + 2 > cap) {
      cap <<= 1;
      const grown = new Int32Array(cap);
      grown.set(out);
      out = grown;
    }
    out[len++] = end;
    out[len++] = type;
  };

  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);

    // whitespace: skip (never emitted)
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i++;
      continue;
    }

    // string or key
    if (c === 34) {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d === 92) {
          j += 2; // escape: swallow next char
          continue;
        }
        if (d === 34) {
          j++;
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        push(n, T_ERR);
        i = n;
        break;
      }
      // key lookahead: next non-ws char is ':' ?
      let k = j;
      while (k < n) {
        const w = src.charCodeAt(k);
        if (w === 32 || w === 9 || w === 10 || w === 13) k++;
        else break;
      }
      push(j, k < n && src.charCodeAt(k) === 58 ? T_KEY : T_STR);
      i = j;
      continue;
    }

    // number
    if (c === 45 || (c >= 48 && c <= 57)) {
      let j = i + 1;
      while (j < n) {
        const d = src.charCodeAt(j);
        if ((d >= 48 && d <= 57) || d === 46 || d === 43 || d === 45 || d === 101 || d === 69) {
          j++;
          continue;
        }
        break;
      }
      push(j, T_NUM);
      i = j;
      continue;
    }

    // true / false / null literals via charCode compare
    if (
      c === 116 &&
      src.charCodeAt(i + 1) === 114 &&
      src.charCodeAt(i + 2) === 117 &&
      src.charCodeAt(i + 3) === 101
    ) {
      push(i + 4, T_TRUE);
      i += 4;
      continue;
    }
    if (
      c === 102 &&
      src.charCodeAt(i + 1) === 97 &&
      src.charCodeAt(i + 2) === 108 &&
      src.charCodeAt(i + 3) === 115 &&
      src.charCodeAt(i + 4) === 101
    ) {
      push(i + 5, T_FALSE);
      i += 5;
      continue;
    }
    if (
      c === 110 &&
      src.charCodeAt(i + 1) === 117 &&
      src.charCodeAt(i + 2) === 108 &&
      src.charCodeAt(i + 3) === 108
    ) {
      push(i + 4, T_NULL);
      i += 4;
      continue;
    }

    // structural punctuation { } [ ] : ,
    if (c === 123 || c === 125 || c === 91 || c === 93 || c === 58 || c === 44) {
      push(i + 1, T_PUNCT);
      i++;
      continue;
    }

    // anything else: invalid single char
    push(i + 1, T_ERR);
    i++;
  }

  return len === out.length ? out : out.slice(0, len);
}
