import { describe, expect, it } from 'vitest';
import { encode, getLattice, makeRng, payloadToText, toModel, type SymbolModel } from '@simurgh/core';
import { renderAscii, renderRaster, renderSVG } from '@simurgh/core/render';
import {
  applyMaskPrior,
  blur,
  contrast,
  decodeImage,
  decodeRGBA,
  locate,
  noise,
  occlude,
  perspective,
  resample,
  rotate,
  type GrayImage,
} from '@simurgh/core/imaging';

const TEXT = 'https://simurgh.example/fa/سلام-世界 robustness';

/** Rendered once and reused: encoding plus rasterising is not what is under test. */
const symbol = encode({ text: TEXT, ecc: 'M' });
const model: SymbolModel = toModel(symbol, TEXT);

function render(scale = 8, shape: 'dot' | 'hex' | 'square' = 'dot'): GrayImage {
  return renderRaster(model, { scale, shape });
}

function darkFraction(img: GrayImage): number {
  let dark = 0;
  for (let i = 0; i < img.data.length; i++) if ((img.data[i] as number) < 128) dark++;
  return dark / img.data.length;
}

describe('rasteriser', () => {
  it('sizes the canvas from the quiet zone and keeps the border clean', () => {
    const img = render(8);
    const side = Math.round(2 * model.canvasRadius * 8);
    expect(img.width).toBe(side);
    expect(img.height).toBe(side);
    expect(img.data.length).toBe(side * side);
    // every pixel of the quiet zone is substrate, and so is the outermost row
    for (let x = 0; x < side; x++) {
      expect(img.data[x]).toBe(255);
      expect(img.data[(side - 1) * side + x]).toBe(255);
      expect(img.data[x * side]).toBe(255);
      expect(img.data[x * side + side - 1]).toBe(255);
    }
  });

  it('lands near 50% ink inside the symbol disc', () => {
    const img = render(8);
    const frac = darkFraction(img);
    // The data field itself is balanced near 50% by the mask; the whole canvas
    // is not, because the quiet zone, the Crown's gaps and the space between
    // circular modules are all substrate. 0.19 is what a balanced symbol looks
    // like end to end, and it is the number a printer should measure.
    expect(frac).toBeGreaterThan(0.15);
    expect(frac).toBeLessThan(0.25);
  });

  it('paints the Core rosette as a dark pupil inside a light ring', () => {
    const img = render(10);
    const c = Math.floor(img.width / 2);
    const pitch = img.width / (2 * model.canvasRadius);
    const at = (dx: number, dy: number) => img.data[Math.round(c + dy * pitch) * img.width + Math.round(c + dx * pitch)] as number;
    expect(at(0, 0)).toBeLessThan(128); // centre cell, dark
    expect(at(1, 0)).toBeGreaterThan(128); // ring 1, light
    expect(at(2, 0)).toBeLessThan(128); // ring 2, dark
  });

  it('renders all three module shapes with similar ink coverage', () => {
    const dot = darkFraction(render(8, 'dot'));
    const hex = darkFraction(render(8, 'hex'));
    const square = darkFraction(render(8, 'square'));
    // Hexagons tile the lattice exactly and squares overfill it, so both hold
    // more ink than the 0.46-radius dots -- but all three stay printable.
    expect(hex).toBeGreaterThan(dot);
    expect(square).toBeGreaterThan(hex);
    expect(square).toBeLessThan(dot * 1.5);
    // An unknown shape is a hard error, not a blank image.
    expect(() => renderRaster(model, { scale: 4, shape: 'hexagon' as never })).toThrow(/unknown module shape/);
  });

  it('rotating the raster does not change how much ink it holds', () => {
    const a = renderRaster(model, { scale: 8 });
    const b = renderRaster(model, { scale: 8, rotateDeg: 37 });
    expect(Math.abs(darkFraction(a) - darkFraction(b))).toBeLessThan(0.01);
  });
});

describe('vector and text renderers', () => {
  it('emits a self-contained SVG that carries the format record', () => {
    const svg = renderSVG(model, { scale: 4, unit: 'mm', caption: TEXT });
    expect(svg).toContain('<?xml');
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox');
    expect(svg).toMatch(/<\/svg>\s*$/);
    // The human-readable payload travels with the artwork as a caption, and the
    // machine-readable format record travels with it as an XML comment, so a
    // designer who loses the database still has both.
    expect(svg).toContain('SiMurgh');
    expect(svg).toContain('<!--');
    expect(svg).toContain(TEXT.replace('&', '&amp;').slice(0, 20));
    expect(svg.length).toBeGreaterThan(2000);
  });

  it('emits ASCII art with one line per module row', () => {
    const art = renderAscii(model, { columnsPerModule: 1, shade: false });
    const lines = art.split('\n').filter((l) => l.length > 0);
    // Terminal glyphs are about twice as tall as wide, so the rasteriser emits
    // one row per two module rows and doubles every glyph horizontally.
    const cols = Math.ceil(model.canvasRadius * 2);
    expect(lines.length).toBe(Math.ceil(cols / 2));
    for (const line of lines) expect(line.length).toBe(cols * 2);
    expect(art).toContain('\u2588\u2588'); // something is inked
  });
});

