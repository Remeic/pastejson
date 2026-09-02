export interface ParseOk {
  ok: true;
  value: unknown;
}

export interface ParseErr {
  ok: false;
  message: string;
  line: number;
  col: number;
  offset: number;
  lineText: string;
}

export type ParseResult = ParseOk | ParseErr;

const POS_RE = /position\s+(\d+)/i;

// JSON grammar accepts only 4 whitespace chars, but clipboards ship
// invisible junk (BOM U+FEFF, NBSP U+00A0, zero-width U+200B–U+200F,
// U+2028/U+2029). JSON.parse rejects it at position 0 → "unexpected
// character at line 1 column 1". Strip leading/trailing junk only:
// mid-string junk is legal inside JSON strings and must survive.
// Cost on a clean paste: two charCodeAt checks, zero alloc (same string).
function isJunk(c: number): boolean {
  return (
    c === 0xfeff || c === 0xa0 || (c >= 0x200b && c <= 0x200f) || c === 0x2028 || c === 0x2029
  );
}

function stripJunk(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isJunk(s.charCodeAt(a))) a++;
  while (b > a && isJunk(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

export function parseJson(raw: string): ParseResult {
  const s = stripJunk(raw);
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return jsonErr(s, e);
  }
}

function jsonErr(raw: string, e: unknown): ParseErr {
  const message = e instanceof Error ? e.message : String(e);
  let offset = -1;
  const m = POS_RE.exec(message);
  if (m) offset = Number(m[1]);

  let line = 0;
  let col = 0;
  let lineText = '';
  if (offset >= 0 && offset <= raw.length) {
    let count = 1;
    let lastNl = -1;
    for (let i = 0; i < offset; i++) {
      if (raw.charCodeAt(i) === 10) {
        count++;
        lastNl = i;
      }
    }
    line = count;
    col = offset - lastNl;
    const ls = lastNl + 1;
    let le = raw.indexOf('\n', ls);
    if (le < 0) le = raw.length;
    lineText = raw.slice(ls, Math.min(le, ls + 200));
  }
  return { ok: false, message, line, col, offset, lineText };
}

// ---------- JSONL (newline-delimited JSON) ----------

export type InputResult =
  | { kind: 'json'; value: unknown }
  | { kind: 'jsonl'; value: unknown[]; docs: number }
  | { kind: 'error'; message: string; line: number; col: number; offset: number; lineText: string };

// Detection: whole-string JSON.parse first (fast path). On failure, try
// line-by-line; if ≥1 line parses → JSONL (docs wrapped in an array).
// A bad line reports an error with 1-based line number + full-raw offset —
// but only when at least one earlier line parsed (else it's plain broken JSON).
export function parseInput(raw: string): InputResult {
  const s = stripJunk(raw);
  try {
    return { kind: 'json', value: JSON.parse(s) };
  } catch (firstErr) {
    const lines = s.split('\n');
    const docs: unknown[] = [];
    let lineStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const trimmed = l.trim();
      if (trimmed === '') {
        lineStart += l.length + 1;
        continue;
      }
      try {
        docs.push(JSON.parse(trimmed));
      } catch (e) {
        if (docs.length === 0) return { kind: 'error', ...jsonErr(s, firstErr) };
        const message = e instanceof Error ? e.message : String(e);
        let inLine = -1;
        const mm = POS_RE.exec(message);
        if (mm) inLine = Number(mm[1]);
        return {
          kind: 'error',
          message,
          line: i + 1,
          col: inLine >= 0 ? inLine + 1 : 0,
          offset: lineStart + (inLine >= 0 ? inLine : 0),
          lineText: trimmed.slice(0, 200),
        };
      }
      lineStart += l.length + 1;
    }
    if (docs.length > 0) return { kind: 'jsonl', value: docs, docs: docs.length };
    return { kind: 'error', ...jsonErr(s, firstErr) };
  }
}
