/**
 * ============================================================================
 *  ORIENT -- rotation, and the model-to-image transform
 * ============================================================================
 *
 * Three jobs:
 *
 *  1. ROTATION. Resample the Angle Track band on a fine angular grid and
 *     correlate it against the reference m-sequence over all 63*S phases. The
 *     m-sequence's two-level autocorrelation (+63 on phase, -1 off phase) makes
 *     this a matched filter with an 18 dB peak-to-sidelobe ratio, so the angle
 *     survives blur, noise and heavy occlusion. Parabolic interpolation around
 *     the peak gives sub-sample accuracy (better than 0.05 deg at S = 16).
 *
 *  2. TRANSFORM. Start from the similarity (centre, pitch, rotation) found by
 *     LOCATE, then upgrade it to a full homography by tracing the Halo and the
 *     Limbus -- two concentric circles of *known* model radii. Two circles give
 *     hundreds of correspondences for an 8-parameter fit, so a tilted camera
 *     shot is rectified instead of merely approximated.
 *
 *  3. TEETH. Read the 63 Angle Track bits and their confidences through the
 *     final transform. These are both the rotation reference and an independent
 *     check on the Beak.
 *
 * The Crown is therefore not decoration: it is a two-circle calibration target
 * that lets the decoder solve for the camera pose before it reads a single
 * payload bit.
 */
import { ANGLE_TRACK, TEETH, TOOTH_DEG } from '../geometry.js';
import { sampleBilinear, type GrayImage } from './image.js';
import {
  inkOf,
  LIMBUS_OFFSET,
  ringRadiusAt,
  traceOuterRing,
  traceRingAngular,
  type LocateResult,
} from './locate.js';

/** Row-major 3x3 projective transform, model space (pitch units) -> image space (pixels). */
export class Transform {
  readonly m: Float64Array;
  private inv: Float64Array | null = null;
  kind: 'similarity' | 'affine' | 'homography' = 'similarity';

  constructor(m: ArrayLike<number>) {
    this.m = new Float64Array(9);
    for (let i = 0; i < 9; i++) this.m[i] = m[i] as number;
  }

