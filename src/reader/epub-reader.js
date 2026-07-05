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

// Wheel distance to accumulate past the chapter's end before turning over.
const SCROLL_ADVANCE_THRESHOLD = 520;

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

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

// Remove the book's own styling so chapters render as plain text under the
// reader's stylesheet alone — no publisher CSS can fight the theme. Inline
// styles are dropped too, except inside SVG (where they draw the artwork).
// html/body element styles are left alone: epub.js writes its pagination
// (column) styles there.
function stripPublisherStyles(doc) {
  for (const node of doc.querySelectorAll('link[rel~="stylesheet"], script')) node.remove();
  for (const node of doc.querySelectorAll('style')) {
    if (!node.id || !node.id.startsWith('epubjs-inserted')) node.remove();
  }
  for (const el of doc.querySelectorAll('body *[style]')) {
    if (!el.closest('svg')) el.removeAttribute('style');
  }
  // Inline handlers are dead under the frame sandbox anyway; drop them so the
  // console stays quiet.
  for (const el of doc.querySelectorAll('body *')) {
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
    }
  }
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
    this.atEnd = false;
    this._accum = 0;
    this._advancing = false;
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
    this.scheduleStyleCheck();
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
      stripPublisherStyles(contents.document);
      contents.addStylesheetCss(fontFaceCss(), 'shx-fonts');
      contents.addStylesheetCss(this.contentCss(), 'shx-style');
      // Wheel events over the book land inside its frame; forward them so
      // scroll mode can sense "kept scrolling past the end".
      contents.document.addEventListener('wheel', (e) => this.handleWheel(e.deltaY), {
        passive: true,
      });
    });
    // Safety net: re-assert reader styling every time a section is shown, in
    // case the content hook misfires in some environment. Idempotent — the
    // keyed style node is simply replaced.
    rendition.on('rendered', () => this.applyTextStyles());

    rendition.on('relocated', (location) => this.handleRelocated(location));
    rendition.on('keydown', (event) => this.callbacks.onKey?.(event));

    await rendition.display(target);

    this.scroller = null;
    this.continueEl = null;
    if (this.settings.layout === 'scroll') this.setupScrollExtras();
  }

  /* ————— Scroll mode: hidden scrollbar, scroll-past-end chapter turn ————— */

  setupScrollExtras() {
    const scroller = this.container.querySelector('.epub-container');
    if (!scroller) return;
    this.scroller = scroller;
    scroller.classList.add('shx-scroller');
    scroller.addEventListener('wheel', (e) => this.handleWheel(e.deltaY), { passive: true });

    const overlay = document.createElement('div');
    overlay.className = 'scroll-continue';
    overlay.innerHTML =
      '<span class="scroll-continue-text"></span>' +
      '<span class="scroll-continue-track"><span class="scroll-continue-fill"></span></span>';
    this.container.appendChild(overlay);
    this.continueEl = overlay;
    this._accum = 0;
  }

  handleWheel(deltaY) {
    if (this.settings.layout !== 'scroll' || !this.scroller || this._advancing) return;
    const s = this.scroller;
    const atBottom = s.scrollTop + s.clientHeight >= s.scrollHeight - 6;
    if (deltaY > 0 && atBottom) {
      this._accum = Math.min(SCROLL_ADVANCE_THRESHOLD, this._accum + deltaY);
      this.updateContinueOverlay();
      clearTimeout(this._continueTimer);
      this._continueTimer = setTimeout(() => this.resetContinue(), 1200);
      if (!this.atEnd && this._accum >= SCROLL_ADVANCE_THRESHOLD) this.advanceChapter();
    } else if (this._accum) {
      this.resetContinue();
    }
  }

  updateContinueOverlay() {
    const el = this.continueEl;
    if (!el) return;
    el.querySelector('.scroll-continue-text').textContent = this.atEnd
      ? 'Finis ❦'
      : 'Chapter’s end — keep scrolling ❧';
    el.querySelector('.scroll-continue-fill').style.width = this.atEnd
      ? '100%'
      : `${Math.round((this._accum / SCROLL_ADVANCE_THRESHOLD) * 100)}%`;
    el.classList.add('visible');
  }

  resetContinue() {
    clearTimeout(this._continueTimer);
    this._accum = 0;
    if (this.continueEl) {
      this.continueEl.classList.remove('visible');
      this.continueEl.querySelector('.scroll-continue-fill').style.width = '0%';
    }
  }

  async advanceChapter() {
    this._advancing = true;
    this.resetContinue();
    this.container.classList.add('shx-chapter-turn');
    try {
      await this.rendition.next();
      this.scroller?.scrollTo({ top: 0, behavior: 'instant' });
    } finally {
      setTimeout(() => {
        this.container.classList.remove('shx-chapter-turn');
        this._advancing = false;
      }, 450);
    }
  }

  // One stylesheet, rebuilt from settings and injected under a fixed key so a
  // re-apply fully replaces the previous version (epub.js's own themes.select
  // leaves the old theme's stylesheet behind, so toggling breaks — we bypass
  // it). Publisher styles are overridden wholesale: the reader shows plain
  // text on the app's background, in the reader's colors, face, and size.
  contentCss() {
    const scheme = this.settings.theme === 'light' ? 'light' : 'dark';
    const colors = this.settings.theme === 'light' ? THEME_COLORS.light : THEME_COLORS.dark;
    const stack = FONT_STACKS[this.settings.font] || FONT_STACKS.garamond;
    return `
      html { color-scheme: ${scheme}; }
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
      stripPublisherStyles(contents.document);
      contents.addStylesheetCss(this.contentCss(), 'shx-style');
    }
  }

  // Inspect the rendered chapter and report whether the reader's styling
  // actually took effect. Logged to the console so problems on machines we
  // can't reach are diagnosable; if the check fails, styling is re-applied.
  styleCheck() {
    try {
      const contents = this.rendition?.getContents()?.[0];
      const doc = contents?.document;
      if (!doc || !doc.defaultView) return null;
      const probe = doc.querySelector('p') || doc.querySelector('h1, div');
      const expected = hexToRgb(
        (this.settings.theme === 'light' ? THEME_COLORS.light : THEME_COLORS.dark).fg,
      );
      const styleNode = doc.getElementById('epubjs-inserted-css-shx-style');
      const iframe = this.container.querySelector('iframe');
      const info = {
        version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '?',
        theme: this.settings.theme,
        expected,
        actual: probe ? doc.defaultView.getComputedStyle(probe).color : '(no text element)',
        font: probe ? doc.defaultView.getComputedStyle(probe).fontFamily.split(',')[0] : '',
        styleNode: styleNode ? styleNode.textContent.length : 0,
        leftoverSheets: doc.querySelectorAll(
          'link[rel~="stylesheet"], style:not([id^="epubjs-inserted"])',
        ).length,
        sandbox: iframe?.getAttribute('sandbox') ?? '(none)',
        srcdoc: !!iframe?.hasAttribute('srcdoc'),
        // Must match the app theme, or the browser backs the frame with an
        // opaque white canvas (the "white page box" bug under OS dark mode).
        frameScheme: doc.defaultView.getComputedStyle(doc.documentElement).colorScheme,
        appScheme: getComputedStyle(document.documentElement).colorScheme,
      };
      info.ok =
        info.actual === expected &&
        info.styleNode > 0 &&
        info.leftoverSheets === 0 &&
        info.frameScheme === info.appScheme;
      console.info('[shakespeare] epub style check:', JSON.stringify(info));
      return info;
    } catch (err) {
      console.warn('[shakespeare] epub style check failed:', err);
      return null;
    }
  }

  scheduleStyleCheck() {
    clearTimeout(this._checkTimer);
    this._checkTimer = setTimeout(() => {
      if (this.destroyed) return;
      const info = this.styleCheck();
      if (info && !info.ok) {
        console.warn('[shakespeare] reader styles missing — re-applying');
        this.applyTextStyles();
        setTimeout(() => !this.destroyed && this.styleCheck(), 600);
      }
    }, 900);
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
    this.atEnd = !!location.atEnd;
    this.emitProgress();
    this.scheduleStyleCheck();
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
    clearTimeout(this._checkTimer);
    clearTimeout(this._continueTimer);
    try {
      this.rendition?.destroy();
      this.book?.destroy();
    } catch {
      /* epub.js can throw during teardown of half-loaded books */
    }
    this.container.innerHTML = '';
  }
}
