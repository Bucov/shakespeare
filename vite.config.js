import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works from any path (file://, sub-folder, GitHub Pages…)
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