  static identity(): Transform {
    return new Transform([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }

  apply(x: number, y: number): { x: number; y: number } {
    const m = this.m;
    const w = (m[6] as number) * x + (m[7] as number) * y + (m[8] as number);
    const u = (m[0] as number) * x + (m[1] as number) * y + (m[2] as number);
    const v = (m[3] as number) * x + (m[4] as number) * y + (m[5] as number);
    if (w === 0) return { x: NaN, y: NaN };
    return { x: u / w, y: v / w };
  }

  applyInverse(px: number, py: number): { x: number; y: number } {
    if (!this.inv) this.inv = invert3x3(this.m);
    const m = this.inv;
    const w = (m[6] as number) * px + (m[7] as number) * py + (m[8] as number);
    const u = (m[0] as number) * px + (m[1] as number) * py + (m[2] as number);
    const v = (m[3] as number) * px + (m[4] as number) * py + (m[5] as number);
    if (w === 0) return { x: NaN, y: NaN };
    return { x: u / w, y: v / w };
  }

  /** Uniform scale (pixels per module), from the linear part. */
  get scale(): number {
    const m = this.m;
    return Math.sqrt(Math.abs(m[0]! * m[4]! - m[1]! * m[3]!));
  }

  /** Rotation of the symbol in image space, degrees clockwise from +x. */
  get rotationDeg(): number {
    const m = this.m;
    // model (1,0) maps to direction (m0, m3)
    return (Math.atan2(m[3] as number, m[0] as number) * 180) / Math.PI;
  }
}

export function invert3x3(m: ArrayLike<number>): Float64Array {
  const a = m[0] as number;
  const b = m[1] as number;
  const c = m[2] as number;
  const d = m[3] as number;
  const e = m[4] as number;
  const f = m[5] as number;
  const g = m[6] as number;
  const h = m[7] as number;
  const i = m[8] as number;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('singular transform');
  const id = 1 / det;
  return Float64Array.from([
    A * id,
    (c * h - b * i) * id,
    (b * f - c * e) * id,
    B * id,
    (a * i - c * g) * id,
    (c * d - a * f) * id,
    C * id,
    (b * g - a * h) * id,
    (a * e - b * d) * id,
  ]);
}

/** Similarity transform: centre (cx, cy), pixels-per-module `p`, clockwise rotation `phiDeg`. */
export function similarity(cx: number, cy: number, p: number, phiDeg: number): Transform {
  const a = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const t = new Transform([p * cos, -p * sin, cx, -p * sin, -p * cos, cy, 0, 0, 1]);
  t.kind = 'similarity';
  return t;
}

/* ------------------------------------------------------------------ *
 *  Rotation by matched filter on the Angle Track
 * ------------------------------------------------------------------ */

export interface RotationEstimate {
  /** Clockwise rotation in image space, degrees. */
  phi: number;
  score: number;
  margin: number;
  /** Sub-samples per tooth used by the search. */
  sub: number;
  /** Raw ring signal (soft ink, length TEETH*sub). */
  signal: Float64Array;
  radius: number;
}

export function estimateRotation(
  img: GrayImage,
  loc: LocateResult,
  cx: number,
  cy: number,
  opt: { sub?: number; lo?: number; hi?: number } = {},
): RotationEstimate {
  const sub = opt.sub ?? 16;
  const M = TEETH * sub;
  const lo = opt.lo ?? loc.lo;
  const hi = opt.hi ?? loc.hi;
  const g = loc.radii;
  // sample the middle of the Angle Track band
  const rIn = (g.teethInner + g.teethOuter) / 2;
  const spread = (g.teethOuter - g.teethInner) * 0.32;
  /*
   * Under perspective the Angle Track is no longer at a constant image radius, so
   * the sampling radius is taken per angle from the Limbus trace: the teeth sit at
   * (K+3.6)/(K+4.85) of it. When no angular trace is available this collapses to
   * the plain constant radius.
   */
  const teethRatio = ((g.teethInner + g.teethOuter) / 2 / loc.pitch) / (loc.K + LIMBUS_OFFSET);
  const radiusAt = (a: number): number =>
    loc.outer && loc.outer.coverage >= 0.4 ? ringRadiusAt(loc.outer, a) * teethRatio : rIn;
  const signal = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    /*
     * Sample COUNTER-clockwise in image space. Model angle theta and image
     * angle alpha are related by alpha = -(theta + phi) because image y grows
     * downwards; walking the ring backwards cancels the reflection and leaves
     * signal[k] = reference[k - phi*M/360], which is exactly what the
     * correlation below assumes.
     */
    const a = -(2 * Math.PI * k) / M;
    const rr = radiusAt(a);
    let acc = 0;
    let n = 0;
    for (const dr of [-spread, -spread / 2, 0, spread / 2, spread]) {
      const v = sampleBilinear(img, cx + Math.cos(a) * (rr + dr), cy + Math.sin(a) * (rr + dr));
      if (Number.isNaN(v)) continue;
      acc += inkOf(v, lo, hi);
      n++;
    }
    signal[k] = n ? (acc / n) * 2 - 1 : 0;
  }

  // reference: +1 for a dark tooth, -1 for a light one, sampled at M phases
  const ref = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    const tooth = Math.round(k / sub) % TEETH;
    ref[k] = (ANGLE_TRACK[tooth] as number) === 1 ? 1 : -1;
  }

  let best = -Infinity;
  let bestS = 0;
  let second = -Infinity;
  const scores = new Float64Array(M);
  for (let s = 0; s < M; s++) {
    let acc = 0;
    for (let k = 0; k < M; k++) {
      acc += (signal[k] as number) * (ref[(k - s + M) % M] as number);
    }
    scores[s] = acc;
    if (acc > best) {
      best = acc;
      bestS = s;
    }
  }
  for (let s = 0; s < M; s++) if (s !== bestS && (scores[s] as number) > second) second = scores[s] as number;

