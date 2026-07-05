# Shakespeare

*A quiet reading room in your browser.*

Shakespeare is a local-only browser book reader for **EPUB** and **PDF**
files. Upload a book, read it, close the tab — it remembers where you left
off. Nothing ever leaves your machine.

## Features

- **EPUB & PDF** — rendered with [epub.js](https://github.com/futurepress/epub.js)
  and [pdf.js](https://mozilla.github.io/pdf.js/)
- **Reading layouts** — one page, two-page spread, or continuous scroll
- **Dark & light themes** — PDFs are gently inverted in the dark theme
  (switchable in Settings)
- **Text size & style** — Garamond, Georgia, or a sans face, 70–160% size
  (EPUB only; PDFs keep their print layout)
- **Table of contents** — collapsible panel on the right of the reader
- **Progress bar** — a hairline along the bottom; hover it for chapter, page,
  and percentage, click it to jump
- **Automatic progress saving** — your position is stored per book in
  `localStorage`, and the books themselves are kept in IndexedDB, so the
  Library lets you reopen anything without re-uploading
- Drag & drop a file anywhere on the front page to open it

## Running it

```bash
npm install
npm run dev       # development server
npm run build     # production build in dist/
npm run preview   # serve the production build
```

The build is fully static — host `dist/` anywhere (or open it from any static
file server). There is no backend.

## The front-page image

The "image for viewing pleasure" is picked at random on every visit from
`src/assets/gallery/`. Drop your own images (svg/png/jpg/webp/gif/avif) into
that folder and they join the rotation automatically; the engraved plates
that ship with the app are just placeholders.

## Where things are stored

| What | Where | Key |
|------|-------|-----|
| Settings | `localStorage` | `shakespeare:settings` |
| Reading position | `localStorage` | `shakespeare:progress:<name>\|<size>` |
| Books (for the Library) | IndexedDB | database `shakespeare`, store `books` |

Everything is browser-local. When Shakespeare goes online one day,
`src/settings.js` and `src/storage.js` are the two seams where a synced
backend slots in — the rest of the app only talks to them.

## License

MIT — see [LICENSE](LICENSE).
