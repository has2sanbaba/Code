/**
 * ============================================================================
 *  SAMPLE -- read modules, beads and teeth out of a rectified image
 * ============================================================================
 *
 * Every module is read as the *mean ink* over a disc at its predicted centre,
 * then thresholded with a two-cluster (Otsu-style) cut computed over the whole
 * symbol. Two numbers come out per module:
 *
 *   bit        -- the hard decision
 *   confidence -- |ink - cut| normalised by the cluster separation
 *
 * Confidence is what turns this from an ordinary decoder into a soft-decision
 * one: modules read near the cut, or over a hole, a scratch or a specular
 * highlight, are handed to Reed-Solomon as *erasures* instead of as trusted
 * bits. An erasure costs one parity symbol; an undetected error costs two.
 * Declaring ignorance is literally twice as cheap as guessing wrong.
 */
import { BEADS, DOT_RADIUS, getLattice } from '../geometry.js';
import { crown, dataRings } from '../geometry.js';
import { sampleBilinear, sampleDisc, type GrayImage } from './image.js';
import { applyMaskPrior, type MaskPriorOptions } from './damage.js';
import { inkOf, type LocateResult } from './locate.js';
import { Transform } from './orient.js';
import type { ModuleShape } from '../model.js';

export interface SampledSymbol {
  version: number;
  /** Printed (masked) value of each data cell. */
  dataBits: Uint8Array;
  confidence: Float32Array;
  /** 24 Format Crown beads. */
  beads: Uint8Array;
  beadConfidence: Float32Array;
  /** 63 Angle Track teeth. */
  teeth: Uint8Array;
  toothConfidence: Float32Array;
  /** 19 Core rosette samples, order: centre, ring1 x6, ring2 x12. */
  core: Uint8Array;
  coreConfidence: Float32Array;
  transform: Transform;
  loc: LocateResult;
  /** Mean confidence over the data field. */
  meanConfidence: number;
  /** Fraction of data cells below the erasure threshold. */
  weakFraction: number;
  /** Cells whose confidence was reduced by the mask-prior damage detector. */
  maskPriorFlagged: number;
  /** Of those, the cells flagged directly (not merely dilated neighbours). */
  maskPriorSeeds: number;
}

export interface SampleOptions {
  shape?: ModuleShape;
  /** Disc radius as a fraction of the module pitch. Default 0.40 for dots. */
  sampleRadius?: number;
  /** Confidence below which a cell counts as "weak". Default 0.30. */
  weakThreshold?: number;
  /** Use the local Jacobian of a homography to size each sampling disc. Default true. */
  localScale?: boolean;
  /**
   * Damage detection from the mask prior: down-weight modules whose 19-cell
   * neighbourhood is uniformly inked or uniformly bare. Default on.
   */
  maskPrior?: boolean | MaskPriorOptions;
}

/** Local linear scale (pixels per module) of a transform at a model point. */
export function localScale(t: Transform, x: number, y: number): number {
  const e = 0.35;
  const a = t.apply(x + e, y);
  const b = t.apply(x - e, y);
  const c = t.apply(x, y + e);
  const d = t.apply(x, y - e);
  if (!Number.isFinite(a.x) || !Number.isFinite(c.x)) return t.scale;
  const jx = Math.hypot(a.x - b.x, a.y - b.y) / (2 * e);
  const jy = Math.hypot(c.x - d.x, c.y - d.y) / (2 * e);
  return Math.sqrt(jx * jy) || t.scale;
}

/**
 * Two-cluster split of a value array.
 *
 * Deliberately NOT histogram-Otsu: a clean render produces values that pile up
 * in exactly two histogram bins, every threshold between them scores equally,
 * and Otsu then returns whichever bin it met first -- typically hard against
 * one cluster, which would mark half the symbol as "uncertain". Instead we take
 * the mean of the darkest 15% and the mean of the lightest 15% and cut exactly
 * in between. That is the maximum-margin separator for a bimodal distribution
 * and it degrades gracefully as blur and noise pull the clusters together.
 */
