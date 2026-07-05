---
name: verify
description: Build, launch, and drive the Shakespeare book reader end-to-end to verify changes at the browser surface.
---

# Verifying Shakespeare

Static Vite app (vanilla JS + epub.js + pdf.js). No test framework — verification
is driving the built app in a real browser.

## Build & launch

```bash
npm install
npm run build
npx vite preview --port 4173 --strictPort   # serves dist/ at http://localhost:4173
```

## Drive it (Playwright)

Use `playwright-core` with the pre-installed Chromium
(`executablePath: '/opt/pw-browsers/chromium'` in remote sessions, or a local
Chrome). Viewport 1440×900 works well.

Fixtures: generate a real EPUB with `jszip` (mimetype STORED first,
`META-INF/container.xml`, OPF with `properties="nav"` nav doc, 3 chapters ×
~30 paragraphs so pagination has room) and a multi-page PDF with `pdf-lib`.
Small buffers uploaded via `page.setInputFiles('#file-input', path)`.

## Flows worth driving

- Front page: `.home-title`, `#btn-settings`, `#btn-upload`, gallery image
  (`#gallery-img` src rotates across reloads), caption text.
- EPUB: upload → wait `#viewer iframe` → `.toc-list button` ×3 → `#nav-next` /
  ArrowRight advances `#progress-pct` → TOC click updates `#progress-label`
  and `.toc-current` → click `#progress-track` seeks.
- Settings: `#set-theme`/`#set-layout` buttons apply live (`html[data-theme]`,
  `#reader[data-layout]`); layout change re-renders the rendition (wait ~1s).
- Resume: reload → `#home-resume` visible → click `#btn-resume` → same
  `#progress-label`/pct. Progress lives in
  `localStorage['shakespeare:progress:<name>|<size>']`, books in IndexedDB
  `shakespeare/books`.
- PDF: upload → `.pdf-stage canvas.pdf-page`; double layout: cover alone then
  pairs; scroll layout: `.pdf-scroll` with one slot per page, scrolling updates
  `Page N of M`; dark theme adds `#reader.pdf-inverted`.
- Error paths: junk `.txt` → status mentions "only EPUB and PDF"; corrupt
  `.epub` buffer → returns home with "resisted opening" status (epub.js
  failures surface via the `openFailed` event race in `epub-reader.js`).

## Gotchas

- `renderLibrary()` populates `#library-list` async after the overlay opens —
  wait for `#library-list li`, don't count immediately.
- epub.js locations generation takes ~1s after open; percentages are blank
  until then.
- The giant home title must keep `pointer-events: none` or it eats clicks on
  the links above it (its line box is far taller than the glyphs).
- Switching EPUB layout through scroll mode can coarsen the saved position to
  the chapter start — chapter-level resume is the guarantee there, not
  paragraph-level.
