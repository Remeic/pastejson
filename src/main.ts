import './style.css';
import { parseInput } from './parse';
import { buildView, ensureMin, buildMinTokens, type ViewModel } from './viewmodel';
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
import type { AlignedResult, DiffResult } from './diffview';
import type { SearchState } from './search';

const ROW_H = 20;
const WORKER_THRESHOLD = 256 * 1024;
const PREVIEW_CHARS = 24000;
const OVERSCAN = 12;
// multi-MB strings inside a (visible) textarea jank the main thread hard —
// the box is a fix-it editor, not a storage surface
const TEXTAREA_CAP = 1_000_000;

// cap=true for auto-fill surfaces (paste/clipboard) where a multi-MB textarea
// would jank; cap=false on the fix-it surfaces (Edit/error) — the user is there
// to edit the REAL document, and a truncated value would be committed by the
// input path, silently destroying the tail (audit F-02).
function setTa(s: string, cap = true): void {
  inTa.value = cap && s.length > TEXTAREA_CAP ? s.slice(0, TEXTAREA_CAP) + '\n…' : s;
}

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
type ViewName = 'text' | 'tree' | 'min' | 'diff';
type Mode = 'landing' | 'working' | 'error' | 'loaded' | 'editing';

let vm: ViewModel | null = null;
let ft: FlatTree | null = null;
let expanded: Uint8Array | null = null;
let visibleRows: Int32Array | null = null;
// undefined means the current document is Worker-backed (or not loaded).
// JSON values can include null but never undefined, so this sentinel is safe.
let parsedValue: unknown | undefined;
let mode: Mode = 'landing';
let curView: ViewName = 'text';
let indent: number | '\t' = 2;
let reqId = 0;
let lastRaw = '';
let bytesIn = 0;
let lastFormatMs = 0;
let wantCopyMin = false;
let scroller: VScroll | null = null;

// diff island state (module code loads lazily; see openDiff)
let diffMod: typeof import('./diffview') | null = null;
let diffRes: DiffResult | null = null;
let alignedRes: AlignedResult | null = null;
let lastDiffRaw = '';
let lastBVal: unknown = null;
let diffSbs = false; // false = changes-only focus, true = side-by-side
let panelOpen = false;
const diffTa = $<HTMLTextAreaElement>('diff-in');
const diffPanel = $('diffpanel');
const dpStatus = $('dp-status');
const dpMsg = $('dp-msg');

// search island state (module code loads lazily; see openSearch)
let searchMod: typeof import('./search') | null = null;
let searchSt: SearchState | null = null;
let searchOpen = false;
let searchCi = false; // match case (session pref)
let searchRe = false; // query is regex
const searchbar = $('searchbar');
const searchIn = $<HTMLInputElement>('search-in');
const searchCount = $('search-count');
const btnSearchCase = $('btn-search-case');
const btnSearchRe = $('btn-search-re');

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
function setMode(m: Mode): void {
  const wasWorkerBusy = mode === 'working';
  mode = m;
  body.dataset.mode = m;
  const workerBusy = m === 'working';
  if (workerBusy === wasWorkerBusy) return;
  toolbar.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select').forEach((el) => {
    // New stays available so a user can abandon a slow Worker parse.
    el.disabled = workerBusy && el.id !== 'btn-new';
  });
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
  lastFormatMs = ms;
  const parts = [
    vm.docs > 0 ? `${vm.docs.toLocaleString('en-US')} docs · JSONL` : humanBytes(bytesIn),
    `${vm.lines.toLocaleString('en-US')} lines`,
    ms > 0 ? `${Math.round(ms)} ms` : '',
  ];
  statusbar.textContent = parts.filter(Boolean).join('  ·  ');
}

function fmtTreeStatus(): void {
  if (!ft) return;
  statusbar.textContent = `${ft.rowCount.toLocaleString('en-US')} nodes`;
}

function restoreViewStatus(view: ViewName): void {
  if (view === 'text') fmtStatus(lastFormatMs);
  else if (view === 'tree') fmtTreeStatus();
}

