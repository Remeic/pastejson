import { tokenize } from './tokenizer';
import { emitJson, emitJsonFromPretty } from './serialize';

// Shared view-model builder. Used by BOTH:
// - main thread (small docs < WORKER_THRESHOLD)
// - worker thread (big docs), which transfers typed arrays back
//
// Perf: ONE fused walk (serialize.ts) produces pretty text + global syntax
// tokens + line index. Min string/tokens and TREE are lazy.

export interface ViewModel {
  pretty: string;
  min: string | null; // lazy: built on first Minified view / copy-min
  // undefined means the source lives in the Worker; null is a valid JSON value.
  source: unknown | undefined;
  indent: number | '\t';
  lineStarts: Uint32Array; // offsets where each pretty-printed line starts
  lines: number;
  maxLen: number; // longest pretty line length (for h-scroll width)
  tokP: Int32Array; // full non-punctuation tokens over pretty
  tokM: Int32Array | null; // lazy
  bytesIn: number;
  docs: number; // >0 = JSONL document count
}

export function buildView(value: unknown, indent: number | '\t', bytesIn: number): ViewModel {
  const r = emitJson(value, indent, bytesIn);
  return viewFromEmit(r, value, indent, bytesIn, 0);
}

// Worker phase 2 starts from the exact phase-1 string. This helper keeps the
// worker cache and the small-document path on the same ViewModel shape.
export function buildViewFromPretty(
  value: unknown,
  pretty: string,
  indent: number | '\t',
  bytesIn: number,
  docs = 0,
): ViewModel {
  const r = emitJsonFromPretty(value, pretty, indent, bytesIn);
  return viewFromEmit(r, value, indent, bytesIn, docs);
}

function viewFromEmit(
  r: ReturnType<typeof emitJson>,
  value: unknown,
  indent: number | '\t',
  bytesIn: number,
  docs: number,
): ViewModel {
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
    docs,
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