export function twoClusterCut(values: ArrayLike<number>): { cut: number; span: number } {
  const n = values.length;
  if (n === 0) return { cut: 0.5, span: 0.5 };
  const sorted = Array.from(values).sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(n * 0.15));
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < k; i++) lo += sorted[i] as number;
  for (let i = n - k; i < n; i++) hi += sorted[i] as number;
  lo /= k;
  hi /= k;
  if (hi - lo < 1e-6) return { cut: lo, span: 0.02 };
  return { cut: (lo + hi) / 2, span: (hi - lo) / 2 };
}

export function sampleSymbol(img: GrayImage, loc: LocateResult, t: Transform, opt: SampleOptions = {}): SampledSymbol {
  const shape = opt.shape ?? 'dot';
  const baseRadius = opt.sampleRadius ?? (shape === 'dot' ? 0.4 : shape === 'hex' ? 0.44 : 0.42);
  const weakThreshold = opt.weakThreshold ?? 0.3;
  const useLocal = opt.localScale !== false;
  const version = loc.version;
  const lat = getLattice(version);
  const g = crown(dataRings(version));

  const values = new Float64Array(lat.N);
  const outside = new Float32Array(lat.N);
  for (let i = 0; i < lat.N; i++) {
    const mx = lat.xy[2 * i] as number;
    const my = lat.xy[2 * i + 1] as number;
    const p = t.apply(mx, my);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      values[i] = 0.5;
      outside[i] = 1;
      continue;
    }
    const s = useLocal ? localScale(t, mx, my) : t.scale;
    const smp = sampleDisc(img, p.x, p.y, Math.max(0.6, s * baseRadius));
    values[i] = smp.n ? inkOf(smp.mean, loc.lo, loc.hi) : 0.5;
    outside[i] = smp.outside;
  }

  const { cut, span } = twoClusterCut(values);
  const dataBits = new Uint8Array(lat.N);
  const confidence = new Float32Array(lat.N);
  for (let i = 0; i < lat.N; i++) {
    dataBits[i] = (values[i] as number) >= cut ? 1 : 0;
    let c = Math.min(1, Math.abs((values[i] as number) - cut) / span);
    c *= 1 - (outside[i] as number);
    confidence[i] = c;
  }

  /*
   * A hole, a sticker or a thumbprint does not lower the *contrast* of the
   * modules it covers -- it removes ink cleanly, so those modules are read as
   * confident, well-separated light values that are simply wrong. Contrast alone
   * therefore cannot see the single most common real-world defect. The mask prior
   * can: a balanced mask makes a 19-cell neighbourhood Binomial(19, 1/2), and a
   * uniformly bare neighbourhood has probability 3.8e-5 under it.
   */
  let maskPriorFlagged = 0;
  let maskPriorSeeds = 0;
  if (opt.maskPrior !== false) {
    const mp = typeof opt.maskPrior === 'object' ? opt.maskPrior : {};
    const pr = applyMaskPrior(version, dataBits, confidence, mp);
    maskPriorFlagged = pr.flagged;
    maskPriorSeeds = pr.seeds;
  }

  let sum = 0;
  let weak = 0;
  for (let i = 0; i < lat.N; i++) {
    sum += confidence[i] as number;
    if ((confidence[i] as number) < weakThreshold) weak++;
  }

  // --- beads ---------------------------------------------------------------
  const beadValues = new Float64Array(BEADS);
  for (let i = 0; i < BEADS; i++) {
    const a = ((i * 360) / BEADS + 360 / BEADS / 2) * (Math.PI / 180);
    const p = t.apply(g.beadRadius * Math.cos(a), g.beadRadius * Math.sin(a));
    const s = useLocal ? localScale(t, g.beadRadius * Math.cos(a), g.beadRadius * Math.sin(a)) : t.scale;
    const smp = sampleDisc(img, p.x, p.y, Math.max(0.5, s * g.beadSize * 0.85));
    beadValues[i] = smp.n ? inkOf(smp.mean, loc.lo, loc.hi) : 0.5;
  }
  const bc = twoClusterCut(beadValues);
  const beads = new Uint8Array(BEADS);
  const beadConfidence = new Float32Array(BEADS);
  for (let i = 0; i < BEADS; i++) {
    beads[i] = (beadValues[i] as number) >= bc.cut ? 1 : 0;
    beadConfidence[i] = Math.min(1, Math.abs((beadValues[i] as number) - bc.cut) / bc.span);
  }

  // --- teeth ---------------------------------------------------------------
  const teeth = new Uint8Array(63);
  const toothConfidence = new Float32Array(63);
  sampleTeethInto(img, loc, t, teeth, toothConfidence, useLocal);

  // --- core ----------------------------------------------------------------
  const core = new Uint8Array(19);
  const coreConfidence = new Float32Array(19);
  {
    let k = 0;
    const push = (mx: number, my: number) => {
      const p = t.apply(mx, my);
      const s = useLocal ? localScale(t, mx, my) : t.scale;
      const smp = sampleDisc(img, p.x, p.y, Math.max(0.6, s * baseRadius));
      const v = smp.n ? inkOf(smp.mean, loc.lo, loc.hi) : 0.5;
      core[k] = v >= cut ? 1 : 0;
      coreConfidence[k] = Math.min(1, Math.abs(v - cut) / span) * (1 - smp.outside);
      k++;
    };
    push(0, 0);
    for (let j = 0; j < 6; j++) {
      const c = ringXY(1, j);
      push(c.x, c.y);
    }
    for (let j = 0; j < 12; j++) {
      const c = ringXY(2, j);
      push(c.x, c.y);
    }
  }

  return {
    version,
    dataBits,
    confidence,
    beads,
    beadConfidence,
    teeth,
    toothConfidence,
    core,
    coreConfidence,
    transform: t,
    loc,
    meanConfidence: sum / lat.N,
    weakFraction: weak / lat.N,
    maskPriorFlagged,
    maskPriorSeeds,
  };
}

