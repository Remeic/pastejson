// Pure render painters. Given state slices -> row HTML strings.
// Called only for the visible window by VScroll.
import type { ViewModel } from './viewmodel';
import { rangeHtml, esc } from './highlight';
import type { FlatTree } from './tree';

export const MIN_CHUNK = 600;

export function textHtml(vm: ViewModel, first: number, count: number): string {
  const P = vm.pretty;
  const LS = vm.lineStarts;
  const L = vm.lines;
  const last = Math.min(first + count, L);
  let h = '';
  for (let i = first; i < last; i++) {
    const s = LS[i];
    const e = i + 1 < L ? LS[i + 1] - 1 : P.length;
    h += `<div class="row"><span class="ln">${i + 1}</span><code>${rangeHtml(P, vm.tokP, s, e)}</code></div>`;
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
  const rows = minRowCount(vm);
  const last = Math.min(first + count, rows);
  let h = '';
  for (let i = first; i < last; i++) {
    const s = i * MIN_CHUNK;
    const e = Math.min(s + MIN_CHUNK, M.length);
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
  let h = '';
  for (let v = first; v < last; v++) {
    const n = visible[v];
    const kind = ft.kind[n];
    const isBranch = kind !== 0;
    const caret = isBranch
      ? `<button class="car${expanded[n] ? ' open' : ''}" data-n="${n}" aria-expanded="${!!expanded[n]}" aria-label="toggle"></button>`
      : '<span class="carsp"></span>';
    const ki = ft.keyIdx[n];
    const keyPart =
      ki >= 0 ? `<span class="tk">${esc(ft.keys[ki])}</span><i class="p">:</i> ` : '';
    let body: string;
    if (isBranch) {
      body =
        `<i class="p">${kind === 2 ? '[' : '{'}</i>` +
        `<span class="meta">${ft.meta[n]}</span>`;
    } else {
      const val = ft.vals[ft.valIdx[n]];
      body = `<span class="tv ${valCls(val)}">${esc(val)}</span>`;
    }
    h += `<div class="trow" data-n="${n}" style="padding-left:${8 + ft.depth[n] * 14}px">${caret}${keyPart}${body}</div>`;
  }
  return h;
}

export function humanBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
