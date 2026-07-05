# Shakespeare

*A quiet reading room in your browser.*

Shakespeare is a local-only browser book reader for **EPUB** and **PDF**(for now)
files. Upload a book, read it, close the tab — it remembers where you left
off. Nothing ever leaves your machine.

## Features

- **EPUB & PDF** — rendered with [epub.js](https://github.com/futurepress/epub.js)
  and [pdf.js](https://mozilla.github.io/pdf.js/)
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


## Inspriation

Main reason for making this is because i needed it and there wasnt any free software that i liked enough to use it, and the other reason is to test new Fable 5.
Front page gallery - [fiven1](https://fiven1.github.io/web/)
Design inspiration - [plyght](https://peril.lol/)

Books are best read physically but if you are for any reason not able feel fre to use Shakespeare :),