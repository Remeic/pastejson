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
      const raw_lineText = raw.slice(ls, Math.min(le, ls + 200));
      lineText = raw_lineText;
    }
    return { ok: false, message, line, col, offset, lineText };
  }
}
