/**
 * ============================================================================
 *  LOCATE -- find the symbol in a raw grayscale image
 * ============================================================================
 *
 * A SiMurgh symbol is a set of concentric circles, so detection is a 1-D
 * problem once you have a rough centre. The algorithm is a *matched filter on
 * the radial ink profile*:
 *
 *   1. normalise contrast and measure rho(r) = mean ink at radius r, averaged
 *      over 256 rays;
 *   2. for every legal (version, pitch) pair, predict where the Halo, Beads,
 *      Angle Track, Limbus and the four light gaps must fall, and score the
 *      hypothesis against rho(r);
 *   3. take the best hypothesis, then refine the centre by tracing the Limbus
 *      ring point by point and fitting a circle algebraically;
 *   4. iterate 2-3 until the centre stops moving.
 *
 * This is rotation-invariant by construction (rho does not depend on angle),
 * scale-invariant (the pitch is a search parameter) and needs no edge detector,
 * no Hough transform and no finder-pattern template matching. It also rejects
 * look-alikes: a random round blob cannot reproduce four rings with the exact
 * radius ratios of a SiMurgh crown.
 */
import { MAX_VERSION, MIN_VERSION, crown, dataRings } from '../geometry.js';
import { binarize, blur, otsuThreshold, sampleBilinear, type GrayImage } from './image.js';

export interface RadialProfile {
  /** Bin centre radius, pixels. */
  r: Float64Array;
  /** Mean ink in [0,1] at that radius. */
  rho: Float64Array;
  /** Number of samples that contributed to each bin. */
  n: Int32Array;
  step: number;
  cx: number;
  cy: number;
  /** Contrast normalisation actually used. */
  lo: number;
  hi: number;
}

export interface ContrastRange {
  lo: number;
  hi: number;
}

/** Robust 2/98 percentile contrast range of an image. */
export function contrastRange(img: GrayImage): ContrastRange {
  const hist = new Int32Array(256);
  for (let i = 0; i < img.data.length; i++) {
    const v = img.data[i] as number;
    hist[v] = (hist[v] as number) + 1;
  }
  const total = img.data.length;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v] as number;
    if (acc >= total * 0.02) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v] as number;
    if (acc >= total * 0.02) {
      hi = v;
      break;
    }
  }
  if (hi - lo < 12) {
    // almost no contrast: fall back to Otsu and widen artificially
    const t = otsuThreshold(img);
    lo = Math.max(0, t - 40);
    hi = Math.min(255, t + 40);
  }
  return { lo, hi };
}

/** ink(v) in [0,1]: 1 = fully inked, 0 = bare substrate. */
export function inkOf(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return 0;
  const x = (hi - v) / (hi - lo);
  return x <= 0 ? 0 : x >= 1 ? 1 : x;
}

export interface ProfileOptions {
  rays?: number;
  step?: number;
  rmax?: number;
  lo?: number;
  hi?: number;
}

export function radialProfile(img: GrayImage, cx: number, cy: number, opt: ProfileOptions = {}): RadialProfile {
  const rays = opt.rays ?? 256;
  const step = opt.step ?? 0.5;
  const rmax = opt.rmax ?? Math.hypot(Math.max(cx, img.width - cx), Math.max(cy, img.height - cy));
  const range = opt.lo !== undefined && opt.hi !== undefined ? { lo: opt.lo, hi: opt.hi } : contrastRange(img);
  const bins = Math.ceil(rmax / step) + 2;
  const acc = new Float64Array(bins);
  const n = new Int32Array(bins);
  for (let k = 0; k < rays; k++) {
    const a = (2 * Math.PI * k) / rays;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let r = 0; r < rmax; r += step) {
      const v = sampleBilinear(img, cx + ca * r, cy + sa * r);
      if (Number.isNaN(v)) continue;
      const b = (r / step) | 0;
      acc[b] = (acc[b] as number) + inkOf(v, range.lo, range.hi);
      n[b] = (n[b] as number) + 1;
    }
  }
  const rho = new Float64Array(bins);
  const rr = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    rho[b] = (n[b] as number) > 0 ? (acc[b] as number) / (n[b] as number) : 0;
    rr[b] = (b + 0.5) * step;
  }
  return { r: rr, rho, n, step, cx, cy, lo: range.lo, hi: range.hi };
}

/** Mean ink of the profile inside [r0, r1]. */
export function bandMean(p: RadialProfile, r0: number, r1: number): { mean: number; n: number } {
  const b0 = Math.max(0, Math.floor(r0 / p.step));
  const b1 = Math.min(p.rho.length - 1, Math.ceil(r1 / p.step));
  if (b1 < b0) return { mean: 0, n: 0 };
  let s = 0;
  let n = 0;
  for (let b = b0; b <= b1; b++) {
    if ((p.n[b] as number) === 0) continue;
    s += p.rho[b] as number;
    n++;
  }
  return { mean: n ? s / n : 0, n };
}

