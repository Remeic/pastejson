import { tokenize } from './tokenizer';

// Shared view-model builder. Used by BOTH:
// - main thread (small docs < WORKER_THRESHOLD)
// - worker thread (big docs), which transfers typed arrays back

export interface ViewModel {
  pretty: string;
  min: string;
  lineStarts: Uint32Array; // offsets where each pretty-printed line starts
  lines: number;
  maxLen: number; // longest pretty line length (for h-scroll width)
  tokP: Int32Array; // tokens over pretty
  tokM: Int32Array | null; // lazy: built on first Minified view
  bytesIn: number;
}

export function buildView(value: unknown, indent: number | '\t', bytesIn: number): ViewModel {
  const pretty = JSON.stringify(value, null, indent);
  const min = JSON.stringify(value);

  // SINGLE pass: line starts + newline count + max line length
  let cap = 1024;
  let ls = new Uint32Array(cap);
  let li = 0;
  ls[li++] = 0;
  let nl = 0;
  let maxLen = 0;
  let segStart = 0;
  for (let i = 0; i < pretty.length; i++) {
    if (pretty.charCodeAt(i) === 10) {
      const segLen = i - segStart;
      if (segLen > maxLen) maxLen = segLen;
      nl++;
      if (li === cap) {
        const g = new Uint32Array(cap << 1);
        g.set(ls);
        ls = g;
        cap <<= 1;
      }
      ls[li++] = i + 1;
      segStart = i + 1;
    }
  }
  const tail = pretty.length - segStart;
  if (tail > maxLen) maxLen = tail;

  return {
    pretty,
    min,
    lineStarts: ls.slice(0, li),
    lines: nl + 1,
    maxLen,
    tokP: tokenize(pretty),
    tokM: null,
    bytesIn,
  };
}

export function buildMinTokens(vm: ViewModel): void {
  if (!vm.tokM) vm.tokM = tokenize(vm.min);
}
