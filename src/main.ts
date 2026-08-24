import './style.css';
import { parseInput } from './parse';
import { buildView, ensureMin, type ViewModel } from './viewmodel';
import { materializeLabels } from './serialize';
import type { FlatTree } from './tree';
import { flatten, buildVisible } from './tree';
import { VScroll } from './vscroll';
import {
  textHtml,
  treeHtml,
  minHtml,
  minRowCount,
  humanBytes,
} from './render';
import { esc } from './highlight';
import PJWorker from './worker?worker&inline';

const ROW_H = 20;
const WORKER_THRESHOLD = 256 * 1024;
const PREVIEW_CHARS = 24000;
const OVERSCAN = 12;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const body = document.body;
const inTa = $<HTMLTextAreaElement>('in');
const toolbar = $('toolbar');
const out = $('out');
const viewEl = $('view');
const rawprev = $('rawprev');
const errbanner = $('errbanner');
const statusbar = $('statusbar');
const toastEl = $('toast');
const dropOverlay = $('drop-overlay');

// ---------- state ----------
type ViewName = 'text' | 'tree' | 'min';

let vm: ViewModel | null = null;
let ft: FlatTree | null = null;
let expanded: Uint8Array | null = null;
let visibleRows: Int32Array | null = null;
let parsedValue: unknown = null; // small-path only (worker holds its own copy)
let mode: string = 'landing';
let curView: ViewName = 'text';
let indent: number | '\t' = 2;
let reqId = 0;
let lastRaw = '';
let bytesIn = 0;
let wantCopyMin = false;
let scroller: VScroll | null = null;

// ---------- char width probe (for h-scroll width estimate) ----------
let charW = 7.8;
let charWProbed = false;
function ensureCharW(): void {
  if (charWProbed) return;
  charWProbed = true;
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;visibility:hidden;font:13px ui-monospace,Menlo,Consolas,monospace;white-space:pre';
  probe.textContent = '{"key0":123.45e-2,"s":"val"}[]:, ';
  document.documentElement.appendChild(probe);
  const w0 = probe.getBoundingClientRect().width;
  charW = w0 / probe.textContent.length || 7.8;
  probe.remove();
}

// ---------- helpers ----------
function setMode(m: string): void {
  mode = m;
  body.dataset.mode = m;
}

let toastTimer = 0;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 1600);
}

function fmtStatus(ms: number): void {
  if (!vm) return;
  const parts = [
    vm.docs > 0 ? `${vm.docs.toLocaleString('en-US')} docs · JSONL` : humanBytes(bytesIn),
    `${vm.lines.toLocaleString('en-US')} lines`,
    ms > 0 ? `${Math.round(ms)} ms` : '',
  ];
  statusbar.textContent = parts.filter(Boolean).join('  ·  ');
}

// ---------- worker ----------
let worker: Worker | null = null;
function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new PJWorker();
  worker.onmessage = (
    e: MessageEvent<
      | {
          id: number;
          ok: boolean;
          pretty: string;
          lines: number;
          maxLen: number;
          indent: number | '\t';
          docs: number;
          lineStartsBuf: ArrayBuffer;
          tokPBuf: ArrayBuffer;
          ms?: number;
          message?: string;
          offset?: number;
        }
      | {
          id: number;
          type: 'tree';
          rowCount: number;
          depthBuf: ArrayBuffer;
          kindBuf: ArrayBuffer;
          keyIdxBuf: ArrayBuffer;
          valIdxBuf: ArrayBuffer;
          metaBuf: ArrayBuffer;
          subtreeRowsBuf: ArrayBuffer;
          keys: string[];
          vals: string[];
        }
      | { id: number; type: 'min'; min: string; tokMBuf: ArrayBuffer }
    >,
  ) => {
    const m = e.data;
    if (m.id !== reqId) return; // stale reply
    if ('type' in m && m.type === 'tree') {
      ft = {
        depth: new Uint16Array(m.depthBuf),
        kind: new Int32Array(m.kindBuf),
        keyIdx: new Int32Array(m.keyIdxBuf),
        valIdx: new Int32Array(m.valIdxBuf),
        keyTokIdx: new Int32Array(0),
        valTokIdx: new Int32Array(0),
        meta: new Int32Array(m.metaBuf),
        subtreeRows: new Int32Array(m.subtreeRowsBuf),
        keys: m.keys,
        vals: m.vals,
        rowCount: m.rowCount,
      };
      expanded = new Uint8Array(ft.rowCount).fill(1);
      visibleRows = buildVisible(ft, expanded);
      if (mode === 'loaded' && curView === 'tree' && scroller) {
        statusbar.textContent = `${ft.rowCount.toLocaleString('en-US')} nodes`;
        scroller.setRowCount(visibleRows.length);
      }
      return;
    }
    if ('type' in m && m.type === 'min') {
      if (vm) {
        vm.min = m.min;
        vm.tokM = new Int32Array(m.tokMBuf);
      }
      if (wantCopyMin && vm?.min) {
        wantCopyMin = false;
        void copyText(vm.min);
      }
      if (mode === 'loaded' && curView === 'min') {
        mountScroller('min', -1); // now with real row count + tokens
      }
      return;
    }
    if (!m.ok) {
      showError(m.message ?? 'Invalid JSON', m.offset ?? -1);
      return;
    }
    vm = {
      pretty: m.pretty,
      min: null,
      source: null, // big path: value lives in the worker
      indent: m.indent,
      lineStarts: new Uint32Array(m.lineStartsBuf),
      lines: m.lines,
      maxLen: m.maxLen,
      tokP: new Int32Array(m.tokPBuf),
      tokM: null,
      tree: null,
      bytesIn,
      docs: m.docs ?? 0,
    };
    ft = null;
    enterView(m.ms ?? 0);
  };
  return worker;
}