export interface CrownHypothesis {
  version: number;
  K: number;
  /** Pixels per module pitch. */
  pitch: number;
  score: number;
  radii: { halo: number; beads: number; teethInner: number; teethOuter: number; limbus: number; outer: number };
}

/**
 * Score one (version, pitch) hypothesis against a radial profile.
 * Lower is better. Each Crown band contributes a weighted absolute error
 * between the measured ink and the ink the specification says must be there.
 */
export function scoreHypothesis(p: RadialProfile, version: number, pitch: number): { score: number; radii: CrownHypothesis['radii'] } {
  const K = dataRings(version);
  const g = crown(K);
  const P = (x: number) => x * pitch;
  const radii = {
    halo: P(g.haloRadius),
    beads: P(g.beadRadius),
    teethInner: P(g.teethInner),
    teethOuter: P(g.teethOuter),
    limbus: P(g.limbusRadius),
    outer: P(g.outerRadius),
  };
  if (radii.outer > p.r[p.r.length - 1]! || radii.halo < 4) return { score: Infinity, radii };

  const bands: [number, number, number, number][] = [
    // model r0, r1, target ink, weight.
    // Wide bands with hard targets carry most of the discrimination: the four
    // light gaps and the quiet zone cannot be faked by a random round blob.
    [2.6, K + 0.577, 0.38, 0.6], // data field: ~50% of 77%-filled dots
    [K + 0.577, g.haloInner, 0.02, 3.0], // gap
    [g.haloInner, g.haloOuter, 0.85, 2.5], // HALO (0.3 p thin: allow for AA)
    [g.haloOuter, g.beadRadius - g.beadSize, 0.02, 3.0], // gap
    [g.beadRadius - g.beadSize, g.beadRadius + g.beadSize, 0.16, 0.7], // BEADS
    [g.beadRadius + g.beadSize, g.teethInner, 0.02, 3.0], // gap
    [g.teethInner, g.teethOuter, 0.51, 1.6], // ANGLE TRACK
    [g.teethOuter, g.limbusInner, 0.04, 3.0], // gap (only the Beak is inked)
    [g.limbusInner, g.limbusOuter, 0.85, 2.5], // LIMBUS
    [g.limbusOuter, g.limbusOuter + 2.0, 0.02, 3.0], // quiet zone
  ];
  let score = 0;
  let totalW = 0;
  for (const [m0, m1, target, w] of bands) {
    const meas = bandMean(p, P(m0), P(m1));
    if (meas.n === 0) return { score: Infinity, radii };
    score += w * Math.abs(meas.mean - target);
    totalW += w;
  }
  return { score: score / totalW, radii };
}


/**
 * Find thin, bright rings in a radial profile: local maxima of rho above
 * `minRho`, with sub-pixel peak positions by parabolic interpolation.
 * The Halo and the Limbus are the two strongest; mask patterns can add weaker
 * maxima inside the data field, so callers must validate any pair they use.
 */
export function findSharpRings(p: RadialProfile, minRho = 0.5): number[] {
  const out: number[] = [];
  const rho = p.rho;
  for (let b = 2; b < rho.length - 2; b++) {
    const y1 = rho[b] as number;
    if (y1 < minRho) continue;
    if (!(y1 >= (rho[b - 1] as number) && y1 > (rho[b + 1] as number))) continue;
    const y0 = rho[b - 1] as number;
    const y2 = rho[b + 1] as number;
    const den = y0 - 2 * y1 + y2;
    const d = Math.abs(den) < 1e-9 ? 0 : (0.5 * (y0 - y2)) / den;
    out.push((p.r[b] as number) + Math.max(-1, Math.min(1, d)) * p.step);
  }
  return out;
}

/** Angular coverage of a candidate ring: fraction of rays that are inked there. */
export function ringCoverage(img: GrayImage, cx: number, cy: number, r: number, lo: number, hi: number, rays = 96): number {
  let hit = 0;
  for (let k = 0; k < rays; k++) {
    const a = (2 * Math.PI * k) / rays;
    let best = 0;
    for (const dr of [-0.6, -0.3, 0, 0.3, 0.6]) {
      const v = sampleBilinear(img, cx + Math.cos(a) * (r + dr * Math.max(1, r * 0.02)), cy + Math.sin(a) * (r + dr * Math.max(1, r * 0.02)));
      if (!Number.isNaN(v)) best = Math.max(best, inkOf(v, lo, hi));
    }
    if (best > 0.5) hit++;
  }
  return hit / rays;
}

/** Legal values of K (data ring count): K = 2*version + 12, version 1..40. */
const LEGAL_K: number[] = (() => {
  const out: number[] = [];
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) out.push(dataRings(v));
  return out;
})();

/**
 * Ring-pair refinement.
 *
 * The Halo and the Limbus are two concentric circles whose model radii differ
 * by EXACTLY 3.8 modules for every version. Measuring both therefore pins down
 * the scale and the version simultaneously:
 *
 *      pitch = (R_limbus - R_halo) / 3.8
 *      K     = R_halo / pitch - 1.05
 *
 * K must then land on a legal value (even, 14..92), which is a very strong
 * consistency test: it rejects spurious ring pairs coming from mask patterns.
 */