  // parabolic interpolation for sub-sample accuracy
  const y0 = scores[(bestS - 1 + M) % M] as number;
  const y1 = best;
  const y2 = scores[(bestS + 1) % M] as number;
  const denom = y0 - 2 * y1 + y2;
  const delta = Math.abs(denom) < 1e-9 ? 0 : (0.5 * (y0 - y2)) / denom;
  const sFine = bestS + Math.max(-1, Math.min(1, delta));
  // image angle of tooth 0 centre = sFine * (360/M); the model angle is 0, so
  // the clockwise rotation of the symbol equals that image angle.
  const phi = (sFine * 360) / M;
  return { phi: ((phi % 360) + 360) % 360, score: best, margin: best - second, sub, signal, radius: rIn };
}

/* ------------------------------------------------------------------ *
 *  Angle Track bit sampling
 * ------------------------------------------------------------------ */

export interface TeethSample {
  bits: Uint8Array;
  confidence: Float32Array;
  /** Mean ink of the dark teeth and of the light teeth (for diagnostics). */
  darkLevel: number;
  lightLevel: number;
}

export function sampleTeeth(img: GrayImage, t: Transform, loc: LocateResult): TeethSample {
  const g = loc.radii;
  const bits = new Uint8Array(TEETH);
  const confidence = new Float32Array(TEETH);
  const values = new Float64Array(TEETH);
  const rIn = t.apply(0, 0);
  void rIn;
  for (let i = 0; i < TEETH; i++) {
    // average over the middle 50% of the tooth's angular width and 60% of the band
    let acc = 0;
    let n = 0;
    for (let ka = -2; ka <= 2; ka++) {
      const angDeg = i * TOOTH_DEG + (ka * TOOTH_DEG) / 8;
      const a = (angDeg * Math.PI) / 180;
      const mx = Math.cos(a);
      const my = Math.sin(a);
      for (let kr = -2; kr <= 2; kr++) {
        const rho = ((g.teethInner + g.teethOuter) / 2) * 1 + kr * (g.teethOuter - g.teethInner) * 0.12;
        const p = t.apply(rho * mx, rho * my);
        const v = sampleBilinear(img, p.x, p.y);
        if (Number.isNaN(v)) continue;
        acc += inkOf(v, loc.lo, loc.hi);
        n++;
      }
    }
    values[i] = n ? acc / n : 0.5;
  }
  // two-cluster threshold
  const sorted = Array.from(values).sort((a, b) => a - b);
  const lo25 = sorted[Math.floor(sorted.length * 0.2)] as number;
  const hi75 = sorted[Math.floor(sorted.length * 0.8)] as number;
  const mid = (lo25 + hi75) / 2;
  const span = Math.max(0.02, (hi75 - lo25) / 2);
  for (let i = 0; i < TEETH; i++) {
    bits[i] = (values[i] as number) >= mid ? 1 : 0;
    confidence[i] = Math.min(1, Math.abs((values[i] as number) - mid) / span);
  }
  return { bits, confidence, darkLevel: hi75, lightLevel: lo25 };
}

/* ------------------------------------------------------------------ *
 *  Homography fit
 * ------------------------------------------------------------------ */

/**
 * Normalised DLT homography fit with h33 = 1.
 * `src` are model points (pitch units), `dst` image points (pixels).
 * Returns null when the system is singular.
 */
