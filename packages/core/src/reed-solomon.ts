/**
 * Reed-Solomon codec over GF(256) with combined erasure + error correction.
 *
 * Used by SiMurgh Code to protect the payload. Design notes:
 *
 *  - Systematic encoding: parity = remainder of (data * x^nK) / g(x), with
 *    g(x) = (x - a^0)(x - a^1)...(x - a^(nK-1))  (first consecutive root = 0).
 *
 *  - Decoding does NOT use Forney's algorithm. Instead, once the *positions*
 *    of all errors and erasures are known, the magnitudes are recovered by
 *    solving the syndrome Vandermonde system with GF(256) Gaussian
 *    elimination. The node values X_p are distinct powers of alpha, so the
 *    square submatrix is always invertible. This is a little slower than
 *    Forney but removes an entire class of sign/convention bugs and is
 *    trivially auditable.
 *
 *  - Erasures are handled by "pre-multiplying" the syndrome polynomial with
 *    the erasure locator sigma_e(x); plain Berlekamp-Massey is then run on the
 *    modified sequence, which yields the locator of the *unknown* errors only.
 *    A block with nu erasures and e errors is correctable iff nu + 2e <= nK.
 */
import { EXP, LOG, exp, inv, log, mul, polyMul, rsGeneratorPoly } from './gf256.js';

export interface RSDecodeResult {
  /** true when the block was recovered (or was already clean). */
  ok: boolean;
  /** Corrected codeword (data + parity). Only meaningful when ok is true. */
  corrected: Uint8Array;
  /** Number of unknown-error positions that were located and fixed. */
  errorsFixed: number;
  /** Number of erasure positions that were supplied and fixed. */
  erasuresFixed: number;
  /** Reason for failure, when ok is false. */
  reason?: string;
}

/** Evaluate a polynomial stored high-degree-first at x (Horner over GF(256)). */
export function polyEval(poly: Uint8Array | number[], x: number): number {
  let acc = 0;
  for (let i = 0; i < poly.length; i++) acc = mul(acc, x) ^ (poly[i] as number);
  return acc;
}

/** Compute the nK syndromes S_i = C(alpha^i), i = 0..nK-1. */
export function syndromes(codeword: Uint8Array, nK: number): Uint8Array {
  const s = new Uint8Array(nK);
  for (let i = 0; i < nK; i++) s[i] = polyEval(codeword, exp(i));
  return s;
}

/**
 * Systematic parity for `data` with `nK` parity symbols.
 */
export function rsParity(data: Uint8Array, nK: number): Uint8Array {
  const gen = rsGeneratorPoly(nK);
  const buf = new Uint8Array(data.length + nK);
  buf.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i] as number;
    if (coef === 0) continue;
    const lc = LOG[coef] as number;
    for (let j = 1; j < gen.length; j++) {
      const g = gen[j] as number;
      if (g === 0) continue;
      buf[i + j] = (buf[i + j] as number) ^ (EXP[lc + (LOG[g] as number)] as number);
    }
  }
  return buf.slice(data.length);
}

/** Full systematic codeword = data || parity. */
export function rsEncode(data: Uint8Array, nK: number): Uint8Array {
  const out = new Uint8Array(data.length + nK);
  out.set(data, 0);
  out.set(rsParity(data, nK), data.length);
  return out;
}

/** Multiply two polynomials stored low-degree-first. */
function polyMulLow(a: number[], b: number[]): number[] {
  const out = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) {
      if (b[j] === 0) continue;
      out[i + j] = (out[i + j] as number) ^ mul(a[i] as number, b[j] as number);
    }
  }
  return out;
}

/** Erasure locator sigma_e(x) = prod (1 - X_j x), low-degree-first. X_j = alpha^(n-1-pos). */
function erasureLocator(n: number, erasures: readonly number[]): number[] {
  let s = [1];
  for (const p of erasures) {
    const X = exp(n - 1 - p);
    s = polyMulLow(s, [1, X]);
  }
  return s;
}

