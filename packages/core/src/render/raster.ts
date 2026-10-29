/**
 * Signed-distance-field rasteriser.
 *
 * Every inked feature of a SiMurgh symbol -- Limbus, Halo, teeth, beads, Beak,
 * Core rosette and data cells -- is a shape whose signed distance field has a
 * closed form. Rendering therefore needs exactly ONE evaluation per pixel
 * (optionally supersampled) and produces genuine anti-aliasing instead of the
 * jagged edges you get from a scanline polygon filler. Anti-aliasing matters
 * here: a hard-edged downscale destroys the contrast the decoder measures.
 *
 * Output is a grayscale buffer, 0 = full ink, 255 = bare substrate.
 */
import {
  ANGLE_TRACK,
  BEADS,
  CELL_CIRCUMRADIUS,
  DOT_RADIUS,
  TOOTH_DEG,
  axialRound,
  coreIsDark,
  getLattice,
  hexDistance,
  ringIndexOf,
  xyToAxialF,
} from '../geometry.js';
import type { ModuleShape, SymbolModel } from '../model.js';

export interface GrayImage {
  width: number;
  height: number;
  /** 0 = black, 255 = white. */
  data: Uint8Array;
}

export interface RasterOptions {
  /** Pixels per module pitch. Default 8. */
  scale?: number;
  /** Data/core module shape. Default 'dot'. */
  shape?: ModuleShape;
  /** Quiet zone width in modules (default: the crown's own quiet zone). */
  quiet?: number;
  /** Ink level, default 0. */
  dark?: number;
  /** Substrate level, default 255. */
  light?: number;
  /** Supersampling factor (1 = pure SDF anti-aliasing). Default 1. */
  supersample?: number;
  /** Rotate the whole symbol, degrees counter-clockwise. Default 0. */
  rotateDeg?: number;
  /** Gap factor for 'hex' and 'square' shapes (1 = cells touch exactly). */
  cellGap?: number;
}

const HEX_NORMALS = (() => {
  const n: [number, number][] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (60 * k);
    n.push([Math.cos(a), Math.sin(a)]);
  }
  return n;
})();

function shapeDistance(dx: number, dy: number, shape: ModuleShape, gap: number): number {
  switch (shape) {
    case 'dot':
      return Math.hypot(dx, dy) - DOT_RADIUS * gap;
    case 'hex': {
      const rr = CELL_CIRCUMRADIUS * gap;
      const inradius = rr * (Math.sqrt(3) / 2);
      let m = -Infinity;
      for (const [nx, ny] of HEX_NORMALS) {
        const d = dx * nx + dy * ny - inradius;
        if (d > m) m = d;
      }
      return m;
    }
    case 'square': {
      const h = 0.5 * gap;
      return Math.max(Math.abs(dx) - h, Math.abs(dy) - h);
    }
    default: {
      // Unreachable through TypeScript. A JavaScript caller passing, say,
      // 'hexagon' used to fall through and return undefined, which makes every
      // SDF comparison false and renders a nearly blank symbol with no error at
      // all -- the quietest possible way to be wrong.
      throw new RangeError(`unknown module shape '${String(shape)}' (expected dot | hex | square)`);
    }
  }
}

/**
 * Signed distance (module units) from a point to the nearest inked feature.
 * Negative = inside ink.
 */
export function inkDistance(m: SymbolModel, x: number, y: number, shape: ModuleShape, gap: number): number {
  const g = m.crown;
  const r = Math.hypot(x, y);
  let best = Infinity;

  // --- Limbus and Halo: two solid annuli ----------------------------------
  best = Math.min(best, Math.max(g.limbusInner - r, r - g.limbusOuter));
  best = Math.min(best, Math.max(g.haloInner - r, r - g.haloOuter));

  const ang = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;

  // --- Angle Track (teeth) + Beak -----------------------------------------
  {
    const tf = ang / TOOTH_DEG;
    const ti = ((Math.round(tf) % 63) + 63) % 63;
    const u = tf - Math.round(tf); // in [-0.5, 0.5)
    const arc = (TOOTH_DEG * Math.PI) / 180 * r;
    const angular = (Math.abs(u) - 0.5) * arc;
    // tooth 0 is grown outward until it touches the Limbus: that is the Beak.
    const outer = ti === 0 ? g.beakRadius : g.teethOuter;
    if ((ANGLE_TRACK[ti] as number) === 1 && r <= outer + 1 && r >= g.teethInner - 1) {
      best = Math.min(best, Math.max(g.teethInner - r, r - outer, angular));
    }
  }

  // --- Format beads --------------------------------------------------------
  {
    const bd = 360 / BEADS;
    const bi = Math.round((ang - bd / 2) / bd);
    for (let k = -1; k <= 1; k++) {
      const i = ((bi + k) % BEADS + BEADS) % BEADS;
      if ((m.beads[i] as number) !== 1) continue;
      const a = ((i * bd + bd / 2) * Math.PI) / 180;
      const cx = g.beadRadius * Math.cos(a);
      const cy = g.beadRadius * Math.sin(a);
      const d = Math.hypot(x - cx, y - cy) - g.beadSize;
      if (d < best) best = d;
    }
  }

  // --- Lattice: Core rosette + data field ----------------------------------
  if (r <= g.haloInner + 0.6) {
    const f = xyToAxialF(x, y);
    const c = axialRound(f.q, f.r);
    const d = hexDistance(c.q, c.r);
    const lat = getLattice(m.version);
    let dark = false;
    let cx = 0;
    let cy = 0;
    if (d <= 2) {
      dark = coreIsDark(d);
      cx = c.q + c.r / 2;
      cy = (Math.sqrt(3) / 2) * c.r;
    } else if (d <= lat.K) {
      const idx = (lat.ringOffset[d] as number) + ringIndexOf(c.q, c.r, d);
      dark = (m.cellDark[idx] as number) === 1;
      cx = lat.xy[2 * idx] as number;
      cy = lat.xy[2 * idx + 1] as number;
    }
    if (dark) {
      const sd = shapeDistance(x - cx, y - cy, shape, gap);
      if (sd < best) best = sd;
    }
  }

  return best;
}

