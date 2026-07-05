import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/400-italic.css';
import '@fontsource/eb-garamond/600.css';
import '@fontsource/eb-garamond/700.css';
import './styles/main.css';

import {
  getSettings,
  updateSettings,
  onSettingsChange,
  applyTheme,
  FONT_SIZE_STEP,
} from './settings.js';
import {
  bookIdFor,
  getProgress,
  saveProgress,
  putBook,
  getBook,
  listBooks,
  deleteBook,
  patchBook,
} from './storage.js';
import { randomImage } from './gallery.js';
import { EpubReader } from './reader/epub-reader.js';
import { PdfReader } from './reader/pdf-reader.js';

const $ = (sel) => document.querySelector(sel);

const homeEl = $('#home');
const readerEl = $('#reader');
const viewerEl = $('#viewer');
const loadingEl = $('#viewer-loading');
const tocPanel = $('#toc-panel');
const tocList = $('#toc-list');
const btnToc = $('#btn-toc');
const progressFill = $('#progress-fill');
const progressPct = $('#progress-pct');
const progressLabel = $('#progress-label');
const bookTitleEl = $('#reader-booktitle');
const fileInput = $('#file-input');
const statusEl = $('#home-status');
const dropveil = $('#dropveil');

const UI_KEY = 'shakespeare:ui';

let currentReader = null;
let currentRecord = null;
let statusTimer = null;

/* ————————— Home page ————————— */

function setStatus(text, sticky = false) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  if (text && !sticky) {
    statusTimer = setTimeout(() => (statusEl.textContent = ''), 6000);
  }
}

function initGallery() {
  const url = randomImage();
  const img = $('#gallery-img');
  if (url) img.src = url;
  else img.closest('.home-art').hidden = true;
}

async function refreshHome() {
  let books = [];
  try {
    books = await listBooks();
  } catch {
    /* IndexedDB unavailable (rare) — library features simply hide */
  }
  $('#btn-library').hidden = books.length === 0;

  const resumeWrap = $('#home-resume');
  const last = books[0];
  if (last) {
    const progress = getProgress(last.id);
    const pct = progress?.fraction != null ? ` — ${Math.round(progress.fraction * 100)}%` : '';
    $('#btn-resume').textContent = `Continue reading “${last.title || last.name}”${pct}`;
    resumeWrap.hidden = false;
    $('#btn-resume').onclick = async () => {
      const record = await getBook(last.id);
      if (record) openBook(record);
    };
  } else {
    resumeWrap.hidden = true;
  }
}

function detectKind(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.epub') || file.type === 'application/epub+zip') return 'epub';
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
  return null;
}

async function openFile(file) {
  const kind = detectKind(file);
  if (!kind) {
    setStatus('Alas — Shakespeare reads only EPUB and PDF for now.');
    return;
  }
  setStatus(`Opening “${file.name}”…`, true);
  try {
    const data = await file.arrayBuffer();
    const id = bookIdFor(file);
    const existing = await getBook(id).catch(() => null);
    const record = {
      id,
      name: file.name,
      size: file.size,
      kind,
      title: existing?.title || file.name.replace(/\.(epub|pdf)$/i, ''),
      author: existing?.author || '',
      locations: existing?.locations || null,
      data,
      addedAt: existing?.addedAt || Date.now(),
      openedAt: Date.now(),
    };
    await putBook(record).catch(() => {});
    setStatus('');
    await openBook(record);
  } catch (err) {
    console.error(err);
    setStatus('That file would not open. Is it a sound EPUB or PDF?');
  }
}

/* ————————— Reader shell ————————— */

const readerCallbacks = {
  onProgress({ fraction, label, tocId, position }) {
    if (fraction != null) {
      progressFill.style.width = `${(fraction * 100).toFixed(2)}%`;
      progressPct.textContent = `${Math.round(fraction * 100)}%`;
    } else {
      progressFill.style.width = '0%';
      progressPct.textContent = '';
    }
    progressLabel.textContent = label || '';
    markTocCurrent(tocId);
    if (currentRecord) saveProgress(currentRecord.id, { ...position, label });
  },
  onKey(event) {
    handleReaderKeys(event);
  },
  onLocations(json) {
    if (currentRecord) {
      currentRecord.locations = json;
      patchBook(currentRecord.id, { locations: json }).catch(() => {});
    }
  },
};

