import { parseInput } from './parse';

export type BeautifyResult =
  | { ok: true; pretty: string }
  | { ok: false; message: string; line: number; col: number; offset: number };

// Editor-side formatter: the native floor only (one parse, one stringify).
// No tokens or line index — the textarea needs just the text.
export function beautifyJson(raw: string, indent: number | '\t'): BeautifyResult {
  const r = parseInput(raw);
  if (r.kind === 'error') {
    return { ok: false, message: r.message, line: r.line, col: r.col, offset: r.offset };
  }
  return { ok: true, pretty: JSON.stringify(r.value, null, indent) ?? 'null' };
}