export function renderRaster(m: SymbolModel, opt: RasterOptions = {}): GrayImage {
  const scale = opt.scale ?? 8;
  const shape = opt.shape ?? 'dot';
  const quiet = opt.quiet ?? m.crown.quietZone;
  const dark = opt.dark ?? 0;
  const light = opt.light ?? 255;

  /*
   * Adaptive supersampling. Below about 5 pixels per module a single sample per
   * pixel aliases the dot edges badly enough to *move the apparent ring radii* --
   * at scale 4 the Crown reads a pitch of 3.71 instead of 4.00, and at scale 3.5
   * the symbol stops decoding altogether. Four samples per pixel restores both
   * (pitch 3.97, decodes clean). Above 8 px/module one sample is already exact to
   * better than a percent of a module, so the extra work is skipped.
   */
  const ss = Math.max(1, Math.round(opt.supersample ?? (scale < 5 ? 4 : scale < 8 ? 2 : 1)));

  const gap = opt.cellGap ?? (shape === 'dot' ? 1 : 0.94);
  const rot = ((opt.rotateDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);

  const radius = m.outerRadius + quiet;
  const size = Math.max(8, Math.ceil(radius * scale * 2));
  const img: GrayImage = { width: size, height: size, data: new Uint8Array(size * size).fill(light) };
  const cx = size / 2;
  const cy = size / 2;
  const px = 1 / scale; // one pixel, in module units
  const soft = px * (ss === 1 ? 1 : 1 / ss) * 0.95;

  const yLimit = Math.ceil(radius * scale);
  for (let py = 0; py < size; py++) {
    const rowBase = py * size;
    for (let pxi = 0; pxi < size; pxi++) {
      let acc = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ox = ss === 1 ? 0.5 : (sx + 0.5) / ss;
          const oy = ss === 1 ? 0.5 : (sy + 0.5) / ss;
          const ix = (pxi + ox - cx) * px;
          const iy = (cy - (py + oy)) * px; // flip y: image space -> model space
          const x = ix * cos - iy * sin;
          const y = ix * sin + iy * cos;
          const dist = inkDistance(m, x, y, shape, gap);
          const cov = 0.5 - dist / soft;
          acc += cov <= 0 ? 0 : cov >= 1 ? 1 : cov;
        }
      }
      const a = acc / (ss * ss);
      if (a <= 0) continue;
      img.data[rowBase + pxi] = Math.round(light + (dark - light) * a);
    }
  }
  // silence unused warning for the fast-path bound
  void yLimit;
  return img;
}

/** Crop/resize helper used by the test harness: nearest-neighbour downscale. */
export function downscale(img: GrayImage, factor: number): GrayImage {
  if (factor <= 1) return img;
  const w = Math.max(1, Math.round(img.width / factor));
  const h = Math.max(1, Math.round(img.height / factor));
  const out: GrayImage = { width: w, height: h, data: new Uint8Array(w * h) };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        const sy = Math.min(img.height - 1, y * factor + dy);
        for (let dx = 0; dx < factor; dx++) {
          const sx = Math.min(img.width - 1, x * factor + dx);
          sum += img.data[sy * img.width + sx] as number;
          n++;
        }
      }
      out.data[y * w + x] = Math.round(sum / n);
    }
  }
  return out;
}

export function cloneImage(img: GrayImage): GrayImage {
  return { width: img.width, height: img.height, data: img.data.slice() };
}