export function fitHomography(src: Float64Array, dst: Float64Array): Transform | null {
  const n = src.length / 2;
  if (n < 6) return null;

  // normalise both point sets: zero mean, RMS distance sqrt(2)
  const norm = (arr: Float64Array) => {
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) {
      mx += arr[2 * i] as number;
      my += arr[2 * i + 1] as number;
    }
    mx /= n;
    my /= n;
    let s = 0;
    for (let i = 0; i < n; i++) s += (arr[2 * i]! - mx) ** 2 + (arr[2 * i + 1]! - my) ** 2;
    const rms = Math.sqrt(s / n) || 1;
    const k = Math.SQRT2 / rms;
    return { mx, my, k };
  };
  const ns = norm(src);
  const nd = norm(dst);

  const rows = 2 * n;
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = ((src[2 * i] as number) - ns.mx) * ns.k;
    const y = ((src[2 * i + 1] as number) - ns.my) * ns.k;
    const u = ((dst[2 * i] as number) - nd.mx) * nd.k;
    const v = ((dst[2 * i + 1] as number) - nd.my) * nd.k;
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    b.push(v);
  }

  // normal equations (8x8), Tikhonov-regularised
  const AtA: number[][] = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb: number[] = new Array(8).fill(0);
  for (let r = 0; r < rows; r++) {
    const row = A[r]!;
    for (let i = 0; i < 8; i++) {
      const ai = row[i] as number;
      if (ai === 0) continue;
      Atb[i] = (Atb[i] as number) + ai * (b[r] as number);
      for (let j = 0; j < 8; j++) AtA[i]![j] = (AtA[i]![j] as number) + ai * (row[j] as number);
    }
  }
  const lambda = 1e-9 * (AtA[0]![0] as number);
  for (let i = 0; i < 8; i++) AtA[i]![i] = (AtA[i]![i] as number) + lambda;
  const h = solveLinear(AtA, Atb);
  if (!h) return null;

  // undo the normalisation:  Td^-1 * Hn * Ts
  const Ts: number[] = [ns.k, 0, -ns.k * ns.mx, 0, ns.k, -ns.k * ns.my, 0, 0, 1];
  const TdInv: number[] = [1 / nd.k, 0, nd.mx, 0, 1 / nd.k, nd.my, 0, 0, 1];
  const Hn: number[] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => h[i] as number).concat([1]);
  const H = mat3(mat3(TdInv, Hn), Ts);
  const t = new Transform(H);
  t.kind = 'homography';
  return t;
}

export function mat3(A: ArrayLike<number>, B: ArrayLike<number>): number[] {
  const out = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += (A[i * 3 + k] as number) * (B[k * 3 + j] as number);
      out[i * 3 + j] = s;
    }
  }
  return out;
}

/** Gaussian elimination with partial pivoting on an n x (n+1) augmented system. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i] as number]);
  for (let c = 0; c < n; c++) {
    let piv = -1;
    let best = 1e-14;
    for (let r = c; r < n; r++) {
      const v = Math.abs(M[r]![c] as number);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (piv < 0) return null;
    const tmp = M[c]!;
    M[c] = M[piv]!;
    M[piv] = tmp;
    const d = M[c]![c] as number;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = (M[r]![c] as number) / d;
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r]![k] = (M[r]![k] as number) - f * (M[c]![k] as number);
    }
  }
  return Array.from({ length: n }, (_, i) => (M[i]![n] as number) / (M[i]![i] as number));
}

/* ------------------------------------------------------------------ *
 *  Transform refinement from the Crown's two calibration circles
 * ------------------------------------------------------------------ */

export interface RefineResult {
  transform: Transform;
  /** RMS radial reprojection error, in pixels. */
  rms: number;
  used: 'homography' | 'similarity';
  points: number;
  /** Rotation of the final transform, degrees (image-space convention). */
  rotationDeg?: number;
  /** Angle Track matched-filter score measured at the final transform. */
  rotationScore?: number;
}

/* ------------------------------------------------------------------ *
 *  Pose from two concentric circles: the radial homography fit
 * ------------------------------------------------------------------ */

/** A set of image points known to lie on one model circle of radius `rho`, in modules. */
export interface RingPoints {
  xs: Float64Array;
  ys: Float64Array;
  n: number;
  rho: number;
}

export interface RadialFitResult {
  /** Fitted image -> model homography, gauge-fixed at G[8] = 1. */
  G: number[];
  /** Model -> image transform (the inverse of G). */
  H: Transform;
  /** RMS radial residual, in modules. */
  rms: number;
  points: number;
  inliers: number;
  iterations: number;
  ok: boolean;
}

