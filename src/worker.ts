import { buildView, buildMinTokens, ensureMin, type ViewModel } from './viewmodel';
import { parseInput } from './parse';
import { flatten, type FlatTree } from './tree';

// Worker path for big payloads (>256KB).
// - parse + fused serialize (pretty/lines) happen here
// - buffers transfer back zero-copy
// - parsed value cached here; tree built on demand via flatten (getTree)

// JSON can contain null, so presence must not use null as the sentinel.
let cachedValue: unknown | undefined;
let cachedVM: ViewModel | null = null;
let cachedDocs = 0;

type InMsg =
  | { type: 'parse'; id: number; raw: string; indent: number | '\t' }
  | { type: 'reformat'; id: number; indent: number | '\t' }
  | { type: 'getTree'; id: number }
  | { type: 'getMin'; id: number };

const wself = self as unknown as Worker;

// One fixed-shape, fixed-key-order literal per message kind → structured clone
// hits the fast monomorphic path. Error replies share a single shape
// (parse-error and unexpected-error differ only in field VALUES).
function replyErr(
  id: number,
  message: string,
  offset: number,
  line = 0,
  col = 0,
  lineText = '',
): void {
  wself.postMessage({ id, ok: false, message, offset, line, col, lineText });
}

function replyVM(id: number, vm: ViewModel, ms: number): void {
  wself.postMessage(
    {
      id,
      ok: true,
      pretty: vm.pretty,
      lines: vm.lines,
      maxLen: vm.maxLen,
      indent: vm.indent,
      ms,
      docs: cachedDocs,
      lsLen: vm.lineStarts.length,
      lineStartsBuf: vm.lineStarts.buffer,
    },
    [vm.lineStarts.buffer] as unknown as Transferable[],
  );
}

function replyTree(id: number, t: FlatTree): void {
  wself.postMessage(
    {
      id,
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
}

self.onmessage = (e: MessageEvent<InMsg>): void => {
  const m = e.data;
  switch (m.type) {
    case 'parse': {
      try {
        const t0 = performance.now();
        const r = parseInput(m.raw);
        if (r.kind === 'error') {
          replyErr(m.id, r.message, r.offset, r.line, r.col, r.lineText);
          return;
        }
        cachedValue = r.value;
        cachedDocs = r.kind === 'jsonl' ? r.docs : 0;
        cachedVM = buildView(cachedValue, m.indent, m.raw.length);
        replyVM(m.id, cachedVM, performance.now() - t0);
      } catch (err) {
        replyErr(m.id, err instanceof Error ? err.message : String(err), -1);
      }
      return;
    }
    case 'reformat': {
      // cachedValue is present together with cachedVM after a successful parse.
      const prev = cachedVM;
      if (cachedValue === undefined || prev === null) return;
      cachedVM = buildView(cachedValue, m.indent, prev.bytesIn);
      replyVM(m.id, cachedVM, 0);
      return;
    }
    case 'getTree': {
      const vm = cachedVM;
      if (vm === null || cachedValue === undefined) return;
      // tree is lazy: flatten on demand (labels built during the walk)
      replyTree(m.id, flatten(cachedValue, vm.lines));
      return;
    }
    case 'getMin': {
      const vm = cachedVM;
      if (vm === null) return;
      const min = ensureMin(vm);
      buildMinTokens(vm); // ensureMin inside is now a cache hit
      const buf = vm.tokM!.buffer;
      vm.tokM = null; // buffer is transferred → detached; null the cache so a
      // re-request re-tokenizes instead of posting a dead buffer (DataCloneError)
      wself.postMessage({ id: m.id, type: 'min', min, tokMBuf: buf }, [
        buf,
      ] as unknown as Transferable[]);
      return;
    }
  }
};
