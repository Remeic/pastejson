// Pure render painters. Given state slices -> row HTML strings.
// Called only for the visible window by VScroll.
import type { ViewModel } from './viewmodel';
import { rangeHtml, esc } from './highlight';
import type { FlatTree } from './tree';
import type { ProvisionalViewState } from './worker-state';

export const MIN_CHUNK = 600;
const WINDOW_TOKEN_RE = /"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null/g;

// First-paint bridge only. It receives a prefix line index because phase 1
// intentionally does not pretend to be a complete ViewModel.
export function provisionalTextHtml(
  view: ProvisionalViewState,
  first: number,
  count: number,
): string {
  const P = view.pretty;
  const LS = view.prefixLineStarts;
  const L = view.rows;
  const last = Math.min(first + count, L);
  if (first >= last) return '';
  const windowStart = LS[first];
  const windowEnd = last < L ? LS[last] - 1 : view.lastRowEnd;
  let row = first;
  let body = '';
  let rowStart = LS[first];
  let rowEnd = first + 1 < L ? LS[first + 1] - 1 : view.lastRowEnd;
  let segmentStart = windowStart;
  let h = '';

  // Append one end-only syntax segment directly to its affected rows. The
  // source span can cover several rows because punctuation is omitted from
  // the token table; each row still excludes its newline and keeps its indent.
  WINDOW_TOKEN_RE.lastIndex = windowStart;
  let match: RegExpExecArray | null;
  while ((match = WINDOW_TOKEN_RE.exec(P)) !== null) {
    const tokEnd = WINDOW_TOKEN_RE.lastIndex;
    const c = P.charCodeAt(match.index);
    let tokClass: string;
    if (c === 34) {
      tokClass = P.charCodeAt(tokEnd) === 58 ? 'k' : 's';
    } else if (c === 116 || c === 102 || c === 110) {
      tokClass = c === 110 ? 'x' : 'b';
    } else {
      tokClass = 'n';
    }

    let appendStart = segmentStart;
    const appendEnd = tokEnd < windowEnd ? tokEnd : windowEnd;
    while (appendStart < appendEnd && row < last) {
      const s = appendStart < rowStart ? rowStart : appendStart;
      const e = appendEnd < rowEnd ? appendEnd : rowEnd;
      if (e > s) body += '<i class=' + tokClass + '>' + esc(P.slice(s, e)) + '</i>';
      if (appendEnd <= rowEnd) break;
      h += `<div class="row"><span class="ln">${row + 1}</span><code>${body}</code></div>`;
      body = '';
      row++;
      appendStart = rowEnd;
      rowStart = row < last ? LS[row] : P.length;
      rowEnd = row + 1 < L ? LS[row + 1] - 1 : view.lastRowEnd;
    }
    segmentStart = tokEnd;
    if (tokEnd >= windowEnd) break;
  }

  let appendStart = segmentStart;
  const appendEnd = windowEnd;
  while (appendStart < appendEnd && row < last) {
    const s = appendStart < rowStart ? rowStart : appendStart;
    const e = appendEnd < rowEnd ? appendEnd : rowEnd;
    if (e > s) body += esc(P.slice(s, e));
    if (appendEnd <= rowEnd) break;
    h += `<div class="row"><span class="ln">${row + 1}</span><code>${body}</code></div>`;
    body = '';
    row++;
    appendStart = rowEnd;
    rowStart = row < last ? LS[row] : P.length;
    rowEnd = row + 1 < L ? LS[row + 1] - 1 : view.lastRowEnd;
  }
  if (row < last) h += `<div class="row"><span class="ln">${row + 1}</span><code>${body}</code></div>`;
  return h;
}

// Hydrated painter. Its token table is built once by the fused walk and then
// reused by Text and Find for every window.
export function textHtml(vm: ViewModel, first: number, count: number): string {
  const P = vm.pretty;
  const LS = vm.lineStarts;
  const TOK = vm.tokP;
  const L = vm.lines;
  const last = Math.min(first + count, L);
  let h = '';
  for (let i = first; i < last; i++) {
    const s = LS[i];
    const e = i + 1 < L ? LS[i + 1] - 1 : P.length;
    h += `<div class="row"><span class="ln">${i + 1}</span><code>${rangeHtml(P, TOK, s, e)}</code></div>`;
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
