import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./', import.meta.url)),
  base: '/',
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('../', import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL('../dist/pilot-web/', import.meta.url)),
    // Clean only this pilot output; existing dist/client and dist/server are retained.
    emptyOutDir: true,
    assetsDir: 'assets',
    minify: true,
    cssCodeSplit: true,
    sourcemap: false,
  },
});