export function refineFromRingPairs(p: RadialProfile, minRho = 0.5): CrownHypothesis[] {
  const peaks = findSharpRings(p, minRho);
  const out: CrownHypothesis[] = [];
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      const Ri = peaks[i] as number;
      const Ro = peaks[j] as number;
      const gap = Ro - Ri;
      if (gap < 3) continue;
      const pitch = gap / 3.8;
      if (pitch < 0.35 || pitch > 200) continue;
      const Kf = Ri / pitch - 1.05;
      if (Kf < 12 || Kf > 96) continue;
      // nearest legal K
      let bestK = LEGAL_K[0] as number;
      let bestD = Infinity;
      for (const K of LEGAL_K) {
        const d = Math.abs(K - Kf);
        if (d < bestD) {
          bestD = d;
          bestK = K;
        }
      }
      if (bestD > 1.4) continue; // not a credible crown
      const version = (bestK - 12) / 2;
      // pitch consistent with the integer K, averaged over both rings
      const pitch2 = (Ri / (bestK + 1.05) + Ro / (bestK + 4.85)) / 2;
      const sc = scoreHypothesis(p, version, pitch2);
      if (!Number.isFinite(sc.score)) continue;
      out.push({ version, K: bestK, pitch: pitch2, score: sc.score, radii: sc.radii });
    }
  }
  out.sort((a, b) => a.score - b.score);
  return out;
}


/* ------------------------------------------------------------------ *
 *  Perspective-tolerant localisation
 * ------------------------------------------------------------------ */

/**
 * Per-angle trace of the OUTERMOST ring of the symbol.
 *
 * A homography turns concentric circles into concentric-looking *conics*: the
 * radius of the Limbus as seen from the projected centre is no longer constant
 * but varies smoothly with angle. A radial profile averaged over all angles
 * therefore smears the rings together and stops being usable past ~15 degrees
 * of tilt.
 *
 * So instead of averaging first, we measure each ray independently: walk inwards
 * from the frame border and take the first dark run that has light outside it.
 * That is the Limbus, at *that* angle. The result is a function r(alpha), which
 * carries the tilt in its first and second angular harmonics and the true
 * radius in its mean. Everything downstream then works per-angle, and the
 * crown matched filter below stays valid at 40 degrees of tilt.
 */
export interface AngularRingTrace {
  n: number;
  /** Image angle of each ray, radians, clockwise from +x. */
  angles: Float64Array;
  /** Measured ring mid-radius in pixels; NaN when the ring was not found. */
  radius: Float64Array;
  /** Measured radial thickness of the dark run, pixels. */
  thickness: Float64Array;
  /** Peak ink inside the run. */
  ink: Float64Array;
  /** Fraction of rays where the ring was found. */
  coverage: number;
  /** Median measured radius. */
  median: number;
}

/**
 * Model radius of the Limbus centre line measured from the outermost data ring,
 * in modules. The Limbus sits at rho = K + LIMBUS_OFFSET for every version, and
 * the Halo at rho = K + 1.05, so the two are separated by exactly 3.8 modules
 * independently of K -- the invariant that makes scale recovery possible.
 */
export const LIMBUS_OFFSET = 4.85;

export function traceOuterRing(
  img: GrayImage,
  cx: number,
  cy: number,
  lo: number,
  hi: number,
  nAngles = 180,
  opt: { rmax?: number; inkOn?: number; inkOff?: number; maxThicknessFrac?: number } = {},
): AngularRingTrace {
  const inkOn = opt.inkOn ?? 0.55;
  const inkOff = opt.inkOff ?? 0.35;
  const maxThickFrac = opt.maxThicknessFrac ?? 0.07;
  const rmax = opt.rmax ?? Math.hypot(Math.max(cx, img.width - cx), Math.max(cy, img.height - cy));
  const angles = new Float64Array(nAngles);
  const radius = new Float64Array(nAngles).fill(NaN);
  const thickness = new Float64Array(nAngles).fill(NaN);
  const ink = new Float64Array(nAngles);
  const step = Math.max(0.35, rmax / 900);
  let found = 0;
  const radiiList: number[] = [];
  for (let k = 0; k < nAngles; k++) {
    const a = (2 * Math.PI * k) / nAngles;
    angles[k] = a;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // walk inwards from the border, looking for the first dark run with light outside
    let rOut = NaN;
    for (let r = rmax; r > 3; r -= step) {
      const v = sampleBilinear(img, cx + ca * r, cy + sa * r);
      if (Number.isNaN(v)) continue;
      if (inkOf(v, lo, hi) >= inkOn) {
        // confirm the outside is light (the quiet zone)
        let light = 0;
        let probes = 0;
        for (const dr of [1.2, 2.4, 3.6, 5.0]) {
          const rr = r + dr * Math.max(1, step * 2);
          const vv = sampleBilinear(img, cx + ca * rr, cy + sa * rr);
          if (Number.isNaN(vv)) continue;
          probes++;
          if (inkOf(vv, lo, hi) < inkOff) light++;
        }
        if (probes > 0 && light / probes >= 0.6) {
          rOut = r;
          break;
        }
      }
    }
    if (!Number.isFinite(rOut)) continue;
    // walk inwards to the inner edge of the run
    let rIn = rOut;
    let peak = 0;
    for (let r = rOut; r > rOut - Math.max(4, rOut * maxThickFrac * 3); r -= step) {
      const v = sampleBilinear(img, cx + ca * r, cy + sa * r);
      if (Number.isNaN(v)) break;
      const ik = inkOf(v, lo, hi);
      if (ik > peak) peak = ik;
      if (ik < 0.4) {
        rIn = r;
        break;
      }
      rIn = r;
    }
    const thick = rOut - rIn;
    if (thick > Math.max(3, rOut * maxThickFrac)) continue; // a blob, not a ring
    const mid = (rOut + rIn) / 2;
    radius[k] = mid;
    thickness[k] = thick;
    ink[k] = peak;
    radiiList.push(mid);
    found++;
  }
  radiiList.sort((a, b) => a - b);
  return {
    n: nAngles,
    angles,
    radius,
    thickness,
    ink,
    coverage: found / nAngles,
    median: radiiList.length ? (radiiList[radiiList.length >> 1] as number) : NaN,
  };
}

