/**
 * ============================================================================
 *  Colour, themes and polarity -- "it has to be beautiful *and* still scan"
 * ============================================================================
 *
 * Two claims are tested here:
 *
 *   1. Every built-in palette keeps enough luminance contrast to survive a phone
 *      camera, and the colour pipeline (renderRGBA -> luma -> decode) reproduces
 *      the payload exactly.
 *   2. Polarity is a property of the photograph, not of the symbology: a symbol
 *      printed light-on-dark decodes through the same pipeline as dark-on-light,
 *      because `decodeImage` normalises it before the radial matcher sees it --
 *      and the tests check that the normalisation is what does the work.
 */
import { describe, expect, it } from 'vitest';
import { encode, toModel } from '@simurgh/core';
import {
  PRINT_CONTRAST_FLOOR,
  SCAN_CONTRAST_FLOOR,
  THEME_IDS,
  THEMES,
  contrastRatio,
  crownDistance,
  fieldDistance,
  inkDistance,
  parseHex,
  relativeLuminance,
  renderRaster,
  renderRGBA,
  renderSVG,
  resolveTheme,
  themeContrast,
} from '@simurgh/core/render';
import { darkFraction, decodeImage, detectPolarity, invertImage, type GrayImage } from '@simurgh/core/imaging';

const TEXT = 'https://simurgh.code/fa/palette';
const sym = encode({ text: TEXT, ecc: 'M' });
const model = toModel(sym);

/** Reduce RGBA to luminance the way a camera's ISP does. */
function luma(rgba: { width: number; height: number; data: Uint8Array }): GrayImage {
  const out = new Uint8Array(rgba.width * rgba.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(
      0.2126 * rgba.data[i * 4]! + 0.7152 * rgba.data[i * 4 + 1]! + 0.0722 * rgba.data[i * 4 + 2]!,
    );
  }
  return { width: rgba.width, height: rgba.height, data: out };
}

/** Paste `inner` in the middle of a `size`-square canvas filled with `fill`. */
function frame(inner: GrayImage, margin: number, fill: number): GrayImage {
  const size = inner.width + 2 * margin;
  const data = new Uint8Array(size * size).fill(fill);
  for (let y = 0; y < inner.height; y++) {
    for (let x = 0; x < inner.width; x++) {
      data[(y + margin) * size + (x + margin)] = inner.data[y * inner.width + x]!;
    }
  }
  return { width: size, height: size, data };
}

describe('palette arithmetic', () => {
  it('parses hex colours in all three widths', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#123a72')).toEqual([0x12, 0x3a, 0x72]);
    expect(parseHex('  #123A72ff ')).toEqual([0x12, 0x3a, 0x72]);
    expect(() => parseHex('#12345')).toThrow();
  });

  it('computes WCAG relative luminance and contrast ratio', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 6);
    expect(contrastRatio('#123a72', '#f7f3e6')).toBe(contrastRatio('#f7f3e6', '#123a72'));
  });

  it('ships only palettes that clear the print floor', () => {
    expect(THEME_IDS.length).toBeGreaterThanOrEqual(8);
    for (const id of THEME_IDS) {
      const c = themeContrast(THEMES[id]!);
      expect(c.worst, `${id} must be printable`).toBeGreaterThanOrEqual(PRINT_CONTRAST_FLOOR);
      expect(c.printable, id).toBe(true);
      expect(c.scannable, id).toBe(true);
      expect(c.verdict, id).toBe('print-safe');
    }
  });

  it('rejects a palette that would not survive a camera', () => {
    const washed = { id: 'washed', fa: 'کم‌رنگ', en: 'washed out', ink: '#cccccc', crown: '#cccccc', paper: '#ffffff' };
    const c = themeContrast(washed);
    expect(c.worst).toBeLessThan(SCAN_CONTRAST_FLOOR);
    expect(c.printable).toBe(false);
    expect(c.scannable).toBe(false);
    expect(c.verdict).toMatch(/unscannable/);
  });

  it('resolves ids, inline themes and the default', () => {
    expect(resolveTheme().id).toBe('ink');
    expect(resolveTheme('lapis').ink).toBe('#123a72');
    expect(resolveTheme(THEMES.turquoise).id).toBe('turquoise');
    expect(() => resolveTheme('nope')).toThrow(/unknown theme/);
  });
});

