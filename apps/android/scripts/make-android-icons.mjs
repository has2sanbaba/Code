/**
 * ============================================================================
 *  Launcher icons for the native app, drawn from the symbology itself
 * ============================================================================
 *
 * Every density bucket gets the same real symbol -- version 3 carrying
 * https://simurgh.code in the Android gold-on-lapis theme -- so the launcher
 * icon is itself a scannable SiMurgh Code. `renderRGBA` supersamples the
 * fractional module pitch, and the soft anti-aliased profile is exactly what
 * the imaging pipeline's resampling path reads (2.33 px/module floor).
 *
 * Adaptive-icon foregrounds keep a true alpha channel (paper-distance keyed,
 * so gold ink is opaque and anti-aliased edges keep partial coverage) and the
 * symbol inside Android's 66/108 safe zone, so no mask -- circle, squircle,
 * rounded square -- can clip the Format Crown.
 *
 *   node apps/android/scripts/make-android-icons.mjs      (after npm run build)
 *
 * The xxxhdpi launcher tile is decoded afterwards with the imaging pipeline:
 * if the icon ever stops scanning, the script fails instead of shipping.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const res = resolve(here, '../app/src/main/res');

const core = await import(resolve(here, '../../../packages/core/dist/index.js'));
const render = await import(resolve(here, '../../../packages/core/dist/render/index.js'));
const { encodePNG } = await import(resolve(here, '../../../packages/cli/dist/png.js'));
const { decodeImage } = await import(resolve(here, '../../../packages/core/dist/imaging/index.js'));

const PAYLOAD = 'https://simurgh.code';
const GOLD = '#e6c46a';
const GOLD_LIGHT = '#f0d79a';
const LAPIS = '#0b1730';

const theme = { id: 'android', fa: 'اندروید', en: 'Android launcher', ink: GOLD, crown: GOLD_LIGHT, paper: LAPIS };
const symbol = core.encode({ text: PAYLOAD, ecc: 'M', version: 3 });
const model = core.toModel(symbol);

/**
 * Alpha for a foreground layer, derived from how far a pixel is from the paper
 * colour: gold ink becomes opaque, lapis becomes transparent, and anti-aliased
 * edges keep their partial coverage instead of turning into a dark halo.
 */
function luminanceAlpha(data, i) {
  const [pr, pg, pb] = render.parseHex(LAPIS);
  const d = Math.abs(data[i] - pr) + Math.abs(data[i + 1] - pg) + Math.abs(data[i + 2] - pb);
  return Math.max(0, Math.min(255, Math.round((d / 120) * 255)));
}

/**
 * Render the symbol into a `size`-square tile.
 *
 * `alpha` produces a transparent-background foreground (adaptive icons);
 * `fit` is the fraction of the tile the symbol's outer diameter should occupy.
 */
function tile(size, { alpha = false, fit = 0.92, quiet = 3 } = {}) {
  const diameter = 2 * (model.outerRadius + quiet); // quiet zone included, in modules
  const scale = (size * fit) / diameter;
  const img = render.renderRGBA(model, {
    theme,
    scale,
    shape: 'dot',
    quiet,
    supersample: size >= 216 ? 4 : 8,
  });

  const out = { width: size, height: size, data: new Uint8Array(size * size * 4) };
  const paperRgb = render.parseHex(alpha ? '#000000' : LAPIS);
  for (let i = 0; i < size * size; i++) {
    out.data[i * 4] = paperRgb[0];
    out.data[i * 4 + 1] = paperRgb[1];
    out.data[i * 4 + 2] = paperRgb[2];
    out.data[i * 4 + 3] = alpha ? 0 : 255;
  }
  const dx = Math.round((size - img.width) / 2);
  const dy = Math.round((size - img.height) / 2);
  for (let y = 0; y < img.height; y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= size) continue;
    for (let x = 0; x < img.width; x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= size) continue;
      const si = (y * img.width + x) * 4;
      const di = (ty * size + tx) * 4;
      const a = alpha ? luminanceAlpha(img.data, si) : 255;
      if (alpha && a === 0) continue;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = alpha ? a : 255;
    }
  }
  return out;
}

function circleMask(img) {
  const r = img.width / 2;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x + 0.5 - r, y + 0.5 - r);
      const i = (y * img.width + x) * 4 + 3;
      img.data[i] = d <= r - 0.75 ? 255 : d >= r - 0.25 ? 0 : Math.round(Math.max(0, r - d) * 2 * 255);
    }
  }
  return img;
}

function writePng(path, img) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, encodePNG(img.width, img.height, img.data, { channels: 4, level: 9 }));
  console.log(`  ${path.slice(res.length + 1)}  (${img.width}x${img.height})`);
}

const DENSITIES = [
  { name: 'mdpi', launcher: 48, foreground: 108 },
  { name: 'hdpi', launcher: 72, foreground: 162 },
  { name: 'xhdpi', launcher: 96, foreground: 216 },
  { name: 'xxhdpi', launcher: 144, foreground: 324 },
  { name: 'xxxhdpi', launcher: 192, foreground: 432 },
];

console.log('launcher icons (full bleed, gold on lapis):');
for (const d of DENSITIES) {
  writePng(resolve(res, `mipmap-${d.name}/ic_launcher.png`), tile(d.launcher));
}
console.log('round launcher icons (circular alpha):');
for (const d of DENSITIES) {
  writePng(resolve(res, `mipmap-${d.name}/ic_launcher_round.png`), circleMask(tile(d.launcher)));
}
console.log('adaptive foregrounds (transparent, 66/108 safe zone):');
for (const d of DENSITIES) {
  writePng(resolve(res, `mipmap-${d.name}/ic_launcher_foreground.png`), tile(d.foreground, { alpha: true, fit: 0.6, quiet: 3.5 }));
}

// Adaptive-icon XML + background colour.
const anydpi = resolve(res, 'mipmap-anydpi-v26');
mkdirSync(anydpi, { recursive: true });
const adaptive = (round) => `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
    ${round ? '<monochrome android:drawable="@mipmap/ic_launcher_foreground" />' : ''}
</adaptive-icon>
`;
writeFileSync(resolve(anydpi, 'ic_launcher.xml'), adaptive(false));
writeFileSync(resolve(anydpi, 'ic_launcher_round.xml'), adaptive(true));
mkdirSync(resolve(res, 'values'), { recursive: true });
writeFileSync(
  resolve(res, 'values/ic_launcher_background.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${LAPIS}</color>
</resources>
`,
);
console.log('  mipmap-anydpi-v26/ic_launcher{,_round}.xml + values/ic_launcher_background.xml');

// The icon must remain a valid symbol: decode the xxxhdpi launcher tile.
const big = tile(192);
const gray = new Uint8Array(192 * 192);
for (let i = 0; i < gray.length; i++) {
  gray[i] = Math.round(0.2126 * big.data[i * 4] + 0.7152 * big.data[i * 4 + 1] + 0.0722 * big.data[i * 4 + 2]);
}
const back = decodeImage({ width: 192, height: 192, data: gray });
if (!back.ok || back.text !== PAYLOAD) {
  console.error(`icon no longer scans: ok=${back.ok} text=${back.text ?? back.error}`);
  process.exitCode = 1;
} else {
  console.log(`icon scan check: "${back.text}" v${back.version} teeth ${back.diagnostics.teethMatches}/63 conf ${back.diagnostics.meanConfidence.toFixed(2)}`);
}
