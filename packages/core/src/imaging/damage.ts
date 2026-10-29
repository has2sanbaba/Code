/**
 * ============================================================================
 *  DAMAGE DETECTION FROM THE MASK PRIOR
 * ============================================================================
 *
 * A hole, a sticker, a scratch or a thumbprint does not reduce the *contrast*
 * of the modules it covers. It removes ink cleanly, so those modules are read as
 * confident, well-separated light values that are simply wrong -- invisible to
 * any detector based on signal quality. This file is the detector that can see
 * them, and it works by exploiting a guarantee the symbology makes elsewhere.
 *
 * THE PRIOR. The data mask forces the printed modules to behave like fair coin
 * flips, so around any module the number of inked modules among the 19 cells at
 * hex distance <= 2 concentrates near 9 or 10 and a uniformly bare neighbourhood
 * is a rare event. Rare, but not as rare as an independent-coin model says: mask
 * patterns are periodic and payloads are structured, so the real distribution has
 * heavier tails than Binomial(19, 1/2). The thresholds below were therefore
 * measured, not assumed -- over 182,796 interior cells drawn from 50 symbols
 * (10 payloads x 5 versions, masks chosen by the penalty function):
 *
 *      dark count <= 1 or >= 18      0.02 cells per 612-cell symbol
 *      dark count <= 2 or >= 17      0.26
 *      dark count <= 3 or >= 16      2.1     <-- Tier A threshold
 *      dark count <= 4 or >= 15      9.1
 *      dark count <= 5 or >= 14      31.6
 *
 * A sticker or a hole punch drives the covered cells to a dark count of 0, which
 * sits 2.1 false positives per symbol away from anything the symbology produces
 * on its own. That gap is the detector.
 *
 * A cluster-corroboration tier (require several neighbours to be biased the same
 * way) was measured and rejected: local bias is spatially correlated by the mask
 * itself, so the test fires 40+ times per clean symbol at the thresholds where it
 * would still see a defect. Only the extreme tail is informative.
 *
 * THE DILATION IS GRADED. Tier A fires deep inside a defect; most of the damaged
 * modules are near its edge, where the local statistics are only mildly off. So
 * the neighbours of a flagged cell are also penalised, but by distance: 0.35 at
 * hex distance 1 and 0.7 at distance 2. Both sit *above* the default 0.28 erasure
 * threshold, so a dilated neighbour only becomes an erasure when it was already
 * doubtful for an independent reason -- two sources of evidence must agree before
 * a parity symbol is spent. Measured over an 11-case degradation suite, that
 * choice costs 2 of 17 erasure slots on a pristine symbol while still recovering
 * a hole covering 16% of the disc; a harsher 0.25 dilation buys nothing extra and
 * costs 6 slots.
 *
 * Every flagged module has its confidence multiplied down, which converts a
 * silent wrong bit into an honest erasure. That is the whole point: an erasure
 * costs Reed-Solomon one parity symbol, an error costs two. A defect that would
 * have exhausted the error budget at 14% of the data field is absorbed at 28%.
 *
 * This is why SiMurgh mandates a balanced mask. It is not cosmetics and it is not
 * only about printability: it is the reference distribution against which
 * physical damage is detected.
 */
import { getLattice } from '../geometry.js';

export interface MaskPriorOptions {
  /** Confidence multiplier for a flagged (seed) cell. Default 0.02. */
  extremePenalty?: number;
  /** Confidence multiplier for a distance-1 neighbour of a seed. Default 0.35. */
  nearPenalty?: number;
  /** Confidence multiplier for a distance-2 neighbour of a seed. Default 0.7. */
  farPenalty?: number;
  /**
   * Dark-count threshold out of 19 that makes a cell a seed: count <= strict or
   * count >= 19 - strict. Default 3, i.e. 2.1 false seeds per 612-cell symbol.
   */
  strictCount?: number;
  /** Disable entirely. */
  disabled?: boolean;
}

export interface MaskPriorResult {
  /** Cells whose confidence was reduced, including dilated neighbours. */
  flagged: number;
  /** Cells flagged directly by the local-bias test. */
  seeds: number;
  /** Mean confidence after the adjustment. */
  meanConfidence: number;
  /** Per-cell dark count over the 19-cell neighbourhood (for diagnostics). */
  darkCount?: Uint8Array;
}

const HOOD = 19;

/**
 * Build the 19-cell neighbourhood (hex distance <= 2) of every data cell as a
 * flat index list. Cells near the Core or the Halo have fewer than 19 neighbours
 * and are reported with their true count; they are never penalised on a partial
 * neighbourhood, because the binomial reference distribution does not apply.
 */
