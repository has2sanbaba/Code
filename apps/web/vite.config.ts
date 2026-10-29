import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * The playground builds straight against the TypeScript sources, not against
 * `packages/core/dist`, so a change in the symbology shows up on reload without
 * a separate build step. The order of the aliases matters: the more specific
 * subpaths have to come first.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@simurgh/core/render': r('../../packages/core/src/render/index.ts'),
      '@simurgh/core/imaging': r('../../packages/core/src/imaging/index.ts'),
      '@simurgh/core': r('../../packages/core/src/index.ts'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The preview is served through a proxy on a different host name.
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
