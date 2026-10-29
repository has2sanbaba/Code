/**
 * ============================================================================
 *  PRINT-AND-SCAN SIMULATOR
 * ============================================================================
 *
 * A symbology is only as good as the worst image a scanner hands it. This
 * module produces those worst-case images deterministically, so robustness can
 * be measured instead of hoped for:
 *
 *   rotate        arbitrary in-plane rotation (nothing is "upside down")
 *   perspective   a real homography, i.e. a tilted phone camera
 *   blur          out-of-focus optics / ink spread on paper
 *   noise         sensor noise at a chosen sigma
 *   contrast      faded ribbon, cheap thermal transfer, sun-bleached label
 *   occlude       scratches, holes, stickers, thumb over the lens
 *   downscale     a symbol that is simply too small for the sensor
 *
 * Everything is seeded, so a failing case can be reproduced exactly and turned
 * into a regression test.
 */
import { makeRng } from '../crc.js';
import { blur, makeImage, sampleBilinear, type GrayImage } from './image.js';
import { invert3x3 } from './orient.js';

/** Resample `img` into a w x h output using an output->input point mapping. */
export function warp(img: GrayImage, inv: (x: number, y: number) => { x: number; y: number }, w: number, h: number, fill = 255): GrayImage {
  const out = makeImage(w, h, fill);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = inv(x + 0.5, y + 0.5);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const v = sampleBilinear(img, p.x - 0.5, p.y - 0.5);
      if (!Number.isNaN(v)) out.data[y * w + x] = v;
    }
  }
  return out;
}

/** Apply a 3x3 homography (input->output) and render into a canvas of size w x h. */
export function warpHomography(img: GrayImage, H: ArrayLike<number>, w: number, h: number, fill = 255): GrayImage {
  const inv = invert3x3(H);
  return warp(
    img,
    (x, y) => {
      const ww = (inv[6] as number) * x + (inv[7] as number) * y + (inv[8] as number);
      if (Math.abs(ww) < 1e-9) return { x: NaN, y: NaN };
      return {
        x: ((inv[0] as number) * x + (inv[1] as number) * y + (inv[2] as number)) / ww,
        y: ((inv[3] as number) * x + (inv[4] as number) * y + (inv[5] as number)) / ww,
      };
    },
    w,
    h,
    fill,
  );
}

/** Rotate about the image centre, keeping the whole frame. */
export function rotate(img: GrayImage, deg: number, fill = 255): GrayImage {
  const a = (deg * Math.PI) / 180;
  const cx = img.width / 2;
  const cy = img.height / 2;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return warp(
    img,
    (x, y) => {
      const dx = x - cx;
      const dy = y - cy;
      return { x: cx + dx * cos + dy * sin, y: cy - dx * sin + dy * cos };
    },
    img.width,
    img.height,
    fill,
  );
}

/**
 * Simulate a camera looking at the label from an angle.
 * `tiltX`/`tiltY` are in degrees; `zoom` scales the projection.
 */
export function perspective(img: GrayImage, tiltX: number, tiltY: number, zoom = 1, fill = 255): GrayImage {
  const H = perspectiveMatrix(img.width, img.height, (tiltX * Math.PI) / 180, (tiltY * Math.PI) / 180, zoom);
  return warpHomography(img, H, img.width, img.height, fill);
}

/**
 * Homography of a plane tilted by `ax` about the image x-axis and `ay` about
 * the y-axis, then perspective-projected with focal length `f` (in pixels) and
 * re-centred. Derived in closed form so tests do not depend on a 3-D library:
 *
 *   X = x-cx, Y = y-cy                                  (plane, Z = 0)
 *   rotate x: (X, Y ca, Y sa)
 *   rotate y: (X cb + Y sa sb, Y ca, -X sb + Y sa cb)
 *   project : u = f X2/(Z2+f), v = f Y2/(Z2+f)
 *   zoom and re-centre are folded into the 3x3 matrix.
 */
export function perspectiveMatrix(
  w: number,
  h: number,
  ax: number,
  ay: number,
  zoom = 1,
  fScale = 2.2,
): number[] {
  const cx = w / 2;
  const cy = h / 2;
  const f = Math.max(w, h) * fScale;
  const ca = Math.cos(ax);
  const sa = Math.sin(ax);
  const cb = Math.cos(ay);
  const sb = Math.sin(ay);

  const A = f * cb; // coefficient of X in the u numerator
  const B = f * sa * sb; // coefficient of Y in the u numerator
  const D = f * ca; // coefficient of Y in the v numerator
  const E = -sb; // coefficient of X in the denominator
  const F = sa * cb; // coefficient of Y in the denominator
  const denC = -E * cx - F * cy + f; // constant term of the denominator

  const uC = -A * cx - B * cy;
  const vC = -D * cy;

  return [
    zoom * A + cx * E,
    zoom * B + cx * F,
    zoom * uC + cx * denC,
    cy * E,
    zoom * D + cy * F,
    zoom * vC + cy * denC,
    E,
    F,
    denC,
  ];
}


