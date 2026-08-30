// Minimal fixed-row-height virtual scroller. No deps.
// DOM: .vscroll (scroll container) > .vs-spacer (total height) + .vs-win (translated window)
// One innerHTML assignment per paint frame (rAF-coalesced; scroll events land before rAF,
// so programmatic scrollTop set + paint collapse into a single paint).

export interface VScrollOpts {
  rowH: number;
  overscan?: number;
  paint: (first: number, count: number) => string;
}

export class VScroll {
  host: HTMLElement;
  private spacer: HTMLElement;
  private win: HTMLElement;
  private opts: VScrollOpts;
  private rowCount = 0;
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
  private destroyed = false;
  private firstPaintDone = false;
  private pendingPainter: ((first: number, count: number) => string) | null = null;

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
    const h = n * this.opts.rowH + 'px';
    if (h !== this.wSpacerH) {
      this.wSpacerH = h;
      this.spacer.style.height = h;
    }
    this.applyWidth();
    // defer to rAF: pending scroll events fire first → single correct paint
    this.schedule();
  }

  setWidth(px: number): void {
    if (px === this.widthPx) return;
    this.widthPx = px;
    this.applyWidth();
  }

  // Hydration may arrive before the first provisional rAF. Keep that first
  // frame on the provisional painter so it can reach a browser paint.
  setPainter(paint: (first: number, count: number) => string): void {
    if (!this.firstPaintDone && this.rowCount > 0) {
      this.pendingPainter = paint;
      return;
    }
    this.opts.paint = paint;
    this.pFirst = -1;
    this.pCount = -1;
    this.schedule();
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
    const target = Math.max(0, anchorVisual * this.opts.rowH - h / 2);
    this.host.scrollTop = target;
  }

  private readonly onScroll = (): void => this.schedule();

  schedule(): void {
    if (!this.ticking) {
      this.ticking = true;
      requestAnimationFrame(this.doPaint);
    }
  }

  private paintNow(): void {
    if (this.destroyed) return;
    this.ticking = false;
    const rowH = this.opts.rowH;
    const overscan = this.opts.overscan ?? 6;
    const first = Math.max(0, Math.floor(this.host.scrollTop / rowH) - overscan);
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
    this.win.style.transform = 'translateY(' + realFirst * rowH + 'px)';
    if (!this.firstPaintDone) {
      this.firstPaintDone = true;
      const pending = this.pendingPainter;
      this.pendingPainter = null;
      if (pending) {
        this.opts.paint = pending;
        this.pFirst = -1;
        this.pCount = -1;
        this.schedule();
      }
    }
  }

  private readonly doPaint = (): void => this.paintNow();

  destroy(): void {
    this.destroyed = true;
    this.pendingPainter = null;
    this.host.removeEventListener('scroll', this.onScroll);
    this.ro?.disconnect();
  }
}
