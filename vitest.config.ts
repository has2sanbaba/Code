import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@simurgh/core/render': r('./packages/core/src/render/index.ts'),
      '@simurgh/core/imaging': r('./packages/core/src/imaging/index.ts'),
      '@simurgh/core': r('./packages/core/src/index.ts'),
    },
    extensionAlias: { '.js': ['.ts', '.js'] },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'forks',
  },
});
