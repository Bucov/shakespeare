// Local persistence: reading progress in localStorage, the books themselves
// in IndexedDB so the library survives reloads without re-uploading.
// All of it stays in the browser; a future online version can sync these
// same records to a server.

const PROGRESS_PREFIX = 'shakespeare:progress:';

export function bookIdFor(file) {
  return `${file.name}|${file.size}`;
}

/* ————— Progress (localStorage) ————— */

export function getProgress(bookId) {
  try {
    const raw = localStorage.getItem(PROGRESS_PREFIX + bookId);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveProgress(bookId, data) {
  try {
    localStorage.setItem(
      PROGRESS_PREFIX + bookId,
      JSON.stringify({ ...data, updatedAt: Date.now() }),
    );
  } catch {
    /* storage full or unavailable — reading continues, position just isn't kept */
  }
}

export function clearProgress(bookId) {
  try {
    localStorage.removeItem(PROGRESS_PREFIX + bookId);
  } catch {
    /* ignore */
  }
}

/* ————— Book library (IndexedDB) ————— */

const DB_NAME = 'shakespeare';
const DB_VERSION = 1;
const STORE = 'books';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * record: { id, name, size, kind: 'epub'|'pdf', title, author,
 *           data: ArrayBuffer, locations?: string, addedAt, openedAt }
 */
export async function putBook(record) {
  const db = await openDb();
  return request(tx(db, 'readwrite').put(record));
}

export async function getBook(id) {
  const db = await openDb();
  return request(tx(db, 'readonly').get(id));
}

export async function listBooks() {
  const db = await openDb();
  const all = await request(tx(db, 'readonly').getAll());
  return all.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
}

export async function deleteBook(id) {
  const db = await openDb();
  clearProgress(id);
  return request(tx(db, 'readwrite').delete(id));
}

export async function patchBook(id, patch) {
  const db = await openDb();
  const store = tx(db, 'readwrite');
  const record = await request(store.get(id));
  if (!record) return null;
  const updated = { ...record, ...patch };
  await request(store.put(updated));
  return updated;
}
