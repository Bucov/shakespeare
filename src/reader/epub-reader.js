import ePub from 'epubjs';
import { FONT_STACKS } from '../settings.js';
import garamond400 from '@fontsource/eb-garamond/files/eb-garamond-latin-400-normal.woff2?url';
import garamond400i from '@fontsource/eb-garamond/files/eb-garamond-latin-400-italic.woff2?url';
import garamond600 from '@fontsource/eb-garamond/files/eb-garamond-latin-600-normal.woff2?url';

const THEME_COLORS = {
  dark: { fg: '#e4ddcc', bg: '#0e0d0b', accent: '#c2a878' },
  light: { fg: '#2b2519', bg: '#f3eddd', accent: '#8a6d3b' },
};

const LOCATIONS_PER = 900; // characters per "location" for the progress scale

const MONO_STACK = 'ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace';

function fontFaceCss() {
  const abs = (u) => new URL(u, document.baseURI).href;
  return `
    @font-face { font-family: "EB Garamond"; font-style: normal; font-weight: 400;
      src: url("${abs(garamond400)}") format("woff2"); }
    @font-face { font-family: "EB Garamond"; font-style: italic; font-weight: 400;
      src: url("${abs(garamond400i)}") format("woff2"); }
    @font-face { font-family: "EB Garamond"; font-style: normal; font-weight: 600;
      src: url("${abs(garamond600)}") format("woff2"); }
  `;
}

function renditionOptions(layout) {
  const base = { width: '100%', height: '100%', allowScriptedContent: false };
  switch (layout) {
    case 'double':
      return { ...base, flow: 'paginated', spread: 'auto', minSpreadWidth: 700 };
    case 'scroll':
      return { ...base, flow: 'scrolled-doc' };
    default:
      return { ...base, flow: 'paginated', spread: 'none' };
  }
}

export class EpubReader {
  kind = 'epub';

  /**
   * @param container element the book renders into
   * @param record    library record ({ data: ArrayBuffer, ... })
   * @param settings  current reader settings
   * @param callbacks { onProgress({fraction,label,position,tocId}), onKey(event) }
   */
  constructor(container, record, settings, callbacks) {
    this.container = container;
    this.record = record;
    this.settings = settings;
    this.callbacks = callbacks;
    this.rendition = null;
    this.currentCfi = null;
    this.currentHref = null;
    this.tocFlat = [];
    this.destroyed = false;
  }

  async open(initialPosition) {
    this.book = ePub(this.record.data);
    // epub.js swallows open failures into an event and leaves `ready` pending
    // forever, so race the two — otherwise a corrupt file hangs the loader.
    await Promise.race([
      this.book.ready,
      new Promise((_, reject) => {
        this.book.on('openFailed', (err) => reject(err instanceof Error ? err : new Error('EPUB failed to open')));
      }),
    ]);

    const nav = await this.book.loaded.navigation;
    this.toc = (nav.toc || []).map((item) => this.mapTocItem(item));

    await this.renderRendition(initialPosition?.cfi || undefined);
    this.prepareLocations();
  }

  mapTocItem(item) {
    const mapped = {
      id: item.href,
      label: (item.label || '').trim() || 'Untitled',
      target: item.href,
      children: (item.subitems || []).map((s) => this.mapTocItem(s)),
    };
    this.tocFlat.push(mapped);
    return mapped;
  }

  async renderRendition(target) {
    if (this.rendition) {
      this.rendition.destroy();
      this.rendition = null;
    }
    this.container.innerHTML = '';

    const rendition = this.book.renderTo(this.container, renditionOptions(this.settings.layout));
    this.rendition = rendition;

    rendition.hooks.content.register((contents) => {
      contents.addStylesheetCss(fontFaceCss(), 'shx-fonts');
      contents.addStylesheetCss(this.contentCss(), 'shx-style');
    });

    rendition.on('relocated', (location) => this.handleRelocated(location));
    rendition.on('keydown', (event) => this.callbacks.onKey?.(event));

    await rendition.display(target);
  }

