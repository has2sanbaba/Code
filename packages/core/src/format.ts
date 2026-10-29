/**
 * ============================================================================
 *  SiMurgh Code -- THE FORMAT CROWN
 * ============================================================================
 *
 * The Crown is the border of a SiMurgh symbol. It is not decoration: every
 * element of it carries information or alignment, and none of it touches the
 * payload region.
 *
 *      +------------------------------------------------------------------+
 *      |  QUIET ZONE (2.5 p)                                              |
 *      |   +----------------------------------------------------------+   |
 *      |   | LIMBUS   solid dark annulus, r = K+4.70 .. K+5.00        |   |
 *      |   |   +--- BEAK: tooth 0 extended to touch the Limbus        |   |
 *      |   |   |  TEETH  Angle Track, r = K+3.10..K+4.10              |   |
 *      |   |   |          63 sectors x 5.714286 deg, order-6          |   |
 *      |   |   |          m-sequence from p(x) = x^6 + x + 1          |   |
 *      |   |   |    BEADS  24 format beads at r = K+2.20, 15 deg apart|   |
 *      |   |   |           one extended Golay(24,12) codeword         |   |
 *      |   |   |        HALO  solid dark annulus, r = K+0.90..K+1.20  |   |
 *      |   |   |           +--------------------------------------+   |   |
 *      |   |   |           | DATA FIELD, hex rings 3..K           |   |   |
 *      |   |   |           |   CORE rosette, hex rings 0..2       |   |   |
 *      |   |   |           +--------------------------------------+   |   |
 *      |   +----------------------------------------------------------+   |
 *      +------------------------------------------------------------------+
 *
 * What each part buys you:
 *
 *  LIMBUS + HALO  Two concentric circles whose radius ratio is fixed by the
 *                 version. Fitting them yields centre, scale and (via the
 *                 ellipse terms) the camera's affine distortion -- all before
 *                 a single payload bit is read.
 *
 *  TEETH          An m-sequence with two-level autocorrelation. Correlating a
 *                 sampled ring against it produces one peak of +63 and 62
 *                 side-lobes of -1, so the absolute rotation is recovered
 *                 even with ~40% of the ring missing. A single 6-tooth window
 *                 also decodes the angle directly, with no correlation at all.
 *
 *  BEAK           Tooth 0 grown outward until it meets the Limbus. A human can
 *                 see which way the symbol is oriented; a machine gets a cheap
 *                 second opinion that cross-checks the Angle Track.
 *
 *  BEADS          The format -- version, ECC level, data mask and compression
 *                 flag, 12 bits -- protected by the perfect extended Golay
 *                 code G24. d_min = 8: any 3 beads may be wrong and the format
 *                 is still exact; 4 wrong beads are detected rather than
 *                 silently misread.
 *
 *  CORE           A 19-cell hexagonal bullseye (dark centre, light ring, dark
 *                 ring). Redundant centre/scale anchor that survives total
 *                 loss of the Crown.
 */
import { golayDecode, golayEncode } from './golay.js';
import {
  BEADS,
  ECC_LEVELS,
  MAX_VERSION,
  MIN_VERSION,
  MASK_COUNT,
  packFormat,
  unpackFormat,
  type EccLevel,
  type FormatBits,
} from './geometry.js';

/** Encode the 12 format bits into the 24 printed beads (MSB = bead 0). */
export function encodeFormatCrown(fb: FormatBits): { word: number; beads: Uint8Array } {
  const word = golayEncode(packFormat(fb));
  const beads = new Uint8Array(BEADS);
  for (let i = 0; i < BEADS; i++) beads[i] = (word >>> (23 - i)) & 1;
  return { word, beads };
}

export interface FormatCrownDecode {
  ok: boolean;
  format: FormatBits | null;
  /** Hamming distance from the sampled ring to the nearest Golay codeword. */
  distance: number;
  word: number;
}

/** Decode 24 sampled beads back into the format. */
export function decodeFormatCrown(beads: ArrayLike<number>): FormatCrownDecode {
  let word = 0;
  for (let i = 0; i < BEADS; i++) word = (word << 1) | (beads[i] ? 1 : 0);
  const res = golayDecode(word >>> 0);
  if (!res.ok) return { ok: false, format: null, distance: res.distance, word: word >>> 0 };
  const f = unpackFormat(res.data);
  if (f.versionIndex > MAX_VERSION - MIN_VERSION) return { ok: false, format: null, distance: res.distance, word: word >>> 0 };
  return { ok: true, format: f, distance: res.distance, word: word >>> 0 };
}

export interface FormatCandidate {
  version: number;
  ecc: EccLevel;
  mask: number;
  compression: number;
  formatBits: number;
}

/**
 * Every legal format, ordered so that the most common configurations are tried
 * first. Used by the decoder when the Format Crown is destroyed beyond Golay's
 * correction radius: it then brute-forces (version x ecc x mask x compression)
 * and accepts the first combination whose payload CRC-32 matches -- a false
 * accept needs a 2^-32 coincidence.
 */
export function formatCandidates(versions: number[] = defaultVersionRange()): FormatCandidate[] {
  const out: FormatCandidate[] = [];
  for (const v of versions) {
    for (let e = 0; e < ECC_LEVELS.length; e++) {
      for (let mask = 0; mask < MASK_COUNT; mask++) {
        for (const compression of [0, 1]) {
          const formatBits = packFormat({ versionIndex: v - MIN_VERSION, ecc: e, mask, compression });
          out.push({ version: v, ecc: ECC_LEVELS[e] as EccLevel, mask, compression, formatBits });
        }
      }
    }
  }
  return out;
}

function defaultVersionRange(): number[] {
  const out: number[] = [];
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) out.push(v);
  return out;
}

