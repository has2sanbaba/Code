/**
 * ============================================================================
 *  DECODE FROM AN IMAGE -- the full machine-vision pipeline
 * ============================================================================
 *
 *      grayscale ─▶ LOCATE   radial matched filter -> centre, version, pitch
 *                ─▶ ORIENT   m-sequence correlation -> absolute rotation
 *                ─▶ RECTIFY  homography from the Halo + Limbus circles
 *                ─▶ SAMPLE   soft decisions on beads, teeth and every module
 *                ─▶ CROWN    Golay(24,12) -> exact format, or brute force
 *                ─▶ RS       erasure-aware Reed-Solomon -> payload bits
 *                ─▶ CRC-32   accept / reject
 *                ─▶ SEGMENTS text, URL, bytes, geo, frames, MAC, signature
 *
 * The pipeline is a ladder: each stage can fail, and the orchestrator retries
 * with relaxed hypotheses (neighbouring versions, hard decisions, no rectification)
 * before giving up.
 */
import { decode, type DecodeOptions, type DecodeResult } from '../decoder.js';
import { decodeFormatCrown } from '../format.js';
import { ANGLE_TRACK, crown, dataRings, MAX_VERSION, MIN_VERSION } from '../geometry.js';
import type { ModuleShape } from '../model.js';
import type { GrayImage } from './image.js';
import { fitCircle, locate, traceRing, type LocateOptions, type LocateResult } from './locate.js';
import { composeModelRotation, estimateRotation, refineTransform, similarity, Transform, type RotationEstimate } from './orient.js';
import { sampleSymbol, type SampledSymbol, type SampleOptions } from './sample.js';

export interface ImageDecodeOptions {
  shape?: ModuleShape;
  locate?: LocateOptions;
  sample?: SampleOptions;
  /** Inflate hook, needed when the format's compression bit is set. */
  decompress?: (raw: Uint8Array) => Uint8Array;
  /** Confidence below which a module becomes an erasure. Default 0.28. */
  erasureThreshold?: number;
  /** Skip the homography rectification (faster, worse under perspective). */
  noRectify?: boolean;
  /** How many relaxed retries to attempt. Default 3. */
  retries?: number;
  /** Restrict the version search around the located version. Default +-1. */
  versionWindow?: number;
  /** Cap on format candidates tried per rung. Default: bounded by symbol size. */
  maxCandidates?: number;
  onStage?: (stage: string, detail?: unknown) => void;
}

export interface ImageDiagnostics {
  width: number;
  height: number;
  locate: LocateResult | null;
  locatedVersion: number;
  pitch: number;
  rotationDeg: number;
  rotationMargin: number;
  transformKind: string;
  transformRms: number;
  teethMatches: number;
  teethShift: number;
  crownOk: boolean;
  golayDistance: number;
  format: { version: number; ecc: number; mask: number; compression: number } | null;
  meanConfidence: number;
  weakFraction: number;
  erasureCells: number;
  attempts: number;
  coreMatches: number;
  /** Data cells whose confidence was cut by the mask-prior damage detector. */
  maskPriorFlagged: number;
  /** Of those, the cells flagged directly rather than as dilated neighbours. */
  maskPriorSeeds: number;
}

export interface ImageDecodeResult extends DecodeResult {
  diagnostics: ImageDiagnostics;
  sampled?: SampledSymbol;
}

/** Best cyclic alignment of a sampled ring against the Angle Track reference. */
export function alignTeeth(sampled: ArrayLike<number>): { shift: number; matches: number } {
  let bestShift = 0;
  let bestMatches = -1;
  for (let s = 0; s < 63; s++) {
    let m = 0;
    for (let i = 0; i < 63; i++) {
      if ((sampled[i] ? 1 : 0) === (ANGLE_TRACK[(i + s) % 63] as number)) m++;
    }
    if (m > bestMatches) {
      bestMatches = m;
      bestShift = s;
    }
  }
  return { shift: bestShift, matches: bestMatches };
}