// ---------- load pipeline ----------
function load(raw: string): void {
  reqId++;
  lastRaw = raw;
  bytesIn = raw.length;
  errbanner.hidden = true;
  rawprev.hidden = true;

  if (raw.length > WORKER_THRESHOLD) {
    setMode('working');
    // streaming preview: show raw immediately while worker parses
    out.hidden = false;
    viewEl.innerHTML = '';
    rawprev.hidden = false;
    rawprev.innerHTML =
      '<span class="working-chip">formatting…</span>' + esc(raw.slice(0, PREVIEW_CHARS)) + '\n…';
    ensureWorker().postMessage({ type: 'parse', id: reqId, raw, indent });
    return;
  }

  const t0 = performance.now();
  const r = parseInput(raw);
  if (r.kind === 'error') {
    showError(r.message, r.offset, r.line, r.col, r.lineText);
    return;
  }
  parsedValue = r.value;
  vm = buildView(parsedValue, indent, bytesIn);
  vm.docs = r.kind === 'jsonl' ? r.docs : 0;
  ft = null;
  enterView(performance.now() - t0);
}



function showError(
  message: string,
  offset: number,
  line = 0,
  col = 0,
  lineText = '',
): void {
  setMode('error');
  out.hidden = true;
  toolbar.hidden = false;
  statusbar.textContent = '';
  inTa.value = lastRaw;
  let loc = '';
  if (line > 0) loc = ` — line ${line}, col ${col}`;
  else if (offset >= 0) loc = ` — at char ${offset.toLocaleString('en-US')}`;
  errbanner.hidden = false;
  errbanner.innerHTML =
    `<b>Invalid JSON${loc}</b><br>${esc(message)}` +
    (line > 0 && lineText
      ? `<span class="snippet">${esc(lineText)}</span>`
      : '');
  inTa.focus();
  // put caret near the error offset for fast fixing
  if (offset >= 0 && offset <= inTa.value.length) {
    try {
      inTa.setSelectionRange(offset, Math.min(offset + 40, inTa.value.length));
    } catch {
      /* ignore */
    }
  }
}

function mountScroller(v: ViewName, anchorTopVisual: number): void {
  ensureCharW();
  scroller?.destroy();
  viewEl.innerHTML = '';

  if (v === 'text') {
    scroller = new VScroll(viewEl, {
      rowH: ROW_H,
      overscan: OVERSCAN,
      paint: (a, b) => textHtml(vm!, a, b),
    });
    scroller.setWidth(vm!.maxLen * charW + 72);
    scroller.setRowCount(vm!.lines);
  } else if (v === 'min') {
    const minStr = vm!.min;
    scroller = new VScroll(viewEl, {
      rowH: ROW_H,
      overscan: OVERSCAN,
      paint: (a, b) => minHtml(vm!, a, b),
    });
    if (minStr === null) {
      // lazy: request from worker, paint chip meanwhile
      ensureWorker().postMessage({ type: 'getMin', id: reqId });
      statusbar.textContent = 'preparing minified…';
      scroller.setWidth(0);
      scroller.setRowCount(0);
    } else {
      scroller.setWidth(minStr.length * charW + 72);
      scroller.setRowCount(minRowCount(vm!));
    }
  } else {
    if (!ft) {
      if (vm?.tree) {
        // small doc: structure came free with the fused pass; labels lazy
        ft = vm.tree;
        if (ft.keyIdx.length !== ft.rowCount) materializeLabels(ft, vm!.pretty, vm!.tokP);
        expanded = new Uint8Array(ft.rowCount).fill(1);
        visibleRows = buildVisible(ft, expanded);
      } else if (parsedValue !== null) {
        ft = flatten(parsedValue, vm?.lines);
        expanded = new Uint8Array(ft.rowCount).fill(1);
        visibleRows = buildVisible(ft, expanded);
      } else {
        // big doc: columns live in the worker — request transfer
        ensureWorker().postMessage({ type: 'getTree', id: reqId });
        statusbar.textContent = 'building tree…';
      }
    }
    const visNow = visibleRows;
    scroller = new VScroll(viewEl, {
      rowH: ROW_H,
      overscan: OVERSCAN,
      paint: (a, b) => treeHtml(ft!, expanded!, visibleRows!, a, b),
    });
    scroller.setWidth(Math.max(600, Math.min(20000, vm!.maxLen * charW * 0.4)));
    scroller.setRowCount(visNow ? visNow.length : 0);
  }

  out.hidden = false;
  toolbar.hidden = false;
  setMode('loaded');
  if (anchorTopVisual > 0 && scroller) scroller.reveal(anchorTopVisual);
  else scroller.scrollToTop();
}