  // One stylesheet, rebuilt from settings and injected under a fixed key so a
  // re-apply fully replaces the previous version (epub.js's own themes.select
  // leaves the old theme's stylesheet behind, so toggling breaks — we bypass
  // it). Publisher styles are overridden wholesale: the reader shows plain
  // text on the app's background, in the reader's colors, face, and size.
  contentCss() {
    const colors = this.settings.theme === 'light' ? THEME_COLORS.light : THEME_COLORS.dark;
    const stack = FONT_STACKS[this.settings.font] || FONT_STACKS.garamond;
    return `
      html, body { background: transparent !important; }
      body * { background: transparent !important; }
      body, body > * { border: 0 !important; box-shadow: none !important; outline: 0 !important; }
      body { color: ${colors.fg} !important; }
      body * { color: inherit !important; }
      a[href], a[href] * { color: ${colors.accent} !important; }
      body, body * { font-family: ${stack} !important; }
      body pre, body code, body kbd, body samp, body tt,
      body pre *, body code * { font-family: ${MONO_STACK} !important; }
      html { font-size: ${this.settings.fontSize}% !important; }
      body { font-size: 1em !important; line-height: 1.65 !important; }
      body p, body li, body blockquote, body dd, body dt {
        font-size: 1em !important;
        line-height: 1.65 !important;
      }
      img, image, svg { max-width: 100% !important; }
    `;
  }

  applyTextStyles() {
    for (const contents of this.rendition.getContents()) {
      contents.addStylesheetCss(this.contentCss(), 'shx-style');
    }
  }

  // Locations give a stable percentage scale across the whole book. Generating
  // them takes a moment, so it runs in the background and is cached on the
  // library record afterwards.
  async prepareLocations() {
    try {
      if (this.record.locations) {
        this.book.locations.load(this.record.locations);
      } else {
        await this.book.locations.generate(LOCATIONS_PER);
        if (this.destroyed) return;
        this.callbacks.onLocations?.(this.book.locations.save());
      }
      // Re-announce progress now that percentages are meaningful.
      if (this.currentCfi) this.emitProgress();
    } catch {
      /* progress bar falls back to chapter-relative position */
    }
  }

  handleRelocated(location) {
    this.currentCfi = location.start.cfi;
    this.currentHref = location.start.href;
    this.emitProgress();
  }

  emitProgress() {
    let fraction = null;
    if (this.book.locations && this.book.locations.length()) {
      fraction = this.book.locations.percentageFromCfi(this.currentCfi);
    }
    const tocItem = this.tocItemForHref(this.currentHref);
    this.callbacks.onProgress?.({
      fraction,
      label: tocItem ? tocItem.label : '',
      tocId: tocItem ? tocItem.id : null,
      position: { cfi: this.currentCfi, fraction },
    });
  }

  tocItemForHref(href) {
    if (!href) return null;
    const clean = href.split('#')[0];
    let match = null;
    for (const item of this.tocFlat) {
      if (item.target.split('#')[0] === clean) match = match || item;
    }
    return match;
  }

  getToc() {
    return this.toc;
  }

  async getMetadata() {
    const meta = await this.book.loaded.metadata;
    return { title: meta.title || this.record.name, author: meta.creator || '' };
  }

  next() {
    return this.rendition?.next();
  }

  prev() {
    return this.rendition?.prev();
  }

  goTo(target) {
    return this.rendition?.display(target);
  }

  async seek(fraction) {
    if (!this.book.locations || !this.book.locations.length()) return;
    const cfi = this.book.locations.cfiFromPercentage(Math.min(1, Math.max(0, fraction)));
    if (cfi) await this.rendition.display(cfi);
  }

  async applySettings(settings) {
    const layoutChanged = settings.layout !== this.settings.layout;
    this.settings = settings;
    if (layoutChanged) {
      await this.renderRendition(this.currentCfi || undefined);
    } else {
      this.applyTextStyles();
    }
  }

  destroy() {
    this.destroyed = true;
    try {
      this.rendition?.destroy();
      this.book?.destroy();
    } catch {
      /* epub.js can throw during teardown of half-loaded books */
    }
    this.container.innerHTML = '';
  }
}