/**
 * Fit the image->model homography from concentric circles using RADIAL residuals
 * only.
 *
 * The Crown carries two concentric circles whose model radii are known exactly,
 * and their separation is the same 3.8 modules for every version. A point traced
 * on either of them therefore supplies one scalar equation
 *
 *        || G p || = rho ,        p = (x, y, 1) in image coordinates,
 *
 * with G the 3x3 image->model homography. Two rings traced over 180 rays each
 * give ~700 equations for 8 unknowns (G is homogeneous, so one entry is gauged
 * to 1): massively over-determined, and -- this is the whole trick -- the
 * equations never ask *which model angle* a point came from. The fit is exactly
 * invariant under a rotation of the model plane, so pose and rotation decouple
 * and are solved independently instead of jointly. Neither can corrupt the
 * other, and there is no chicken-and-egg loop between "where is the ring" and
 * "which way is up".
 *
 * Solved by Levenberg-Marquardt on the nonlinear residual, wrapped in a Tukey
 * biweight outer loop, so a sticker half covering the Limbus cannot drag the
 * fit: those points are voted off the ring rather than averaged in.
 *
 * Note what this replaces. A homography from point correspondences needs the
 * model angle of every traced image point, which needs the transform, which is
 * what is being fitted -- so it must be iterated from an initial guess that is
 * already nearly right. Under a 25 degree tilt the guess from an averaged radial
 * profile is off by more than a module and that iteration diverges. Radial
 * residuals have no such basin-of-attraction problem: the identity-scale guess
 * converges from anywhere.
 */