async function openBook(record) {
  destroyReader();
  currentRecord = record;

  homeEl.hidden = true;
  readerEl.hidden = false;
  readerEl.dataset.kind = record.kind;
  readerEl.dataset.layout = getSettings().layout;
  bookTitleEl.textContent = record.title || record.name;
  loadingEl.hidden = false;
  tocList.innerHTML = '';
  progressFill.style.width = '0%';
  progressPct.textContent = '';
  progressLabel.textContent = '';

  const ReaderClass = record.kind === 'epub' ? EpubReader : PdfReader;
  const reader = new ReaderClass(viewerEl, record, getSettings(), readerCallbacks);
  currentReader = reader;

  try {
    await reader.open(getProgress(record.id) || undefined);
  } catch (err) {
    console.error(err);
    destroyReader();
    showHome();
    setStatus('That book resisted opening — the file may be damaged.');
    return;
  }

  renderToc(reader.getToc());
  updatePdfInvertClass();
  loadingEl.hidden = true;

  // Fill in real metadata for the title bar and the library.
  try {
    const meta = await reader.getMetadata();
    if (meta.title) {
      currentRecord.title = meta.title;
      currentRecord.author = meta.author || '';
      bookTitleEl.textContent = meta.author ? `${meta.title} — ${meta.author}` : meta.title;
      patchBook(record.id, {
        title: meta.title,
        author: meta.author || '',
        openedAt: Date.now(),
      }).catch(() => {});
    }
  } catch {
    /* metadata is a nicety, not a requirement */
  }
}

function destroyReader() {
  currentReader?.destroy();
  currentReader = null;
  currentRecord = null;
}

function showHome() {
  readerEl.hidden = true;
  homeEl.hidden = false;
  refreshHome();
}

function updatePdfInvertClass() {
  const s = getSettings();
  readerEl.classList.toggle(
    'pdf-inverted',
    currentRecord?.kind === 'pdf' && s.theme === 'dark' && s.pdfInvert,
  );
}

/* ————— Contents panel ————— */

function renderToc(items) {
  tocList.innerHTML = '';
  if (!items || items.length === 0) {
    const p = document.createElement('p');
    p.className = 'toc-empty';
    p.textContent = 'This book offers no table of contents.';
    tocList.appendChild(p);
    return;
  }
  tocList.appendChild(buildTocLevel(items));
}

function buildTocLevel(items) {
  const ol = document.createElement('ol');
  for (const item of items) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = item.label;
    btn.dataset.tocId = item.id;
    btn.addEventListener('click', () => currentReader?.goTo(item.target));
    li.appendChild(btn);
    if (item.children && item.children.length) {
      li.appendChild(buildTocLevel(item.children));
    }
    ol.appendChild(li);
  }
  return ol;
}

function markTocCurrent(tocId) {
  tocList.querySelector('.toc-current')?.classList.remove('toc-current');
  if (tocId == null) return;
  for (const btn of tocList.querySelectorAll('button[data-toc-id]')) {
    if (btn.dataset.tocId === String(tocId)) {
      btn.classList.add('toc-current');
      break;
    }
  }
}

function setTocCollapsed(collapsed) {
  readerEl.classList.toggle('toc-collapsed', collapsed);
  btnToc.setAttribute('aria-expanded', String(!collapsed));
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ tocCollapsed: collapsed }));
  } catch {
    /* ignore */
  }
}

function initTocState() {
  let collapsed = window.matchMedia('(max-width: 900px)').matches;
  try {
    const saved = JSON.parse(localStorage.getItem(UI_KEY) || 'null');
    if (saved && typeof saved.tocCollapsed === 'boolean') collapsed = saved.tocCollapsed;
  } catch {
    /* ignore */
  }
  setTocCollapsed(collapsed);
}

/* ————— Progress bar ————— */

$('#progress-track').addEventListener('click', (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  const fraction = (e.clientX - rect.left) / rect.width;
  currentReader?.seek(fraction);
});

/* ————— Keyboard ————— */

function anyOverlayOpen() {
  return !$('#settings-overlay').hidden || !$('#library-overlay').hidden;
}

function handleReaderKeys(e) {
  if (e.key === 'ArrowRight' || e.key === 'PageDown') {
    currentReader?.next();
  } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    currentReader?.prev();
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!$('#settings-overlay').hidden) closeOverlay('#settings-overlay');
    else if (!$('#library-overlay').hidden) closeOverlay('#library-overlay');
    return;
  }
  if (readerEl.hidden || anyOverlayOpen()) return;
  if (e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)) return;
  handleReaderKeys(e);
});

/* ————————— Overlays ————————— */