function rebuildLoc(loc: LocateResult, version: number, img: GrayImage): LocateResult {
  const K = dataRings(version);
  const g = crown(K);
  // re-measure the Limbus radius directly: it is the strongest circle in the symbol
  const trace = traceRing(img, loc.cx, loc.cy, loc.radii.limbus, Math.max(1.5, loc.pitch * 0.6), loc.lo, loc.hi, 360);
  const fit = fitCircle(trace.pts);
  const cx = Number.isFinite(fit.cx) ? fit.cx : loc.cx;
  const cy = Number.isFinite(fit.cy) ? fit.cy : loc.cy;
  const rLimb = Number.isFinite(fit.r) && fit.r > 1 ? fit.r : loc.radii.limbus;
  const pitch = rLimb / (K + 4.85);
  const radii = {
    halo: pitch * g.haloRadius,
    beads: pitch * g.beadRadius,
    teethInner: pitch * g.teethInner,
    teethOuter: pitch * g.teethOuter,
    limbus: pitch * g.limbusRadius,
    outer: pitch * g.outerRadius,
  };
  return {
    ...loc,
    version,
    K,
    pitch,
    cx,
    cy,
    radii,
    score: loc.score,
    ringCoverage: trace.coverage,
    ringPoints: trace.pts,
  };
}