// ---------- diff (lazy island orchestration) ----------
function syncSeg(name: ViewName): void {
  toolbar.querySelectorAll('.seg button').forEach((b) => {
    const el = b as HTMLElement;
    const isDiff = el.dataset.view === 'diff';
    const active = el.dataset.view === name;
    el.classList.toggle('on', active);
    el.setAttribute('aria-selected', active ? 'true' : 'false');
    // single-doc views mislead inside diff mode — disabled while active
    const disable = name === 'diff' && !isDiff;
    el.toggleAttribute('disabled', disable);
  });
  // minified/diff have no indentation, tree renders depth structurally —
  // the select is meaningless in all three
  $<HTMLSelectElement>('sel-indent').disabled =
    name === 'diff' || name === 'min' || name === 'tree';
}

function showDiffPanel(): void {
  panelOpen = true;
  diffPanel.hidden = false;
  dpMsg.textContent = '';
  if (!diffRes) dpStatus.textContent = lastDiffRaw ? 'ready — press Diff' : 'paste JSON B';
  requestAnimationFrame(() => diffTa.focus());
}

function closeDiffPanel(): void {
  panelOpen = false;
  diffPanel.hidden = true;
}

function syncModeBtns(): void {
  $('btn-dp-focus').classList.toggle('on', !diffSbs);
  $('btn-dp-sbs').classList.toggle('on', diffSbs);
}

async function ensureDiffMod(): Promise<typeof import('./diffview')> {
  if (!diffMod) diffMod = await import('./diffview');
  return diffMod;
}

// left side: parsed small-path value, else (big path) re-parse pretty —
// JSON.parse is the native floor; explicit user action only.
function getLeftValue(): unknown {
  if (parsedValue !== undefined) return parsedValue;
  if (vm && vm.source !== undefined) return vm.source;
  return JSON.parse(vm!.pretty);
}

async function runDiff(rawB: string): Promise<void> {
  const mod = await ensureDiffMod();
  // state may have moved during the lazy import (reset to landing)
  if (!vm || mode !== 'loaded') return;
  const rb = parseInput(rawB);
  if (rb.kind === 'error') {
    dpMsg.innerHTML = `<b>Invalid JSON B</b> — ${esc(rb.message)}`;
    return;
  }
  statusbar.textContent = 'diffing…';
  dpStatus.textContent = '…';
  await new Promise((r) => setTimeout(r, 0)); // let the chip paint first
  if (!vm || mode !== 'loaded') return; // reset landed during the paint yield
  const t0 = performance.now();
  const left = getLeftValue();
  const res = mod.diffJson(left, rb.value);
  diffRes = res;
  lastBVal = rb.value;
  alignedRes = diffSbs ? mod.diffAligned(left, lastBVal) : null;
  curView = 'diff';
  syncSeg('diff');
  mountScroller('diff', -1);
  const ms = Math.round(performance.now() - t0);
  const summary = `${mod.diffSummary(res)} · ${ms} ms${diffSbs ? ' · side by side' : ''}`;
  dpStatus.textContent = summary;
  statusbar.textContent = summary;
}

// toggle Changes ↔ Side-by-side; aligned build is lazy + cached per inputs
async function setDiffMode(sbs: boolean): Promise<void> {
  if (diffSbs === sbs) return;
  diffSbs = sbs;
  syncModeBtns();
  if (!vm || curView !== 'diff' || !diffRes || lastBVal === null) return;
  if (sbs && !alignedRes) {
    const mod = await ensureDiffMod();
    statusbar.textContent = 'building side-by-side…';
    dpStatus.textContent = '…';
    await new Promise((r) => setTimeout(r, 0));
    if (!vm || mode !== 'loaded' || curView !== 'diff') return; // reset during yield
    const t0 = performance.now();
    alignedRes = mod.diffAligned(getLeftValue(), lastBVal);
    const note = `side-by-side built in ${Math.round(performance.now() - t0)} ms`;
    dpStatus.textContent = note;
    statusbar.textContent = note;
  } else {
    // back to focus — restore the diff summary, drop stale build notes
    const note = diffRes ? diffMod!.diffSummary(diffRes) : '';
    dpStatus.textContent = diffRes ? `${note} · changes` : '';
    statusbar.textContent = note;
  }
  mountScroller('diff', -1);
}

async function openDiff(): Promise<void> {
  if (mode !== 'loaded' || !vm) return;
  if (!panelOpen) showDiffPanel();
  if (lastDiffRaw && curView !== 'diff') return void runDiff(lastDiffRaw);
  requestAnimationFrame(() => diffTa.focus());
}