/**
 * Plain Berlekamp-Massey over GF(256).
 * Input: sequence T[0..L-1] (low index = low power). Output: connection
 * polynomial C(x), low-degree-first, with C[0] = 1, such that the LFSR
 *   sum_{j=0..deg} C[j] * T[i-j] = 0
 * holds for all valid i.
 */
function berlekampMassey(T: number[]): number[] {
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let n = 0; n < T.length; n++) {
    // discrepancy
    let d = T[n] as number;
    for (let i = 1; i <= L; i++) {
      d ^= mul(C[i] ?? 0, T[n - i] as number);
    }
    if (d === 0) {
      m++;
      continue;
    }
    const Tm = C.slice();
    const scale = mul(d, inv(b));
    for (let i = 0; i < B.length; i++) {
      const idx = i + m;
      const v = mul(scale, B[i] as number);
      while (Tm.length <= idx) Tm.push(0);
      Tm[idx] = (Tm[idx] as number) ^ v;
    }
    if (2 * L <= n) {
      L = n + 1 - L;
      B = C.slice();
      b = d;
      m = 1;
    } else {
      m++;
    }
    C = Tm;
  }
  return C;
}

/** Chien search: returns the array positions p where sigma(X_p^-1) = 0. */
function chienSearch(sigma: number[], n: number): number[] {
  const positions: number[] = [];
  for (let p = 0; p < n; p++) {
    // X_p = alpha^(n-1-p); we need sigma(X_p^-1) = sigma(alpha^(p-n+1))
    const xInv = exp(p - (n - 1));
    let acc = 0;
    for (let j = 0; j < sigma.length; j++) {
      const c = sigma[j] as number;
      if (c === 0) continue;
      acc ^= j === 0 ? c : mul(c, exp((LOG[xInv] as number) * j));
    }
    if (acc === 0) positions.push(p);
  }
  return positions;
}

/** Solve sum_p e_p * X_p^i = S_i for the given positions using GF(256) elimination. */
function solveMagnitudes(S: Uint8Array, n: number, positions: number[]): Uint8Array | null {
  const m = positions.length;
  if (m === 0) return new Uint8Array(0);
  if (m > S.length) return null; // more unknowns than equations
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < m; i++) {
    const row: number[] = new Array(m);
    for (let j = 0; j < m; j++) {
      const X = exp(n - 1 - (positions[j] as number));
      row[j] = i === 0 ? 1 : exp((LOG[X] as number) * i);
    }
    A.push(row);
    b.push(S[i] as number);
  }
  // Gauss-Jordan
  for (let col = 0; col < m; col++) {
    let piv = -1;
    for (let r = col; r < m; r++) {
      if (A[r]![col] !== 0) {
        piv = r;
        break;
      }
    }
    if (piv < 0) return null;
    if (piv !== col) {
      const t = A[col]!;
      A[col] = A[piv]!;
      A[piv] = t;
      const tb = b[col]!;
      b[col] = b[piv]!;
      b[piv] = tb;
    }
    const ip = inv(A[col]![col] as number);
    for (let j = 0; j < m; j++) A[col]![j] = mul(A[col]![j] as number, ip);
    b[col] = mul(b[col] as number, ip);
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = A[r]![col] as number;
      if (f === 0) continue;
      for (let j = 0; j < m; j++) A[r]![j] = (A[r]![j] as number) ^ mul(f, A[col]![j] as number);
      b[r] = (b[r] as number) ^ mul(f, b[col] as number);
    }
  }
  return Uint8Array.from(b);
}

/**
 * Correct a systematic RS codeword.
 *
 * @param codeword  data || parity, length n
 * @param nK        number of parity symbols
 * @param erasures  array indices (0 = first data symbol) whose value is unknown
 */
