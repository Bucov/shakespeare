// The front-page gallery.
// Every file dropped into src/assets/gallery/ is picked up automatically;
// titles, artists, and Wikipedia links live in gallery-manifest.js.

import { GALLERY_INFO } from './gallery-manifest.js';

const images = import.meta.glob('./assets/gallery/*.{svg,png,jpg,jpeg,webp,gif,avif}', {
  eager: true,
  query: '?url',
  import: 'default',
});

const LAST_KEY = 'shakespeare:last-plate';

function prettify(file) {
  return file
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^\d+px-/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const artworks = Object.entries(images).map(([path, url]) => {
  const file = path.split('/').pop();
  const info = GALLERY_INFO[file] || {};
  const title = info.title || prettify(file);
  return {
    url,
    title,
    artist: info.artist || 'Artist unknown',
    wiki:
      info.wiki ||
      `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(title)}`,
  };
});

export function randomArtwork() {
  if (artworks.length === 0) return null;
  if (artworks.length === 1) return artworks[0];

  // Avoid showing the same picture twice in a row across refreshes.
  let last = null;
  try {
    last = sessionStorage.getItem(LAST_KEY);
  } catch {
    /* storage unavailable — plain random is fine */
  }
  let pick;
  do {
    pick = artworks[Math.floor(Math.random() * artworks.length)];
  } while (pick.url === last);
  try {
    sessionStorage.setItem(LAST_KEY, pick.url);
  } catch {
    /* ignore */
  }
  return pick;
}
