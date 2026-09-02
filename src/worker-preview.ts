import { tokenize, T_PUNCT } from './tokenizer';

export const WORKER_PREVIEW_LINES = 96;
export const WORKER_PREVIEW_CHARS = 64 * 1024;
export const PRETTY_CHUNK_CHARS = 4 * 1024 * 1024;
export const CHUNKED_PRETTY_MIN = 16 * 1024 * 1024;

export interface WorkerPreview {
  pretty: string;
  tokens: Int32Array;
  lineStarts: Uint32Array;
  lines: number;
  maxLen: number;
}

export function makeWorkerPreview(
  pretty: string,
  lineLimit: number,
  charLimit = WORKER_PREVIEW_CHARS,
): WorkerPreview {
  if (!Number.isSafeInteger(lineLimit) || lineLimit < 1)
    throw new RangeError('preview line limit must be a positive integer');
  if (!Number.isSafeInteger(charLimit) || charLimit < 1)
    throw new RangeError('preview character limit must be a positive integer');

  const starts = [0];
  let from = 0;
  while (starts.length < lineLimit) {
    const newline = pretty.indexOf('\n', from);
    if (newline < 0) break;
    from = newline + 1;
    starts.push(from);
  }
  let end = pretty.length;
  if (starts.length === lineLimit) {
    const newline = pretty.indexOf('\n', starts[starts.length - 1]);
    if (newline >= 0) end = newline;
  }
  end = Math.min(end, charLimit);
  const source = pretty.slice(0, end);
  const visibleStarts = end === 0 ? [0] : starts.filter((start) => start < end);

  let maxLen = 0;
  for (let i = 0; i < visibleStarts.length; i++) {
    const lineEnd = i + 1 < visibleStarts.length ? visibleStarts[i + 1] - 1 : source.length;
    maxLen = Math.max(maxLen, lineEnd - visibleStarts[i]);
  }

  const allTokens = tokenize(source);
  let tokenInts = 0;
  for (let i = 0; i < allTokens.length; i += 2) {
    if (allTokens[i + 1] !== T_PUNCT) tokenInts += 2;
  }
  const tokens = new Int32Array(tokenInts);
  let out = 0;
  for (let i = 0; i < allTokens.length; i += 2) {
    if (allTokens[i + 1] === T_PUNCT) continue;
    tokens[out++] = allTokens[i];
    tokens[out++] = allTokens[i + 1];
  }

  return {
    pretty: source,
    tokens,
    lineStarts: Uint32Array.from(visibleStarts),
    lines: visibleStarts.length,
    maxLen,
  };
}

function validChunkChars(chunkChars: number): void {
  if (!Number.isSafeInteger(chunkChars) || chunkChars < 1)
    throw new RangeError('pretty chunk size must be a positive integer');
}

export function prettyChunkCount(pretty: string, chunkChars = PRETTY_CHUNK_CHARS): number {
  validChunkChars(chunkChars);
  return Math.ceil(pretty.length / chunkChars);
}

export function prettyChunkAt(
  pretty: string,
  index: number,
  chunkChars = PRETTY_CHUNK_CHARS,
): string {
  const count = prettyChunkCount(pretty, chunkChars);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count)
    throw new RangeError('pretty chunk index is out of range');
  const start = index * chunkChars;
  return pretty.slice(start, Math.min(start + chunkChars, pretty.length));
}