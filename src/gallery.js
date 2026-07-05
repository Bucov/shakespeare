// The front-page "image for viewing pleasure".
// Every file dropped into src/assets/gallery/ is picked up automatically —
// replace or add your own images there and they join the rotation.

const images = import.meta.glob('./assets/gallery/*.{svg,png,jpg,jpeg,webp,gif,avif}', {
  eager: true,
  query: '?url',
  import: 'default',
});

const urls = Object.values(images);
const LAST_KEY = 'shakespeare:last-plate';

export function randomImage() {
  if (urls.length === 0) return null;
  if (urls.length === 1) return urls[0];

  // Avoid showing the same plate twice in a row across refreshes.
  let last = null;
  try {
    last = sessionStorage.getItem(LAST_KEY);
  } catch {
    /* storage unavailable — plain random is fine */
  }
  let pick;
  do {
    pick = urls[Math.floor(Math.random() * urls.length)];
  } while (pick === last);
  try {
    sessionStorage.setItem(LAST_KEY, pick);
  } catch {
    /* ignore */
  }
  return pick;
}
