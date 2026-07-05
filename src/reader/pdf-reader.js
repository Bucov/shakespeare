import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const SCROLL_MAX_WIDTH = 860;
const RENDERED_KEEP = 12; // in scroll mode, keep canvases within this page distance

export class PdfReader {
  kind = 'pdf';

  constructor(container, record, settings, callbacks) {
    this.container = container;
    this.record = record;
    this.settings = settings;
    this.callbacks = callbacks;
    this.page = 1;
    this.renderToken = 0;
    this.tocFlat = [];
    this.slots = [];
    this.destroyed = false;
  }

  async open(initialPosition) {
    // pdf.js takes ownership of the buffer, so hand it a copy and keep the
    // original intact for the IndexedDB record.
    const data = this.record.data.slice(0);
    this.pdf = await pdfjs.getDocument({ data }).promise;
    this.numPages = this.pdf.numPages;
    this.page = this.clampPage(initialPosition?.page || 1);

    this.toc = await this.buildToc();
    this.resolveOutlinePages(); // background; enables chapter highlighting

    await this.buildStage();

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(this.container);
  }

  clampPage(p) {
    return Math.min(this.numPages, Math.max(1, Math.round(p)));
  }

  /* ————— Contents ————— */

  async buildToc() {
    let outline = null;
    try {
      outline = await this.pdf.getOutline();
    } catch {
      /* malformed outline — treat as none */
    }
    if (!outline || outline.length === 0) return [];
    let counter = 0;
    const map = (item) => {
      const mapped = {
        id: `outline-${counter++}`,
        label: (item.title || '').trim() || 'Untitled',
        target: { dest: item.dest },
        page: null,
        children: (item.items || []).map(map),
      };
      this.tocFlat.push(mapped);
      return mapped;
    };
    return outline.map(map);
  }

  async pageForDest(dest) {
    const d = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
    if (!Array.isArray(d) || !d[0]) return null;
    const idx = await this.pdf.getPageIndex(d[0]);
    return idx + 1;
  }

  async resolveOutlinePages() {
    for (const item of this.tocFlat) {
      if (this.destroyed) return;
      try {
        item.page = await this.pageForDest(item.target.dest);
      } catch {
        /* unresolvable destination — item stays clickable-less */
      }
    }
    this.emitProgress();
  }

  getToc() {
    return this.toc;
  }

  async getMetadata() {
    let title = '';
    let author = '';
    try {
      const { info } = await this.pdf.getMetadata();
      title = info?.Title || '';
      author = info?.Author || '';
    } catch {
      /* no metadata */
    }
    return { title: title || this.record.name.replace(/\.pdf$/i, ''), author };
  }

  /* ————— Stage ————— */

  async buildStage() {
    this.renderToken++;
    this.slots = [];
    this.container.innerHTML = '';
    this.stage = document.createElement('div');
    this.stage.className = 'pdf-stage' + (this.settings.layout === 'scroll' ? ' pdf-scroll' : '');
    this.container.appendChild(this.stage);

    if (this.settings.layout === 'scroll') {
      await this.buildScroll();
    } else {
      await this.renderSpread();
    }
  }

  spreadFor(p) {
    if (this.settings.layout !== 'double') return [p];
    if (p === 1) return [1]; // the cover sits alone, as in a real book
    const left = p % 2 === 0 ? p : p - 1;
    return left + 1 <= this.numPages ? [left, left + 1] : [left];
  }

  async renderSpread() {
    const token = ++this.renderToken;
    const pages = this.spreadFor(this.page);
    this.page = pages[0];

    const availW = Math.max(120, this.stage.clientWidth - 56);
    const availH = Math.max(120, this.stage.clientHeight - 28);
    const gap = pages.length > 1 ? 20 : 0;
    const perW = (availW - gap) / pages.length;

    const pdfPages = await Promise.all(pages.map((p) => this.pdf.getPage(p)));
    if (token !== this.renderToken || this.destroyed) return;

    let scale = Infinity;
    for (const pg of pdfPages) {
      const vp = pg.getViewport({ scale: 1 });
      scale = Math.min(scale, perW / vp.width, availH / vp.height);
    }

    this.stage.innerHTML = '';
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    for (const pg of pdfPages) {
      const viewport = pg.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page';
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
      this.stage.appendChild(canvas);
      await pg.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (token !== this.renderToken) return;
    }
    this.emitProgress();
  }