/** Interpolate a per-angle ring trace at an arbitrary image angle. */
export function ringRadiusAt(trace: AngularRingTrace, angleRad: number): number {
  if (trace.n === 0) return NaN;
  const a = ((angleRad % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const f = (a / (2 * Math.PI)) * trace.n;
  const i0 = Math.floor(f) % trace.n;
  const i1 = (i0 + 1) % trace.n;
  const t = f - Math.floor(f);
  const r0 = trace.radius[i0] as number;
  const r1 = trace.radius[i1] as number;
  if (!Number.isFinite(r0)) return Number.isFinite(r1) ? r1 : trace.median;
  if (!Number.isFinite(r1)) return r0;
  return r0 + (r1 - r0) * t;
}

/**
 * Mean ink, over every ray, in the annulus between two model radii.
 *
 * Radii are given in module units and converted through the *locally measured*
 * Limbus radius of each ray, so a tilted symbol is measured on its own warped
 * geometry rather than on an assumed circle.
 */
function inkInBand(
  img: GrayImage,
  cx: number,
  cy: number,
  trace: AngularRingTrace,
  m0: number,
  m1: number,
  limbusModules: number,
  lo: number,
  hi: number,
): { ink: number; n: number } {
  let sum = 0;
  let n = 0;
  const NS = 5;
  for (let k = 0; k < trace.n; k++) {
    const R = trace.radius[k] as number;
    if (!Number.isFinite(R)) continue;
    const pitch = R / limbusModules;
    const a = trace.angles[k] as number;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let acc = 0;
    let m = 0;
    for (let i = 0; i < NS; i++) {
      const t = i / (NS - 1);
      const r = pitch * (m0 + (m1 - m0) * t);
      if (r < 1) continue;
      const v = sampleBilinear(img, cx + ca * r, cy + sa * r);
      if (Number.isNaN(v)) continue;
      acc += inkOf(v, lo, hi);
      m++;
    }
    if (m === 0) continue;
    sum += acc / m;
    n++;
  }
  return { ink: n ? sum / n : 0, n };
}

/**
 * Least-squares fit of r(alpha) = c0 + a1 cos + b1 sin + a2 cos2 + b2 sin2.
 *
 * A plain Fourier sum assumes every angle is present. It is not: rays that miss
 * the ring drop out, and with r ~ 190 px the DC term leaks straight into the
 * harmonics (a spurious 7 px "centre offset" on a perfectly centred symbol).
 * Solving the normal equations over the surviving rays is both cheap (5x5) and
 * unbiased. The h=1 term is the centre error, h=2 the conic ellipticity that
 * perspective introduces, h=0 the true radius.
 */
export function fitRadialHarmonics(trace: AngularRingTrace, order = 2): {
  c0: number; a1: number; b1: number; a2: number; b2: number; rms: number; n: number;
} | null {
  const idx: number[] = [];
  for (let k = 0; k < trace.n; k++) if (Number.isFinite(trace.radius[k])) idx.push(k);
  const P = 1 + 2 * order;
  if (idx.length < P + 4) return null;
  const A: number[][] = [];
  for (let i = 0; i < P; i++) A.push(new Array<number>(P + 1).fill(0));
  const basis = (a: number): number[] => {
    const b = [1];
    for (let h = 1; h <= order; h++) b.push(Math.cos(h * a), Math.sin(h * a));
    return b;
  };
  for (const k of idx) {
    const a = trace.angles[k] as number;
    const r = trace.radius[k] as number;
    const b = basis(a);
    for (let i = 0; i < P; i++) {
      for (let j = 0; j < P; j++) (A[i] as number[])[j]! += b[i]! * b[j]!;
      (A[i] as number[])[P]! += b[i]! * r;
    }
  }
  const x = solveNormal(A, P);
  if (!x) return null;
  let se = 0;
  for (const k of idx) {
    const b = basis(trace.angles[k] as number);
    let pred = 0;
    for (let i = 0; i < P; i++) pred += b[i]! * x[i]!;
    se += (pred - (trace.radius[k] as number)) ** 2;
  }
  return {
    c0: x[0]!,
    a1: x[1]!,
    b1: x[2]!,
    a2: order >= 2 ? x[3]! : 0,
    b2: order >= 2 ? x[4]! : 0,
    rms: Math.sqrt(se / idx.length),
    n: idx.length,
  };
}

function solveNormal(A: number[][], P: number): number[] | null {
  // Tikhonov-regularised Gaussian elimination
  const M = A.map((row) => row.slice());
  for (let i = 0; i < P; i++) (M[i] as number[])[i]! += 1e-9;
  for (let col = 0; col < P; col++) {
    let piv = col;
    for (let r = col + 1; r < P; r++) if (Math.abs((M[r] as number[])[col]!) > Math.abs((M[piv] as number[])[col]!)) piv = r;
    if (Math.abs((M[piv] as number[])[col]!) < 1e-12) return null;
    const tmp = M[col]!; M[col] = M[piv]!; M[piv] = tmp;
    for (let r = 0; r < P; r++) {
      if (r === col) continue;
      const f = (M[r] as number[])[col]! / (M[col] as number[])[col]!;
      if (f === 0) continue;
      for (let c = col; c <= P; c++) (M[r] as number[])[c]! -= f * (M[col] as number[])[c]!;
    }
  }
  const out = new Array<number>(P);
  for (let i = 0; i < P; i++) out[i] = (M[i] as number[])[P]! / (M[i] as number[])[i]!;
  return out;
}

/**
 * Crown matched filter, evaluated per angle instead of on an averaged profile.
 * For every legal K it predicts where each Crown band must sit *relative to the
 * locally measured Limbus radius*, so a tilted symbol still scores correctly.
 */
export function matchCrownByAngles(
  img: GrayImage,
  cx: number,
  cy: number,
  trace: AngularRingTrace,
  lo: number,
  hi: number,
  versions?: number[],
): { version: number; K: number; pitch: number; score: number; detail: Record<string, number> } | null {
  if (trace.coverage < 0.35 || !Number.isFinite(trace.median)) return null;
  const R = trace.median;
  let best: { version: number; K: number; pitch: number; score: number; detail: Record<string, number> } | null = null;
  const list = versions ?? LEGAL_K.map((K) => (K - 12) / 2);
  for (const version of list) {
    if (version < MIN_VERSION || version > MAX_VERSION) continue;
    const K = dataRings(version);
    const g = crown(K);
    // Same band table as scoreHypothesis, minus the Limbus (that is the reference
    // radius) and minus the quiet zone (the ring tracer already required light
    // outside, so it carries no extra information here).
    const bands: [string, number, number, number, number][] = [
      ['dataOuter', Math.max(3.0, K - 0.6), K + 0.577, 0.38, 0.7],
      ['gapCore', K + 0.577, g.haloInner, 0.02, 3.0],
      ['halo', g.haloInner, g.haloOuter, 0.85, 2.5],
      ['gap1', g.haloOuter, g.beadRadius - g.beadSize, 0.02, 3.0],
      ['beads', g.beadRadius - g.beadSize, g.beadRadius + g.beadSize, 0.16, 0.7],
      ['gap2', g.beadRadius + g.beadSize, g.teethInner, 0.02, 3.0],
      ['teeth', g.teethInner, g.teethOuter, 0.51, 1.8],
      ['gap3', g.teethOuter, g.limbusInner, 0.05, 3.0],
    ];
    let score = 0;
    let totalW = 0;
    const detail: Record<string, number> = {};
    for (const [name, m0, m1, target, w] of bands) {
      const meas = inkInBand(img, cx, cy, trace, m0, m1, K + LIMBUS_OFFSET, lo, hi);
      if (meas.n < trace.n * 0.3) {
        score = Infinity;
        break;
      }
      detail[name] = meas.ink;
      score += w * Math.abs(meas.ink - target);
      totalW += w;
    }
    if (!Number.isFinite(score) || totalW === 0) continue;
    const s = score / totalW;
    if (!best || s < best.score) best = { version, K, pitch: R / (K + 4.85), score: s, detail };
  }
  return best;
}

export interface LocateOptions {
  /** Candidate centres to try, image pixels. Auto-generated when omitted. */
  candidates?: { x: number; y: number }[];
  /** Restrict the version search. */
  minVersion?: number;
  maxVersion?: number;
  /** Blur passes before profiling. Default 1. */
  blur?: number;
  /** Rays used by the radial profile. Default 256. */
  rays?: number;
  /** Profile radial step in pixels. Default 0.5. */
  step?: number;
  /** Reject hypotheses scoring worse than this. Default 0.30. */
  maxScore?: number;
}

export interface LocateResult extends CrownHypothesis {
  /** True when the matched-filter score was inside the acceptance threshold. */
  acceptable?: boolean;
  /** Per-angle Limbus trace; the perspective-aware reference for every later stage. */
  outer?: AngularRingTrace;
  cx: number;
  cy: number;
  profile: RadialProfile;
  /** Limbus ring points used for the circle fit, [x0,y0,x1,y1,...]. */
  ringPoints: Float64Array;
  /** Fraction of angles where the Limbus was actually found. */
  ringCoverage: number;
  /** Score of the per-angle Crown matched filter (perspective-aware). */
  angularScore?: number;
  iterations: number;
  lo: number;
  hi: number;
}

/** Algebraic circle fit: minimise sum (x^2+y^2+Dx+Ey+F)^2. */
export function fitCircle(pts: Float64Array): { cx: number; cy: number; r: number; rms: number } {
  const n = pts.length / 2;
  if (n < 3) return { cx: NaN, cy: NaN, r: NaN, rms: NaN };
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let sxz = 0;
  let syz = 0;
  let szz = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[2 * i] as number;
    const y = pts[2 * i + 1] as number;
    const z = x * x + y * y;
    sx += x;
    sy += y;
    sz += z;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    sxz += x * z;
    syz += y * z;
    szz += z * z;
  }
  // solve [[sxx sxy sx],[sxy syy sy],[sx sy n]] * [D,E,F] = -[sxz,syz,sz]
  const A = [
    [sxx, sxy, sx, -sxz],
    [sxy, syy, sy, -syz],
    [sx, sy, n, -sz],
  ];
  const sol = solve3(A);
  if (!sol) return { cx: NaN, cy: NaN, r: NaN, rms: NaN };
  const D = sol[0] as number;
  const E = sol[1] as number;
  const F = sol[2] as number;
  const cx = -D / 2;
  const cy = -E / 2;
  const r2 = (D * D) / 4 + (E * E) / 4 - F;
  const r = Math.sqrt(Math.max(0, r2));
  let se = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot((pts[2 * i] as number) - cx, (pts[2 * i + 1] as number) - cy) - r;
    se += d * d;
  }
  return { cx, cy, r, rms: Math.sqrt(se / n) };
}