export function fitRadialHomography(
  rings: RingPoints[],
  G0: ArrayLike<number>,
  opt: { maxIterations?: number; lambda0?: number; robustRounds?: number } = {},
): RadialFitResult {
  const pts: number[] = [];
  const rho: number[] = [];
  for (const r of rings) {
    for (let i = 0; i < r.n; i++) {
      pts.push(r.xs[i] as number, r.ys[i] as number);
      rho.push(r.rho);
    }
  }
  const n = rho.length;
  const g0 = Array.from({ length: 9 }, (_, i) => (G0[i] as number) / (G0[8] as number || 1));
  const fail: RadialFitResult = {
    G: g0,
    H: new Transform(invert3x3(Float64Array.from(g0)) ?? new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])),
    rms: Infinity,
    points: n,
    inliers: 0,
    iterations: 0,
    ok: false,
  };
  if (n < 24) return fail;

  const P = 8;
  let p = g0.slice(0, P);
  let w = new Float64Array(n).fill(1);
  const r = new Float64Array(n);
  const rp = new Float64Array(n);
  const rm = new Float64Array(n);

  const residual = (par: number[], out: Float64Array): void => {
    for (let i = 0; i < n; i++) {
      const x = pts[2 * i] as number;
      const y = pts[2 * i + 1] as number;
      const a = par[0]! * x + par[1]! * y + par[2]!;
      const b = par[3]! * x + par[4]! * y + par[5]!;
      const c = par[6]! * x + par[7]! * y + 1;
      if (Math.abs(c) < 1e-12) {
        out[i] = 1e6;
        continue;
      }
      out[i] = Math.hypot(a / c, b / c) - (rho[i] as number);
    }
  };
  const cost = (rr: Float64Array): number => {
    let s = 0;
    for (let i = 0; i < n; i++) s += (w[i] as number) * (rr[i] as number) ** 2;
    return s;
  };
  /** One damped Gauss-Newton sweep; returns false when no step helped. */
  const step = (lambda: number): { p: number[]; c: number } | null => {
    const J: number[][] = [];
    for (let i = 0; i < n; i++) J.push(new Array<number>(P).fill(0));
    for (let k = 0; k < P; k++) {
      const h = 1e-7 * Math.max(1e-3, Math.abs(p[k] as number));
      const save = p[k] as number;
      p[k] = save + h;
      residual(p, rp);
      p[k] = save - h;
      residual(p, rm);
      p[k] = save;
      for (let i = 0; i < n; i++) J[i]![k] = ((rp[i] as number) - (rm[i] as number)) / (2 * h);
    }
    const A: number[][] = [];
    const b: number[] = new Array<number>(P).fill(0);
    for (let i = 0; i < P; i++) A.push(new Array<number>(P).fill(0));
    for (let i = 0; i < n; i++) {
      const wi = w[i] as number;
      if (wi === 0) continue;
      const row = J[i]!;
      const ri = r[i] as number;
      for (let a = 0; a < P; a++) {
        b[a] = (b[a] as number) - wi * (row[a] as number) * ri;
        for (let bb = 0; bb < P; bb++) A[a]![bb] = (A[a]![bb] as number) + wi * (row[a] as number) * (row[bb] as number);
      }
    }
    const Ad = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
    const d = solveLinear(Ad, b);
    if (!d) return null;
    return { p: p.map((v, i) => v + (d[i] as number)), c: 0 };
  };

  residual(p, r);
  let c = cost(r);
  let lambda = opt.lambda0 ?? 1e-4;
  const maxIt = opt.maxIterations ?? 40;
  let iters = 0;
  for (let it = 0; it < maxIt; it++) {
    iters = it + 1;
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const cand = step(lambda);
      if (!cand) {
        lambda *= 8;
        continue;
      }
      residual(cand.p, rp);
      const cc = cost(rp);
      if (Number.isFinite(cc) && cc < c) {
        const rel = (c - cc) / Math.max(1e-12, c);
        p = cand.p;
        residual(p, r);
        c = cc;
        lambda = Math.max(1e-9, lambda / 6);
        improved = true;
        if (rel < 1e-10) it = maxIt;
      } else {
        lambda *= 8;
      }
    }
    if (!improved) break;
  }

  // Tukey biweight IRLS: discard points that are not really on their ring.
  let inliers = n;
  const rounds = 2;
  for (let round = 0; round < rounds; round++) {
    residual(p, r);
    const abs = Array.from(r).map(Math.abs).sort((a, b) => a - b);
    const med = abs[abs.length >> 1] ?? 0;
    const sigma = Math.max(0.05, 1.4826 * med);
    const cut = 3.5 * sigma;
    inliers = 0;
    for (let i = 0; i < n; i++) {
      const t = Math.abs(r[i] as number) / cut;
      if (t >= 1) w[i] = 0;
      else {
        w[i] = (1 - t * t) ** 2;
        inliers++;
      }
    }
    if (inliers < 24) {
      w = new Float64Array(n).fill(1);
      inliers = n;
      break;
    }
    residual(p, r);
    let c2 = cost(r);
    for (let it = 0; it < 12; it++) {
      const cand = step(1e-4);
      if (!cand) break;
      residual(cand.p, rp);
      const cc = cost(rp);
      if (!Number.isFinite(cc) || cc >= c2) break;
      c2 = cc;
      p = cand.p;
      residual(p, r);
    }
  }

  residual(p, r);
  const G = [...p, 1];
  let se = 0;
  inliers = 0;
  for (let i = 0; i < n; i++) {
    if ((w[i] as number) === 0) continue;
    se += (r[i] as number) ** 2;
    inliers++;
  }
  const rms = Math.sqrt(se / Math.max(1, inliers));
  const Hm = invert3x3(Float64Array.from(G));
  if (!Hm) return { ...fail, G, rms, iterations: iters };
  const H = new Transform(Hm);
  H.kind = 'homography';
  // model y is up and image y is down, so a valid pose flips orientation
  const det = (H.m[0] as number) * (H.m[4] as number) - (H.m[1] as number) * (H.m[3] as number);
  const ok = Number.isFinite(rms) && rms < 4 && det < 0 && H.scale > 1e-3;
  return { G, H, rms, points: n, inliers, iterations: iters, ok };
}

/** Compose a model-plane rotation onto a transform: H . Rot(psiDeg). */
export function composeModelRotation(H: Transform, psiDeg: number): Transform {
  const a = (psiDeg * Math.PI) / 180;
  const R = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
  const t = new Transform(mat3(H.m, R));
  t.kind = H.kind;
  return t;
}

