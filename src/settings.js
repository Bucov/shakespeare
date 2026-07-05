// Reader preferences, persisted to localStorage so they survive reloads.
// When Shakespeare goes online this module is the single place to swap
// localStorage for a synced store.

const KEY = 'shakespeare:settings';

const DEFAULTS = {
  theme: 'dark', // 'dark' | 'light'
  fontSize: 100, // percent, applied to EPUB text
  font: 'garamond', // 'garamond' | 'georgia' | 'sans'
  layout: 'single', // 'single' | 'double' | 'scroll'
  pdfInvert: true, // soften PDFs to match the dark theme
};

export const FONT_STACKS = {
  garamond: '"EB Garamond", Garamond, "Palatino Linotype", Palatino, Georgia, serif',
  georgia: 'Georgia, "Times New Roman", Times, serif',
  sans: 'system-ui, "Segoe UI", Helvetica, Arial, sans-serif',
};

export const FONT_SIZE_MIN = 70;
export const FONT_SIZE_MAX = 160;
export const FONT_SIZE_STEP = 5;

let settings = load();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* corrupted or unavailable storage — fall back to defaults */
  }
  return { ...DEFAULTS };
}

export function getSettings() {
  return { ...settings };
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
  settings.fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, settings.fontSize));
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private browsing quota — settings simply won't persist */
  }
  for (const cb of listeners) cb(getSettings());
}

export function onSettingsChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
}