function solve3(A: number[][]): number[] | null {
  const M = A.map((row) => row.slice());
  for (let c = 0; c < 3; c++) {
    let piv = -1;
    let best = 1e-12;
    for (let r = c; r < 3; r++) {
      if (Math.abs(M[r]![c] as number) > best) {
        best = Math.abs(M[r]![c] as number);
        piv = r;
      }
    }
    if (piv < 0) return null;
    const t = M[c]!;
    M[c] = M[piv]!;
    M[piv] = t;
    const d = M[c]![c] as number;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = (M[r]![c] as number) / d;
      if (f === 0) continue;
      for (let k = c; k < 4; k++) M[r]![k] = (M[r]![k] as number) - f * (M[c]![k] as number);
    }
  }
  return [0, 1, 2].map((i) => (M[i]![3] as number) / (M[i]![i] as number));
}

/**
 * Trace a ring: at each of `rays` angles, find the darkness-weighted radial
 * centroid of the ink near `r0`. Returns the accepted points and the coverage.
 */
export function traceRing(
  img: GrayImage,
  cx: number,
  cy: number,
  r0: number,
  halfWidth: number,
  lo: number,
  hi: number,
  rays = 360,
): { pts: Float64Array; coverage: number; radii: Float64Array; angles: Float64Array } {
  return traceRingAngular(img, cx, cy, () => r0, halfWidth, lo, hi, rays);
}

