import { tokenize } from './tokenizer';
import { emitJson } from './serialize';

// Shared view-model builder. Used by BOTH:
// - main thread (small docs < WORKER_THRESHOLD)
// - worker thread (big docs), which transfers typed arrays back
//
// Perf: ONE fused walk (serialize.ts) produces pretty text + tokens +
// line index. min string, min tokens and TREE are LAZY.

export interface ViewModel {
  pretty: string;
  min: string | null; // lazy: built on first Minified view / copy-min
  source: unknown; // kept for lazy min build
  indent: number | '\t';
  lineStarts: Uint32Array; // offsets where each pretty-printed line starts
  lines: number;
  maxLen: number; // longest pretty line length (for h-scroll width)
  tokP: Int32Array; // tokens over pretty
  tokM: Int32Array | null; // lazy
  bytesIn: number;
  docs: number; // >0 = JSONL document count
}

export function buildView(value: unknown, indent: number | '\t', bytesIn: number): ViewModel {
  const r = emitJson(value, indent, bytesIn);
  return {
    pretty: r.pretty,
    min: null,
    source: value,
    indent,
    lineStarts: r.lineStarts,
    lines: r.lines,
    maxLen: r.maxLen,
    tokP: r.tokens,
    tokM: null,
    bytesIn,
    docs: 0,
  };
}

export function ensureMin(vm: ViewModel): string {
  let m = vm.min;
  if (m === null) m = vm.min = JSON.stringify(vm.source);
  return m;
}

export function buildMinTokens(vm: ViewModel): void {
  if (vm.tokM === null) vm.tokM = tokenize(ensureMin(vm));
}
