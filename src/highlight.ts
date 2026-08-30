// Token-type -> CSS class letter
const TOKEN_CLASSES = ['s', 'n', 'b', 'b', 'x', 'k', 'p', 'e'];

const AMP = '&amp;';
const LT = '&lt;';
const GT = '&gt;';

export function esc(s: string): string {
  // single-scan guard; replace only when needed
  if (!/[&<>]/.test(s)) return s;
  return s.replace(/[&<>]/g, (c) => (c === '&' ? AMP : c === '<' ? LT : GT));
}

// Binary search: first token whose endOffset > offset.
// tokens = pairs [end,type]; token i spans [tokens[2i-2]||0, tokens[2i])
export function firstTokenAt(tokens: Int32Array, offset: number): number {
  let lo = 0;
  let hi = (tokens.length >> 1) - 1;
  let ans = hi + 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid * 2] > offset) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

// HTML for source range [start,end) using an ordered token table.
export function rangeHtml(src: string, tokens: Int32Array, start: number, end: number): string {
  const cnt = tokens.length >> 1;
  let html = '';
  let pos = start;
  let idx = firstTokenAt(tokens, start);
  while (idx < cnt) {
    const tokEnd = tokens[idx * 2];
    if (tokEnd <= pos) {
      idx++;
      continue;
    }
    const tokStart = idx > 0 ? tokens[(idx - 1) * 2] : 0;
    if (tokStart > pos) {
      const gapEnd = Math.min(tokStart, end);
      if (gapEnd > pos) html += esc(src.slice(pos, gapEnd));
    }
    const s = Math.max(tokStart, pos);
    const e = Math.min(tokEnd, end);
    if (e > s) {
      html += '<i class=' + TOKEN_CLASSES[tokens[idx * 2 + 1]] + '>' + esc(src.slice(s, e)) + '</i>';
    }
    if (e > pos) pos = e;
    if (pos >= end) break;
    idx++;
  }
  if (pos < end) html += esc(src.slice(pos, end));
  return html;
}