// leave diff mode → back to the base document (Text)
function exitDiff(): void {
  if (curView !== 'diff') return;
  curView = 'text';
  syncSeg('text');
  mountScroller('text', 0);
  restoreViewStatus('text');
}

// ---------- edit (back to the fix-it textarea, content kept) ----------
function enterEdit(): void {
  if (mode !== 'loaded' || !vm) return;
  closeSearch();
  closeDiffPanel();
  out.hidden = true;
  setTa(lastRaw, false);
  setMode('editing');
  inTa.focus();
  inTa.setSelectionRange(1e9, 1e9); // clamps to end
}

// exit → unchanged restores free; edits run ONE parse (Esc / Edit = apply).
// vm/scroller are never torn down on the unchanged path.
function exitEdit(): void {
  if (mode !== 'editing') return;
  clearTimeout(debounceT);
  const v = inTa.value;
  inTa.value = '';
  if (!v || /^\s*$/.test(v)) return resetToLanding();
  if (v === lastRaw) {
    out.hidden = false;
    setMode('loaded');
    return;
  }
  load(v); // errors land in error mode, caret at offset — the fix-it loop
}

// ---------- search (lazy island orchestration) ----------
async function ensureSearchMod(): Promise<typeof import('./search')> {
  if (!searchMod) searchMod = await import('./search');
  return searchMod;
}

function updSearchCount(): void {
  const st = searchSt;
  searchCount.classList.remove('bad');
  if (!st) {
    searchCount.textContent = '';
    return;
  }
  if (st.bad) {
    searchCount.textContent = 'bad pattern';
    searchCount.classList.add('bad');
    return;
  }
  const treeMode = curView === 'tree' && st.tree !== null;
  const n = treeMode ? st.tree!.visCount : st.starts.length;
  if (n === 0) {
    searchCount.textContent = 'no hits';
    return;
  }
  const notes = [
    treeMode ? '' : st.ms < 1 ? '<1 ms' : `${Math.round(st.ms)} ms`,
    st.partial ? 'stopped' : '',
  ].filter(Boolean).join(' · ');
  searchCount.textContent =
    `${st.cur + 1} / ${n.toLocaleString('en-US')}${notes ? ' · ' + notes : ''}`;
}

function gotoMatch(st: SearchState, k: number): void {
  const treeNav = curView === 'tree' && st.tree !== null;
  const n = treeNav ? st.tree!.visCount : st.starts.length;
  if (n === 0) return;
  st.cur = ((k % n) + n) % n;
  updSearchCount();
  if (!scroller) return;
  if (treeNav) {
    const t = st.tree!;
    const vi = t.pos[t.visNodeIds[st.cur]];
    const target = Math.max(0, vi * ROW_H - scroller.host.clientHeight / 2 + ROW_H / 2);
    // scroll change paints via its own event; same-window flips need a kick
    if (scroller.host.scrollTop !== target) scroller.host.scrollTop = target;
    else scroller.repaint();
  } else if (curView === 'text' && vm) {
    const line = searchMod!.lineOf(vm.lineStarts, st.starts[st.cur]);
    const target = Math.max(0, line * ROW_H - scroller.host.clientHeight / 2 + ROW_H / 2);
    if (scroller.host.scrollTop !== target) scroller.host.scrollTop = target;
    else scroller.repaint();
  }
}

function runQuery(): void {
  if (!vm || !searchMod) return;
  const q = searchIn.value;
  if (!q) {
    searchSt = null;
    scroller?.repaint();
    updSearchCount();
    return;
  }
  searchSt = searchMod.findAll(vm, q, { ci: searchCi, re: searchRe });
  if (curView === 'tree' && ft && searchSt.bad === '')
    searchMod.attachTree(searchSt, ft, visibleRows);
  if (curView === 'text') scroller?.repaint(); // window may be unchanged — marks must appear
  else if (curView === 'tree' && searchSt.tree) scroller?.repaint();
  if (searchSt.bad === '' && searchSt.cur >= 0) gotoMatch(searchSt, 0);
  else updSearchCount();
}

