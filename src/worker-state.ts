// Pure main-thread seam for the two-phase formatting protocol.
//
// A provisional view is deliberately not a ViewModel. It owns only the
// exact phase-1 string and the small line-prefix index needed for first paint.
// A hydrated view is created only after phase 2 supplies the complete indexes.
// This module has no DOM or Worker dependency so request races stay testable.

import type { Indent, Phase1Reply, Phase2Reply } from './worker-protocol';

export interface ProvisionalSeed {
  prefixLineStarts: Uint32Array;
  rows: number;
  lastRowEnd: number;
  mountable: boolean;
}

export interface IdleViewState {
  phase: 'idle';
  id: number;
}

export interface PendingViewState {
  phase: 'pending';
  id: number;
  preserveScrollTop: number;
  showProvisional: boolean;
}

export interface ProvisionalViewState {
  phase: 'provisional';
  id: number;
  pretty: string;
  indent: Indent;
  bytesIn: number;
  docs: number;
  preserveScrollTop: number;
  showProvisional: boolean;
  mountable: boolean;
  prefixLineStarts: Uint32Array;
  rows: number;
  lastRowEnd: number;
}

const NO_PROVISIONAL_SEED: ProvisionalSeed = {
  prefixLineStarts: new Uint32Array([0]),
  rows: 1,
  lastRowEnd: 0,
  mountable: false,
};

export interface HydratedViewState {
  phase: 'hydrated';
  id: number;
  pretty: string;
  indent: Indent;
  bytesIn: number;
  docs: number;
  ms: number;
  preserveScrollTop: number;
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

// Scan only the prefix needed to paint the first viewport. Refuse a prefix
// whose complete rows exceed the raw-preview budget: one long line must not
// turn the first paint into a multi-megabyte main-thread HTML build.
export function scanProvisional(
  pretty: string,
  maxRows: number,
  maxChars = 24000,
): ProvisionalSeed {
  const target = Math.max(1, Math.floor(maxRows));
  const budget = Math.max(1, Math.floor(maxChars));
  const prefix = pretty.length > budget ? pretty.slice(0, budget) : pretty;
  const starts = [0];
  let cursor = 0;
  while (starts.length < target) {
    const nl = prefix.indexOf('\n', cursor);
    if (nl < 0) break;
    cursor = nl + 1;
    starts.push(cursor);
  }
  const lastStart = starts[starts.length - 1];
  const nextNl = prefix.indexOf('\n', lastStart);
  const lastRowEnd = nextNl < 0 ? Math.min(pretty.length, budget) : nextNl;
  const mountable = nextNl >= 0 || pretty.length <= budget;
  return {
    prefixLineStarts: Uint32Array.from(starts),
    rows: starts.length,
    lastRowEnd,
    mountable,
  };
}

export function idleViewState(id: number): IdleViewState {
  return { phase: 'idle', id };
}

export function beginViewRequest(
  id: number,
  preserveScrollTop = 0,
  showProvisional = false,
): PendingViewState {
  return {
    phase: 'pending',
    id,
    preserveScrollTop: Math.max(0, preserveScrollTop),
    showProvisional,
  };
}

export function acceptPhase1(
  state: WorkerViewState,
  reply: Phase1Reply,
  seed?: ProvisionalSeed,
): WorkerViewState {
  if (state.phase !== 'pending' || state.id !== reply.id) return state;
  const actualSeed = seed ?? NO_PROVISIONAL_SEED;
  if (seed && !validSeed(reply.pretty, seed)) return state;
  return {
    phase: 'provisional',
    id: state.id,
    pretty: reply.pretty,
    indent: reply.indent,
    bytesIn: reply.bytesIn,
    docs: reply.docs,
    preserveScrollTop: state.preserveScrollTop,
    showProvisional: state.showProvisional,
    mountable: actualSeed.mountable,
    prefixLineStarts: actualSeed.prefixLineStarts,
    rows: actualSeed.rows,
    lastRowEnd: actualSeed.lastRowEnd,
  };
}

export function acceptPhase2(
  state: WorkerViewState,
  reply: Phase2Reply,
): WorkerViewState {
  if (state.phase !== 'provisional' || state.id !== reply.id) return state;
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
    id: state.id,
    pretty: state.pretty,
    indent: state.indent,
    bytesIn: state.bytesIn,
    docs: state.docs,
    ms: reply.ms,
    preserveScrollTop: state.preserveScrollTop,
    lineStarts: new Uint32Array(reply.lineStartsBuf, 0, reply.lsLen),
    lines: reply.lines,
    maxLen: reply.maxLen,
    tokP: new Int32Array(reply.tokPBuf, 0, reply.tokPLen),
  };
}