/**
 * Same estimator as {@link traceRing} but with a per-ray predicted radius.
 *
 * Under perspective the ring is a conic, not a circle: at 25 degrees of tilt its
 * radius swings by several percent with angle, which is far more than the search
 * window a constant-radius tracer can afford. Predicting the radius ray by ray
 * from an already-measured ring keeps the window tight and the estimate exact.
 */
export function traceRingAngular(
  img: GrayImage,
  cx: number,
  cy: number,
  predict: (angleRad: number) => number,
  halfWidth: number,
  lo: number,
  hi: number,
  rays = 360,
): { pts: Float64Array; coverage: number; radii: Float64Array; angles: Float64Array } {
  const ptsList: number[] = [];
  const radii = new Float64Array(rays);
  const angles = new Float64Array(rays);
  let found = 0;
  const steps = Math.max(3, Math.ceil((2 * halfWidth) / 0.4));
  for (let k = 0; k < rays; k++) {
    const a = (2 * Math.PI * k) / rays;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const r0 = predict(a);
    if (!Number.isFinite(r0) || r0 < 2) {
      angles[k] = a;
      radii[k] = NaN;
      continue;
    }
    let wsum = 0;
    let rsum = 0;
    let peak = 0;
    for (let s = 0; s <= steps; s++) {
      const r = r0 - halfWidth + (2 * halfWidth * s) / steps;
      if (r < 1) continue;
      const v = sampleBilinear(img, cx + ca * r, cy + sa * r);
      const ink = inkOf(v, lo, hi);
      // weight by proximity to the expected radius so noise far away cannot win
      const w = ink * Math.exp(-((r - r0) ** 2) / (2 * (halfWidth / 1.6) ** 2));
      wsum += w;
      rsum += w * r;
      if (ink > peak) peak = ink;
    }
    angles[k] = a;
    if (wsum > 0.35 && peak > 0.5) {
      const r = rsum / wsum;
      radii[k] = r;
      ptsList.push(cx + ca * r, cy + sa * r);
      found++;
    } else {
      radii[k] = NaN;
    }
  }
  return { pts: Float64Array.from(ptsList), coverage: found / rays, radii, angles };
}

