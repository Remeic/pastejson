// Diff VIEW island — dynamically imported on first Diff click.
// Pure painters only (same contract as render.ts): state in, row HTML out.
// Orchestration lives in main.ts; the diff core lives in diffcore.ts.

import { esc } from './highlight';
import { valCls } from './render';
import { OP_ADD, OP_DEL, type DiffResult } from './diffcore';

export { diffJson } from './diffcore';
export type { DiffResult } from './diffcore';

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
