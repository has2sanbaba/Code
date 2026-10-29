/**
 * Bundle the SiMurgh core into the single IIFE the native Android app loads in
 * its embedded QuickJS VM.
 *
 *   node tools/build-engine.mjs [outfile]
 *
 * The bundle has no DOM, no network and no globals of its own beyond
 * `SimurghEngine`; optional chaining and nullish coalescing are compiled away
 * (target es2019) so even conservative JS engines run it unchanged.
 */
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outfile = process.argv[2] ?? resolve(root, 'apps/android/app/src/main/assets/engine.js');
mkdirSync(dirname(outfile), { recursive: true });

const alias = (p) => resolve(root, p);

await build({
  entryPoints: [resolve(here, 'engine-entry.ts')],
  outfile,
  bundle: true,
  format: 'iife',
  target: 'es2019',
  platform: 'neutral',
  // The symbology sources, not the built dist, so a fresh checkout needs no
  // prior tsc step: one command produces the asset.
  alias: {
    '@simurgh/core/render': alias('packages/core/src/render/index.ts'),
    '@simurgh/core/imaging': alias('packages/core/src/imaging/index.ts'),
    '@simurgh/core': alias('packages/core/src/index.ts'),
  },
  logLevel: 'info',
  legalComments: 'none',
});

const { statSync } = await import('node:fs');
const size = statSync(outfile).size;
console.log(`engine.js: ${(size / 1024).toFixed(0)} KiB -> ${outfile}`);
if (size > 900 * 1024) {
  console.error('engine bundle grew past 900 KiB -- inspect before shipping');
  process.exitCode = 1;
}
