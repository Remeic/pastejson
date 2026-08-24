// Minimal fixed-row-height virtual scroller. No deps.
// DOM: .vscroll (scroll container) > .vs-spacer (total height) + .vs-win (translated window)
// One innerHTML assignment per paint frame (rAF-throttled).

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
    this.spacer.style.height = n * this.opts.rowH + 'px';
    this.applyWidth();
    this.paintNow();
  }

  setWidth(px: number): void {
    this.widthPx = px;
    this.applyWidth();
  }

  private applyWidth(): void {
    const w = this.widthPx > 0 ? Math.min(this.widthPx, 20000) : 0;
    this.spacer.style.width = w ? w + 'px' : '100%';
    this.win.style.width = w ? w + 'px' : '100%';
  }

  scrollToTop(): void {
    this.host.scrollTop = 0;
  }

  // keep node `anchor` (row index in VISUAL space) at same viewport spot after data change
  reveal(anchorVisual: number): void {
    const h = this.host.clientHeight;
    const target = Math.max(0, anchorVisual * this.opts.rowH - h / 2);
    this.host.scrollTop = target;
  }

  private onScroll = (): void => {
    if (!this.ticking) {
      this.ticking = true;
      requestAnimationFrame(this.doPaint);
    }
  };

  schedule(): void {
    if (!this.ticking) {
      this.ticking = true;
      requestAnimationFrame(this.doPaint);
    }
  }

  paintNow(): void {
    this.ticking = false;
    const rowH = this.opts.rowH;
    const overscan = this.opts.overscan ?? 6;
    const first = Math.max(0, Math.floor(this.host.scrollTop / rowH) - overscan);
    const count = Math.ceil(this.host.clientHeight / rowH) + overscan * 2;
    const last = Math.min(first + count, this.rowCount);
    const realFirst = Math.min(first, Math.max(0, this.rowCount - 1));
    const html = this.rowCount === 0 ? '' : this.opts.paint(realFirst, Math.max(0, last - realFirst));
    this.win.innerHTML = html;
    this.win.style.transform = 'translateY(' + realFirst * rowH + 'px)';
  }

  private doPaint = (): void => {
    this.paintNow();
  };

  destroy(): void {
    this.host.removeEventListener('scroll', this.onScroll);
    this.ro?.disconnect();
  }
}