async function openSearch(): Promise<void> {
  if (mode !== 'loaded' || !vm || curView === 'diff') return;
  if (!searchOpen) {
    searchOpen = true;
    searchbar.hidden = false;
  }
  const mod = await ensureSearchMod();
  // text + tree take live marks; anything else lands on Text
  if (curView !== 'text' && curView !== 'tree') {
    curView = 'text';
    syncSeg('text');
    mountScroller('text', -1);
    restoreViewStatus('text');
  } else if (curView === 'tree' && ft && searchSt && !searchSt.tree) {
    mod.attachTree(searchSt, ft, visibleRows);
    scroller?.repaint();
  } else {
    scroller?.repaint(); // painter closure adapts via flags — repaint is enough
  }
  updSearchCount();
  requestAnimationFrame(() => {
    searchIn.focus();
    searchIn.select();
  });
}

function closeSearch(): void {
  if (!searchOpen) return;
  searchOpen = false;
  searchSt = null;
  searchbar.hidden = true;
  if (curView === 'text' || curView === 'tree') scroller?.repaint();
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
          lsLen: number;
          lineStartsBuf: ArrayBuffer;
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
        meta: new Int32Array(m.metaBuf),
        subtreeRows: new Int32Array(m.subtreeRowsBuf),
        keys: m.keys,
        vals: m.vals,
        rowCount: m.rowCount,
      };
      expanded = new Uint8Array(ft.rowCount).fill(1);
      visibleRows = buildVisible(ft, expanded);
      // search bar open → build hit tables now that columns exist
      if (searchOpen && searchSt && searchMod && !searchSt.tree && !searchSt.bad) {
        searchMod.attachTree(searchSt, ft, visibleRows);
        updSearchCount();
      }
      if (mode === 'loaded' && curView === 'tree' && scroller) {
        fmtTreeStatus();
        scroller.setRowCount(visibleRows.length);
        if (searchSt?.tree && searchOpen) scroller.repaint();
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
        statusbar.textContent = ''; // clear 'preparing minified…'
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
      source: undefined, // big path: value lives in the worker
      indent: m.indent,
      lineStarts: new Uint32Array(m.lineStartsBuf, 0, m.lsLen),
      lines: m.lines,
      maxLen: m.maxLen,
      tokM: null,
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
  diffRes = null; // new doc invalidates any diff
  alignedRes = null;
  lastBVal = null;
  closeSearch(); // offsets are doc-scoped — fresh doc, fresh search
  if (panelOpen) dpStatus.textContent = 'doc changed — press Diff';
  if (curView === 'diff') {
    curView = 'text';
    syncSeg('text');
  }

  if (raw.length > WORKER_THRESHOLD) {
    parsedValue = undefined;
    vm = null;
    ft = null;
    expanded = null;
    visibleRows = null;
    scroller?.destroy();
    scroller = null;
    setMode('working');
    // streaming preview: show raw immediately while worker parses
    out.hidden = false;
    viewEl.innerHTML = '';
    rawprev.hidden = false;
    rawprev.innerHTML =
      '<span class="working-chip">formatting…</span>' +
      esc(raw.slice(0, PREVIEW_CHARS).replace(/(.{200})/g, '$1\n')) +
      '\n…';
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
  setTa(lastRaw, false);
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
      // search-active branch costs two falsy checks per WINDOW paint —
      // zero paste-path impact (flags only flip on explicit user action)
      paint: (a, b) =>
        searchOpen && searchSt && searchMod
          ? searchMod.rowHtml(vm!, searchSt, a, b)
          : textHtml(vm!, a, b),
    });
    scroller.setWidth(vm!.maxLen * charW + 72);
    scroller.setRowCount(vm!.lines);
  } else if (v === 'min') {
    scroller = new VScroll(viewEl, {
      rowH: ROW_H,
      overscan: OVERSCAN,
      paint: (a, b) => minHtml(vm!, a, b),
    });
    if (vm!.min === null && parsedValue !== undefined) {
      // small path: the worker holds no cache for this doc — build locally
      // (measured 0.7–3ms on real-world files)
      ensureMin(vm!);
      buildMinTokens(vm!);
    }
    const minStr = vm!.min;
    if (minStr === null) {
      // big path: lazy via worker, paint chip meanwhile
      ensureWorker().postMessage({ type: 'getMin', id: reqId });
      statusbar.textContent = 'preparing minified…';
      scroller.setWidth(0);
      scroller.setRowCount(0);
    } else {
      scroller.setWidth(minStr.length * charW + 72);
      scroller.setRowCount(minRowCount(vm!));
    }
  } else if (v === 'diff') {
    const mod = diffMod!;
    const sbs = diffSbs && alignedRes !== null;
    scroller = new VScroll(viewEl, {
      rowH: ROW_H,
      overscan: OVERSCAN,
      paint: (a, b) =>
        sbs ? mod.sbsHtml(alignedRes!, a, b) : mod.diffHtml(diffRes!, a, b),
    });
    if (sbs || !diffRes) {
      scroller.setWidth(0); // flex columns — full width
    } else {
      const est = Math.min(20000, diffRes.maxChars * charW + 72);
      // tint bars span at least the viewport — no mid-screen cutoff on small docs
      scroller.setWidth(Math.max(viewEl.clientWidth || 0, est, 600));
    }
    scroller.setRowCount(sbs ? alignedRes!.rowCount : (diffRes?.rowCount ?? 0));
  } else {
    if (!ft) {
      if (parsedValue !== undefined) {
        // small doc: tree is lazy — flatten on first Tree mount (self-labeled)
        ft = flatten(parsedValue, vm?.lines);
        expanded = new Uint8Array(ft.rowCount).fill(1);
        visibleRows = buildVisible(ft, expanded);
      } else {
        // big doc: columns live in the worker — request transfer
        ensureWorker().postMessage({ type: 'getTree', id: reqId });
        statusbar.textContent = 'building tree…';
      }
    }
    // bar open + fresh query → tree hit tables before first paint
    if (ft && searchOpen && searchSt && searchMod && !searchSt.tree && !searchSt.bad)
      searchMod.attachTree(searchSt, ft, visibleRows);
    const visNow = visibleRows;
    scroller = new VScroll(viewEl, {
      rowH: ROW_H,
      overscan: OVERSCAN,
      paint: (a, b) =>
        searchOpen && searchSt && searchMod && searchSt.tree
          ? searchMod.treeRowHtml(ft!, expanded!, visibleRows!, searchSt, a, b)
          : treeHtml(ft!, expanded!, visibleRows!, a, b),
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
  if (curView === 'diff') {
    curView = 'text'; // doc changed (worker path) — diff is stale
    syncSeg('text');
  }
  mountScroller(curView, 0);
  fmtStatus(ms);
}

// ---------- interactions ----------

// paste anywhere on the page
document.addEventListener('paste', (e: ClipboardEvent) => {
  if (panelOpen) {
    // paste while the diff panel is open = JSON B — auto-run, product is speed
    const tb = e.clipboardData?.getData('text/plain');
    if (!tb) return;
    e.preventDefault();
    diffTa.value = tb;
    lastDiffRaw = tb;
    void runDiff(tb);
    return;
  }
  if (document.activeElement === inTa) return; // native path via input event
  const t = e.clipboardData?.getData('text/plain');
  if (!t) return;
  e.preventDefault();
  load(t);
});

// paste into the textarea = PRIMARY path: zero debounce, instant load.
// Editing is sticky — native insert only, parse happens once on exit.
inTa.addEventListener('paste', (e: ClipboardEvent) => {
  if (mode === 'editing') return;
  const t = e.clipboardData?.getData('text/plain');
  if (!t) return; // let native insert fire input path
  e.preventDefault();
  clearTimeout(debounceT);
  setTa(t);
  load(t);
});

// typing / native fallback paste into textarea (debounced)
let debounceT = 0;
inTa.addEventListener('input', () => {
  if (mode === 'editing') return; // sticky: no parse per keystroke
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
  if (el.id === 'btn-edit') return mode === 'editing' ? exitEdit() : enterEdit();
  if (el.id === 'btn-copyp') return copyText(vm?.pretty ?? '');
  if (el.id === 'btn-copym') {
    if (!vm) return;
    if (vm.min !== null) return copyText(vm.min);
    if (vm.source !== undefined) return copyText(ensureMin(vm)); // small path: local
    wantCopyMin = true;
    ensureWorker().postMessage({ type: 'getMin', id: reqId });
    toast('preparing…');
    return;
  }
  const v = el.dataset.view as ViewName | undefined;
  if (v === 'diff') {
    // seg is a mode toggle: click again = leave diff, back to Text
    if (curView === 'diff') exitDiff();
    else void openDiff();
    return;
  }
  if (v && v !== curView) {
    // leaving a view with a lazy build in flight → abort it: bumping reqId
    // makes the stale reply drop on arrival (worker has no message-level cancel)
    if ((curView === 'min' && vm && vm.min === null) || (curView === 'tree' && ft === null)) {
      reqId++;
      wantCopyMin = false;
    }
    curView = v;
    syncSeg(v);
    // clear view-scoped chips ('preparing minified…', 'building tree…') —
    // they are write-only otherwise and outlive their view
    statusbar.textContent = '';
    // preserve scroll position across views by visual fraction
    const frac = scroller ? scroller.host.scrollTop / Math.max(1, scroller.host.scrollHeight) : 0;
    mountScroller(v, -1);
    restoreViewStatus(v);
    if (scroller) scroller.host.scrollTop = frac * scroller.host.scrollHeight;
    // match counts are view-scoped (text offsets vs visible nodes)
    if (searchOpen) updSearchCount();
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
  // bar open → visible match sequence changed; keep marks + nav in sync
  if (searchOpen && searchSt?.tree && searchMod) {
    searchMod.refreshTree(searchSt, ftL, visibleRows);
    updSearchCount();
  }
  let newTop = 0;
  for (let i = 0; i < visibleRows.length; i++) {
    if (visibleRows[i] === anchorNode) {
      newTop = i;
      break;
    }
  }
  sc.setRowCount(visibleRows.length);
  sc.host.scrollTop = newTop * ROW_H;
  if (searchSt?.tree && searchOpen && searchMod) sc.repaint();
});

// indent change
$<HTMLSelectElement>('sel-indent').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  indent = v === 'tab' ? '\t' : Number(v);
  if (!vm) return;
  reqId++;
  closeSearch(); // pretty rebuilt — offsets shifted
  if (parsedValue !== undefined) {
    const t0 = performance.now();
    vm = buildView(parsedValue, indent, bytesIn);
    ft = null;
    diffRes = null; // pretty changed — any diff is stale
    alignedRes = null;
    lastBVal = null;
    if (panelOpen) dpStatus.textContent = 'stale — press Diff';
    if (curView === 'diff') {
      curView = 'text';
      syncSeg('text');
    }
    mountScroller(curView, 0);
    const ms = performance.now() - t0;
    fmtStatus(ms);
    if (curView === 'tree') fmtTreeStatus();
  } else {
    ensureWorker().postMessage({ type: 'reformat', id: reqId, indent });
  }
});

async function copyText(s: string): Promise<void> {
  if (!s) return;
  try {
    await navigator.clipboard.writeText(s);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(`Copied ${humanBytes(s.length)}`);
}

function resetToLanding(): void {
  reqId++;
  vm = null;
  ft = null;
  parsedValue = undefined;
  expanded = null;
  visibleRows = null;
  diffRes = null;
  alignedRes = null;
  lastBVal = null;
  curView = 'text';
  closeSearch();
  closeDiffPanel();
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

// Esc = close diff panel, else close search, else leave diff, else clear
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (panelOpen) return closeDiffPanel();
  if (searchOpen) return closeSearch();
  if (curView === 'diff') return exitDiff();
  if (mode === 'editing') return exitEdit();
  if (mode !== 'landing') resetToLanding();
});

// ⌘F / Ctrl+F = find in document (loaded mode only; diff keeps browser find)
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
    if (mode === 'loaded' && curView !== 'diff') {
      e.preventDefault();
      void openSearch();
    }
  }
});

