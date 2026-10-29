/**
 * ============================================================================
 *  Android launcher icons and splash screens, drawn from the symbology itself
 * ============================================================================
 *
 * Every density bucket gets the same real symbol -- version 3 carrying
 * https://simurgh.code -- so the launcher icon is itself scannable, and the
 * splash screen is the icon at wall size. Adaptive-icon foregrounds are rendered
 * with a true alpha channel and the symbol inside Android's 66% safe zone, so no
 * mask (circle, squircle, rounded square) can clip the Format Crown.
 *
 *   node apps/android/scripts/make-android-icons.mjs      (after npm run build)
 *
 * Existing PNGs are read for their dimensions, so if Capacitor's template ever
 * changes size the output follows it instead of guessing.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const androidRes = resolve(here, '../android/app/src/main/res');
if (!existsSync(androidRes)) {
  console.error('android/ project not found -- run `npx cap add android` in apps/android first.');
  process.exit(1);
}

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

/** PNG IHDR: width and height, without needing a decoder. */
function pngSize(path) {
  const head = readFileSync(path).subarray(16, 24);
  return { width: head.readUInt32BE(0), height: head.readUInt32BE(4) };
}

function writePng(path, img, channels) {
  let samples;
  if (channels === 4) {
    samples = img.data;
  } else {
    samples = new Uint8Array(img.width * img.height * 3);
    for (let i = 0, o = 0; i < samples.length; i += 3, o += 4) {
      samples[i] = img.data[o];
      samples[i + 1] = img.data[o + 1];
      samples[i + 2] = img.data[o + 2];
    }
  }
  const png = encodePNG(img.width, img.height, samples, { channels, level: 9 });
  writeFileSync(path, png);
  return png.length;
}

/**
 * Render the symbol into a `size`-square tile.
 *
 * `alpha` produces a transparent-background foreground (adaptive icons);
 * `fit` is the fraction of the tile the symbol's outer diameter should occupy.
 */
function tile(size, { alpha = false, fit = 0.92, quiet = 2.5 } = {}) {
  // Rendered diameter, quiet zone included, is 2 * (outerRadius + quiet) modules.
  const diameter = 2 * (model.outerRadius + quiet);
  const scale = (size * fit) / diameter;
  const img = render.renderRGBA(model, {
    theme,
    scale,
    shape: 'dot',
    quiet,
    supersample: size >= 216 ? 2 : 4,
  });

  // Centre (and optionally matte) into an exact-size canvas.
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

let written = 0;
let bytes = 0;

/* ------------------------------------------------------- launcher icons */
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const foreground = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

for (const [density, size] of Object.entries(densities)) {
  const dir = join(androidRes, `mipmap-${density}`);
  if (!existsSync(dir)) continue;
  for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
    const path = join(dir, name);
    const want = existsSync(path) ? pngSize(path).width : size;
    bytes += writePng(path, tile(want, { fit: 0.94 }), 3);
    written++;
  }
}

for (const [density, size] of Object.entries(foreground)) {
  const dir = join(androidRes, `mipmap-${density}`);
  if (!existsSync(dir)) continue;
  const path = join(dir, 'ic_launcher_foreground.png');
  const want = existsSync(path) ? pngSize(path).width : size;
  // Android's safe zone is the inner 66dp of a 108dp canvas: keep the Crown inside it.
  bytes += writePng(path, tile(want, { alpha: true, fit: 0.6, quiet: 3.5 }), 4);
  written++;
}

/* ------------------------------------------------------------ splash screens */
const splashDirs = readdirSync(androidRes).filter((d) => d.startsWith('drawable'));
for (const dir of splashDirs) {
  const path = join(androidRes, dir, 'splash.png');
  if (!existsSync(path)) continue;
  const { width, height } = pngSize(path);
  const img = { width, height, data: new Uint8Array(width * height * 4) };
  const paper = render.parseHex(LAPIS);
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = paper[0];
    img.data[i * 4 + 1] = paper[1];
    img.data[i * 4 + 2] = paper[2];
    img.data[i * 4 + 3] = 255;
  }
  const symbolSize = Math.round(Math.min(width, height) * 0.46);
  const t = tile(symbolSize, { fit: 1 });
  const dx = Math.round((width - symbolSize) / 2);
  const dy = Math.round((height - symbolSize) / 2);
  for (let y = 0; y < symbolSize; y++) {
    for (let x = 0; x < symbolSize; x++) {
      const si = (y * symbolSize + x) * 4;
      const di = ((y + dy) * width + (x + dx)) * 4;
      img.data[di] = t.data[si];
      img.data[di + 1] = t.data[si + 1];
      img.data[di + 2] = t.data[si + 2];
      img.data[di + 3] = 255;
    }
  }
  bytes += writePng(path, img, 3);
  written++;
}

/* ------------------------------------------------- adaptive icon background */
const bgPath = join(androidRes, 'values/ic_launcher_background.xml');
if (existsSync(bgPath)) {
  writeFileSync(
    bgPath,
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${LAPIS}</color>\n</resources>\n`,
  );
  console.log('  ic_launcher_background -> ' + LAPIS);
}

console.log(`wrote ${written} images, ${(bytes / 1024).toFixed(0)} KiB total`);

/* ---------------------------------------------------------- self-verification */
// The xxxhdpi launcher icon must still be readable by the very reader the app
// ships: light-on-dark, so this also proves polarity normalisation on a real
// Android asset rather than a synthetic one.
{
  const path = join(androidRes, 'mipmap-xxxhdpi/ic_launcher.png');
  const img = tile(pngSize(path).width, { fit: 0.94 });
  const gray = new Uint8Array(img.width * img.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2]);
  }
  const res = decodeImage({ width: img.width, height: img.height, data: gray });
  if (res.ok && res.text === PAYLOAD) {
    console.log(`  xxxhdpi icon scans back to "${res.text}" (${img.width}px, inverted=${res.diagnostics.inverted})`);
  } else {
    console.error(`  xxxhdpi icon does NOT scan: ${res.ok ? res.text : res.error}`);
    process.exitCode = 1;
  }
}