function openOverlay(sel) {
  $(sel).hidden = false;
}

function closeOverlay(sel) {
  $(sel).hidden = true;
}

for (const overlay of document.querySelectorAll('.overlay')) {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
  overlay.querySelector('[data-close]')?.addEventListener('click', () => (overlay.hidden = true));
}

/* ————— Settings panel ————— */

function wireChoiceGroup(sel, key, parse = (v) => v) {
  const group = $(sel);
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    updateSettings({ [key]: parse(btn.dataset.value) });
  });
}

wireChoiceGroup('#set-theme', 'theme');
wireChoiceGroup('#set-font', 'font');
wireChoiceGroup('#set-layout', 'layout');
wireChoiceGroup('#set-pdfinvert', 'pdfInvert', (v) => v === 'true');

$('#set-fontsize').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-step]');
  if (!btn) return;
  updateSettings({ fontSize: getSettings().fontSize + Number(btn.dataset.step) * FONT_SIZE_STEP });
});

function syncSettingsUI() {
  const s = getSettings();
  const groups = [
    ['#set-theme', String(s.theme)],
    ['#set-font', String(s.font)],
    ['#set-layout', String(s.layout)],
    ['#set-pdfinvert', String(s.pdfInvert)],
  ];
  for (const [sel, value] of groups) {
    for (const btn of $(sel).querySelectorAll('button[data-value]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.value === value));
    }
  }
  $('#fontsize-value').textContent = `${s.fontSize}%`;
}

onSettingsChange((s) => {
  applyTheme();
  syncSettingsUI();
  readerEl.dataset.layout = s.layout;
  updatePdfInvertClass();
  currentReader?.applySettings(s);
  refreshHome(); // resume percentage text may reference progress — cheap to refresh
});

/* ————— Library panel ————— */

async function renderLibrary() {
  const listEl = $('#library-list');
  listEl.innerHTML = '';
  const books = await listBooks().catch(() => []);
  if (books.length === 0) {
    const li = document.createElement('li');
    li.className = 'library-empty';
    li.textContent = 'The shelves stand empty. Upload a book to begin.';
    listEl.appendChild(li);
    return;
  }
  for (const book of books) {
    const li = document.createElement('li');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'linklike library-open';
    const title = document.createElement('span');
    title.className = 'lib-title';
    title.textContent = book.author ? `${book.title} — ${book.author}` : book.title || book.name;
    const meta = document.createElement('span');
    meta.className = 'lib-meta';
    const progress = getProgress(book.id);
    const pct = progress?.fraction != null ? `${Math.round(progress.fraction * 100)}% read` : 'unread';
    meta.textContent = `${book.kind.toUpperCase()} · ${pct}`;
    open.append(title, meta);
    open.addEventListener('click', async () => {
      closeOverlay('#library-overlay');
      const record = await getBook(book.id);
      if (record) openBook(record);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'linklike library-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${book.title || book.name}`);
    remove.addEventListener('click', async () => {
      await deleteBook(book.id).catch(() => {});
      renderLibrary();
      refreshHome();
    });

    li.append(open, remove);
    listEl.appendChild(li);
  }
}

/* ————————— Wiring ————————— */

$('#btn-settings').addEventListener('click', () => openOverlay('#settings-overlay'));
$('#btn-reader-settings').addEventListener('click', () => openOverlay('#settings-overlay'));
$('#btn-upload').addEventListener('click', () => fileInput.click());
$('#btn-library').addEventListener('click', () => {
  renderLibrary();
  openOverlay('#library-overlay');
});
$('#btn-toc').addEventListener('click', () =>
  setTocCollapsed(!readerEl.classList.contains('toc-collapsed')),
);
$('#btn-close-reader').addEventListener('click', () => {
  destroyReader();
  showHome();
});
$('#nav-prev').addEventListener('click', () => currentReader?.prev());
$('#nav-next').addEventListener('click', () => currentReader?.next());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) openFile(file);
});

// Drag a book anywhere onto the page.
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dropveil.hidden = false;
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropveil.hidden = true;
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropveil.hidden = true;
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    if (!readerEl.hidden) {
      destroyReader();
      showHome();
    }
    openFile(file);
  }
});

/* ————————— Curtain up ————————— */

// Build stamp — lets anyone confirm which edition their browser is running.
console.info(`Shakespeare v${__APP_VERSION__}`);
$('#colophon').textContent = `Edition v${__APP_VERSION__}`;

applyTheme();
syncSettingsUI();
initTocState();
initGallery();
refreshHome();