// diff panel controls
diffTa.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    lastDiffRaw = diffTa.value.trim();
    if (!lastDiffRaw) return;
    void runDiff(lastDiffRaw);
  }
});
$('btn-diff-run').addEventListener('click', () => {
  lastDiffRaw = diffTa.value.trim();
  if (!lastDiffRaw) return;
  void runDiff(lastDiffRaw);
});
$('btn-diff-cancel').addEventListener('click', () => {
  diffTa.value = '';
  lastDiffRaw = '';
  lastBVal = null;
  diffRes = null;
  alignedRes = null;
  dpStatus.textContent = 'paste JSON B';
});
$('btn-dp-close').addEventListener('click', closeDiffPanel);
$('btn-dp-focus').addEventListener('click', () => void setDiffMode(false));
$('btn-dp-sbs').addEventListener('click', () => void setDiffMode(true));

// search controls
$('btn-find').addEventListener('click', () => void openSearch());
function syncSearchToggles(): void {
  btnSearchCase.classList.toggle('on', searchCi);
  btnSearchCase.setAttribute('aria-pressed', String(searchCi));
  btnSearchRe.classList.toggle('on', searchRe);
  btnSearchRe.setAttribute('aria-pressed', String(searchRe));
}
btnSearchCase.addEventListener('click', () => {
  searchCi = !searchCi;
  syncSearchToggles();
  runQuery();
});
btnSearchRe.addEventListener('click', () => {
  searchRe = !searchRe;
  syncSearchToggles();
  runQuery();
});
searchIn.addEventListener('input', runQuery);
searchIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (searchSt && searchSt.starts.length > 0)
      gotoMatch(searchSt, searchSt.cur + (e.shiftKey ? -1 : 1));
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
  }
});
$('btn-search-prev').addEventListener('click', () => {
  if (searchSt && searchSt.starts.length > 0) gotoMatch(searchSt, searchSt.cur - 1);
});
$('btn-search-next').addEventListener('click', () => {
  if (searchSt && searchSt.starts.length > 0) gotoMatch(searchSt, searchSt.cur + 1);
});
$('btn-search-close').addEventListener('click', closeSearch);