function ringXY(d: number, j: number): { x: number; y: number } {
  const side = Math.floor(j / d);
  const k = j - side * d;
  let q = 0;
  let r = 0;
  if (side === 0) {
    q = d - k;
    r = k;
  } else if (side === 1) {
    q = -k;
    r = d;
  } else if (side === 2) {
    q = -d;
    r = d - k;
  } else if (side === 3) {
    q = -d + k;
    r = -k;
  } else if (side === 4) {
    q = k;
    r = -d;
  } else {
    q = d;
    r = -d + k;
  }
  return { x: q + r / 2, y: (Math.sqrt(3) / 2) * r };
}

/** Sample the 63 teeth through a transform (average over the middle of each sector). */
export function sampleTeethInto(
  img: GrayImage,
  loc: LocateResult,
  t: Transform,
  bits: Uint8Array,
  conf: Float32Array,
  useLocal = true,
): void {
  const g = crown(dataRings(loc.version));
  const toothDeg = 360 / 63;
  const values = new Float64Array(63);
  for (let i = 0; i < 63; i++) {
    let acc = 0;
    let n = 0;
    for (let ka = -2; ka <= 2; ka++) {
      const a = ((i * toothDeg + (ka * toothDeg) / 10) * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (let kr = -2; kr <= 2; kr++) {
        const rho = (g.teethInner + g.teethOuter) / 2 + kr * (g.teethOuter - g.teethInner) * 0.16;
        const p = t.apply(rho * ca, rho * sa);
        const v = sampleBilinear(img, p.x, p.y);
        if (Number.isNaN(v)) continue;
        acc += inkOf(v, loc.lo, loc.hi);
        n++;
      }
    }
    values[i] = n ? acc / n : 0.5;
    void useLocal;
  }
  const c = twoClusterCut(values);
  for (let i = 0; i < 63; i++) {
    bits[i] = (values[i] as number) >= c.cut ? 1 : 0;
    conf[i] = Math.min(1, Math.abs((values[i] as number) - c.cut) / c.span);
  }
}

/** Reference dot radius, exported so tests can render and sample consistently. */
export const DEFAULT_SAMPLE_RADIUS = DOT_RADIUS * 0.87;
