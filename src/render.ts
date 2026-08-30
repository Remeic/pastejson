// Pure render painters. Given state slices -> row HTML strings.
// Called only for the visible window by VScroll.
import type { ViewModel } from './viewmodel';
import { rangeHtml, esc } from './highlight';
import type { FlatTree } from './tree';

export const MIN_CHUNK = 600;
const TOKEN_CLASSES = ['s', 'n', 'b', 'b', 'x', 'k', 'p', 'e'];
const C_WS = 1;
const C_QUOTE = 2;
const C_NUMSTART = 3;
const C_PUNCT = 4;
const C_LITERAL = 5;
const WINDOW_CLS = new Uint8Array(128);
WINDOW_CLS[32] = C_WS;
WINDOW_CLS[9] = C_WS;
WINDOW_CLS[10] = C_WS;
WINDOW_CLS[13] = C_WS;
WINDOW_CLS[34] = C_QUOTE;
for (let d = 48; d <= 57; d++) WINDOW_CLS[d] = C_NUMSTART;
WINDOW_CLS[45] = C_NUMSTART;
WINDOW_CLS[123] = C_PUNCT;
WINDOW_CLS[125] = C_PUNCT;
WINDOW_CLS[91] = C_PUNCT;
WINDOW_CLS[93] = C_PUNCT;
WINDOW_CLS[58] = C_PUNCT;
WINDOW_CLS[44] = C_PUNCT;
WINDOW_CLS[116] = C_LITERAL;
WINDOW_CLS[102] = C_LITERAL;
WINDOW_CLS[110] = C_LITERAL;
const WINDOW_NUMCH = new Uint8Array(128);
for (let d = 48; d <= 57; d++) WINDOW_NUMCH[d] = 1;
WINDOW_NUMCH[46] = 1;
WINDOW_NUMCH[101] = 1;
WINDOW_NUMCH[69] = 1;
WINDOW_NUMCH[43] = 1;
WINDOW_NUMCH[45] = 1;