// ---------- clipboard auto-load (best effort, zero main-thread cost) ----------
// Browser reality:
//  - Chrome/Edge: works on load ONLY if clipboard permission already granted;
//    first-use shows the permission prompt when called during a gesture.
//  - Firefox: requires a gesture per read — shows its paste doorhanger.
//  - Safari: gesture + its own paste confirmation.
// Strategy: attempt on load (covers granted permission = instant auto-load),
// then retry on EVERY user activation until success (prompt shows once,
// permission persists → all future visits auto-load).
const CLIPBOARD_CAP = 8 * 1024 * 1024; // 8MB guard
let clipLoaded = false;
let clipPending = false;
let clipIrrelevant = false;   // clipboard readable but no JSON — stop retrying

// cheap leading-char probe before paying for a parse
function looksLikeJson(t: string): boolean {
  let i = 0;
  const n = t.length;
  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  if (i >= n) return false;
  const c = t.charCodeAt(i);
  return (
    c === 123 || c === 91 || c === 34 || // { [ "
    (c >= 48 && c <= 57) || c === 45 || c === 116 || c === 102 || c === 110 // - 0-9 t f n
  );
}

async function tryClipboardAuto(): Promise<void> {
  if (clipLoaded || clipIrrelevant || clipPending || mode !== 'landing') return;
  const read = navigator.clipboard?.readText;
  if (!read) return; // no API (old browser) — Ctrl+V hint covers it
  clipPending = true;
  try {
    const t = await read.call(navigator.clipboard);
    if (!t || t.length > CLIPBOARD_CAP || !looksLikeJson(t)) {
      // readable but no JSON — stop retrying, clipboard holds something else
      clipIrrelevant = true;
      return;
    }
    if (mode !== 'landing') return; // user acted first — never race them
    clipLoaded = true;
    setTa(t);
    load(t);
    toast('Loaded from clipboard');
  } catch {
    /* denied / needs gesture — retried silently on next activation */
  } finally {
    clipPending = false;
  }
}

// after first paint, off the critical path (works when permission granted)
requestAnimationFrame(() => setTimeout(() => void tryClipboardAuto(), 0));

// every user activation retries — Firefox/Safari need the gesture for their
// paste prompt; once allowed, the permission persists for future visits.
// Gestures on interactive elements (links, buttons, inputs) are NOT paste
// intents — stealing them broke footer navigation.
const PASTE_STEAL_SKIP = 'a, button, select, input, textarea';
const clipRetry = (e: Event): void => {
  if (e.target instanceof Element && e.target.closest(PASTE_STEAL_SKIP)) return;
  if (!clipLoaded && mode === 'landing') void tryClipboardAuto();
};
document.addEventListener('pointerdown', clipRetry);
document.addEventListener('touchstart', clipRetry, { passive: true });
document.addEventListener('keydown', clipRetry);
window.addEventListener('focus', clipRetry);

// Compile the large-paste worker after landing listeners are ready. The
// fallback keeps older browsers off the first interaction when possible.
const idle = (window as Window & {
  requestIdleCallback?: (callback: () => void) => number;
}).requestIdleCallback;
if (idle) idle.call(window, () => { ensureWorker(); });
else setTimeout(() => { ensureWorker(); }, 1);

// service worker (prod only)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
