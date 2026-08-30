// Main/Worker formatting protocol.
//
// Phase 1 carries only the exact native pretty string and the metadata needed
// to identify the request. Phase 2 carries the hydrated indexes. It does not
// repeat `pretty`: the main thread keeps the phase-1 string.

export type Indent = number | '\t';

export interface RequestMetadata {
  id: number;
  epoch: number;
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

// Keep these lists beside the constructors. The worker must use the
// constructors so structured-clone sees one fixed key order per phase.
export const PHASE1_KEYS = [
  'id',
  'epoch',
  'ok',
  'phase',
  'pretty',
  'indent',
  'bytesIn',
  'docs',
  'ms',
] as const;

export const PHASE2_KEYS = [
  'id',
  'epoch',
  'ok',
  'phase',
  'lines',
  'maxLen',
  'indent',
  'bytesIn',
  'docs',
  'lsLen',
  'lineStartsBuf',
  'tokPLen',
  'tokPBuf',
] as const;

export type Phase1ReplyInput = Omit<Phase1Reply, 'ok' | 'phase'>;
export type Phase2ReplyInput = Omit<Phase2Reply, 'ok' | 'phase'>;

export function makePhase1Reply(input: Phase1ReplyInput): Phase1Reply {
  return {
    id: input.id,
    epoch: input.epoch,
    ok: true,
    phase: 1,
    pretty: input.pretty,
    indent: input.indent,
    bytesIn: input.bytesIn,
    docs: input.docs,
    ms: input.ms,
  };
}

export function makePhase2Reply(input: Phase2ReplyInput): Phase2Reply {
  return {
    id: input.id,
    epoch: input.epoch,
    ok: true,
    phase: 2,
    lines: input.lines,
    maxLen: input.maxLen,
    indent: input.indent,
    bytesIn: input.bytesIn,
    docs: input.docs,
    lsLen: input.lsLen,
    lineStartsBuf: input.lineStartsBuf,
    tokPLen: input.tokPLen,
    tokPBuf: input.tokPBuf,
  };
}