function enterView(ms: number): void {
  rawprev.hidden = true;
  ft = null; // rebuilt lazily on first tree mount (or reused if same doc+view switch)
  mountScroller(curView, 0);
  fmtStatus(ms);
}

// ---------- interactions ----------

// paste anywhere on the page
document.addEventListener('paste', (e: ClipboardEvent) => {
  if (document.activeElement === inTa) return; // native path via input event
  const t = e.clipboardData?.getData('text/plain');
  if (!t) return;
  e.preventDefault();
  load(t);
});

// paste into the textarea = PRIMARY path: zero debounce, instant load
inTa.addEventListener('paste', (e: ClipboardEvent) => {
  const t = e.clipboardData?.getData('text/plain');
  if (!t) return; // let native insert fire input path
  e.preventDefault();
  clearTimeout(debounceT);
  inTa.value = t;
  load(t);
});

// typing / native fallback paste into textarea (debounced)
let debounceT = 0;
inTa.addEventListener('input', () => {
  clearTimeout(debounceT);
  debounceT = window.setTimeout(() => {
    const v = inTa.value;
    if (!v || /^\s*$/.test(v)) return resetToLanding();
    load(v);
  }, 140);
});

// click-to-focus in landing
document.addEventListener('pointerdown', (e) => {
  if (mode === 'landing' && e.target !== inTa) inTa.focus();
});

// drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const f = e.dataTransfer?.files[0];
  if (!f) return;
  f.text().then(load).catch(() => toast('Could not read file'));
});

// view toggle
toolbar.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('button');
  if (!el) return;
  if (el.id === 'btn-new') return resetToLanding();
  if (el.id === 'btn-copyp') return copyText(vm?.pretty ?? '');
  if (el.id === 'btn-copym') {
    if (!vm) return;
    if (vm.min !== null) return copyText(vm.min);
    if (vm.source !== null) return copyText(ensureMin(vm)); // small path: local
    wantCopyMin = true;
    ensureWorker().postMessage({ type: 'getMin', id: reqId });
    toast('preparing…');
    return;
  }
  const v = el.dataset.view as ViewName | undefined;
  if (v && v !== curView) {
    curView = v;
    toolbar.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b === el));
    // preserve scroll position across views by visual fraction
    const frac = scroller ? scroller.host.scrollTop / Math.max(1, scroller.host.scrollHeight) : 0;
    mountScroller(v, -1);
    if (scroller) scroller.host.scrollTop = frac * scroller.host.scrollHeight;
  }
});

// tree collapse/expand (delegated)
viewEl.addEventListener('click', (e) => {
  const car = (e.target as HTMLElement).closest('.car') as HTMLElement | null;
  if (!car) return;
  const ftL = ft;
  const exp = expanded;
  const vis = visibleRows;
  const sc = scroller;
  if (!ftL || !exp || !vis || !sc) return;
  const n = Number(car.dataset.n);
  const topVis = Math.floor(sc.host.scrollTop / ROW_H);
  const anchorNode = vis[Math.min(topVis, vis.length - 1)] ?? n;
  exp[n] ^= 1;
  visibleRows = buildVisible(ftL, exp);
  let newTop = 0;
  for (let i = 0; i < visibleRows.length; i++) {
    if (visibleRows[i] === anchorNode) {
      newTop = i;
      break;
    }
  }
  sc.setRowCount(visibleRows.length);
  sc.host.scrollTop = newTop * ROW_H;
});

// indent change
$<HTMLSelectElement>('sel-indent').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  indent = v === 'tab' ? '\t' : Number(v);
  if (!vm) return;
  reqId++;
  if (parsedValue !== null) {
    const t0 = performance.now();
    vm = buildView(parsedValue, indent, bytesIn);
    ft = null;
    mountScroller(curView, 0);
    fmtStatus(performance.now() - t0);
  } else {
    ensureWorker().postMessage({ type: 'reformat', id: reqId, indent });
  }
});

async function copyText(s: string): Promise<void> {
  if (!s) return;
  try {
    await navigator.clipboard.writeText(s);
    toast(`Copied ${humanBytes(s.length)}`);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast(`Copied ${humanBytes(s.length)}`);
  }
}

function resetToLanding(): void {
  reqId++;
  vm = null;
  ft = null;
  parsedValue = null;
  expanded = null;
  visibleRows = null;
  scroller?.destroy();
  scroller = null;
  viewEl.innerHTML = '';
  out.hidden = true;
  toolbar.hidden = true;
  errbanner.hidden = true;
  rawprev.hidden = true;
  statusbar.textContent = '';
  inTa.value = '';
  setMode('landing');
  requestAnimationFrame(() => inTa.focus());
}

// Esc = clear
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mode !== 'landing') resetToLanding();
});

// service worker (prod only)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