/** Cheap candidate centres: dark centroid + image centre + quadrant centroids. */
export function candidateCentres(img: GrayImage): { x: number; y: number }[] {
  const t = otsuThreshold(img);
  const dark = binarize(img, t);
  let sx = 0;
  let sy = 0;
  let n = 0;
  const q = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const hw = img.width / 2;
  const hh = img.height / 2;
  for (let y = 0; y < img.height; y++) {
    const qy = y < hh ? 0 : 2;
    for (let x = 0; x < img.width; x++) {
      if (!dark[y * img.width + x]) continue;
      sx += x;
      sy += y;
      n++;
      const i = qy + (x < hw ? 0 : 1);
      const cell = q[i]!;
      cell[0] = (cell[0] as number) + x;
      cell[1] = (cell[1] as number) + y;
      cell[2] = (cell[2] as number) + 1;
    }
  }
  const out: { x: number; y: number }[] = [];
  if (n > 0) out.push({ x: sx / n, y: sy / n });
  out.push({ x: hw, y: hh });
  for (const c of q) if ((c[2] as number) > 0) out.push({ x: (c[0] as number) / (c[2] as number), y: (c[1] as number) / (c[2] as number) });
  // a coarse 3x3 grid as a last resort
  for (let gy = 1; gy <= 3; gy++) for (let gx = 1; gx <= 3; gx++) out.push({ x: (img.width * gx) / 4, y: (img.height * gy) / 4 });
  return out;
}

