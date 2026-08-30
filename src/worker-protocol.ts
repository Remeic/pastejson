// Main/Worker formatting protocol.
//
// Phase 1 carries only the exact native pretty string and the metadata needed
// to identify the request. Phase 2 carries the hydrated indexes. It does not
// repeat `pretty`: the main thread keeps the phase-1 string.

export type Indent = number | '\t';

export interface RequestMetadata {
  id: number;
}

export type FormatRequest =
  | (RequestMetadata & { type: 'parse'; raw: string; indent: Indent })
  | (RequestMetadata & { type: 'reformat'; indent: Indent });

export interface Phase1Reply extends RequestMetadata {
  ok: true;
  phase: 1;
  pretty: string;
  indent: Indent;
  bytesIn: number;
  docs: number;
  ms: number;
}

export interface Phase2Reply extends RequestMetadata {
  ok: true;
  phase: 2;
  lines: number;
  maxLen: number;
  indent: Indent;
  bytesIn: number;
  docs: number;
  lsLen: number;
  lineStartsBuf: ArrayBuffer;
  tokPLen: number;
  tokPBuf: ArrayBuffer;
}

export type FormatReply = Phase1Reply | Phase2Reply;
