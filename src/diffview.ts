// Diff VIEW island — dynamically imported on first Diff click.
// Pure painters only (same contract as render.ts): state in, row HTML out.
// Orchestration lives in main.ts; the diff core lives in diffcore.ts.

import { esc } from './highlight';
import { valCls } from './render';
import { OP_ADD, OP_DEL, OP_MOD, type AlignedResult, type DiffResult } from './diffcore';

export { diffJson, diffAligned } from './diffcore';
export type { DiffResult, AlignedResult } from './diffcore';

export function diffSummary(d: DiffResult): string {
  if (d.rowCount === 0) return 'documents identical';
  const loc = (n: number): string => n.toLocaleString('en-US');
  return `+${loc(d.adds)}  −${loc(d.dels)}  ·  ${loc(d.rowCount)} rows`;
}

export function diffHtml(d: DiffResult, first: number, count: number): string {
  const last = Math.min(first + count, d.rowCount);
  let h = '';
  for (let r = first; r < last; r++) {
    const op = d.op[r];
    const cls = op === OP_ADD ? 'd-add' : op === OP_DEL ? 'd-del' : '';
    const gut = op === OP_ADD ? '+' : op === OP_DEL ? '−' : '·';
    let body = '';
    const ki = d.keyIdx[r];
    if (ki >= 0) body += `<span class="tk">${esc(d.keys[ki])}</span><i class="p">:</i> `;
    const kind = d.kind[r];
    if (kind !== 0) {
      body += `<i class="p">${kind === 2 ? '[' : '{'}</i><span class="meta">${d.meta[r]}</span>`;
    } else {
      const val = d.vals[d.valIdx[r]];
      body += `<span class="${valCls(val)}">${esc(val)}</span>`;
    }
    h += `<div class="row drow ${cls}" style="padding-left:${8 + d.depth[r] * 14}px"><span class="dg">${gut}</span><code>${body}</code></div>`;
  }
  return h;
}

// one cell of a side-by-side pair (row<0 → empty spacer keeps the gutter grid)
function sbsCell(
  kind: Uint8Array,
  depth: Uint16Array,
  key: Int32Array,
  val: Int32Array,
  meta: Int32Array,
  keys: string[],
  vals: string[],
  row: number,
  gut: string,
): string {
  if (row < 0) return `<span class="dg"></span>`;
  let body = '';
  const ki = key[row];
  if (ki >= 0) body += `<span class="tk">${esc(keys[ki])}</span><i class="p">:</i> `;
  const k = kind[row];
  if (k !== 0) {
    body += `<i class="p">${k === 2 ? '[' : '{'}</i><span class="meta">${meta[row]}</span>`;
  } else {
    const v = vals[val[row]];
    body += `<span class="${valCls(v)}">${esc(v)}</span>`;
  }
  return `<span class="dg">${gut}</span><code style="padding-left:${depth[row] * 12}px">${body}</code>`;
}

export function sbsHtml(d: AlignedResult, first: number, count: number): string {
  const last = Math.min(first + count, d.rowCount);
  let h = '';
  for (let r = first; r < last; r++) {
    const op = d.op[r];
    const cls =
      op === OP_ADD
        ? ' d-add'
        : op === OP_DEL
          ? ' d-del'
          : op === OP_MOD
            ? ' d-mod'
            : '';
    const gl = op === OP_DEL || op === OP_MOD ? '−' : '·';
    const gr = op === OP_ADD || op === OP_MOD ? '+' : '·';
    h +=
      `<div class="row sb${cls}">` +
      `<div class="sc sl">${sbsCell(d.lKind, d.lDepth, d.lKey, d.lVal, d.lMeta, d.lKeys, d.lVals, d.lRow[r], gl)}</div>` +
      `<div class="sc sr">${sbsCell(d.rKind, d.rDepth, d.rKey, d.rVal, d.rMeta, d.rKeys, d.rVals, d.rRow[r], gr)}</div>` +
      `</div>`;
  }
  return h;
}