/** Additive Gaussian noise (Box-Muller), clamped to [0,255]. */
export function noise(img: GrayImage, sigma: number, seed = 1): GrayImage {
  const rnd = makeRng(seed);
  const out = makeImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    let u1 = rnd();
    const u2 = rnd();
    if (u1 < 1e-9) u1 = 1e-9;
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out.data[i] = Math.max(0, Math.min(255, Math.round((img.data[i] as number) + g * sigma)));
  }
  return out;
}

/** Stretch/compress the tonal range: faded print or a dirty lens. */
export function contrast(img: GrayImage, lo: number, hi: number, gamma = 1): GrayImage {
  const out = makeImage(img.width, img.height);
  for (let i = 0; i < img.data.length; i++) {
    let v = ((img.data[i] as number) - lo) / Math.max(1, hi - lo);
    v = Math.max(0, Math.min(1, v));
    if (gamma !== 1) v = Math.pow(v, gamma);
    out.data[i] = Math.round(v * 255);
  }
  return out;
}

export interface Blob {
  /** Centre as a fraction of width/height. */
  fx: number;
  fy: number;
  /** Radius as a fraction of min(width, height). */
  fr: number;
  /** 0 = paint white (hole/scratch), 255 = paint black (ink spill). */
  value?: number;
  /** Feather in pixels. */
  feather?: number;
}

/** Punch opaque blobs through the image: holes, scratches, stickers, thumbs. */
export function occlude(img: GrayImage, blobs: Blob[]): GrayImage {
  const out = { width: img.width, height: img.height, data: img.data.slice() };
  const m = Math.min(img.width, img.height);
  for (const b of blobs) {
    const cx = b.fx * img.width;
    const cy = b.fy * img.height;
    const r = b.fr * m;
    const value = b.value ?? 255;
    const feather = b.feather ?? Math.max(1, r * 0.12);
    const x0 = Math.max(0, Math.floor(cx - r - feather));
    const x1 = Math.min(img.width - 1, Math.ceil(cx + r + feather));
    const y0 = Math.max(0, Math.floor(cy - r - feather));
    const y1 = Math.min(img.height - 1, Math.ceil(cy + r + feather));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const a = d <= r ? 1 : d >= r + feather ? 0 : 1 - (d - r) / feather;
        if (a <= 0) continue;
        const i = y * img.width + x;
        out.data[i] = Math.round((out.data[i] as number) * (1 - a) + value * a);
      }
    }
  }
  return out;
}

/** Nearest-neighbour downscale then bilinear upscale: the "too few pixels" case. */
export function resample(img: GrayImage, targetWidth: number): GrayImage {
  const s = targetWidth / img.width;
  const w = Math.max(1, Math.round(img.width * s));
  const h = Math.max(1, Math.round(img.height * s));
  const small = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // NOTE: not `|| 255`. Fully inked pixels sample to exactly 0, and 0 is
      // falsy, so a `||` default silently paints the darkest ink white.
      const v = sampleBilinear(img, (x + 0.5) / s - 0.5, (y + 0.5) / s - 0.5);
      small.data[y * w + x] = Number.isFinite(v) ? (v as number) : 255;
    }
  }
  return warp(
    small,
    (x, y) => ({ x: (x + 0.5) * s - 0.5, y: (y + 0.5) * s - 0.5 }),
    img.width,
    img.height,
  );
}

/** Convenience: build a whole degradation chain in one call. */
export interface Degradation {
  rotateDeg?: number;
  blurPasses?: number;
  noiseSigma?: number;
  contrastLo?: number;
  contrastHi?: number;
  gamma?: number;
  blobs?: Blob[];
  resampleWidth?: number;
  homography?: number[];
  seed?: number;
}

export function degrade(img: GrayImage, d: Degradation): GrayImage {
  let out = img;
  if (d.homography) out = warpHomography(out, d.homography, out.width, out.height);
  if (d.rotateDeg) out = rotate(out, d.rotateDeg);
  if (d.resampleWidth) out = resample(out, d.resampleWidth);
  if (d.blurPasses) out = blur(out, d.blurPasses);
  if (d.contrastLo !== undefined || d.contrastHi !== undefined) {
    out = contrast(out, d.contrastLo ?? 0, d.contrastHi ?? 255, d.gamma ?? 1);
  }
  if (d.noiseSigma) out = noise(out, d.noiseSigma, d.seed ?? 1);
  if (d.blobs) out = occlude(out, d.blobs);
  return out;
}