  async buildScroll() {
    const first = await this.pdf.getPage(1);
    const vp1 = first.getViewport({ scale: 1 });
    this.pageRatio = vp1.height / vp1.width;

    const frag = document.createDocumentFragment();
    for (let i = 1; i <= this.numPages; i++) {
      const slot = document.createElement('div');
      slot.className = 'pdf-page';
      slot.dataset.page = String(i);
      frag.appendChild(slot);
      this.slots.push(slot);
    }
    this.stage.appendChild(frag);
    this.layoutScroll();

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.renderSlot(entry.target);
        }
      },
      { root: this.stage, rootMargin: '120% 0px' },
    );
    this.slots.forEach((slot) => this.observer.observe(slot));

    this.onScroll = () => {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = setTimeout(() => this.trackScrollPosition(), 140);
    };
    this.stage.addEventListener('scroll', this.onScroll, { passive: true });

    // Land on the saved page once the slots have laid out.
    requestAnimationFrame(() => this.scrollToPage(this.page, false));
    this.emitProgress();
  }

  layoutScroll() {
    this.slotWidth = Math.min(Math.max(160, this.stage.clientWidth - 48), SCROLL_MAX_WIDTH);
    for (const slot of this.slots) {
      slot.style.width = `${this.slotWidth}px`;
      if (!slot.dataset.rendered) {
        slot.style.height = `${Math.round(this.slotWidth * this.pageRatio)}px`;
      }
    }
  }

  async renderSlot(slot) {
    if (slot.dataset.rendered || this.destroyed) return;
    slot.dataset.rendered = '1';
    const num = Number(slot.dataset.page);
    try {
      const pg = await this.pdf.getPage(num);
      if (this.destroyed || !slot.isConnected) return;
      const vp1 = pg.getViewport({ scale: 1 });
      const scale = this.slotWidth / vp1.width;
      slot.style.height = `${Math.round(vp1.height * scale)}px`;

      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const viewport = pg.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = '100%';
      canvas.style.display = 'block';
      await pg.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (this.destroyed || !slot.isConnected) return;
      slot.replaceChildren(canvas);
      this.evictFarPages();
    } catch {
      delete slot.dataset.rendered;
    }
  }

  evictFarPages() {
    for (const slot of this.slots) {
      if (!slot.dataset.rendered) continue;
      if (Math.abs(Number(slot.dataset.page) - this.page) > RENDERED_KEEP) {
        delete slot.dataset.rendered;
        slot.replaceChildren();
      }
    }
  }

  trackScrollPosition() {
    const center = this.stage.scrollTop + this.stage.clientHeight / 2;
    for (const slot of this.slots) {
      if (slot.offsetTop <= center && center < slot.offsetTop + slot.offsetHeight) {
        const p = Number(slot.dataset.page);
        if (p !== this.page) {
          this.page = p;
          this.emitProgress();
        }
        break;
      }
    }
  }

  scrollToPage(p, smooth = true) {
    const slot = this.slots[p - 1];
    if (!slot) return;
    this.stage.scrollTo({
      top: Math.max(0, slot.offsetTop - 16),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  /* ————— Navigation ————— */

  async showPage(p) {
    this.page = this.clampPage(p);
    if (this.settings.layout === 'scroll') {
      this.scrollToPage(this.page);
      this.emitProgress();
    } else {
      await this.renderSpread();
    }
  }

  next() {
    const current = this.spreadFor(this.page);
    const target = current[current.length - 1] + 1;
    if (target <= this.numPages) return this.showPage(target);
  }

  prev() {
    const target = this.spreadFor(this.page)[0] - 1;
    if (target >= 1) return this.showPage(target);
  }

  async goTo(target) {
    const page = target.page ?? (await this.pageForDest(target.dest));
    if (page) await this.showPage(page);
  }

  seek(fraction) {
    const f = Math.min(1, Math.max(0, fraction));
    return this.showPage(1 + f * (this.numPages - 1));
  }

  emitProgress() {
    const fraction = this.numPages > 1 ? (this.page - 1) / (this.numPages - 1) : 1;
    let tocItem = null;
    for (const item of this.tocFlat) {
      if (item.page && item.page <= this.page) tocItem = item;
    }
    this.callbacks.onProgress?.({
      fraction,
      label: `Page ${this.page} of ${this.numPages}`,
      tocId: tocItem ? tocItem.id : null,
      position: { page: this.page, fraction },
    });
  }

  /* ————— Settings / lifecycle ————— */

  async applySettings(settings) {
    const layoutChanged = settings.layout !== this.settings.layout;
    this.settings = settings;
    if (layoutChanged) {
      this.teardownScroll();
      await this.buildStage();
    }
    // Theme & inversion are handled by CSS on the reader shell.
  }

  handleResize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.destroyed) return;
      if (this.settings.layout === 'scroll') {
        // Re-measure and let the observer re-render at the new width.
        for (const slot of this.slots) {
          delete slot.dataset.rendered;
          slot.replaceChildren();
        }
        this.layoutScroll();
        this.scrollToPage(this.page, false);
      } else {
        this.renderSpread();
      }
    }, 180);
  }

  teardownScroll() {
    this.observer?.disconnect();
    this.observer = null;
    if (this.onScroll && this.stage) this.stage.removeEventListener('scroll', this.onScroll);
    this.onScroll = null;
    this.slots = [];
  }

  destroy() {
    this.destroyed = true;
    this.renderToken++;
    clearTimeout(this.resizeTimer);
    clearTimeout(this.scrollTimer);
    this.resizeObserver?.disconnect();
    this.teardownScroll();
    this.pdf?.destroy();
    this.container.innerHTML = '';
  }
}