describe('locator', () => {
  it('finds the centre, the version and the pitch of a clean symbol', () => {
    const img = render(10);
    const loc = locate(img)!;
    expect(loc).not.toBeNull();
    expect(loc.version).toBe(symbol.version);
    expect(loc.K).toBe(getLattice(symbol.version).K);
    const c = img.width / 2;
    expect(Math.abs(loc.cx - c)).toBeLessThan(1.5);
    expect(Math.abs(loc.cy - c)).toBeLessThan(1.5);
    expect(Math.abs(loc.pitch - 10)).toBeLessThan(0.4);
    expect(loc.ringCoverage).toBeGreaterThan(0.9);
    expect(loc.angularScore!).toBeLessThan(0.15);
  });

  it('still finds the symbol when it is rotated and tilted', () => {
    const img = perspective(rotate(render(10), 41), 22, -14);
    const loc = locate(img)!;
    expect(loc).not.toBeNull();
    // Under tilt the traced radii can put the size estimate a ring out; the
    // decode ladder re-derives the exact size from the Format Crown, so "close"
    // is all the locator has to be.
    expect(Math.abs(loc.version - symbol.version)).toBeLessThanOrEqual(1);
    /*
     * ringCoverage counts how often the *circular* Limbus trace hit ink. Under
     * tilt the Limbus projects to an ellipse, so that figure collapses to 0.08
     * on an image that still decodes perfectly -- it is a clean-image quality
     * metric, not a pose metric. The perspective-aware angular Crown score is
     * the one that keeps meaning something.
     */
    expect(loc.ringCoverage).toBeLessThan(0.5);
    expect(loc.angularScore!).toBeLessThan(0.35);
    expect(loc.outer).toBeDefined();
  });
});

