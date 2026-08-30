import { buildViewFromPretty, buildMinTokens, ensureMin, type ViewModel } from './viewmodel';
import { parseInput } from './parse';
import { flatten, type FlatTree } from './tree';
import {
  makePhase1Reply,
  makePhase2Reply,
  type FormatRequest,
  type Indent,
} from './worker-protocol';

// Worker path for big payloads (>256KB).
// - native parse + native stringify produce the exact phase-1 source
// - phase 2 walks the parsed value once to build indexes and token pairs
// - buffers transfer back zero-copy
// - the parsed value stays here for lazy Tree/Min work

interface CachedDoc {
  value: unknown;
  pretty: string;
  indent: Indent;
  bytesIn: number;
  docs: number;
  id: number;
  epoch: number;
  vm: ViewModel | null;
}

type InMsg =
  | FormatRequest
  | { type: 'getTree'; id: number; epoch: number }
  | { type: 'getMin'; id: number; epoch: number };

type ErrorReply = {
  id: number;
  epoch: number;
  ok: false;
  message: string;
  offset: number;
  line: number;
  col: number;
  lineText: string;
};

const wself = self as unknown as Worker;
let cachedDoc: CachedDoc | null = null;

// Replacing the cached document invalidates a queued phase-2 callback. The
// identity check below is the worker-side half of stale request handling.
function invalidateCachedDoc(): void {
  cachedDoc = null;
}

// One fixed-shape, fixed-key-order literal per message kind -> structured
// clone hits the fast monomorphic path. Error replies share one shape.
function replyErr(
  id: number,
  epoch: number,
  message: string,
  offset: number,
  line = 0,
  col = 0,
  lineText = '',
): void {
  const reply: ErrorReply = { id, epoch, ok: false, message, offset, line, col, lineText };
  wself.postMessage(reply);
}

function replyPhase1(doc: CachedDoc, ms: number): void {
  wself.postMessage(
    makePhase1Reply({
      id: doc.id,
      epoch: doc.epoch,
      pretty: doc.pretty,
      indent: doc.indent,
      bytesIn: doc.bytesIn,
      docs: doc.docs,
      ms,
    }),
  );
}

function replyPhase2(doc: CachedDoc, vm: ViewModel): void {
  const lineStartsBuf = vm.lineStarts.buffer as ArrayBuffer;
  const tokPBuf = vm.tokP.buffer as ArrayBuffer;
  wself.postMessage(
    makePhase2Reply({
      id: doc.id,
      epoch: doc.epoch,
      lines: vm.lines,
      maxLen: vm.maxLen,
      indent: vm.indent,
      bytesIn: vm.bytesIn,
      docs: vm.docs,
      lsLen: vm.lineStarts.length,
      lineStartsBuf,
      tokPLen: vm.tokP.length,
      tokPBuf,
    }),
    [lineStartsBuf, tokPBuf] as unknown as Transferable[],
  );
}

function replyTree(id: number, epoch: number, t: FlatTree): void {
  wself.postMessage(
    {
      id,
      epoch,
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

function formatDoc(
  value: unknown,
  id: number,
  epoch: number,
  indent: Indent,
  bytesIn: number,
  docs: number,
  ms: number,
): void {
  // This is the only stringify on the parse/reformat path. Phase 2 receives
  // and walks this exact string; it does not rebuild it.
  const pretty = JSON.stringify(value, null, indent) ?? 'null';
  const doc: CachedDoc = {
    value,
    pretty,
    indent,
    bytesIn,
    docs,
    id,
    epoch,
    vm: null,
  };
  cachedDoc = doc;
  replyPhase1(doc, ms);

  // Yield so the main thread can paint phase 1 before the value walk starts.
  setTimeout(() => {
    if (cachedDoc !== doc) return;
    const vm = buildViewFromPretty(doc.value, doc.pretty, doc.indent, doc.bytesIn, doc.docs);
    if (cachedDoc !== doc) return;
    doc.vm = vm;
    replyPhase2(doc, vm);
  }, 0);
}

self.onmessage = (e: MessageEvent<InMsg>): void => {
  const m = e.data;
  switch (m.type) {
    case 'parse': {
      invalidateCachedDoc();
      try {
        const t0 = performance.now();
        const r = parseInput(m.raw);
        if (r.kind === 'error') {
          replyErr(m.id, m.epoch, r.message, r.offset, r.line, r.col, r.lineText);
          return;
        }
        const docs = r.kind === 'jsonl' ? r.docs : 0;
        formatDoc(r.value, m.id, m.epoch, m.indent, m.raw.length, docs, performance.now() - t0);
      } catch (err) {
        replyErr(m.id, m.epoch, err instanceof Error ? err.message : String(err), -1);
      }
      return;
    }
    case 'reformat': {
      const prev = cachedDoc;
      if (prev === null) return;
      formatDoc(prev.value, m.id, m.epoch, m.indent, prev.bytesIn, prev.docs, 0);
      return;
    }
    case 'getTree': {
      const doc = cachedDoc;
      if (doc === null || doc.vm === null) return;
      // Tree is lazy: flatten on demand (labels built during the walk).
      replyTree(m.id, m.epoch, flatten(doc.value, doc.vm.lines));
      return;
    }
    case 'getMin': {
      const doc = cachedDoc;
      const vm = doc?.vm;
      if (vm === null || vm === undefined) return;
      const min = ensureMin(vm);
      buildMinTokens(vm); // ensureMin inside is now a cache hit
      const buf = vm.tokM!.buffer;
      vm.tokM = null; // transferred buffers are detached; do not reuse them
      wself.postMessage({ id: m.id, epoch: m.epoch, type: 'min', min, tokMBuf: buf }, [
        buf,
      ] as unknown as Transferable[]);
      return;
    }
  }
};
