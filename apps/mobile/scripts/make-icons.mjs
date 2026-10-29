/**
 * ============================================================================
 *  App icons that are themselves working SiMurgh symbols
 * ============================================================================
 *
 * The icon is not a drawing *of* a code: it is a real version-3 symbol whose
 * payload is the project URL, rendered in the gold-on-lapis palette. Scan the
 * launcher icon and it opens simurgh.code -- which is also the cheapest possible
 * regression test that the renderer, the palette and the reader still agree.
 *
 * Run with `npm run icons -w @simurgh/mobile` after `npm run build` at the root
 * (it imports the compiled packages, so no tsx or bundler is needed).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '../public');
mkdirSync(publicDir, { recursive: true });

const core = await import(resolve(here, '../../../packages/core/dist/index.js'));
const render = await import(resolve(here, '../../../packages/core/dist/render/index.js'));
const { encodePNG } = await import(resolve(here, '../../../packages/cli/dist/png.js'));

const PAYLOAD = 'https://simurgh.code';

/** Gold ink on lapis: 9.7:1 by WCAG luminance, so it survives thresholding. */
const iconTheme = {
  id: 'app-gold',
  fa: 'طلایی',
  en: 'App gold on lapis',
  ink: '#e6c46a',
  crown: '#f0d79a',
  paper: '#0b1730',
};

const symbol = core.encode({ text: PAYLOAD, ecc: 'M', version: 3 });
const model = core.toModel(symbol);

console.log(`icon payload: ${PAYLOAD}`);
console.log(`symbol: version ${symbol.version}, ECC ${symbol.ecc}, ${symbol.plan.payloadBytes} B payload`);
console.log(`contrast: ${render.themeContrast(iconTheme).worst.toFixed(2)}:1 (${render.themeContrast(iconTheme).verdict})`);

function rgbaToPng(img, path) {
  // The PNG encoder takes interleaved samples; 3 channels keeps the file small
  // and every launcher treats icons as opaque anyway.
  const rgb = new Uint8Array(img.width * img.height * 3);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
    rgb[i] = img.data[o];
    rgb[i + 1] = img.data[o + 1];
    rgb[i + 2] = img.data[o + 2];
  }
  const png = encodePNG(img.width, img.height, rgb, { channels: 3, level: 9 });
  writeFileSync(path, png);
  console.log(`  wrote ${path.split('/').pop()} (${img.width}x${img.height}, ${(png.length / 1024).toFixed(1)} KiB)`);
  return png;
}

// Plain icons: the symbol fills the tile with its own quiet zone.
for (const size of [192, 512]) {
  const scale = size / (2 * (model.outerRadius + model.crown.quietZone));
  const img = render.renderRGBA(model, { theme: iconTheme, scale, shape: 'dot' });
  rgbaToPng(img, resolve(publicDir, `icon-${size}.png`));
}

// Maskable: launchers crop to a circle, so the symbol sits inside the inner 80%
// and the corners are solid substrate.
{
  const size = 512;
  const quiet = 7.5; // modules of margin, well beyond the spec's 2.5
  const scale = size / (2 * (model.outerRadius + quiet));
  const img = render.renderRGBA(model, { theme: iconTheme, scale, shape: 'dot', quiet });
  rgbaToPng(img, resolve(publicDir, 'maskable-512.png'));
}

// Apple touch icon: 180 px, opaque, slightly tighter.
{
  const size = 180;
  const scale = size / (2 * (model.outerRadius + 1.5));
  const img = render.renderRGBA(model, { theme: iconTheme, scale, shape: 'dot', quiet: 1.5 });
  rgbaToPng(img, resolve(publicDir, 'apple-touch-icon.png'));
}

// Vector icon for the browser tab and the in-app brand mark.
{
  const svg = render.renderSVG(model, {
    theme: iconTheme,
    scale: 1,
    unit: 'px',
    shape: 'dot',
    caption: null,
    metadata: true,
    precision: 2,
    quiet: 1,
  });
  writeFileSync(resolve(publicDir, 'icon.svg'), svg);
  console.log(`  wrote icon.svg (${(svg.length / 1024).toFixed(1)} KiB)`);
}

/*
 * Prove the icon is a working code: threshold it back to luminance (what a camera
 * does) and run the reader on it. The palette is light-on-dark, so this also
 * exercises the polarity normalisation.
 */
{
  const scale = 512 / (2 * (model.outerRadius + model.crown.quietZone));
  const img = render.renderRGBA(model, { theme: iconTheme, scale, shape: 'dot' });
  const gray = new Uint8Array(img.width * img.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2]);
  }
  const { decodeImage } = await import(resolve(here, '../../../packages/core/dist/imaging/index.js'));
  const res = decodeImage({ width: img.width, height: img.height, data: gray });
  if (res.ok && res.text === PAYLOAD) {
    console.log(`  icon decodes back to "${res.text}" (inverted=${res.diagnostics.inverted}, ${res.diagnostics.teethMatches}/63 teeth)`);
  } else {
    console.error(`  ICON DOES NOT SCAN: ${res.ok ? `"${res.text}"` : res.error}`);
    process.exitCode = 1;
  }
}
