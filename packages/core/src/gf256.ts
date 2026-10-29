/**
 * GF(2^8) arithmetic for SiMurgh Code.
 *
 * Field: GF(256) with the primitive polynomial
 *
 *      p(x) = x^8 + x^4 + x^3 + x^2 + 1        (0x11D)
 *
 * and primitive element alpha = 2. This is the same field used by QR Code,
 * Data Matrix and CCSDS, which means the log/antilog tables below are the
 * canonical ones and can be cross-checked against any published table.
 *
 * All operations are branch-free table lookups; the tables are built once.
 */

export const GF_SIZE = 256;
export const GF_PRIMITIVE_POLY = 0x11d;
export const GF_GENERATOR = 2;

/** exp[i] = alpha^i for i in [0, 512) -- doubled to avoid modulo in hot loops. */
export const EXP = new Uint8Array(512);
/** log[a] = i such that alpha^i = a, for a in [1, 256). log[0] is unused. */
export const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_PRIMITIVE_POLY;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
}

export function exp(a: number): number {
  return EXP[((a % 255) + 255) % 255] as number;
}

export function log(a: number): number {
  if (a === 0) throw new RangeError('log(0) is undefined in GF(256)');
  return LOG[a] as number;
}

export function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

export function div(a: number, b: number): number {
  if (b === 0) throw new RangeError('division by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[(LOG[a] as number) + 255 - (LOG[b] as number)] as number;
}

/** a^n in GF(256). */
export function pow(a: number, n: number): number {
  if (a === 0) return n === 0 ? 1 : 0;
  return EXP[((LOG[a] as number) * n) % 255] as number;
}

export function inv(a: number): number {
  if (a === 0) throw new RangeError('zero has no inverse in GF(256)');
  return EXP[255 - (LOG[a] as number)] as number;
}

/** Multiply two polynomials over GF(256); coefficients are ordered high degree first. */
export function polyMul(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0 || b.length === 0) return new Uint8Array(0);
  const out = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    if (ai === 0) continue;
    const lai = LOG[ai] as number;
    for (let j = 0; j < b.length; j++) {
      const bj = b[j] as number;
      if (bj === 0) continue;
      out[i + j] = (out[i + j] as number) ^ (EXP[lai + (LOG[bj] as number)] as number);
    }
  }
  return out;
}

/**
 * Reed-Solomon generator polynomial for `nK` parity symbols:
 *   g(x) = (x - alpha^0)(x - alpha^1)...(x - alpha^(nK-1))
 * Returned high-degree-first, length nK + 1, monic.
 */
export function rsGeneratorPoly(nK: number): Uint8Array {
  let g: Uint8Array = Uint8Array.from([1]);
  for (let i = 0; i < nK; i++) {
    g = polyMul(g, Uint8Array.from([1, exp(i)]));
  }
  return g;
}

/** In-place GF(256) Gaussian elimination inverse of an n x n matrix. Returns null if singular. */
export function invertMatrixGF256(m: number[][], n: number): number[][] | null {
  // Build augmented matrix.
  const a: number[][] = m.map((row, i) => {
    const r = row.slice(0, n);
    for (let j = 0; j < n; j++) r.push(i === j ? 1 : 0);
    return r;
  });
  for (let col = 0; col < n; col++) {
    let piv = -1;
    for (let r = col; r < n; r++) {
      if (a[r]![col] !== 0) {
        piv = r;
        break;
      }
    }
    if (piv < 0) return null;
    if (piv !== col) {
      const t = a[col]!;
      a[col] = a[piv]!;
      a[piv] = t;
    }
    const invPiv = inv(a[col]![col] as number);
    const rowC = a[col]!;
    for (let j = 0; j < 2 * n; j++) rowC[j] = mul(rowC[j] as number, invPiv);
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col] as number;
      if (f === 0) continue;
      const rowR = a[r]!;
      for (let j = 0; j < 2 * n; j++) rowR[j] = (rowR[j] as number) ^ mul(f, rowC[j] as number);
    }
  }
  return a.map((row) => row.slice(n));
}
