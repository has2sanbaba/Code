/**
 * ============================================================================
 *  SiMurgh Code (SMC) -- GEOMETRY
 * ============================================================================
 *
 *  The single most important design decision in SiMurgh Code is that it is
 *  NOT a square grid. It is a *radial* symbology built on a **triangular
 *  (hexagonal) lattice** and framed by a three-part border -- the Crown.
 *
 *  Why a triangular lattice?
 *   - Each module has 6 neighbours instead of 4, so an eroded or over-inked
 *     print run cannot grow a defect along a single row/column the way it does
 *     in a square matrix.
 *   - Cell area is sqrt(3)/2 * p^2 = 0.866 p^2 versus p^2 for a square lattice,
 *     i.e. ~15.5% more modules fit inside the same printed disc.
 *   - The lattice has no privileged axis, so the code is equally robust at any
 *     rotation. There is no "upside down" and no "90 degrees off" failure mode.
 *
 *  Why radial (concentric) framing?
 *   - A circle is the only shape whose silhouette is invariant under rotation,
 *     which makes detection trivially rotation-invariant: threshold, centroid,
 *     radial profile. No finder patterns to hunt for, no perspective-sensitive
 *     L-shaped timing edges.
 *   - The Crown carries alignment, format and rotation data *outside* the
 *     payload region, so the payload area is 100% data.
 *
 *  Radial band layout (all radii in module pitch units p, K = data ring count):
 *
 *      r = 0 .. K          HEXAGONAL LATTICE
 *                          d <= 2   -> Core rosette (fixed finder, 19 cells)
 *                          3 <= d <= K -> DATA FIELD (N cells)
 *      [K+0.90, K+1.20]    HALO     inner guard annulus (solid dark)
 *      r = K+2.20          BEADS    24 format beads, 15 deg apart,
 *                                   one extended Golay(24,12) codeword
 *      [K+3.10, K+4.10]    TEETH    Angle Track: 63 sectors of 5.714286 deg
 *                                   carrying an order-6 m-sequence
 *      tooth 0 -> K+4.70   BEAK     tooth 0 is radially extended until it
 *                                   touches the Limbus: a permanent,
 *                                   human-readable zero-angle marker
 *      [K+4.70, K+5.00]    LIMBUS   outer guard annulus (solid dark)
 *      [K+5.00, K+7.50]    QUIET    mandatory clear zone
 *
 *  The Halo and the Limbus are two concentric circles of *known* radius ratio.
 *  Fitting them gives centre + scale + (with the ellipse terms) the affine
 *  camera transform, without ever looking at the payload. The Teeth give the
 *  absolute rotation. The Beads give the format. The Core gives a redundant
 *  centre estimate that still works if the whole Crown is torn off.
 */

import { makeRng } from './crc.js';

/* ------------------------------------------------------------------ *
 *  Lattice constants
 * ------------------------------------------------------------------ */

/** Centre-to-centre distance between adjacent modules (the "pitch"), = 1 unit. */
export const PITCH = 1;
/** Area of one hexagonal cell in pitch units: sqrt(3)/2. */
export const CELL_AREA = Math.sqrt(3) / 2;
/** Circumradius of the hexagonal cell that tiles the lattice: 1/sqrt(3). */
export const CELL_CIRCUMRADIUS = 1 / Math.sqrt(3);
/** Rendered dot radius (dots are drawn slightly smaller than the cell). */
export const DOT_RADIUS = 0.46;

/** Rings 0..CORE_RADIUS are the fixed Core rosette. */
export const CORE_RADIUS = 2;
/** Cells in the Core rosette: 1 + 3*2*3 = 19. */
export const CORE_CELLS = 1 + 3 * CORE_RADIUS * (CORE_RADIUS + 1);

export const MIN_VERSION = 1;
export const MAX_VERSION = 40;

/** Outermost data ring index for a version. V1 -> 14, V40 -> 92. */
export function dataRings(version: number): number {
  if (version < MIN_VERSION || version > MAX_VERSION) throw new RangeError(`version ${version} out of range`);
  return 2 * version + 12;
}