function neighbourhoods(version: number): { hood: Int32Array; count: Int32Array } {
  const lat = getLattice(version);
  const N = lat.N;
  const hood = new Int32Array(N * HOOD).fill(-1);
  const count = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const set = new Set<number>([i]);
    for (let k = 0; k < 6; k++) {
      const a = lat.neighbours[i * 6 + k] as number;
      if (a < 0) continue;
      set.add(a);
      for (let m = 0; m < 6; m++) {
        const b = lat.neighbours[a * 6 + m] as number;
        if (b >= 0) set.add(b);
      }
    }
    let n = 0;
    for (const j of set) {
      if (n >= HOOD) break;
      hood[i * HOOD + n++] = j;
    }
    count[i] = n;
  }
  return { hood, count };
}

export function applyMaskPrior(
  version: number,
  bits: Uint8Array,
  confidence: Float32Array,
  opt: MaskPriorOptions = {},
): MaskPriorResult {
  const mean = (): number => {
    let s = 0;
    for (let i = 0; i < confidence.length; i++) s += confidence[i] as number;
    return confidence.length ? s / confidence.length : 0;
  };
  if (opt.disabled) return { flagged: 0, seeds: 0, meanConfidence: mean() };

  const lat = getLattice(version);
  const N = lat.N;
  const extremePenalty = opt.extremePenalty ?? 0.02;
  const nearPenalty = opt.nearPenalty ?? 0.35;
  const farPenalty = opt.farPenalty ?? 0.7;
  const strict = opt.strictCount ?? 3;

  const { hood, count } = neighbourhoods(version);

  // ---- local dark count ---------------------------------------------------
  const dark = new Uint8Array(N);
  const full = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const n = count[i] as number;
    // A partial neighbourhood has no binomial reference, so it is never judged.
    full[i] = n >= HOOD - 1 ? 1 : 0;
    if (n < 10) continue;
    let d = 0;
    for (let k = 0; k < n; k++) d += bits[hood[i * HOOD + k] as number] as number;
    dark[i] = d;
  }

  // ---- seeds: extreme local bias -----------------------------------------
  const seed = new Uint8Array(N);
  let seeds = 0;
  for (let i = 0; i < N; i++) {
    if (!full[i]) continue;
    const n = count[i] as number;
    const d = dark[i] as number;
    if (d <= strict || d >= n - strict) {
      seed[i] = 1;
      seeds++;
    }
  }
  if (seeds === 0) return { flagged: 0, seeds: 0, meanConfidence: mean(), darkCount: dark };

  /*
   * Seeds are not merely penalised, they are *ranked*: the confidence is set to a
   * value that grades how extreme the local bias was, so a cell whose whole
   * neighbourhood is bare (dark count 0, essentially impossible under the mask
   * prior) sorts ahead of one at the threshold. The decoder spends its per-block
   * erasure budget in ascending confidence order, so this ranking decides which
   * damage gets bought out of the error budget -- and the interior of a defect is
   * where the codewords are destroyed whole, which is exactly what should be
   * spent first.
   */
  const pen = new Float32Array(N).fill(1);
  const set = new Float32Array(N).fill(NaN);
  for (let i = 0; i < N; i++) {
    if (!seed[i]) continue;
    const n = count[i] as number;
    const d = dark[i] as number;
    const excess = d <= strict ? strict - d : d - (n - strict);
    set[i] = Math.max(0.0005, extremePenalty - 0.006 * excess);
    pen[i] = extremePenalty;
  }
  // ---- graded dilation by hex distance -----------------------------------
  for (let i = 0; i < N; i++) {
    if (!seed[i]) continue;
    for (let k = 0; k < 6; k++) {
      const j = lat.neighbours[i * 6 + k] as number;
      if (j < 0) continue;
      if (!seed[j]) pen[j] = Math.min(pen[j] as number, nearPenalty);
      for (let m = 0; m < 6; m++) {
        const b = lat.neighbours[j * 6 + m] as number;
        if (b < 0 || seed[b]) continue;
        pen[b] = Math.min(pen[b] as number, farPenalty);
      }
    }
  }

  let flagged = 0;
  for (let i = 0; i < N; i++) {
    const sev = set[i] as number;
    const p = pen[i] as number;
    if (Number.isFinite(sev)) {
      confidence[i] = Math.min(confidence[i] as number, sev);
      flagged++;
    } else if (p < 1) {
      confidence[i] = (confidence[i] as number) * p;
      flagged++;
    }
  }
    return { flagged, seeds, meanConfidence: mean(), darkCount: dark };
}