/** Main entry point: find the symbol. */
export function locate(img0: GrayImage, opt: LocateOptions = {}): LocateResult | null {
  const img = (opt.blur ?? 1) > 0 ? blur(img0, opt.blur ?? 1) : img0;
  const vMin = opt.minVersion ?? MIN_VERSION;
  const vMax = opt.maxVersion ?? MAX_VERSION;
  const maxScore = opt.maxScore ?? 0.45;
  const candidates = opt.candidates ?? candidateCentres(img);
  const maxDim = Math.max(img.width, img.height);

  const pLo = 0.35;
  const pHi = Math.max(1.5, maxDim / 11);
  const steps = 110;
  const pitches = new Float64Array(steps);
  for (let i = 0; i < steps; i++) pitches[i] = pLo * Math.pow(pHi / pLo, i / (steps - 1));

  const gridSearch = (profile: RadialProfile): CrownHypothesis | null => {
    let bestScore = Infinity;
    let bestV = 0;
    let bestP = 0;
    for (let v = vMin; v <= vMax; v++) {
      for (let i = 0; i < steps; i++) {
        const s = scoreHypothesis(profile, v, pitches[i] as number).score;
        if (s < bestScore) {
          bestScore = s;
          bestV = v;
          bestP = pitches[i] as number;
        }
      }
    }
    if (bestV === 0) return null;
    // local refinement of the pitch
    let p0 = bestP;
    for (let refine = 0; refine < 3; refine++) {
      const span = p0 * 0.06;
      let bs = Infinity;
      let bp = p0;
      for (let i = -6; i <= 6; i++) {
        const p = p0 + (span * i) / 6;
        if (p <= 0.05) continue;
        const s = scoreHypothesis(profile, bestV, p).score;
        if (s < bs) {
          bs = s;
          bp = p;
        }
      }
      p0 = bp;
      bestScore = bs;
    }
    for (const dv of [-1, 1]) {
      const v = bestV + dv;
      if (v < vMin || v > vMax) continue;
      const s = scoreHypothesis(profile, v, p0).score;
      if (s < bestScore) {
        bestScore = s;
        bestV = v;
      }
    }
    const scored = scoreHypothesis(profile, bestV, p0);
    return { version: bestV, K: dataRings(bestV), pitch: p0, score: bestScore, radii: scored.radii };
  };

  let best: LocateResult | null = null;
  for (const c of candidates) {
    let cx = c.x;
    let cy = c.y;
    let range = contrastRange(img);
    let profile = radialProfile(img, cx, cy, { rays: opt.rays ?? 256, step: opt.step ?? 0.5, rmax: maxDim, lo: range.lo, hi: range.hi });
    let hyp: CrownHypothesis | null = null;

    for (let iter = 0; iter < 3; iter++) {
      // hypotheses: coarse matched filter + ring-pair refinement
      const list: CrownHypothesis[] = [];
      const coarse = gridSearch(profile);
      if (coarse) list.push(coarse);
      list.push(...refineFromRingPairs(profile, 0.5).slice(0, 6));
      list.push(...refineFromRingPairs(profile, 0.38).slice(0, 6));
      if (list.length === 0) break;
      list.sort((a, b) => a.score - b.score);
      hyp = list[0]!;

      // refine the centre on the Limbus, the strongest circle in the symbol
      const trace = traceRing(img, cx, cy, hyp.radii.limbus, Math.max(1.6, hyp.pitch * 0.6), range.lo, range.hi, 360);
      if (trace.coverage < 0.25 || trace.pts.length < 12) break;
      const fit = fitCircle(trace.pts);
      if (!Number.isFinite(fit.cx)) break;
      const moved = Math.hypot(fit.cx - cx, fit.cy - cy);
      const scaleChanged = Math.abs(fit.r - hyp.radii.limbus) / Math.max(1, hyp.radii.limbus);
      cx = fit.cx;
      cy = fit.cy;
      if (Number.isFinite(fit.r) && fit.r > 2 && scaleChanged < 0.25) {
        // trust the direct circle measurement for the scale
        const pitch3 = fit.r / (hyp.K + 4.85);
        const sc = scoreHypothesis(profile, hyp.version, pitch3);
        if (Number.isFinite(sc.score)) {
          hyp = { ...hyp, pitch: pitch3, radii: sc.radii };
        }
      }
      if (moved < 0.04 * hyp.pitch) break;
      profile = radialProfile(img, cx, cy, { rays: opt.rays ?? 256, step: opt.step ?? 0.5, rmax: maxDim, lo: range.lo, hi: range.hi });
    }
    if (!hyp) continue;

    // final centre/scale pass on the refined radius
    const trace = traceRing(img, cx, cy, hyp.radii.limbus, Math.max(1.6, hyp.pitch * 0.55), range.lo, range.hi, 360);
    const fit = fitCircle(trace.pts);
    if (Number.isFinite(fit.cx)) {
      cx = fit.cx;
      cy = fit.cy;
      if (Number.isFinite(fit.r) && fit.r > 2 && Math.abs(fit.r - hyp.radii.limbus) / Math.max(1, hyp.radii.limbus) < 0.2) {
        const pitch4 = fit.r / (hyp.K + 4.85);
        const scored = scoreHypothesis(profile, hyp.version, pitch4);
        hyp = { ...hyp, pitch: pitch4, radii: scored.radii, score: Number.isFinite(scored.score) ? scored.score : hyp.score };
      }
    }

    let res: LocateResult = {
      ...hyp,
      acceptable: hyp.score < maxScore,
      cx,
      cy,
      profile,
      ringPoints: trace.pts,
      ringCoverage: trace.coverage,
      iterations: 3,
      lo: range.lo,
      hi: range.hi,
    };

    /*
     * Perspective-aware pass. Re-trace the Limbus ray by ray and re-run the
     * Crown matched filter per angle; if it scores better than the averaged
     * profile did, trust it -- it is the only estimator here that survives a
     * tilted camera.
     */
    const outer = traceOuterRing(img, cx, cy, range.lo, range.hi, 180);
    res.outer = outer;
    if (outer.coverage >= 0.5) {
      const h = fitRadialHarmonics(outer, 2);
      if (h && h.rms < 0.35 * h.c0) {
        // h=1 is the centre error (see fitRadialHarmonics). Guard against a wild
        // fit: a real offset can never exceed a fraction of the symbol radius.
        const dx = h.a1;
        const dy = h.b1;
        if (Math.hypot(dx, dy) < 0.2 * h.c0) {
          const cx2 = cx + dx;
          const cy2 = cy + dy;
          const outer2 = traceOuterRing(img, cx2, cy2, range.lo, range.hi, 180);
          const h2 = fitRadialHarmonics(outer2, 2);
          if (outer2.coverage >= outer.coverage && (!h2 || h2.rms <= h.rms)) {
            cx = cx2;
            cy = cy2;
            res.outer = outer2;
          }
        }
      }
      const m = matchCrownByAngles(img, cx, cy, res.outer, range.lo, range.hi);
      if (m) {
        const sc = scoreHypothesis(profile, m.version, m.pitch);
        res = {
          ...res,
          cx,
          cy,
          version: m.version,
          K: m.K,
          pitch: m.pitch,
          radii: Number.isFinite(sc.score) ? sc.radii : res.radii,
          score: Math.min(res.score, m.score),
          angularScore: m.score,
        };
      }
    }
    if (!best || res.score < best.score) best = res;
  }
  return best;
}