/**
 * The Serpentine Spiral -- the order in which payload bits are written.
 *
 * Rings are walked alternately counter-clockwise and clockwise. Because ring d
 * ends at (d,-1) and ring d+1 walked backwards *starts* at (d+1,-1), and ring d
 * walked backwards ends at (d,0) while ring d+1 walked forwards starts at
 * (d+1,0), every consecutive pair of modules on the path is a lattice
 * neighbour. The whole payload is therefore one unbroken spiral of touching
 * modules growing out of the Core, like the growth rings of a tree.
 *
 * Why this beats scattering the bits (which was the first design):
 *   Reed-Solomon corrects P/2 wrong symbols or P erased symbols. A compact
 *   defect -- a hole punch, a coffee ring, a thumb over the lens -- covers f*N
 *   modules. If those modules are contiguous on the path they form f*C whole
 *   symbols, so damage stays at f*C symbols and is correctable up to
 *   f <= rho/2 (errors) or f <= rho (erasures). If instead the bits are
 *   scattered, the same f*N modules land in ~C(1-(1-f)^8) *different* symbols
 *   -- for f = 13% that is 67% of all symbols, three times worse. Spreading
 *   the bits spreads the damage into every codeword at once.
 *   Block interleaving is what protects against bursts; contiguity is what
 *   protects against holes. You want both, and only both.
 */
function buildSerpentine(K: number, ringOffset: Int32Array, N: number): { serpentine: Int32Array; spiralIndexOfCell: Int32Array } {
  const serpentine = new Int32Array(N);
  const spiralIndexOfCell = new Int32Array(N);
  let p = 0;
  for (let d = CORE_RADIUS + 1; d <= K; d++) {
    const base = ringOffset[d] as number;
    const len = 6 * d;
    const reverse = d % 2 === 0;
    for (let k = 0; k < len; k++) {
      const j = reverse ? len - 1 - k : k;
      const cell = base + j;
      serpentine[p] = cell;
      spiralIndexOfCell[cell] = p;
      p++;
    }
  }
  return { serpentine, spiralIndexOfCell };
}

function buildNeighbours(cells: Axial[], N: number): Int32Array {
  const key = new Map<number, number>();
  const pack = (q: number, r: number) => ((q + 1024) << 11) | (r + 1024);
  for (let i = 0; i < N; i++) key.set(pack(cells[i]!.q, cells[i]!.r), i);
  const out = new Int32Array(N * 6).fill(-1);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, -1],
    [-1, 1],
  ];
  for (let i = 0; i < N; i++) {
    const c = cells[i]!;
    for (let k = 0; k < 6; k++) {
      const d = dirs[k]!;
      const j = key.get(pack(c.q + d[0]!, c.r + d[1]!));
      out[i * 6 + k] = j === undefined ? -1 : j;
    }
  }
  return out;
}

/** Axial coordinate of a lattice cell. */
export interface Axial {
  q: number;
  r: number;
}

/** Hex distance from the origin. */
export function hexDistance(q: number, r: number): number {
  return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
}

/** Cartesian position of a lattice cell, in pitch units. Angle 0 is +x, CCW positive. */
export function axialToXY(q: number, r: number): { x: number; y: number } {
  return { x: q + r / 2, y: (Math.sqrt(3) / 2) * r };
}