/**
 * Rotation from the Angle Track, sampled THROUGH a transform.
 *
 * Once the homography is known the teeth no longer sit at a constant image
 * radius, so the correlation is taken by walking the *model* circle at uniform
 * angular steps and pushing each point through the transform. The radial fit is
 * blind to rotation, which leaves exactly one rotational degree of freedom to
 * resolve here, and the m-sequence resolves it with an 18 dB matched-filter
 * peak.
 *
 * Returns `psi`, the model-plane rotation to compose onto H so that tooth 0
 * lands on the Beak.
 */
export function estimateRotationMapped(
  img: GrayImage,
  loc: LocateResult,
  H: Transform,
  opt: { sub?: number; lo?: number; hi?: number } = {},
): RotationEstimate & { psi: number } {
  const sub = opt.sub ?? 16;
  const M = TEETH * sub;
  const lo = opt.lo ?? loc.lo;
  const hi = opt.hi ?? loc.hi;
  const g = loc.radii;
  const rhoT = (g.teethInner + g.teethOuter) / 2 / loc.pitch;
  const spread = ((g.teethOuter - g.teethInner) / loc.pitch) * 0.3;
  const signal = new Float64Array(M);
  let live = 0;
  for (let k = 0; k < M; k++) {
    const beta = (2 * Math.PI * k) / M;
    const cb = Math.cos(beta);
    const sb = Math.sin(beta);
    let acc = 0;
    let nn = 0;
    for (const dr of [-spread, 0, spread]) {
      const q = H.apply((rhoT + dr) * cb, (rhoT + dr) * sb);
      if (!Number.isFinite(q.x)) continue;
      const v = sampleBilinear(img, q.x, q.y);
      if (Number.isNaN(v)) continue;
      acc += inkOf(v, lo, hi);
      nn++;
    }
    if (nn === 0) continue;
    signal[k] = (acc / nn) * 2 - 1;
    live++;
  }
  const ref = new Float64Array(M);
  for (let k = 0; k < M; k++) ref[k] = (ANGLE_TRACK[Math.round(k / sub) % TEETH] as number) === 1 ? 1 : -1;

  let best = -Infinity;
  let bestS = 0;
  let second = -Infinity;
  const scores = new Float64Array(M);
  for (let s = 0; s < M; s++) {
    let acc = 0;
    for (let k = 0; k < M; k++) acc += (signal[k] as number) * (ref[(k - s + M) % M] as number);
    scores[s] = acc;
    if (acc > best) {
      best = acc;
      bestS = s;
    }
  }
  for (let s = 0; s < M; s++) if (s !== bestS && (scores[s] as number) > second) second = scores[s] as number;
  const y0 = scores[(bestS - 1 + M) % M] as number;
  const y2 = scores[(bestS + 1) % M] as number;
  const denom = y0 - 2 * best + y2;
  const delta = Math.abs(denom) < 1e-9 ? 0 : (0.5 * (y0 - y2)) / denom;
  const sFine = bestS + Math.max(-1, Math.min(1, delta));
  const psi = (-sFine * 360) / M;
  return {
    phi: (((-psi) % 360) + 360) % 360,
    psi,
    score: best * (live / M),
    margin: best - second,
    sub,
    signal,
    radius: rhoT * loc.pitch,
  };
}

/**
 * Collect the Crown's two calibration circles as image point sets.
 *
 * The Limbus comes from the pole-free outward scan -- it needs no prior at all,
 * because it is simply the outermost dark ring with a light quiet zone outside
 * it. The Halo is then searched at the radius the Limbus predicts *for each ray*,
 * which under tilt is good to a fraction of a module; that is why one tight
 * window serves both the untilted and the 40-degree case.
 */