describe('colour rendering', () => {
  it('keeps inkDistance exactly the minimum of crown and field', () => {
    // The refactor that made a second Crown colour possible must not have moved a
    // single pixel of the grayscale renderer, which every decode test depends on.
    for (const [x, y] of [
      [0, 0],
      [3.5, -2.25],
      [-8, 4],
      [12.9, 12.9],
      [-15.4, 0.3],
      [0, 19.8],
    ]) {
      expect(inkDistance(model, x, y, 'dot', 1)).toBe(
        Math.min(crownDistance(model, x, y), fieldDistance(model, x, y, 'dot', 1)),
      );
    }
  });

  it('paints paper, Crown and modules in the theme colours', () => {
    const img = renderRGBA(model, { theme: 'lapis', scale: 8 });
    const at = (x: number, y: number): [number, number, number] => [
      img.data[(y * img.width + x) * 4]!,
      img.data[(y * img.width + x) * 4 + 1]!,
      img.data[(y * img.width + x) * 4 + 2]!,
    ];
    const paper = parseHex('#f7f3e6');
    expect(at(1, 1)).toEqual(paper); // corner of the quiet zone
    expect(at(img.width >> 1, img.height >> 1)).not.toEqual(paper); // core rosette is inked

    // Walking the Limbus must find the Crown ink, which is a different colour
    // from the module ink in this palette.
    const crownRgb = parseHex('#0d2a55');
    const pitch = img.width / (2 * (model.outerRadius + model.crown.quietZone));
    const rLimbus = ((model.crown.limbusInner + model.crown.limbusOuter) / 2) * pitch;
    let sawCrown = 0;
    for (let deg = 0; deg < 360; deg += 3) {
      const a = (deg * Math.PI) / 180;
      const px = Math.round(img.width / 2 + rLimbus * Math.cos(a));
      const py = Math.round(img.height / 2 + rLimbus * Math.sin(a));
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const [r, g, b] = at(px, py);
      if (Math.abs(r - crownRgb[0]) + Math.abs(g - crownRgb[1]) + Math.abs(b - crownRgb[2]) < 24) sawCrown++;
    }
    expect(sawCrown).toBeGreaterThan(60); // most of the ring, allowing for anti-aliasing
  });

  it('lets explicit dark/light levels override the theme, as before', () => {
    const themed = renderRGBA(model, { scale: 4 });
    const explicit = renderRGBA(model, { scale: 4, dark: 0, light: 255 });
    expect(explicit.data[0]).toBe(255);
    expect(themed.data[0]).toBe(parseHex(THEMES.ink!.paper)[0]);
  });

  it('emits a themed SVG that names its palette and its contrast', () => {
    const svg = renderSVG(model, { theme: 'pomegranate', caption: null });
    expect(svg).toContain('theme pomegranate');
    expect(svg).toContain('print-safe');
    expect(svg).toContain('#6d0f1c'); // module ink
    expect(svg).toContain('#4c0912'); // Crown ink
    expect(svg.startsWith('<?xml')).toBe(true);
  });
});

describe('scanning coloured and inverted symbols', () => {
  it('reads every palette back through the luminance pipeline', () => {
    for (const id of ['ink', 'lapis', 'turquoise', 'pomegranate', 'night']) {
      const res = decodeImage(luma(renderRGBA(model, { theme: id, scale: 8 })));
      expect(res.ok, `${id}: ${res.error ?? ''}`).toBe(true);
      expect(res.text).toBe(TEXT);
      expect(res.diagnostics.teethMatches).toBe(63);
    }
  });

  it('measures polarity from the image histogram', () => {
    const normal = renderRaster(model, { scale: 6 });
    const inverted = invertImage(normal);
    expect(darkFraction(normal)).toBeLessThan(0.5);
    expect(darkFraction(inverted)).toBeGreaterThan(0.5);
    expect(detectPolarity(normal)).toBe('normal');
    expect(detectPolarity(inverted)).toBe('inverted');
  });

  it('reads a light-on-dark symbol, and reports that it flipped it', () => {
    const res = decodeImage(invertImage(renderRaster(model, { scale: 8 })));
    expect(res.ok, res.error ?? '').toBe(true);
    expect(res.text).toBe(TEXT);
    expect(res.diagnostics.inverted).toBe(true);
    // The histogram guess was right, so no retry was needed.
    expect(res.diagnostics.polarityRetries).toBe(0);
  });

  it('is the polarity flip that saves it, not a lucky matcher', () => {
    const inverted = invertImage(renderRaster(model, { scale: 8 }));
    const pinned = decodeImage(inverted, { polarity: 'normal', noPolarityRetry: true });
    expect(pinned.ok).toBe(false);
    const explicit = decodeImage(inverted, { polarity: 'inverted' });
    expect(explicit.ok).toBe(true);
    expect(explicit.text).toBe(TEXT);
    expect(explicit.diagnostics.inverted).toBe(true);
  });

  it('retries the opposite polarity when the histogram guesses wrong', () => {
    /*
     * An inverted symbol inside a wide white margin: most of the frame is bright,
     * so the dark fraction falls under 0.5 and 'auto' starts from the wrong side.
     * The first pass must fail, the retry must flip and succeed -- and the result
     * must say so, because a silent retry would hide a real performance cost.
     */
    const inner = invertImage(renderRaster(model, { scale: 5 }));
    const img = frame(inner, Math.round(inner.width * 0.9), 255);
    expect(darkFraction(img)).toBeLessThan(0.5);

    const res = decodeImage(img);
    expect(res.ok, res.error ?? '').toBe(true);
    expect(res.text).toBe(TEXT);
    expect(res.diagnostics.polarityRetries).toBe(1);
    expect(res.diagnostics.inverted).toBe(true);

    // Pinned to the wrong polarity with no retry, the same image must fail.
    expect(decodeImage(img, { polarity: 'normal', noPolarityRetry: true }).ok).toBe(false);
  });

  it('never pays for the retry on a clean symbol', () => {
    const res = decodeImage(renderRaster(model, { scale: 6 }));
    expect(res.ok).toBe(true);
    expect(res.diagnostics.polarityRetries).toBe(0);
    expect(res.diagnostics.inverted).toBe(false);
  });

  it('still seals and opens an encrypted symbol that was rendered in colour', () => {
    const sealed = encode({ text: 'رمز رنگی', ecc: 'Q', secure: { key: 'palette', iterations: 4096 } });
    const img = luma(renderRGBA(toModel(sealed), { theme: 'turquoise', scale: 7 }));
    const locked = decodeImage(img);
    expect(locked.ok).toBe(true);
    expect(locked.encrypted).toBe(true);
    expect(locked.secureUnlocked).toBeFalsy();
    const opened = decodeImage(img, { secure: { key: 'palette' } });
    expect(opened.text).toBe('رمز رنگی');
    expect(opened.secureUnlocked).toBe(true);
  });
});
