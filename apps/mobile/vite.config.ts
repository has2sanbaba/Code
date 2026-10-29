import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The mobile app is built to be *installed*: as a PWA straight from the browser,
 * or wrapped by Capacitor into an APK (see ../android). Two consequences shape
 * this config:
 *
 *   base './'   Capacitor serves the bundle from a file-ish origin, so every
 *               asset URL must be relative.
 *   es2022      The symbology's math uses BigInt-free 32-bit tricks and typed
 *               arrays only; no polyfills are needed on any current WebView.
 */
export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@simurgh/core/render': r('../../packages/core/src/render/index.ts'),
      '@simurgh/core/imaging': r('../../packages/core/src/imaging/index.ts'),
      '@simurgh/core': r('../../packages/core/src/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: false,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 5174,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // One chunk keeps the service worker's precache list trivial and the first
    // paint fast on a mid-range phone.
    rollupOptions: { output: { manualChunks: undefined } },
  },
});
