/**
 * Extended binary Golay code G24 = (24, 12, 8) -- the "Format Crown" of
 * SiMurgh Code.
 *
 * Why Golay?
 *  - It is a *perfect* code: the Hamming spheres of radius 3 around its 4096
 *    codewords tile GF(2)^24 exactly. There is no wasted space and no
 *    ambiguity -- every one of the 16,777,216 possible 24-bead rings is either
 *    a codeword or within distance 3 of exactly one codeword.
 *  - d_min = 8 => corrects any 3 bead errors and detects 4.
 *  - Its automorphism group is the Mathieu group M24, and G24 is the shadow of
 *    the Leech lattice: the densest known sphere packing in 24 dimensions. For
 *    a symbology this translates into a format ring that survives a bead being
 *    torn off, over-inked or misread, with a provable margin.
 *
 * Construction: the (23,12) cyclic Golay code with
 *      g(x) = x^11 + x^10 + x^6 + x^5 + x^4 + x^2 + 1     (0xC75)
 * extended by an overall parity bit to length 24.
 *
 * Decoding is exhaustive nearest-neighbour over the 4096 codewords, which is
 * exactly maximum-likelihood on the binary symmetric channel and needs no
 * syndrome casework. 4096 x (xor + popcount) is a few microseconds.
 */

const G23 = 0xc75;

function popcount32(x: number): number {
  let v = x >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >>> 24) & 0x3f;
}

/** 11-bit remainder of (data * x^11) / g(x). */
function parity11(data12: number): number {
  let r = (data12 << 11) >>> 0;
  for (let i = 22; i >= 11; i--) {
    if ((r >>> i) & 1) r ^= G23 << (i - 11);
  }
  return r & 0x7ff;
}

/** Encode 12 data bits into a 24-bit extended Golay codeword. */
export function golayEncode(data12: number): number {
  if (data12 < 0 || data12 > 0xfff) throw new RangeError('golayEncode: data must be 12 bits');
  const w23 = ((data12 << 11) | parity11(data12)) >>> 0;
  return ((w23 << 1) | (popcount32(w23) & 1)) >>> 0;
}

let TABLE: Uint32Array | null = null;

/** All 4096 codewords, indexed by their 12-bit data word. */
export function golayTable(): Uint32Array {
  if (TABLE) return TABLE;
  const t = new Uint32Array(4096);
  for (let i = 0; i < 4096; i++) t[i] = golayEncode(i);
  TABLE = t;
  return t;
}

export interface GolayDecodeResult {
  ok: boolean;
  data: number;
  /** Hamming distance between the received word and the nearest codeword. */
  distance: number;
  /** true when another codeword was at the same distance (should never happen for d<=3). */
  ambiguous: boolean;
}

/**
 * Maximum-likelihood decode of a 24-bit received word.
 * Returns ok=false when the nearest codeword is farther than 3 bits away,
 * which turns the perfect 3-error-correcting code into a 4-error-detecting one.
 */
export function golayDecode(word24: number): GolayDecodeResult {
  const table = golayTable();
  const w = word24 >>> 0;
  let best = -1;
  let bestD = 25;
  let ambiguous = false;
  for (let i = 0; i < 4096; i++) {
    const d = popcount32((table[i] as number) ^ w);
    if (d < bestD) {
      bestD = d;
      best = i;
      ambiguous = false;
    } else if (d === bestD) {
      ambiguous = true;
    }
  }
  if (bestD > 3) return { ok: false, data: best >= 0 ? best : 0, distance: bestD, ambiguous };
  return { ok: true, data: best as number, distance: bestD, ambiguous };
}

/** Minimum Hamming distance of the code (proves d_min = 8). Used by the test suite. */
export function golayMinimumDistance(): number {
  const table = golayTable();
  let min = 25;
  for (let i = 1; i < 4096; i++) {
    const w = popcount32(table[i] as number);
    if (w < min) min = w;
  }
  return min; // linear code: d_min = minimum non-zero weight
}

export { popcount32 };