export function decodeImage(img: GrayImage, opt: ImageDecodeOptions = {}): ImageDecodeResult {
  const diag: ImageDiagnostics = {
    width: img.width,
    height: img.height,
    locate: null,
    locatedVersion: 0,
    pitch: 0,
    rotationDeg: 0,
    rotationMargin: 0,
    transformKind: 'none',
    transformRms: NaN,
    teethMatches: 0,
    teethShift: 0,
    crownOk: false,
    golayDistance: 0,
    format: null,
    meanConfidence: 0,
    weakFraction: 0,
    erasureCells: 0,
    attempts: 0,
    coreMatches: 0,
    maskPriorFlagged: 0,
    maskPriorSeeds: 0,
  };

  opt.onStage?.('locate');
  const loc0 = locate(img, opt.locate);
  if (!loc0) {
    return { ok: false, error: 'no SiMurgh symbol found (radial matched filter scored too low)', diagnostics: diag };
  }
  diag.locate = loc0;
  diag.locatedVersion = loc0.version;
  diag.pitch = loc0.pitch;

  opt.onStage?.('orient', { version: loc0.version, pitch: loc0.pitch, score: loc0.score });
  let rot: RotationEstimate = estimateRotation(img, loc0, loc0.cx, loc0.cy);
  diag.rotationDeg = rot.phi;
  diag.rotationMargin = rot.margin;
  if (rot.score < 6) {
    return {
      ok: false,
      error: `Angle Track correlation too weak (score ${rot.score.toFixed(1)}, need >= 6): is the outer ring intact?`,
      diagnostics: diag,
    };
  }

  let loc = loc0;
  let t: Transform = similarity(loc.cx, loc.cy, loc.pitch, rot.phi);

  if (!opt.noRectify) {
    opt.onStage?.('rectify');
    const refined = refineTransform(img, loc, t);
    diag.transformKind = refined.used;
    diag.transformRms = refined.rms;
    if (refined.transform) t = refined.transform;
    /*
     * The refinement re-derives the rotation by correlating the Angle Track
     * *through* the fitted homography, which is the only estimate that survives
     * perspective (a constant-radius correlation loses the teeth band once the
     * ring radius swings by more than half a module). Trust it when it is strong.
     */
    if (refined.used === 'homography' && Number.isFinite(refined.rotationDeg) && (refined.rotationScore ?? 0) > 6) {
      rot = { ...rot, phi: ((-(refined.rotationDeg as number)) % 360 + 360) % 360 };
      diag.rotationDeg = rot.phi;
    }
  } else {
    diag.transformKind = 'similarity';
  }

  opt.onStage?.('sample');
  let sampled = sampleSymbol(img, loc, t, opt.sample);

  // --- Angle Track self-check: correct any whole-tooth rotation error -------
  const align = alignTeeth(sampled.teeth);
  diag.teethMatches = align.matches;
  diag.teethShift = align.shift;
  if (align.matches >= 40 && align.shift !== 0) {
    const delta = align.shift <= 31 ? align.shift : align.shift - 63;
    opt.onStage?.('rotation-fix', { delta });
    /*
     * sampled[i] = ANGLE_TRACK[i + delta] means the transform carried model angle
     * beta to the image position of the tooth at beta + delta, i.e. it is the true
     * map post-composed with a rotation of +delta teeth. Undo it in the model
     * plane -- composing keeps the fitted pose intact, whereas rebuilding a
     * similarity from scratch would throw the perspective correction away.
     */
    t = composeModelRotation(t, -delta * (360 / 63));
    sampled = sampleSymbol(img, loc, t, opt.sample);
    const a2 = alignTeeth(sampled.teeth);
    diag.teethMatches = a2.matches;
    diag.teethShift = a2.shift;
  }

  // --- Core rosette check (diagnostic only) --------------------------------
  {
    const expected = [1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    let m = 0;
    for (let i = 0; i < 19; i++) if (sampled.core[i] === expected[i]) m++;
    diag.coreMatches = m;
  }

  // --- Format Crown --------------------------------------------------------
  const crownRes = decodeFormatCrown(sampled.beads);
  diag.crownOk = crownRes.ok;
  diag.golayDistance = crownRes.distance;
  if (crownRes.ok && crownRes.format) {
    diag.format = {
      version: crownRes.format.versionIndex + 1,
      ecc: crownRes.format.ecc,
      mask: crownRes.format.mask,
      compression: crownRes.format.compression,
    };
    const v = crownRes.format.versionIndex + 1;
    if (v !== loc.version) {
      opt.onStage?.('version-fix', { from: loc.version, to: v });
      loc = rebuildLoc(loc, v, img);
      diag.pitch = loc.pitch;
      diag.locatedVersion = v;
      const delta = diag.teethShift <= 31 ? diag.teethShift : diag.teethShift - 63;
      t = similarity(loc.cx, loc.cy, loc.pitch, rot.phi - delta * (360 / 63));
      if (!opt.noRectify) {
        const refined = refineTransform(img, loc, t);
        if (refined.transform) t = refined.transform;
        diag.transformKind = refined.used;
        diag.transformRms = refined.rms;
      }
      if (delta !== 0) t = composeModelRotation(t, -delta * (360 / 63));
      sampled = sampleSymbol(img, loc, t, opt.sample);
    }
  }

  /*
   * Bail out before the expensive part when the image simply does not carry a
   * readable symbol. All three conditions must hold: the Format Crown could not
   * be read (so the version is not confirmed), the Angle Track correlation lost
   * most of its teeth (so the scale and phase are not confirmed), and the average
   * module confidence is near the two-cluster cut (so the modules themselves are
   * not separated). Brute-forcing the format space of a mislocated large version
   * otherwise costs tens of seconds to arrive at a guaranteed CRC failure.
   */
  if (!diag.crownOk && diag.teethMatches < 40 && diag.meanConfidence < 0.3) {
    return {
      ok: false,
      error:
        `image does not resolve a SiMurgh symbol: mean module confidence ${diag.meanConfidence.toFixed(2)}, ` +
        `Angle Track ${diag.teethMatches}/63, Format Crown unreadable (resolution too low, or no symbol present)`,
      diagnostics: diag,
      sampled,
    };
  }

  diag.meanConfidence = sampled.meanConfidence;
  diag.weakFraction = sampled.weakFraction;
  diag.maskPriorFlagged = sampled.maskPriorFlagged;
  diag.maskPriorSeeds = sampled.maskPriorSeeds;

  // --- Decode, with a ladder of relaxed retries -----------------------------
  const win = opt.versionWindow ?? 1;
  const versions: number[] = [];
  for (let v = loc.version - win; v <= loc.version + win; v++) if (v >= MIN_VERSION && v <= MAX_VERSION) versions.push(v);
  if (!versions.includes(loc.version)) versions.unshift(loc.version);

  /*
   * The brute-force rungs are bounded by *work*, not by a fixed candidate count:
   * every candidate is a full Reed-Solomon decode over the whole disc, so the
   * affordable number falls as the version grows. The CRC-32 oracle makes a false
   * accept impossible, so a tight bound costs only a missed recovery, never a
   * wrong payload.
   */
  const workBound = Math.max(8, Math.min(512, Math.floor(4e5 / Math.max(1, sampled.dataBits.length))));
  const decodeOpts: DecodeOptions = {
    erasureThreshold: opt.erasureThreshold ?? 0.28,
    decompress: opt.decompress,
    candidateVersions: versions,
    maxCandidates: opt.maxCandidates ?? workBound,
  };

  const attempts: { label: string; run: () => DecodeResult }[] = [
    {
      label: 'crown+soft',
      run: () => decode({ dataBits: sampled.dataBits, confidence: sampled.confidence, beads: sampled.beads }, decodeOpts),
    },
    {
      /*
       * The 0.85 budget factor deliberately holds back 15% of each block's parity
       * to pay for errors the sampler did not notice. When the damage detector has
       * fired hard, that reserve is the wrong bet: the flagged cells are almost
       * certainly real damage, and a symbol left out of the erasure list costs two
       * parity symbols instead of one. So spend the whole parity budget on
       * erasures and let the CRC-32 decide.
       */
      label: 'crown+full-erasure',
      run: () =>
        decode(
          { dataBits: sampled.dataBits, confidence: sampled.confidence, beads: sampled.beads },
          { ...decodeOpts, maxErasureFraction: 1 },
        ),
    },
    {
      label: 'brute+soft',
      run: () => decode({ dataBits: sampled.dataBits, confidence: sampled.confidence }, { ...decodeOpts }),
    },
    {
      label: 'brute+hard',
      run: () => decode({ dataBits: sampled.dataBits }, { ...decodeOpts }),
    },
    {
      label: 'brute+soft+wide-erasure',
      run: () =>
        decode(
          { dataBits: sampled.dataBits, confidence: sampled.confidence },
          { ...decodeOpts, erasureThreshold: (opt.erasureThreshold ?? 0.28) * 1.7 },
        ),
    },
  ];

  const retries = opt.retries ?? attempts.length;
  let last: DecodeResult = { ok: false, error: 'no attempt produced a result' };
  for (let i = 0; i < Math.min(retries, attempts.length); i++) {
    diag.attempts = i + 1;
    opt.onStage?.(`decode:${attempts[i]!.label}`);
    const r = attempts[i]!.run();
    last = r;
    if (r.ok) {
      const er = r.stats?.erasureCells ?? 0;
      diag.erasureCells = er;
      return { ...r, diagnostics: diag, sampled };
    }
  }
  return { ...last, ok: false, diagnostics: diag, sampled };
}

/**
 * Convenience: decode from anything that can produce RGBA pixels (a canvas,
 * an ImageBitmap, a video frame). The host supplies the pixel buffer.
 */
export function decodeRGBA(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opt: ImageDecodeOptions = {},
): ImageDecodeResult {
  // inline to avoid a circular import at module init
  const out = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = data[p] as number;
    const g = data[p + 1] as number;
    const b = data[p + 2] as number;
    const a = data[p + 3] as number;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out[i] = Math.round((luma * a) / 255 + 255 * (1 - a / 255));
  }
  return decodeImage({ width, height, data: out }, opt);
}