export function textHtml(vm: ViewModel, first: number, count: number): string {
  const P = vm.pretty;
  const LS = vm.lineStarts;
  const L = vm.lines;
  const last = Math.min(first + count, L);
  if (first >= last) return '';
  const windowStart = LS[first];
  const windowEnd = last < L ? LS[last] - 1 : P.length;
  const bodies = new Array<string>(last - first);
  let row = 0;
  let body = '';
  let rowStart = LS[first];
  let rowEnd = first + 1 < L ? LS[first + 1] - 1 : P.length;
  let segmentStart = windowStart;

  // Append one end-only syntax segment directly to its affected rows. The
  // source span can cover several rows because punctuation is omitted from
  // the token table; each row still excludes its newline and keeps its indent.
  let i = windowStart;
  let done = false;
  while (i < P.length && !done) {
    const c = P.charCodeAt(i);
    const cls = c < 128 ? WINDOW_CLS[c] : 0;
    let tokEnd = -1;
    let tokType = -1;

    if (cls === C_WS) {
      i++;
      continue;
    }
    if (cls === C_QUOTE) {
      let j = i + 1;
      let closed = false;
      for (;;) {
        const q = P.indexOf('"', j);
        if (q < 0) break;
        let bsl = 0;
        let k = q - 1;
        while (k >= 0 && P.charCodeAt(k) === 92) {
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
        tokEnd = P.length;
        tokType = 7;
        i = P.length;
      } else {
        let k = j;
        while (k < P.length) {
          const w = P.charCodeAt(k);
          if (w === 32 || w === 9 || w === 10 || w === 13) k++;
          else break;
        }
        tokEnd = j;
        tokType = k < P.length && P.charCodeAt(k) === 58 ? 5 : 0;
        i = j;
      }
    } else if (cls === C_NUMSTART) {
      let j = i + 1;
      while (j < P.length) {
        const d = P.charCodeAt(j);
        if (d < 128 && WINDOW_NUMCH[d] === 1) j++;
        else break;
      }
      tokEnd = j;
      tokType = 1;
      i = j;
    } else if (cls === C_LITERAL) {
      if (c === 116 && P.charCodeAt(i + 1) === 114 && P.charCodeAt(i + 2) === 117 && P.charCodeAt(i + 3) === 101) {
        tokEnd = i + 4;
        tokType = 2;
        i += 4;
      } else if (c === 102 && P.charCodeAt(i + 1) === 97 && P.charCodeAt(i + 2) === 108 && P.charCodeAt(i + 3) === 115 && P.charCodeAt(i + 4) === 101) {
        tokEnd = i + 5;
        tokType = 3;
        i += 5;
      } else if (c === 110 && P.charCodeAt(i + 1) === 117 && P.charCodeAt(i + 2) === 108 && P.charCodeAt(i + 3) === 108) {
        tokEnd = i + 4;
        tokType = 4;
        i += 4;
      } else {
        tokEnd = i + 1;
        tokType = 7;
        i++;
      }
    } else if (cls === C_PUNCT) {
      i++;
      continue;
    } else {
      tokEnd = i + 1;
      tokType = 7;
      i++;
    }

    let appendStart = segmentStart;
    const appendEnd = Math.min(tokEnd, windowEnd);
    while (appendStart < appendEnd && row < bodies.length) {
      const s = appendStart < rowStart ? rowStart : appendStart;
      const e = appendEnd < rowEnd ? appendEnd : rowEnd;
      if (e > s) body += '<i class=' + TOKEN_CLASSES[tokType] + '>' + esc(P.slice(s, e)) + '</i>';
      if (appendEnd <= rowEnd) break;
      bodies[row] = body;
      body = '';
      row++;
      appendStart = rowEnd;
      rowStart = row < bodies.length ? LS[first + row] : P.length;
      rowEnd = first + row + 1 < L ? LS[first + row + 1] - 1 : P.length;
    }
    segmentStart = tokEnd;
    if (i >= windowEnd) done = true;
  }

  let appendStart = segmentStart;
  const appendEnd = windowEnd;
  while (appendStart < appendEnd && row < bodies.length) {
    const s = appendStart < rowStart ? rowStart : appendStart;
    const e = appendEnd < rowEnd ? appendEnd : rowEnd;
    if (e > s) body += esc(P.slice(s, e));
    if (appendEnd <= rowEnd) break;
    bodies[row] = body;
    body = '';
    row++;
    appendStart = rowEnd;
    rowStart = row < bodies.length ? LS[first + row] : P.length;
    rowEnd = first + row + 1 < L ? LS[first + row + 1] - 1 : P.length;
  }
  if (row < bodies.length) bodies[row] = body;

  let h = '';
  for (let i = first; i < last; i++) {
    h += `<div class="row"><span class="ln">${i + 1}</span><code>${bodies[i - first]}</code></div>`;
  }
  return h;
}

export function minRowCount(vm: ViewModel): number {
  if (vm.min === null) return 0;
  return Math.max(1, Math.ceil(vm.min.length / MIN_CHUNK));
}

export function minHtml(vm: ViewModel, first: number, count: number): string {
  const M = vm.min;
  if (M === null) return '';
  const tok = vm.tokM;
  const len = M.length;
  const rows = Math.max(1, Math.ceil(len / MIN_CHUNK));
  const last = Math.min(first + count, rows);
  let h = '';
  for (let i = first; i < last; i++) {
    const s = i * MIN_CHUNK;
    const e = Math.min(s + MIN_CHUNK, len);
    const body = tok ? rangeHtml(M, tok, s, e) : esc(M.slice(s, e));
    h += `<div class="row"><span class="ln">${i + 1}</span><code>${body}</code></div>`;
  }
  return h;
}

export function valCls(v: string): string {
  const c = v.charCodeAt(0);
  if (c === 34) return 's'; // "
  if ((c >= 48 && c <= 57) || c === 45) return 'n';
  if (c === 116 || c === 102) return 'b'; // t f
  return 'x'; // null
}

export function treeHtml(
  ft: FlatTree,
  expanded: Uint8Array,
  visible: Int32Array,
  first: number,
  count: number,
): string {
  const last = Math.min(first + count, visible.length);
  // hoist column arrays out of the hot loop
  const KIND = ft.kind;
  const DEPTH = ft.depth;
  const KEYIDX = ft.keyIdx;
  const META = ft.meta;
  const VALIDX = ft.valIdx;
  const KEYS = ft.keys;
  const VALS = ft.vals;
  let h = '';
  for (let v = first; v < last; v++) {
    const n = visible[v];
    const exp = expanded[n];
    const kind = KIND[n];
    const isBranch = kind !== 0;
    const caret = isBranch
      ? `<button class="car${exp ? ' open' : ''}" data-n="${n}" aria-expanded="${exp ? 'true' : 'false'}" aria-label="toggle"></button>`
      : '<span class="carsp"></span>';
    const ki = KEYIDX[n];
    const keyPart =
      ki >= 0 ? `<span class="tk">${esc(KEYS[ki])}</span><i class="p">:</i> ` : '';
    let body: string;
    if (isBranch) {
      body =
        `<i class="p">${kind === 2 ? '[' : '{'}</i>` +
        `<span class="meta">${META[n]}</span>`;
    } else {
      const val = VALS[VALIDX[n]];
      body = `<span class="${valCls(val)}">${esc(val)}</span>`;
    }
    h += `<div class="trow" data-n="${n}" style="padding-left:${8 + DEPTH[n] * 14}px">${caret}${keyPart}${body}</div>`;
  }
  return h;
}

export function humanBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
