import { buildView, buildMinTokens, type ViewModel } from './viewmodel';
import { flatten, type FlatTree } from './tree';

// Worker path for big payloads (>256KB).
// - parse+stringify+tokenize(pretty) happen here, buffers transfer back zero-copy
// - parsed value + tree columns cached here; sent only on demand (getTree)
// - minified tokens built lazily (getMinTok) — most sessions never open Minified

let cachedValue: unknown = null;
let cachedVM: ViewModel | null = null;
let cachedTree: FlatTree | null = null;

type InMsg =
  | { type: 'parse'; id: number; raw: string; indent: number | '\t' }
  | { type: 'reformat'; id: number; indent: number | '\t' }
  | { type: 'getTree'; id: number }
  | { type: 'getMinTok'; id: number };

const wself = self as unknown as Worker;

self.onmessage = (e: MessageEvent<InMsg>): void => {
  const m = e.data;
  if (m.type === 'parse') {
    try {
      const t0 = performance.now();
      cachedValue = JSON.parse(m.raw);
      cachedTree = null;
      cachedVM = buildView(cachedValue, m.indent, m.raw.length);
      replyVM(m.id, cachedVM, performance.now() - t0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let offset = -1;
      const mm = /position\s+(\d+)/i.exec(message);
      if (mm) offset = Number(mm[1]);
      wself.postMessage({ id: m.id, ok: false, message, offset });
    }
    return;
  }
  if (m.type === 'reformat' && cachedValue !== null) {
    cachedVM = buildView(cachedValue, m.indent, cachedVM?.bytesIn ?? -1);
    replyVM(m.id, cachedVM, 0);
    return;
  }
  if (m.type === 'getTree' && cachedValue !== null) {
    if (!cachedTree) cachedTree = flatten(cachedValue);
    const t = cachedTree;
    wself.postMessage(
      {
        id: m.id,
        type: 'tree',
        rowCount: t.rowCount,
        depthBuf: t.depth.buffer,
        kindBuf: t.kind.buffer,
        keyIdxBuf: t.keyIdx.buffer,
        valIdxBuf: t.valIdx.buffer,
        metaBuf: t.meta.buffer,
        subtreeRowsBuf: t.subtreeRows.buffer,
        keys: t.keys,
        vals: t.vals,
      },
      [
        t.depth.buffer,
        t.kind.buffer,
        t.keyIdx.buffer,
        t.valIdx.buffer,
        t.meta.buffer,
        t.subtreeRows.buffer,
      ] as unknown as Transferable[],
    );
    return;
  }
  if (m.type === 'getMinTok' && cachedVM !== null) {
    buildMinTokens(cachedVM);
    wself.postMessage(
      { id: m.id, type: 'minTok', tokMBuf: cachedVM.tokM!.buffer },
      [cachedVM.tokM!.buffer] as unknown as Transferable[],
    );
  }
};

function replyVM(id: number, vm: ViewModel, ms: number): void {
  wself.postMessage(
    {
      id,
      ok: true,
      pretty: vm.pretty,
      min: vm.min,
      lines: vm.lines,
      maxLen: vm.maxLen,
      ms,
      lineStartsBuf: vm.lineStarts.buffer,
      tokPBuf: vm.tokP.buffer,
    },
    [vm.lineStarts.buffer, vm.tokP.buffer] as unknown as Transferable[],
  );
}