export function collectCrownRings(img: GrayImage, loc: LocateResult, pole: { x: number; y: number }, rays = 180): RingPoints[] {
  const modelHalo = loc.K + 1.05;
  const modelLimb = loc.K + LIMBUS_OFFSET;
  const useLoc = pole.x === loc.cx && pole.y === loc.cy && !!loc.outer && loc.outer.coverage >= 0.4;
  const outer = useLoc
    ? (loc.outer as NonNullable<LocateResult['outer']>)
    : traceOuterRing(img, pole.x, pole.y, loc.lo, loc.hi, rays);
  if (outer.coverage < 0.25 || !Number.isFinite(outer.median)) return [];

  const limbus: RingPoints = { xs: new Float64Array(outer.n), ys: new Float64Array(outer.n), n: 0, rho: modelLimb };
  for (let k = 0; k < outer.n; k++) {
    const rr = outer.radius[k] as number;
    if (!Number.isFinite(rr)) continue;
    const a = outer.angles[k] as number;
    limbus.xs[limbus.n] = pole.x + Math.cos(a) * rr;
    limbus.ys[limbus.n] = pole.y + Math.sin(a) * rr;
    limbus.n++;
  }

  const haloTrace = traceRingAngular(
    img,
    pole.x,
    pole.y,
    (a) => ringRadiusAt(outer, a) * (modelHalo / modelLimb),
    Math.max(0.9, loc.pitch * 0.45),
    loc.lo,
    loc.hi,
    rays,
  );
  const halo: RingPoints = { xs: new Float64Array(haloTrace.radii.length), ys: new Float64Array(haloTrace.radii.length), n: 0, rho: modelHalo };
  for (let k = 0; k < haloTrace.radii.length; k++) {
    const rr = haloTrace.radii[k] as number;
    if (!Number.isFinite(rr)) continue;
    const a = haloTrace.angles[k] as number;
    halo.xs[halo.n] = pole.x + Math.cos(a) * rr;
    halo.ys[halo.n] = pole.y + Math.sin(a) * rr;
    halo.n++;
  }

  const out: RingPoints[] = [];
  if (limbus.n >= 12) out.push(limbus);
  if (halo.n >= 12) out.push(halo);
  return out;
}

/**
 * Full pose refinement: radial homography fit, then rotation through that fit,
 * iterated so each pass traces the rings at radii the previous pass predicts.
 */
export function refineTransform(img: GrayImage, loc: LocateResult, t0: Transform, iterations = 3): RefineResult {
  const G0m = invert3x3(similarity(loc.cx, loc.cy, loc.pitch, 0).m);
  if (!G0m) return { transform: t0, rms: Infinity, used: 'similarity', points: 0, rotationDeg: t0.rotationDeg };
  let G: number[] = Array.from(G0m);
  let H = t0;
  let rms = Infinity;
  let used: 'homography' | 'similarity' = 'similarity';
  let usedPoints = 0;
  let rotDeg = t0.rotationDeg;
  let rotScore = 0;

  for (let it = 0; it < iterations; it++) {
    const pole = it === 0 ? { x: loc.cx, y: loc.cy } : H.apply(0, 0);
    if (!Number.isFinite(pole.x)) break;
    const rings = collectCrownRings(img, loc, pole, 180);
    if (rings.length === 0) break;
    const fit = fitRadialHomography(rings, G);
    if (!fit.ok) break;
    const scaleRatio = fit.H.scale / loc.pitch;
    if (!(scaleRatio > 0.55 && scaleRatio < 1.8)) break;
    if (it > 0 && fit.rms * loc.pitch > rms) break;
    G = fit.G;
    rms = fit.rms * loc.pitch;
    used = 'homography';
    usedPoints = fit.inliers;
    const rot = estimateRotationMapped(img, loc, fit.H);
    rotScore = rot.score;
    if (rot.score > 6) {
      /*
       * fit.H = H_true . Rot(psi), because the radial residual cannot see a
       * rotation of the model plane. Undoing it means composing Rot(-psi):
       * similarity(phi) . Rot(psi) = similarity(phi + psi), so the sign here is
       * the whole difference between a correct pose and one that is off by twice
       * the symbol's rotation -- which reads as a 13-tooth shift at 37 degrees.
       */
      H = composeModelRotation(fit.H, -rot.psi);
      rotDeg = H.rotationDeg;
    } else {
      H = fit.H;
    }
  }
  if (used === 'similarity') {
    H = t0;
    rotDeg = t0.rotationDeg;
  }
  return { transform: H, rms, used, points: usedPoints, rotationDeg: rotDeg, rotationScore: rotScore };
}