export function rsDecode(codeword: Uint8Array, nK: number, erasures: readonly number[] = []): RSDecodeResult {
  const n = codeword.length;
  if (nK <= 0) return { ok: true, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: 0 };
  // X_p = alpha^(n-1-p) must be distinct for every position, which requires
  // n <= 255 in GF(256). Longer blocks are not a Reed-Solomon code.
  if (n > 255) throw new RangeError(`RS block length ${n} exceeds the GF(256) limit of 255`);
  const uniqErasures = Array.from(new Set(erasures.filter((p) => p >= 0 && p < n))).sort((a, b) => a - b);
  if (uniqErasures.length > nK) {
    return { ok: false, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: 0, reason: 'too many erasures' };
  }

  const S = syndromes(codeword, nK);
  let allZero = true;
  for (let i = 0; i < nK; i++) if (S[i] !== 0) { allZero = false; break; }

  if (allZero && uniqErasures.length === 0) {
    return { ok: true, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: 0 };
  }

  let sigma: number[];
  if (uniqErasures.length > 0) {
    const sigmaE = erasureLocator(n, uniqErasures);
    if (allZero) {
      // Only erasures, no other errors: the erasure locator alone explains the syndromes
      // (the erased symbols are the only unknowns).
      sigma = sigmaE;
    } else {
      /*
       * Syndrome modification.
       *
       *      T_i = sum_{j=0..nu} sigma_e[j] * S_{i-j},   i = nu .. nK-1
       *
       * Because  sum_j sigma_e[j] X^(nu-j) = prod_{q in erasures}(X - X_q),
       * every *known* erasure is annihilated, and T_i becomes a pure syndrome
       * sequence for the unknown errors alone:
       *
       *      T_i = sum_{p in U} e'_p X_p^i ,  e'_p = e_p X_p^-nu prod_q (X_p - X_q)
       *
       * The sequence has nK - nu terms, so Berlekamp-Massey recovers the
       * unknown-error locator whenever 2u <= nK - nu, i.e. nu + 2u <= nK.
       * Starting the convolution at i = nu (never earlier) is what makes the
       * erasure cancellation exact -- the truncated convolutions for i < nu
       * still contain erasure terms and would poison the LFSR.
       */
      const nu = uniqErasures.length;
      const T = new Array<number>(nK - nu);
      for (let i = nu; i < nK; i++) {
        let acc = 0;
        for (let j = 0; j < sigmaE.length; j++) {
          const sj = S[i - j] as number;
          if (sj === 0) continue;
          acc ^= mul(sigmaE[j] as number, sj);
        }
        T[i - nu] = acc;
      }
      const sigmaErr = berlekampMassey(T);
      sigma = polyMulLow(sigmaE, sigmaErr);
    }
  } else {
    sigma = berlekampMassey(Array.from(S));
  }

  const degree = sigma.length - 1;
  if (degree === 0) {
    // No locator found but syndromes are non-zero => uncorrectable
    return { ok: false, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: uniqErasures.length, reason: 'no error locator' };
  }
  if (degree > nK) {
    return { ok: false, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: uniqErasures.length, reason: 'locator degree exceeds parity' };
  }

  const positions = chienSearch(sigma, n);
  if (positions.length !== degree) {
    return {
      ok: false,
      corrected: codeword.slice(),
      errorsFixed: 0,
      erasuresFixed: uniqErasures.length,
      reason: `chien search found ${positions.length} of ${degree} roots`,
    };
  }

  const mags = solveMagnitudes(S, n, positions);
  if (!mags) {
    return { ok: false, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: uniqErasures.length, reason: 'singular magnitude system' };
  }

  const corrected = codeword.slice();
  const erasureSet = new Set(uniqErasures);
  let errorsFixed = 0;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i] as number;
    corrected[p] = (corrected[p] as number) ^ (mags[i] as number);
    if (!erasureSet.has(p)) errorsFixed++;
  }

  // Verify: recompute syndromes, they must all vanish.
  const S2 = syndromes(corrected, nK);
  for (let i = 0; i < nK; i++) {
    if (S2[i] !== 0) {
      return { ok: false, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: uniqErasures.length, reason: 'residual syndrome' };
    }
  }

  return { ok: true, corrected, errorsFixed, erasuresFixed: uniqErasures.length };
}