export function xyToAngleDeg(x: number, y: number): number {
  const a = (Math.atan2(y, x) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}

/* ------------------------------------------------------------------ *
 *  Ring enumeration
 * ------------------------------------------------------------------ */

/**
 * The 6 cells of ring `d` at angles 0, 60, ..., 300 degrees, then the cells
 * between them. Ring traversal starts at (d, 0) and walks counter-clockwise,
 * so ring index j grows monotonically with polar angle.
 */
export function ringCell(d: number, j: number): Axial {
  const side = Math.floor(j / d);
  const k = j - side * d;
  const c = ringCellRaw(d, side, k);
  // normalise -0 so that axial keys and Object.is comparisons behave
  return { q: c.q + 0, r: c.r + 0 };
}

function ringCellRaw(d: number, side: number, k: number): Axial {
  switch (side) {
    case 0:
      return { q: d - k, r: k };
    case 1:
      return { q: -k, r: d };
    case 2:
      return { q: -d, r: d - k };
    case 3:
      return { q: -d + k, r: -k };
    case 4:
      return { q: k, r: -d };
    case 5:
      return { q: d, r: -d + k };
    default:
      throw new RangeError(`ring side ${side} out of range for ring ${d}`);
  }
}

/** Cumulative offset of each data ring inside the linearised cell array. */
function buildOffsets(K: number): Int32Array {
  const off = new Int32Array(K + 2);
  let acc = 0;
  for (let d = CORE_RADIUS + 1; d <= K; d++) {
    off[d] = acc;
    acc += 6 * d;
  }
  off[K + 1] = acc;
  return off;
}

export interface Lattice {
  /** Version this lattice belongs to. */
  version: number;
  /** Outermost data ring. */
  K: number;
  /** Number of data cells. */
  N: number;
  /** cells[i] = axial coordinate of linear cell i. */
  cells: Axial[];
  /** cellsXY[i] = pre-computed cartesian position (pitch units). */
  xy: Float64Array;
  /** angles[i] = polar angle in degrees, 0..360. */
  angles: Float64Array;
  /** dist[i] = hex ring index of cell i. */
  dist: Uint16Array;
  /** ringOffset[d] = linear index of the first cell of ring d. */
  ringOffset: Int32Array;
  /**
   * serpentine[i] = ring-order cell index of the i-th module along the
   * continuous outward spiral (the bit-stream path).
   */
  serpentine: Int32Array;
  /** Inverse of `serpentine`: cell index -> position on the spiral path. */
  spiralIndexOfCell: Int32Array;
  /** 6 neighbour cell indices per cell (-1 when the neighbour is outside the data field). */
  neighbours: Int32Array;
}

const latticeCache = new Map<number, Lattice>();

/** Build (and cache) the data-field lattice of a version. */
export function getLattice(version: number): Lattice {
  const cached = latticeCache.get(version);
  if (cached) return cached;
  const K = dataRings(version);
  const ringOffset = buildOffsets(K);
  const N = ringOffset[K + 1] as number;
  const cells: Axial[] = new Array(N);
  const xy = new Float64Array(2 * N);
  const angles = new Float64Array(N);
  const dist = new Uint16Array(N);
  for (let d = CORE_RADIUS + 1; d <= K; d++) {
    const base = ringOffset[d] as number;
    for (let j = 0; j < 6 * d; j++) {
      const c = ringCell(d, j);
      const i = base + j;
      cells[i] = c;
      const p = axialToXY(c.q, c.r);
      xy[2 * i] = p.x;
      xy[2 * i + 1] = p.y;
      angles[i] = xyToAngleDeg(p.x, p.y);
      dist[i] = d;
    }
  }
  const { serpentine, spiralIndexOfCell } = buildSerpentine(K, ringOffset, N);
  const neighbours = buildNeighbours(cells, N);
  const lat: Lattice = { version, K, N, cells, xy, angles, dist, ringOffset, serpentine, spiralIndexOfCell, neighbours };
  latticeCache.set(version, lat);
  return lat;
}

/** The 19 fixed Core rosette cells, ordered [centre, ring1 x6, ring2 x12]. */
export function coreCells(): { cell: Axial; dark: boolean; x: number; y: number }[] {
  const out: { cell: Axial; dark: boolean; x: number; y: number }[] = [];
  const push = (c: Axial, dark: boolean) => {
    const p = axialToXY(c.q, c.r);
    out.push({ cell: c, dark, x: p.x, y: p.y });
  };
  push({ q: 0, r: 0 }, true);
  // ring 1: light  -> the dark centre is visually isolated (a "pupil")
  for (let j = 0; j < 6; j++) push(ringCell(1, j), false);
  // ring 2: dark   -> together with the centre this is a hexagonal bullseye
  for (let j = 0; j < 12; j++) push(ringCell(2, j), true);
  return out;
}

/* ------------------------------------------------------------------ *
 *  Crown geometry
 * ------------------------------------------------------------------ */

export interface CrownGeometry {
  /** Inner guard annulus. */
  haloInner: number;
  haloOuter: number;
  haloRadius: number;
  /** Format bead centres. */
  beadRadius: number;
  beadSize: number;
  /** Angle track band. */
  teethInner: number;
  teethOuter: number;
  teethRadius: number;
  /** Outer guard annulus. */
  limbusInner: number;
  limbusOuter: number;
  limbusRadius: number;
  /** Beak: tooth 0 is extended out to this radius. */
  beakRadius: number;
  /** Overall ink radius. */
  outerRadius: number;
  /** Quiet zone width. */
  quietZone: number;
  /** Half-size of the square canvas the code is drawn into. */
  canvasRadius: number;
}

export function crown(K: number): CrownGeometry {
  // Every gap inside the Crown is at least 0.5 pitch wide so that the four
  // rings stay separable even at 3 pixels per module.
  const haloInner = K + 0.9;
  const haloOuter = K + 1.2;
  const teethInner = K + 3.1;
  const teethOuter = K + 4.1;
  const limbusInner = K + 4.7;
  const limbusOuter = K + 5.0;
  return {
    haloInner,
    haloOuter,
    haloRadius: (haloInner + haloOuter) / 2,
    beadRadius: K + 2.2,
    beadSize: 0.38,
    teethInner,
    teethOuter,
    teethRadius: (teethInner + teethOuter) / 2,
    limbusInner,
    limbusOuter,
    limbusRadius: (limbusInner + limbusOuter) / 2,
    beakRadius: limbusInner,
    outerRadius: limbusOuter,
    quietZone: 2.5,
    canvasRadius: limbusOuter + 2.5,
  };
}

export function geometry(version: number) {
  const K = dataRings(version);
  return { K, crown: crown(K), lattice: getLattice(version) };
}

/* ------------------------------------------------------------------ *
 *  Angle Track (Teeth)
 * ------------------------------------------------------------------ */

/**
 * Order-6 maximum-length sequence, generated by the primitive polynomial
 * x^6 + x + 1 over GF(2). See tools/derive-angle-track.mjs for the proof of:
 *   - every cyclic 6-window is distinct  (absolute rotation from 6 teeth)
 *   - weight exactly 32/63
 *   - Golomb run distribution
 *   - two-level autocorrelation: -1 for every non-zero shift
 */
export const ANGLE_TRACK: readonly number[] = Object.freeze([
  1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1,
  1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
]);

/** Number of teeth in the Angle Track. */
export const TEETH = 63;
/** Angular width of one tooth, degrees. */
export const TOOTH_DEG = 360 / TEETH;
/** Window length (in teeth) needed for an unambiguous absolute angle. */
export const TOOTH_WINDOW = 6;

/** Angle (degrees) of the centre of tooth `i`, with tooth 0 centred on 0 deg. */
export function toothAngle(i: number): number {
  return (((i % TEETH) + TEETH) % TEETH) * TOOTH_DEG;
}

let toothIndexByWindow: Int8Array | null = null;

/** Lookup table: 6-bit window -> tooth index of its first tooth, or -1. */
export function toothWindowTable(): Int8Array {
  if (toothIndexByWindow) return toothIndexByWindow;
  const t = new Int8Array(64).fill(-1);
  for (let i = 0; i < TEETH; i++) {
    let w = 0;
    for (let j = 0; j < TOOTH_WINDOW; j++) w = (w << 1) | (ANGLE_TRACK[(i + j) % TEETH] as number);
    t[w] = i;
  }
  toothIndexByWindow = t;
  return t;
}

/**
 * Decode an absolute tooth index from `TOOTH_WINDOW` consecutive sampled teeth
 * (oldest = at the smallest angle). Returns -1 when the window is not in the
 * m-sequence, which happens only if a tooth was misread.
 */
export function toothIndexFromWindow(bits: ArrayLike<number>): number {
  let w = 0;
  for (let j = 0; j < TOOTH_WINDOW; j++) w = (w << 1) | (bits[j] ? 1 : 0);
  return toothWindowTable()[w] as number;
}

/**
 * Cyclic autocorrelation of the Angle Track against a sampled ring.
 * Returns the best phase (tooth index at 0 deg) and its margin.
 *
 * Because the m-sequence has two-level autocorrelation, the correct phase
 * scores +63 while every wrong phase scores -1: an 18.4 dB peak with no
 * side-lobe ambiguity. This is the primary rotation estimator.
 */
export function correlateAngleTrack(sampled: ArrayLike<number>): { phase: number; score: number; margin: number } {
  let best = -Infinity;
  let bestPhase = 0;
  let second = -Infinity;
  const scores: number[] = [];
  for (let shift = 0; shift < TEETH; shift++) {
    let s = 0;
    for (let i = 0; i < TEETH; i++) {
      // sampled[i] is expected to be +1 (dark) or -1 (light)
      const ref = (ANGLE_TRACK[(i + shift) % TEETH] as number) === 1 ? 1 : -1;
      s += (sampled[i] as number) * ref;
    }
    scores.push(s);
    if (s > best) {
      best = s;
      bestPhase = shift;
    }
  }
  for (let i = 0; i < TEETH; i++) {
    if (i !== bestPhase && (scores[i] as number) > second) second = scores[i] as number;
  }
  // sampled[i] corresponds to angle i*TOOTH_DEG. A match at `shift` means
  // tooth `shift` sits at angle 0, i.e. the ring is rotated by -toothAngle(shift).
  return { phase: bestPhase, score: best, margin: best - second };
}

/* ------------------------------------------------------------------ *
 *  Format Crown (Beads) -- extended Golay(24,12)
 * ------------------------------------------------------------------ */

export const BEADS = 24;
export const BEAD_DEG = 360 / BEADS;

/** Bead `i` centre angle. Bead 0 is placed between tooth 0 and tooth 1. */
export function beadAngle(i: number): number {
  return (((i % BEADS) + BEADS) % BEADS) * BEAD_DEG + BEAD_DEG / 2;
}

export const ECC_LEVELS = ['L', 'M', 'Q', 'H'] as const;
export type EccLevel = (typeof ECC_LEVELS)[number];

/** Parity fraction of the total codeword budget, per ECC level. */
export const ECC_PARITY_FRACTION: Record<EccLevel, number> = { L: 0.16, M: 0.28, Q: 0.4, H: 0.55 };

/**
 * Payload compression codecs.
 *  0 = none (the `compressed` format bit is clear)
 *  1 = raw DEFLATE (RFC 1951)
 */
export const COMPRESSION_NONE = 0;
export const COMPRESSION_DEFLATE = 1;

/** The 12 information bits carried by the Format Crown. */
export interface FormatBits {
  /** 0..39 -> version 1..40 */
  versionIndex: number;
  /** 0..3 -> L, M, Q, H */
  ecc: number;
  /** 0..7 */
  mask: number;
  /** 0 = raw, 1 = deflate */
  compression: number;
}

export function packFormat(f: FormatBits): number {
  return ((f.versionIndex & 0x3f) << 6) | ((f.ecc & 0x3) << 4) | ((f.mask & 0x7) << 1) | (f.compression & 0x1);
}

export function unpackFormat(v: number): FormatBits {
  return {
    versionIndex: (v >>> 6) & 0x3f,
    ecc: (v >>> 4) & 0x3,
    mask: (v >>> 1) & 0x7,
    compression: v & 0x1,
  };
}

/* ------------------------------------------------------------------ *
 *  Placement permutation
 * ------------------------------------------------------------------ */

function gcd(a: number, b: number): number {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/**
 * The Scattering Stride.
 *
 * Bit i of the interleaved codeword stream is written into cell
 *     pi(i) = (i * S) mod N
 * with S chosen from the golden ratio so that consecutive bits land as far
 * apart as possible on the disc, and gcd(S, N) = 1 so pi is a bijection.
 *
 * Effect: a physical defect (scratch, hole, coffee stain) covers a *contiguous
 * arc* of cells, which under pi^-1 becomes an arithmetic progression spread
 * evenly over the whole bit stream. Instead of destroying one Reed-Solomon
 * block outright, the damage becomes a handful of erasures in every block, and
 * every block stays inside its correction radius.
 */
export function scatteringStride(N: number): number {
  const INV_PHI = 0.6180339887498949;
  let S = (2 * Math.floor(N * INV_PHI) + 1) % N;
  if (S < 1) S = 1;
  while (gcd(S, N) !== 1) S = (S + 2) % N || 1;
  return S;
}

/** Modular inverse of a mod m (m not necessarily prime) via the extended Euclid algorithm. */
export function modInverse(a: number, m: number): number {
  let [old_r, r] = [a % m, m];
  let [old_s, s] = [1, 0];
  while (r !== 0) {
    const q = Math.floor(old_r / r);
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1) throw new RangeError('not invertible');
  return ((old_s % m) + m) % m;
}

/* ------------------------------------------------------------------ *
 *  Data masks
 * ------------------------------------------------------------------ */

export const MASK_COUNT = 8;

function mix32(a: number, b: number, c: number, d: number): number {
  let h = 0x9e3779b9;
  h = Math.imul(h ^ (a + 0x165667b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (b + 0xc2b2ae35), 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h ^ (c + 0x2545f491), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (d + 0x9e3779b9), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const mod = (x: number, m: number) => ((x % m) + m) % m;

/**
 * Mask value (0/1) for a lattice cell. XORed into every data bit before
 * printing so the disc has no large uniform areas, no periodic structure that
 * could alias against the scanner's sampling grid, and an ink coverage close
 * to 50%.
 */
export function maskBit(maskId: number, q: number, r: number, version: number): number {
  switch (maskId) {
    case 0:
      return mod(q, 3) === 0 ? 1 : 0;
    case 1:
      return mod(r, 3) === 0 ? 1 : 0;
    case 2:
      return mod(q + r, 3) === 0 ? 1 : 0;
    case 3:
      return mod(q - r, 2) === 0 ? 1 : 0;
    case 4:
      return mod(hexDistance(q, r), 2) === 0 ? 1 : 0;
    case 5:
      return mod(q * q + 3 * r, 5) < 2 ? 1 : 0;
    case 6:
      return mix32(q, r, version, 6) & 1;
    case 7:
      return mix32(q * 7 + 3, r * 11 + 5, version * 13 + 1, 7) & 1;
    default:
      throw new RangeError(`unknown mask ${maskId}`);
  }
}

/** Pre-computed mask array for a version/mask pair (length N). */
export function maskArray(version: number, maskId: number): Uint8Array {
  const lat = getLattice(version);
  const out = new Uint8Array(lat.N);
  for (let i = 0; i < lat.N; i++) {
    const c = lat.cells[i] as { q: number; r: number };
    out[i] = maskBit(maskId, c.q, c.r, version);
  }
  return out;
}

/**
 * Printability penalty of a masked data field. Lower is better.
 *  - P1: deviation of ink coverage from 50%
 *  - P2: fraction of neighbouring cell pairs that share a colour (blobs)
 *  - P3: longest monochrome arc inside any single ring
 */
export function maskPenalty(version: number, maskId: number, bits: Uint8Array): number {
  const lat = getLattice(version);
  const N = lat.N;
  const v = new Uint8Array(N);
  for (let i = 0; i < N; i++) v[i] = bits[i]! ^ maskBit(maskId, lat.cells[i]!.q, lat.cells[i]!.r, version);

  let dark = 0;
  for (let i = 0; i < N; i++) dark += v[i] as number;
  const p1 = Math.abs(dark / N - 0.5) * 2000;

  // neighbour pairs: for each cell, its +q and +r neighbours (covers every edge once)
  const key = new Map<number, number>();
  for (let i = 0; i < N; i++) key.set(((lat.cells[i]!.q + 512) << 10) | (lat.cells[i]!.r + 512), i);
  let same = 0;
  let pairs = 0;
  for (let i = 0; i < N; i++) {
    const c = lat.cells[i]!;
    for (const nb of [
      { q: c.q + 1, r: c.r },
      { q: c.q, r: c.r + 1 },
      { q: c.q + 1, r: c.r - 1 },
    ]) {
      const j = key.get(((nb.q + 512) << 10) | (nb.r + 512));
      if (j === undefined) continue;
      pairs++;
      if (v[i] === v[j]) same++;
    }
  }
  const p2 = (same / Math.max(1, pairs)) * 1200;

  let worstRun = 0;
  for (let d = CORE_RADIUS + 1; d <= lat.K; d++) {
    const base = lat.ringOffset[d] as number;
    const len = 6 * d;
    let run = 1;
    for (let j = 1; j <= len; j++) {
      const a = v[base + ((j - 1) % len)] as number;
      const b = v[base + (j % len)] as number;
      if (a === b) run++;
      else {
        if (run > worstRun) worstRun = run;
        run = 1;
      }
    }
    if (run > worstRun) worstRun = run;
  }
  const p3 = Math.max(0, worstRun - 6) * 40;

  return p1 + p2 + p3;
}

/** Pick the best mask for a given (already ECC-encoded, interleaved) bit stream. */
export function bestMask(version: number, bits: Uint8Array): { mask: number; penalty: number; scores: number[] } {
  const scores: number[] = [];
  let best = 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < MASK_COUNT; m++) {
    const p = maskPenalty(version, m, bits);
    scores.push(p);
    if (p < bestPenalty) {
      bestPenalty = p;
      best = m;
    }
  }
  return { mask: best, penalty: bestPenalty, scores };
}

/** Deterministic sanity noise source used by the reference test harness. */
export function latticeRng(seed: number): () => number {
  return makeRng(seed);
}

/* ------------------------------------------------------------------ *
 *  Point -> cell lookup
 * ------------------------------------------------------------------ */

/** Fractional axial coordinates of a point given in pitch units. */
export function xyToAxialF(x: number, y: number): { q: number; r: number } {
  const r = (2 * y) / Math.sqrt(3);
  return { q: x - r / 2, r };
}

/** Round fractional axial coordinates to the nearest lattice cell. */
export function axialRound(q: number, r: number): Axial {
  const x = q;
  const z = r;
  const y = -x - z;
  let rx = Math.round(x);
  let ry = Math.round(y);
  let rz = Math.round(z);
  const dx = Math.abs(rx - x);
  const dy = Math.abs(ry - y);
  const dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  // normalise -0 so callers can compare with Object.is / toBe
  return { q: rx + 0, r: rz + 0 };
}

/**
 * Index of a cell inside its ring (0 .. 6d-1), using the enumeration defined by
 * {@link ringCell}: start at (d, 0), walk counter-clockwise.
 */
export function ringIndexOf(q: number, r: number, d: number): number {
  if (q + r === d && r >= 0 && r < d) return r; // side 0
  if (r === d && q <= 0 && q > -d) return d - q; // side 1
  if (q === -d && r > 0 && r <= d) return 3 * d - r; // side 2
  if (q + r === -d && q >= -d) return 3 * d - r; // side 3
  if (r === -d && q >= 0 && q < d) return 4 * d + q; // side 4
  if (q === d && r < 0) return 6 * d + r; // side 5
  throw new RangeError(`cell (${q},${r}) is not on ring ${d}`);
}

/** True when the fixed Core rosette paints this cell dark (hex distance <= 2). */
export function coreIsDark(d: number): boolean {
  return d !== 1; // centre dark, ring 1 light, ring 2 dark
}
