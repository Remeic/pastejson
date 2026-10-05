// Minimal fixed-row-height virtual scroller. No deps.
// DOM: .vscroll (scroll container) > .vs-spacer (total height) + .vs-win (translated window)
// One innerHTML assignment per paint frame (rAF-coalesced; scroll events land before rAF,
// so programmatic scrollTop set + paint collapse into a single paint).

export interface VScrollOpts {
  rowH: number;
  overscan?: number;
  paint: (first: number, count: number) => string;
}

// Browsers cap element scroll height (~33.5M px Chrome, ~17.9M Firefox). Past
// that, rows are unreachable: the spacer clamps and search/scroll can never
// reach a deep match. When content exceeds this safe floor we compress the
// scroll space proportionally (scale<1) so the WHOLE document stays reachable.
const MAX_SCROLL_H = 10_000_000;

export class VScroll {
  host: HTMLElement;
  private spacer: HTMLElement;
  private win: HTMLElement;
  private opts: VScrollOpts;
  private rowCount = 0;
  private scrollH = 0; // spacer height in px (capped when the doc is huge)
  private widthPx = 0;
  private ticking = false;
  private painted = false;
  private ro: ResizeObserver | null = null;
  // last-written style values — skip redundant style writes
  private wSpacerH = '';
  private wSpacerW = '';
  private wWinW = '';
  // last painted window — skip identical innerHTML/transform writes
  private pFirst = -1;
  private pCount = -1;
  private pRows = -1;

  constructor(host: HTMLElement, opts: VScrollOpts) {
    this.host = host;
    this.opts = opts;
    host.classList.add('vscroll');
    host.innerHTML =
      '<div class="vs-spacer"></div><div class="vs-win"></div>';
    this.spacer = host.firstElementChild as HTMLElement;
    this.win = host.lastElementChild as HTMLElement;

    host.addEventListener('scroll', this.onScroll, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        if (this.painted) this.schedule();
      });
      this.ro.observe(host);
    }
  }

  setRowCount(n: number): void {
    this.rowCount = n;
    this.painted = true;
    const contentH = n * this.opts.rowH;
    this.scrollH = contentH > MAX_SCROLL_H ? MAX_SCROLL_H : contentH;
    const h = this.scrollH + 'px';
    if (h !== this.wSpacerH) {
      this.wSpacerH = h;
      this.spacer.style.height = h;
    }
    this.applyWidth();
    // defer to rAF: pending scroll events fire first → single correct paint
    this.schedule();
  }

  // Rows per scroll px. Normally 1/rowH. For docs taller than the browser cap
  // the spacer is clamped to MAX_SCROLL_H, so scroll is compressed: map the
  // whole top-row range [0, N-V] onto the scrollable range so the LAST row
  // stays reachable (V = rows that fit the viewport).
  private rowsPerPx(): number {
    const h = this.host.clientHeight;
    const v = Math.ceil(h / this.opts.rowH);
    const n = this.rowCount;
    if (n <= v) return 0;
    return (n - v) / Math.max(1, this.scrollH - h);
  }

  private topRowFor(scrollTop: number): number {
    return scrollTop * this.rowsPerPx();
  }

  setWidth(px: number): void {
    if (px === this.widthPx) return;
    this.widthPx = px;
    this.applyWidth();
  }

  private applyWidth(): void {
    const w = this.widthPx > 0 ? Math.min(this.widthPx, 20000) : 0;
    const ws = w ? w + 'px' : '100%';
    if (ws !== this.wSpacerW) {
      this.wSpacerW = ws;
      this.spacer.style.width = ws;
    }
    if (ws !== this.wWinW) {
      this.wWinW = ws;
      this.win.style.width = ws;
    }
  }

  scrollToTop(): void {
    this.host.scrollTop = 0;
  }

  // Scroll so `row` is centred. Always repaint: the window can be identical
  // while caller state (the current search match) changed, and paintNow's
  // window dedupe would otherwise skip it (stale highlight).
  scrollToRow(row: number): void {
    const h = this.host.clientHeight;
    const v = Math.ceil(h / this.opts.rowH);
    const n = this.rowCount;
    if (n === 0) return;
    const top = Math.max(0, Math.min(n - v, row - v / 2));
    const rpp = this.rowsPerPx();
    const target = rpp > 0 ? top / rpp : 0;
    if (this.host.scrollTop !== target) this.host.scrollTop = target;
    this.repaint();
  }

  // force the next paint even when the visible window is unchanged
  // (paint-state flips without touching scroll — e.g. search marks)
  repaint(): void {
    this.pFirst = -1;
    this.pCount = -1;
    this.schedule();
  }

  // keep node `anchor` (row index in VISUAL space) at same viewport spot after data change
  reveal(anchorVisual: number): void {
    const h = this.host.clientHeight;
    const v = Math.ceil(h / this.opts.rowH);
    const n = this.rowCount;
    if (n === 0) return;
    const top = Math.max(0, Math.min(n - v, anchorVisual - v / 2));
    const rpp = this.rowsPerPx();
    this.host.scrollTop = rpp > 0 ? top / rpp : 0;
  }

  private readonly onScroll = (): void => this.schedule();

  schedule(): void {
    if (!this.ticking) {
      this.ticking = true;
      requestAnimationFrame(this.doPaint);
    }
  }

  private paintNow(): void {
    this.ticking = false;
    const rowH = this.opts.rowH;
    const overscan = this.opts.overscan ?? 6;
    // row (float) sitting at the viewport top, in compressed scroll space
    const rt = this.topRowFor(this.host.scrollTop);
    const first = Math.max(0, Math.floor(rt) - overscan);
    const count = Math.ceil(this.host.clientHeight / rowH) + overscan * 2;
    const last = Math.min(first + count, this.rowCount);
    const realFirst = Math.min(first, Math.max(0, this.rowCount - 1));
    const n = Math.max(0, last - realFirst);
    if (realFirst === this.pFirst && n === this.pCount && this.rowCount === this.pRows) return;
    this.pFirst = realFirst;
    this.pCount = n;
    this.pRows = this.rowCount;
    const html = this.rowCount === 0 ? '' : this.opts.paint(realFirst, n);
    this.win.innerHTML = html;
    // Place the window so row `rt` lands at the viewport top. At 1:1 this is
    // exactly realFirst*rowH (unchanged); compressed, the window rides the
    // mapped offset so deep rows stay reachable.
    this.win.style.transform = 'translateY(' + (this.host.scrollTop - (rt - realFirst) * rowH) + 'px)';
  }

  private readonly doPaint = (): void => this.paintNow();

  destroy(): void {
    this.host.removeEventListener('scroll', this.onScroll);
    this.ro?.disconnect();
  }
}