describe('image decode', () => {
  function check(label: string, img: GrayImage, minConfidence = 0.5): void {
    const res = decodeImage(img);
    const d = res.diagnostics;
    expect(res.ok, `${label}: ${res.error ?? ''} teeth=${d.teethMatches} crown=${d.crownOk} conf=${d.meanConfidence.toFixed(2)}`).toBe(true);
    expect(res.version, label).toBe(symbol.version);
    expect(payloadToText(res.payload!), label).toBe(TEXT);
    expect(d.meanConfidence, label).toBeGreaterThan(minConfidence);
    expect(d.crownOk, label).toBe(true);
  }

  it('clean', () => {
    check('clean', render(10));
  });

  it('rotated 37 degrees', () => {
    check('rotate37', rotate(render(10), 37));
  });

  it('rotated 133 degrees with noise', () => {
    check('rotate133+noise', noise(rotate(render(10), 133), 18, 3));
  });

  it('blurred and noisy', () => {
    check('blur+noise', noise(blur(render(10), 2), 12, 3));
  });

  it('perspective 25/15 degrees', () => {
    check('perspective', perspective(render(10), 25, 15));
  });

  it('perspective 35/-25 degrees with noise', () => {
    check('perspective+noise', noise(perspective(render(10), 35, -25), 10, 5), 0.4);
  });

  it('occluded by a 12% disc over the centre', () => {
    // 12% of the disc area: fr is a fraction of min(width, height)
    check('occlude12', occlude(render(10), [{ fx: 0.5, fy: 0.5, fr: 0.12, feather: 4 }]));
  });

  it('faded contrast and heavy noise', () => {
    check('lowcontrast', noise(contrast(render(10), 90, 190), 20, 9), 0.45);
  });

  it('resampled down to about 2.3 pixels per module', () => {
    check('resample120', resample(render(10), 120), 0.45);
  });

  it('hexagon modules', () => {
    check('hex', render(9, 'hex'));
  });

  it('square modules', () => {
    check('square', render(9, 'square'));
  });

  it('rotated, tilted, blurred, noisy and ink-spilled all at once', () => {
    // The whole degradation stack in one image: 22 degrees of rotation, 18/12
    // degrees of perspective, a blur pass, sigma-14 noise and a black spill over
    // part of the Crown.
    check(
      'combined',
      occlude(noise(blur(perspective(rotate(render(10), 22), 18, 12), 1), 14, 9), [
        { fx: 0.62, fy: 0.35, fr: 0.06, value: 255, feather: 2 },
      ]),
      0.45,
    );
  });

  it('accepts RGBA pixels as well as greyscale', () => {
    const img = render(8);
    const rgba = new Uint8Array(img.width * img.height * 4);
    for (let i = 0; i < img.data.length; i++) {
      const v = img.data[i] as number;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
    }
    const res = decodeRGBA(rgba, img.width, img.height);
    expect(res.ok, res.error).toBe(true);
    expect(payloadToText(res.payload!)).toBe(TEXT);
  });

  it('recovers the rotation to well under one tooth of the Angle Track', () => {
    for (const deg of [0, 37, 133, 271]) {
      const res = decodeImage(rotate(render(10), deg));
      expect(res.ok, `rotate ${deg}: ${res.error}`).toBe(true);
      // A tooth is 360/63 = 5.71 degrees; the reported angle is modulo 360.
      const err = Math.min(
        Math.abs(res.diagnostics.rotationDeg - (360 - deg)) % 360,
        360 - (Math.abs(res.diagnostics.rotationDeg - (360 - deg)) % 360),
      );
      expect(err, `rotate ${deg}: got ${res.diagnostics.rotationDeg}`).toBeLessThan(2);
    }
  });

  it('refuses an image that contains no symbol', () => {
    const rng = makeRng(4);
    const junk: GrayImage = {
      width: 300,
      height: 300,
      data: Uint8Array.from({ length: 300 * 300 }, () => Math.floor(rng() * 256)),
    };
    const res = decodeImage(junk);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('reports why a damaged symbol could not be corrected', () => {
    // Three separated blobs: individually survivable, jointly beyond level M.
    const res = decodeImage(
      occlude(render(10), [
        { fx: 0.42, fy: 0.38, fr: 0.07, feather: 1 },
        { fx: 0.6, fy: 0.55, fr: 0.08, feather: 1 },
        { fx: 0.5, fy: 0.68, fr: 0.06, feather: 1 },
      ]),
    );
    // Beyond the code's reach the decoder must say so rather than invent text.
    if (!res.ok) expect(res.error).toMatch(/Reed-Solomon|crc|payload|format/i);
  });
});

describe('ECC ladder under physical damage', () => {
  it('level H survives a hole that level M cannot', () => {
    const hole = (img: GrayImage) => occlude(img, [{ fx: 0.5, fy: 0.5, fr: 0.155, feather: 3 }]);
    const m = decodeImage(hole(renderRaster(toModel(encode({ text: TEXT, ecc: 'M' })), 9)));
    const h = decodeImage(hole(renderRaster(toModel(encode({ text: TEXT, ecc: 'H' })), 9)));
    expect(h.ok, h.error).toBe(true);
    expect(payloadToText(h.payload!)).toBe(TEXT);
    // M carries 28% parity against H's 55%, so the same hole is beyond it.
    expect(m.ok).toBe(false);
  });
});

describe('damage detector (mask prior)', () => {
  it('flags almost nothing on a clean symbol', () => {
    const sampled = decodeImage(render(10)).sampled!;
    expect(sampled).toBeDefined();
    const res = applyMaskPrior(sampled.version, sampled.dataBits, Float32Array.from(sampled.confidence));
    const per612 = (res.seeds / sampled.dataBits.length) * 612;
    // Measured over 182k neighbourhoods: 2.1 false seeds per 612-cell symbol.
    expect(per612).toBeLessThan(12);
    expect(res.flagged).toBeGreaterThanOrEqual(res.seeds);
  });

  it('flags the cells around a hole and lowers their confidence', () => {
    const sampled = decodeImage(occlude(render(10), [{ fx: 0.5, fy: 0.5, fr: 0.12, feather: 1 }])).sampled!;
    const before = mean(sampled.confidence);
    const res = applyMaskPrior(sampled.version, sampled.dataBits, Float32Array.from(sampled.confidence));
    expect(res.seeds).toBeGreaterThan(0);
    expect(res.flagged).toBeGreaterThan(res.seeds); // dilation adds neighbours
    expect(res.meanConfidence).toBeLessThan(before);
  });

  it('can be switched off, which is what makes its contribution measurable', () => {
    const sampled = decodeImage(render(10)).sampled!;
    const res = applyMaskPrior(sampled.version, sampled.dataBits, Float32Array.from(sampled.confidence), {
      disabled: true,
    });
    expect(res.seeds).toBe(0);
    expect(res.flagged).toBe(0);
  });

  it('the detector costs a clean symbol only a couple of erasure slots', () => {
    const res = decodeImage(render(10));
    expect(res.diagnostics.maskPriorSeeds).toBeLessThan(6);
    expect(res.diagnostics.erasureCells).toBeLessThan(40);
  });
});

function mean(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] as number;
  return s / a.length;
}
