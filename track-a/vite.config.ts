import { defineConfig } from 'vite';

// Relative base so the build works from any subpath (GitHub Pages, itch, file://).
export default defineConfig({
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  preview: { port: 4173, host: '127.0.0.1' },
  build: {
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
  },
});
