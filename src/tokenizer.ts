// Hand-rolled charCode FSM tokenizer — tuned hot path.
// - 128-entry char-class tables: 1 lookup replaces comparison cascades
// - string scan via native indexOf (memchr speed) + backslash-parity check
// Output: Int32Array of PAIRS [endOffset, typeCode].
// Token start = previous pair's endOffset (first token starts at 0).
// Only ever run on JSON that already passed JSON.parse.

export const T_STR = 0;
export const T_NUM = 1;
export const T_TRUE = 2;
export const T_FALSE = 3;
export const T_NULL = 4;
export const T_KEY = 5;
export const T_PUNCT = 6;
export const T_ERR = 7;

// char classes
const C_WS = 1;
const C_QUOTE = 2;
const C_NUMSTART = 3;
const C_PUNCT = 4;
const C_LITERAL = 5;

const CLS = new Uint8Array(128);
CLS[32] = C_WS;
CLS[9] = C_WS;
CLS[10] = C_WS;
CLS[13] = C_WS;
CLS[34] = C_QUOTE;
for (let d = 48; d <= 57; d++) CLS[d] = C_NUMSTART;
CLS[45] = C_NUMSTART; // -
CLS[123] = C_PUNCT;
CLS[125] = C_PUNCT;
CLS[91] = C_PUNCT;
CLS[93] = C_PUNCT;
CLS[58] = C_PUNCT;
CLS[44] = C_PUNCT;
CLS[116] = C_LITERAL; // t
CLS[102] = C_LITERAL; // f
CLS[110] = C_LITERAL; // n

// number continuation chars: digits . e E + -
const NUMCH = new Uint8Array(128);
for (let d = 48; d <= 57; d++) NUMCH[d] = 1;
NUMCH[46] = 1;
NUMCH[101] = 1;
NUMCH[69] = 1;
NUMCH[43] = 1;
NUMCH[45] = 1;

export function tokenize(src: string): Int32Array {
  const n = src.length;
  // seed: ~6 src chars per token on formatted JSON → len/6 pairs = len/3 int32s
  let cap = (n / 3) | 0;
  if (cap < 4096) cap = 4096;
  let len = 0;
  let out = new Int32Array(cap);

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
    const cls = c < 128 ? CLS[c] : 0;

    if (cls === C_WS) {
      i++;
      continue;
    }

    if (cls === C_QUOTE) {
      // fast scan: jump to next quote via native indexOf, verify escape parity
      let j = i + 1;
      let closed = false;
      for (;;) {
        const q = src.indexOf('"', j);
        if (q < 0) break;
        // count backslashes immediately before q
        let bsl = 0;
        let k = q - 1;
        while (k >= 0 && src.charCodeAt(k) === 92) {
          bsl++;
          k--;
        }
        j = q + 1;
        if ((bsl & 1) === 0) {
          closed = true;
          break;
        }
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

    if (cls === C_NUMSTART) {
      let j = i + 1;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d < 128 && NUMCH[d] === 1) {
          j++;
          continue;
        }
        break;
      }
      push(j, T_NUM);
      i = j;
      continue;
    }

    if (cls === C_LITERAL) {
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
      // stray letter: invalid
      push(i + 1, T_ERR);
      i++;
      continue;
    }

    if (cls === C_PUNCT) {
      push(i + 1, T_PUNCT);
      i++;
      continue;
    }

    // invalid char
    push(i + 1, T_ERR);
    i++;
  }

  return len === out.length ? out : out.slice(0, len);
}

