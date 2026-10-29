/**
 * Minimal grayscale image toolkit used by the decoder.
 *
 * Conventions: 0 = black (ink), 255 = white (substrate). Coordinates are
 * (x, y) with x to the right and y *downwards*, i.e. standard image space;
 * every conversion to/from the symbol's mathematical space flips y.
 */

export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function makeImage(width: number, height: number, fill = 255): GrayImage {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}

export function cloneImage(img: GrayImage): GrayImage {
  return { width: img.width, height: img.height, data: img.data.slice() };
}

/** Nearest-neighbour, clamped to the border. */
export function getPixel(img: GrayImage, x: number, y: number): number {
  const xi = x < 0 ? 0 : x >= img.width ? img.width - 1 : Math.round(x);
  const yi = y < 0 ? 0 : y >= img.height ? img.height - 1 : Math.round(y);
  return img.data[yi * img.width + xi] as number;
}

/** True when (x, y) is strictly inside the image. */
export function inBounds(img: GrayImage, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < img.width && y < img.height;
}

/** Bilinear interpolation; returns NaN outside the image. */
export function sampleBilinear(img: GrayImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x > img.width - 1 || y > img.height - 1) return NaN;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const w = img.width;
  const p00 = img.data[y0 * w + x0] as number;
  const p10 = img.data[y0 * w + x0 + 1] as number;
  const p01 = img.data[(y0 + 1) * w + x0] as number;
  const p11 = img.data[(y0 + 1) * w + x0 + 1] as number;
  const top = p00 + (p10 - p00) * fx;
  const bot = p01 + (p11 - p01) * fx;
  return top + (bot - top) * fy;
}

/**
 * 13-point sunflower kernel inside the unit disc. Used for every area sample:
 * it is rotationally unbiased (unlike a square grid) and cheap.
 */
const DISC_KERNEL: [number, number][] = (() => {
  const pts: [number, number][] = [[0, 0]];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 1; i < 13; i++) {
    const rr = Math.sqrt(i / 13) * 0.92;
    const a = i * golden;
    pts.push([rr * Math.cos(a), rr * Math.sin(a)]);
  }
  return pts;
})();

export interface DiscSample {
  mean: number;
  min: number;
  max: number;
  n: number;
  /** Fraction of kernel samples that fell outside the image. */
  outside: number;
}

/** Average intensity inside a disc of radius r centred on (cx, cy). */
export function sampleDisc(img: GrayImage, cx: number, cy: number, r: number): DiscSample {
  let sum = 0;
  let n = 0;
  let min = 255;
  let max = 0;
  let outside = 0;
  for (const [kx, ky] of DISC_KERNEL) {
    const v = sampleBilinear(img, cx + kx * r, cy + ky * r);
    if (Number.isNaN(v)) {
      outside++;
      continue;
    }
    sum += v;
    n++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { mean: n ? sum / n : 255, min: n ? min : 255, max: n ? max : 0, n, outside: outside / DISC_KERNEL.length };
}

/** Otsu's threshold over the whole image. */
export function otsuThreshold(img: GrayImage): number {
  const hist = new Int32Array(256);
  for (let i = 0; i < img.data.length; i++) {
    const v = img.data[i] as number;
    hist[v] = (hist[v] as number) + 1;
  }
  const total = img.data.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * (hist[t] as number);
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t] as number;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * (hist[t] as number);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return bestT;
}

/** 1 = ink, 0 = substrate. */
/**
 * Fraction of pixels at or below the Otsu split.
 *
 * A SiMurgh symbol printed dark-on-light and photographed with any reasonable
 * margin puts this between roughly 0.05 and 0.45; the same symbol inverted
 * (light ink on a dark substrate, which is what a screen shows in dark mode and
 * what white-on-black packaging prints) lands above 0.5. That single number is
 * enough to pick which polarity to try first -- see `detectPolarity`.
 */
export function darkFraction(img: GrayImage): number {
  const t = otsuThreshold(img);
  let dark = 0;
  for (let i = 0; i < img.data.length; i++) if ((img.data[i] as number) <= t) dark++;
  return dark / Math.max(1, img.data.length);
}

/** A copy of the image with its polarity flipped (255 - v). */
export function invertImage(img: GrayImage): GrayImage {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = 255 - (img.data[i] as number);
  return { width: img.width, height: img.height, data: out };
}

/** Which polarity an image most likely holds a symbol in. */
export function detectPolarity(img: GrayImage): 'normal' | 'inverted' {
  return darkFraction(img) > 0.5 ? 'inverted' : 'normal';
}

export function binarize(img: GrayImage, t: number): Uint8Array {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) out[i] = (img.data[i] as number) <= t ? 1 : 0;
  return out;
}

/** Separable box blur, `radius` passes of a 3-tap [1 2 1]/4 kernel. */
export function blur(img: GrayImage, radius: number): GrayImage {
  if (radius <= 0) return img;
  let cur = img;
  for (let pass = 0; pass < radius; pass++) {
    const tmp = new Uint8Array(cur.data.length);
    const { width: w, height: h } = cur;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const l = cur.data[i - (x > 0 ? 1 : 0)] as number;
        const c = cur.data[i] as number;
        const r = cur.data[i + (x < w - 1 ? 1 : 0)] as number;
        tmp[i] = (l + 2 * c + r) >> 2;
      }
    }
    const out = new Uint8Array(tmp.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const u = tmp[i - (y > 0 ? w : 0)] as number;
        const c = tmp[i] as number;
        const d = tmp[i + (y < h - 1 ? w : 0)] as number;
        out[i] = (u + 2 * c + d) >> 2;
      }
    }
    cur = { width: w, height: h, data: out };
  }
  return cur;
}

/**
 * Decode common raster formats into a GrayImage.
 * PNG/JPEG/WebP go through whatever image decoder the host provides
 * (`createImageBitmap` in browsers, a caller-supplied loader in Node), so this
 * helper only deals with the trivial formats and luma conversion.
 */
export function rgbaToGray(data: Uint8Array | Uint8ClampedArray, width: number, height: number): GrayImage {
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = data[p] as number;
    const g = data[p + 1] as number;
    const b = data[p + 2] as number;
    const a = data[p + 3] as number;
    // Rec.709 luma, composited over white for transparency
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[i] = Math.round((luma * a) / 255 + 255 * (1 - a / 255));
  }
  return { width, height, data: out };
}

/** Crop, clamped to the source image. */
export function crop(img: GrayImage, x0: number, y0: number, w: number, h: number): GrayImage {
  const sx = Math.max(0, Math.floor(x0));
  const sy = Math.max(0, Math.floor(y0));
  const ex = Math.min(img.width, Math.ceil(x0 + w));
  const ey = Math.min(img.height, Math.ceil(y0 + h));
  const cw = Math.max(0, ex - sx);
  const ch = Math.max(0, ey - sy);
  const out = makeImage(cw, ch, 255);
  for (let y = 0; y < ch; y++) {
    out.data.set(img.data.subarray((sy + y) * img.width + sx, (sy + y) * img.width + sx + cw), y * cw);
  }
  return out;
}

/**
 * Encode a GrayImage as a (lossless, dependency-free) PGM file. Handy for
 * tests, bug reports and for piping into ImageMagick/GIMP.
 */
export function toPGM(img: GrayImage): Uint8Array {
  const header = `P5\n${img.width} ${img.height}\n255\n`;
  const out = new Uint8Array(header.length + img.data.length);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  out.set(img.data, header.length);
  return out;
}
