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

export function parseJson(raw: string): ParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return jsonErr(raw, e);
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
  try {
    return { kind: 'json', value: JSON.parse(raw) };
  } catch (firstErr) {
    const lines = raw.split('\n');
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
        if (docs.length === 0) return { kind: 'error', ...jsonErr(raw, firstErr) };
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
          lineText: trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed,
        };
      }
      lineStart += l.length + 1;
    }
    if (docs.length > 0) return { kind: 'jsonl', value: docs, docs: docs.length };
    return { kind: 'error', ...jsonErr(raw, firstErr) };
  }
}
