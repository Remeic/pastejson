// Pure main-thread seam for the two-phase formatting protocol.
//
// A provisional view is deliberately not a ViewModel. It owns only the
// exact phase-1 string and the small line-prefix index needed for first paint.
// A hydrated view is created only after phase 2 supplies the complete indexes.
// This module has no DOM or Worker dependency so request races stay testable.

import type { Indent, Phase1Reply, Phase2Reply, RequestMetadata } from './worker-protocol';

export interface ProvisionalSeed {
  prefixLineStarts: Uint32Array;
  rows: number;
  lastRowEnd: number;
}

export interface IdleViewState {
  phase: 'idle';
  request: RequestMetadata;
}

export interface PendingViewState {
  phase: 'pending';
  request: RequestMetadata;
}

export interface ProvisionalViewState {
  phase: 'provisional';
  request: RequestMetadata;
  pretty: string;
  indent: Indent;
  bytesIn: number;
  docs: number;
  prefixLineStarts: Uint32Array;
  rows: number;
  lastRowEnd: number;
}

export interface HydratedViewState {
  phase: 'hydrated';
  request: RequestMetadata;
  pretty: string;
  indent: Indent;
  bytesIn: number;
  docs: number;
  lineStarts: Uint32Array;
  lines: number;
  maxLen: number;
  tokP: Int32Array;
}

export type WorkerViewState =
  | IdleViewState
  | PendingViewState
  | ProvisionalViewState
  | HydratedViewState;

function sameRequest(a: RequestMetadata, b: RequestMetadata): boolean {
  return a.id === b.id && a.epoch === b.epoch;
}

function validSeed(pretty: string, seed: ProvisionalSeed): boolean {
  if (seed.rows < 1 || seed.rows !== seed.prefixLineStarts.length) return false;
  if (seed.prefixLineStarts[0] !== 0) return false;
  const last = seed.prefixLineStarts[seed.rows - 1];
  return last <= seed.lastRowEnd && seed.lastRowEnd <= pretty.length;
}

function validPhase2(reply: Phase2Reply): boolean {
  if (reply.lines < 1 || reply.lsLen !== reply.lines) return false;
  if (reply.tokPLen < 0 || (reply.tokPLen & 1) !== 0) return false;
  if (reply.lsLen * Uint32Array.BYTES_PER_ELEMENT > reply.lineStartsBuf.byteLength) return false;
  if (reply.tokPLen * Int32Array.BYTES_PER_ELEMENT > reply.tokPBuf.byteLength) return false;
  return true;
}

export function idleViewState(id: number, epoch: number): IdleViewState {
  return { phase: 'idle', request: { id, epoch } };
}

export function beginViewRequest(id: number, epoch: number): PendingViewState {
  return { phase: 'pending', request: { id, epoch } };
}

export function acceptPhase1(
  state: WorkerViewState,
  reply: Phase1Reply,
  seed: ProvisionalSeed,
): WorkerViewState {
  if (state.phase !== 'pending' || !sameRequest(state.request, reply)) return state;
  if (!validSeed(reply.pretty, seed)) return state;
  return {
    phase: 'provisional',
    request: state.request,
    pretty: reply.pretty,
    indent: reply.indent,
    bytesIn: reply.bytesIn,
    docs: reply.docs,
    prefixLineStarts: seed.prefixLineStarts,
    rows: seed.rows,
    lastRowEnd: seed.lastRowEnd,
  };
}

export function acceptPhase2(
  state: WorkerViewState,
  reply: Phase2Reply,
): WorkerViewState {
  if (state.phase !== 'provisional' || !sameRequest(state.request, reply)) return state;
  if (
    reply.indent !== state.indent ||
    reply.bytesIn !== state.bytesIn ||
    reply.docs !== state.docs ||
    !validPhase2(reply)
  ) {
    return state;
  }
  return {
    phase: 'hydrated',
    request: state.request,
    pretty: state.pretty,
    indent: state.indent,
    bytesIn: state.bytesIn,
    docs: state.docs,
    lineStarts: new Uint32Array(reply.lineStartsBuf, 0, reply.lsLen),
    lines: reply.lines,
    maxLen: reply.maxLen,
    tokP: new Int32Array(reply.tokPBuf, 0, reply.tokPLen),
  };
}

export function resetViewState(id: number, epoch: number): IdleViewState {
  return idleViewState(id, epoch);
}

export function restartViewState(id: number, epoch: number): IdleViewState {
  return idleViewState(id, epoch);
}
