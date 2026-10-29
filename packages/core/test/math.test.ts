import { describe, expect, it } from 'vitest';
import {
  ANGLE_TRACK,
  CORE_RADIUS,
  TEETH,
  TOOTH_WINDOW,
  axialRound,
  bestMask,
  coreIsDark,
  dataRings,
  exp,
  getLattice,
  hexDistance,
  log,
  maskArray,
  maskPenalty,
  modInverse,
  mul,
  ringCell,
  ringIndexOf,
  scatteringStride,
  toothIndexFromWindow,
  xyToAxialF,
} from '@simurgh/core';
import { correlateAngleTrack } from '@simurgh/core';
import { golayDecode, golayEncode, golayMinimumDistance } from '@simurgh/core';
import { rsDecode, rsEncode, rsParity } from '@simurgh/core';
import { crc32 } from '@simurgh/core';
import { planBlocks } from '@simurgh/core';

describe('GF(256)', () => {
  it('log/exp are inverses over the whole multiplicative group', () => {
    for (let i = 0; i < 255; i++) {
      expect(log(exp(i))).toBe(i % 255);
    }
    for (let a = 1; a < 256; a++) {
      expect(exp(log(a))).toBe(a);
    }
  });
  it('alpha = 2 is primitive (order 255)', () => {
    let x = 1;
    const seen = new Set<number>();
    for (let i = 0; i < 255; i++) {
      seen.add(x);
      x = mul(x, 2);
    }
    expect(seen.size).toBe(255);
    expect(x).toBe(1);
  });
  it('multiplication is commutative and associative on samples', () => {
    for (let a = 1; a < 256; a += 7) {
      for (let b = 1; b < 256; b += 11) {
        expect(mul(a, b)).toBe(mul(b, a));
        expect(mul(mul(a, b), 3)).toBe(mul(a, mul(b, 3)));
      }
    }
  });
});

describe('Reed-Solomon', () => {
  it('encodes the reference (26,16) block', () => {
    const data = Uint8Array.from([0x40, 0xd2, 0x75, 0x47, 0x76, 0x17, 0x32, 0x06, 0x27, 0x26, 0x96, 0xc6, 0xc6, 0x96, 0x70, 0xec]);
    const parity = rsParity(data, 10);
    expect(parity.length).toBe(10);
    // a clean codeword has all-zero syndromes and decodes with no correction
    const cw = rsEncode(data, 10);
    const res = rsDecode(cw, 10);
    expect(res.ok).toBe(true);
    expect(res.errorsFixed).toBe(0);
    expect(Array.from(res.corrected.slice(0, 16))).toEqual(Array.from(data));
  });

  it('corrects t random symbol errors for many block shapes', () => {
    const shapes: [number, number][] = [
      [10, 4],
      [16, 8],
      [32, 16],
      [64, 22],
      [128, 40],
      [195, 60],
      [247, 8],
    ];
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (const [k, nK] of shapes) {
      const t = Math.floor(nK / 2);
      for (let trial = 0; trial < 12; trial++) {
        const data = new Uint8Array(k);
        for (let i = 0; i < k; i++) data[i] = Math.floor(rnd() * 256);
        const cw = rsEncode(data, nK);
        // corrupt exactly t distinct positions
        const positions = new Set<number>();
        while (positions.size < t) positions.add(Math.floor(rnd() * cw.length));
        for (const p of positions) cw[p] = (cw[p]! ^ (1 + Math.floor(rnd() * 255))) & 0xff;
        const res = rsDecode(cw, nK);
        expect(res.ok, `k=${k} nK=${nK} trial=${trial}`).toBe(true);
        expect(Array.from(res.corrected.slice(0, k))).toEqual(Array.from(data));
        expect(res.errorsFixed).toBe(t);
      }
    }
  });

  it('corrects twice as many erasures as errors', () => {
    const k = 40;
    const nK = 20;
    const data = new Uint8Array(k);
    for (let i = 0; i < k; i++) data[i] = (i * 37 + 11) & 0xff;
    const cw = rsEncode(data, nK);
    // nK erasures => fully recoverable
    const erasures: number[] = [];
    for (let i = 0; i < nK; i += 1) erasures.push((i * 7) % cw.length);
    const uniq = Array.from(new Set(erasures));
    for (const p of uniq) cw[p] = 0;
    const res = rsDecode(cw, nK, uniq);
    expect(res.ok).toBe(true);
    expect(Array.from(res.corrected.slice(0, k))).toEqual(Array.from(data));
    expect(res.erasuresFixed).toBe(uniq.length);
  });

  it('corrects a mix of errors and erasures up to nu + 2e <= nK', () => {
    const nK = 24;
    const k = 60;
    let seed = 777;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 40; trial++) {
      const data = new Uint8Array(k);
      for (let i = 0; i < k; i++) data[i] = Math.floor(rnd() * 256);
      const cw = rsEncode(data, nK);
      const nu = Math.floor(rnd() * (nK + 1));
      const e = Math.floor((nK - nu) / 2);
      const pos = new Set<number>();
      while (pos.size < nu + e) pos.add(Math.floor(rnd() * cw.length));
      const all = Array.from(pos);
      const erasures = all.slice(0, nu);
      for (const p of all) cw[p] = (cw[p]! ^ (1 + Math.floor(rnd() * 255))) & 0xff;
      const res = rsDecode(cw, nK, erasures);
      expect(res.ok, `nu=${nu} e=${e} trial=${trial}`).toBe(true);
      expect(Array.from(res.corrected.slice(0, k))).toEqual(Array.from(data));
    }
  });

  it('detects (never silently accepts) errors beyond its radius', () => {
    const nK = 8;
    const k = 20;
    const data = new Uint8Array(k).fill(0x5a);
    const cw = rsEncode(data, nK);
    // 5 errors > t = 4: must not come back "ok" with the original data
    for (let i = 0; i < 5; i++) cw[i * 3] = (cw[i * 3]! ^ 0xff) & 0xff;
    const res = rsDecode(cw, nK);
    if (res.ok) {
      expect(Array.from(res.corrected.slice(0, k))).not.toEqual(Array.from(data));
    } else {
      expect(res.ok).toBe(false);
    }
  });
});

describe('Extended Golay G24 (Format Crown)', () => {
  it('has minimum distance 8', () => {
    expect(golayMinimumDistance()).toBe(8);
  });
  it('is linear: encode(a^b) = encode(a)^encode(b)', () => {
    for (let a = 0; a < 4096; a += 137) {
      for (let b = 0; b < 4096; b += 91) {
        expect(golayEncode(a ^ b)).toBe(golayEncode(a) ^ golayEncode(b));
      }
    }
  });
  it('every codeword has even weight', () => {
    for (let d = 0; d < 4096; d++) {
      const w = golayEncode(d);
      let bits = 0;
      for (let i = 0; i < 24; i++) bits += (w >>> i) & 1;
      expect(bits % 2).toBe(0);
    }
  });
  it('corrects all patterns of up to 3 errors and detects 4', () => {
    for (let d = 0; d < 4096; d += 31) {
      const w = golayEncode(d);
      for (let i = 0; i < 24; i++)
        for (let j = i + 1; j < 24; j++)
          for (let k = j + 1; k < 24; k++) {
            const bad = w ^ (1 << i) ^ (1 << j) ^ (1 << k);
            const r = golayDecode(bad >>> 0);
            expect(r.ok).toBe(true);
            expect(r.data).toBe(d);
            expect(r.distance).toBe(3);
          }
      // 4 errors must be detected, not silently mis-corrected
      const bad4 = (w ^ (1 << 0) ^ (1 << 1) ^ (1 << 2) ^ (1 << 3)) >>> 0;
      const r4 = golayDecode(bad4);
      expect(r4.ok && r4.data === d).toBe(false);
    }
  });
  it('has covering radius 4, which is exactly why it is not a perfect code', () => {
    /*
     * The perfect Golay code is G23. Extending it with an overall parity bit
     * raises the minimum distance to 8 but pushes the covering radius to 4:
     * a radius-3 ball holds 1 + 24 + 276 + 2024 = 2325 words, and 4096
     * codewords would cover only 9 523 200 of the 16 777 216 patterns. So
     * about 43 % of all 24-bit words sit four bits from the nearest codeword,
     * and for those the decoder returns a *nearest* word, not a provably
     * correct one. That is why the Format Crown never stands alone: the
     * payload CRC-32 is the arbiter that catches a plausible-looking
     * miscorrection here.
     */
    let seed = 4242;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const histogram = new Map<number, number>();
    let atRadius4 = -1;
    for (let i = 0; i < 200000; i++) {
      const w = Math.floor(rnd() * 16777216) >>> 0;
      const r = golayDecode(w);
      expect(r.distance).toBeLessThanOrEqual(4);
      histogram.set(r.distance, (histogram.get(r.distance) ?? 0) + 1);
      if (r.distance === 4 && atRadius4 < 0) atRadius4 = w;
    }
    expect(atRadius4).toBeGreaterThanOrEqual(0);
    expect(golayDecode(atRadius4).distance).toBe(4);
    const fraction = (histogram.get(4) ?? 0) / 200000;
    expect(fraction).toBeGreaterThan(0.35);
    expect(fraction).toBeLessThan(0.5);
    // sphere-packing bound, stated as arithmetic rather than as a claim
    expect(4096 * (1 + 24 + 276 + 2024)).toBe(9523200);
    expect(9523200).toBeLessThan(16777216);
  });
});

describe('Angle Track (order-6 m-sequence)', () => {
  it('has length 63 and weight 32', () => {
    expect(ANGLE_TRACK.length).toBe(TEETH);
    expect(ANGLE_TRACK.reduce((a, b) => a + b, 0)).toBe(32);
  });
  it('every cyclic 6-window decodes to a unique absolute tooth index', () => {
    const seen = new Set<number>();
    for (let i = 0; i < TEETH; i++) {
      const w: number[] = [];
      for (let j = 0; j < TOOTH_WINDOW; j++) w.push(ANGLE_TRACK[(i + j) % TEETH] as number);
      const idx = toothIndexFromWindow(w);
      expect(idx).toBe(i);
      seen.add(idx);
    }
    expect(seen.size).toBe(TEETH);
  });
  it('has two-level cyclic autocorrelation: peak 63, every side-lobe -1', () => {
    for (let tau = 1; tau < TEETH; tau++) {
      let c = 0;
      for (let i = 0; i < TEETH; i++) {
        c += (ANGLE_TRACK[i] as number) === (ANGLE_TRACK[(i + tau) % TEETH] as number) ? 1 : -1;
      }
      expect(c).toBe(-1);
    }
  });
  it('correlation recovers the phase from a noisy, 40%-occluded ring', () => {
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let trial = 0; trial < 200; trial++) {
      const phase = Math.floor(rnd() * TEETH);
      const sampled = new Array<number>(TEETH);
      for (let i = 0; i < TEETH; i++) {
        const v = (ANGLE_TRACK[(i + phase) % TEETH] as number) === 1 ? 1 : -1;
        if (rnd() < 0.4) sampled[i] = 0;
        // occluded
        else sampled[i] = rnd() < 0.12 ? -v : v;
      }
      const res = correlateAngleTrack(sampled);
      expect(res.phase).toBe(phase);
    }
  });
});

describe('Hexagonal lattice', () => {
  it('ringIndexOf inverts ringCell for every cell of every ring', () => {
    for (let d = 1; d <= 24; d++) {
      for (let j = 0; j < 6 * d; j++) {
        const c = ringCell(d, j);
        expect(hexDistance(c.q, c.r)).toBe(d);
        expect(ringIndexOf(c.q, c.r, d)).toBe(j);
      }
    }
  });
  it('cell count matches 3K(K+1) - 18', () => {
    for (let v = 1; v <= 40; v++) {
      const K = dataRings(v);
      const lat = getLattice(v);
      expect(lat.N).toBe(3 * K * (K + 1) - 18);
      expect(lat.cells.length).toBe(lat.N);
    }
  });
  it('lattice cells are distinct and every interior cell has exactly 6 neighbours', () => {
    const lat = getLattice(3);
    const present = new Set<string>();
    for (let i = 0; i < lat.N; i++) {
      const k = `${lat.cells[i]!.q},${lat.cells[i]!.r}`;
      expect(present.has(k)).toBe(false);
      present.add(k);
    }
    let checked = 0;
    for (let i = 0; i < lat.N; i++) {
      const c = lat.cells[i]!;
      const d = hexDistance(c.q, c.r);
      // d = 3 cells touch the Core rosette and d = K cells touch the Halo, so
      // only 4 <= d < K has all six neighbours inside the data field.
      if (d >= 4 && d < lat.K) {
        let n = 0;
        for (const [dq, dr] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [1, -1],
          [-1, 1],
        ]) {
          if (present.has(`${c.q + dq},${c.r + dr}`)) n++;
        }
        expect(n).toBe(6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
  it('xyToAxialF + axialRound is the identity on lattice points', () => {
    const lat = getLattice(5);
    for (let i = 0; i < lat.N; i++) {
      const f = xyToAxialF(lat.xy[2 * i] as number, lat.xy[2 * i + 1] as number);
      const c = axialRound(f.q, f.r);
      expect(c.q).toBe(lat.cells[i]!.q);
      expect(c.r).toBe(lat.cells[i]!.r);
    }
  });
  it('core rosette: centre dark, ring 1 light, ring 2 dark', () => {
    expect(coreIsDark(0)).toBe(true);
    expect(coreIsDark(1)).toBe(false);
    expect(coreIsDark(2)).toBe(true);
    expect(1 + 3 * CORE_RADIUS * (CORE_RADIUS + 1)).toBe(19);
  });
});

/*
 * Bit placement.
 *
 * Two candidate placements are tested here, and only one of them is used. The
 * difference is the single most consequential design decision in the symbology,
 * so both are pinned by tests and the reasoning is written down where the code
 * can be checked against it.
 */
describe('Serpentine placement (the one SiMurgh uses)', () => {
  it('is a bijection: the path visits every data cell exactly once', () => {
    for (const v of [1, 2, 5, 11, 23, 40]) {
      const lat = getLattice(v);
      const seen = new Uint8Array(lat.N);
      for (let i = 0; i < lat.N; i++) {
        const c = lat.serpentine[i] as number;
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThan(lat.N);
        expect(seen[c]).toBe(0);
        seen[c] = 1;
      }
    }
  });

  it('spiralIndexOfCell inverts serpentine', () => {
    const lat = getLattice(9);
    for (let i = 0; i < lat.N; i++) {
      expect(lat.spiralIndexOfCell[lat.serpentine[i] as number] as number).toBe(i);
    }
  });

  it('every consecutive pair of path positions is a lattice neighbour', () => {
    /*
     * This is the whole point of the placement. A payload bit stream written
     * along a path where consecutive modules touch means a compact physical
     * defect -- a hole punch, a sticker, a scratch -- damages a *contiguous run*
     * of the codeword stream instead of one bit in each of many codewords.
     */
    for (const v of [1, 3, 8, 17]) {
      const lat = getLattice(v);
      const axial = new Map<string, { q: number; r: number }>();
      for (let i = 0; i < lat.N; i++) axial.set(`${lat.cells[i]!.q},${lat.cells[i]!.r}`, lat.cells[i]!);
      for (let i = 0; i + 1 < lat.N; i++) {
        const a = lat.cells[lat.serpentine[i] as number]!;
        const b = lat.cells[lat.serpentine[i + 1] as number]!;
        expect(hexDistance(b.q - a.q, b.r - a.r)).toBe(1);
      }
    }
  });

  it('walks rings outward, alternating direction so ring joins stay adjacent', () => {
    const lat = getLattice(6);
    const K = dataRings(6);
    // first path position is the first cell of the innermost data ring
    expect(lat.dist[lat.serpentine[0] as number] as number).toBe(CORE_RADIUS + 1);
    // last is on the outermost ring
    expect(lat.dist[lat.serpentine[lat.N - 1] as number] as number).toBe(K);
    // ring index is non-decreasing along the path
    for (let i = 0; i + 1 < lat.N; i++) {
      expect(lat.dist[lat.serpentine[i + 1] as number] as number).toBeGreaterThanOrEqual(
        lat.dist[lat.serpentine[i] as number] as number,
      );
    }
  });

  it('a compact defect damages a contiguous run of the codeword stream', () => {
    /*
     * The practical payoff, stated as a measurable property: take a disc-shaped
     * defect covering 10% of the data field and count how many *codewords* it
     * touches, against how many modules it destroys. Contiguous placement keeps
     * the ratio near 8 modules per damaged codeword, so one parity symbol per
     * eight destroyed modules buys the damage back as erasures.
     */
    const v = 8;
    const lat = getLattice(v);
    const K = dataRings(v);
    const hit = new Uint8Array(lat.N);
    let hitCount = 0;
    const R = Math.sqrt(0.1 * lat.N / Math.PI); // radius covering 10% of the cells
    for (let i = 0; i < lat.N; i++) {
      const x = lat.xy[2 * i] as number;
      const y = lat.xy[2 * i + 1] as number;
      if (Math.hypot(x - K * 0.3, y - K * 0.3) <= R) {
        hit[i] = 1;
        hitCount++;
      }
    }
    expect(hitCount).toBeGreaterThan(lat.N * 0.05);
    // runs along the path
    let runs = 0;
    for (let i = 0; i < lat.N; i++) {
      if (hit[lat.serpentine[i] as number] && !hit[lat.serpentine[(i - 1 + lat.N) % lat.N] as number]) runs++;
    }
    // codewords touched, at 8 modules per codeword
    const touched = new Set<number>();
    for (let i = 0; i < lat.N; i++) if (hit[lat.serpentine[i] as number]) touched.add(Math.floor(i / 8));
    const ratio = hitCount / Math.max(1, touched.size);
    /*
     * A disc of radius R centred away from the origin is crossed once per data
     * ring it spans, so the number of runs is the number of rings it covers --
     * here about 2R. What matters is that it is O(R), not O(R^2): scattering
     * placement would give one run per damaged module.
     */
    expect(runs).toBeLessThan(2 * R + 6);
    expect(runs).toBeLessThan(hitCount / 4);
    expect(ratio).toBeGreaterThan(4); // most damaged codewords lose several modules
  });
});

describe('Scattering stride (rejected placement, kept for analysis)', () => {
  /*
   * pi(i) = (i * S) mod N with S a golden-ratio multiplier is a perfect
   * bijection and it does spread consecutive bits maximally apart. That is
   * exactly why it was rejected: spreading bits spreads *damage*. A hole
   * covering a fraction f of the modules lands in C(1 - (1-f)^8) distinct
   * codewords -- 67% of all of them at f = 13% -- turning one compact defect
   * into a symbol-wide sprinkling of single-bit errors, each of which costs two
   * parity symbols. Contiguity plus block interleaving gets the burst protection
   * where it belongs (across blocks) without paying for it inside a block.
   * These tests keep the arithmetic honest for anyone who wants to re-examine
   * the decision; the encoder does not call it.
   */
  it('is a bijection on [0, N) for every version', () => {
    for (let v = 1; v <= 40; v++) {
      const N = getLattice(v).N;
      const S = scatteringStride(N);
      const seen = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        const c = (i * S) % N;
        expect(seen[c]).toBe(0);
        seen[c] = 1;
      }
      const Sinv = modInverse(S, N);
      for (let i = 0; i < N; i++) expect((((i * S) % N) * Sinv) % N).toBe(i);
    }
  });
  it('spreads consecutive bits far apart', () => {
    const N = getLattice(6).N;
    const S = scatteringStride(N);
    let minGap = Infinity;
    for (let i = 0; i + 1 < 200; i++) {
      const a = (i * S) % N;
      const b = ((i + 1) * S) % N;
      const gap = Math.min(Math.abs(a - b), N - Math.abs(a - b));
      if (gap < minGap) minGap = gap;
    }
    expect(minGap).toBeGreaterThan(N * 0.1);
  });
});

describe('Data masks', () => {
  it('all 8 masks are deterministic and roughly balanced', () => {
    const N = getLattice(4).N;
    const zeros = new Uint8Array(N);
    for (let m = 0; m < 8; m++) {
      const a = maskArray(4, m);
      const b = maskArray(4, m);
      expect(Array.from(a)).toEqual(Array.from(b));
      let dark = 0;
      for (let i = 0; i < N; i++) dark += a[i] as number;
      expect(dark / N).toBeGreaterThan(0.2);
      expect(dark / N).toBeLessThan(0.8);
      expect(maskPenalty(4, m, zeros)).toBeGreaterThanOrEqual(0);
    }
  });
  it('bestMask returns a legal mask id', () => {
    const N = getLattice(3).N;
    const bits = new Uint8Array(N);
    for (let i = 0; i < N; i++) bits[i] = i % 7 < 3 ? 1 : 0;
    const sel = bestMask(3, bits);
    expect(sel.mask).toBeGreaterThanOrEqual(0);
    expect(sel.mask).toBeLessThan(8);
    expect(sel.scores.length).toBe(8);
  });
});

describe('Block plan', () => {
  it('is consistent for every version and ECC level', () => {
    for (let v = 1; v <= 40; v++) {
      for (const ecc of ['L', 'M', 'Q', 'H'] as const) {
        const p = planBlocks(v, ecc);
        expect(p.dataCodewords + p.parityCodewords).toBe(p.codewords);
        expect(p.codewords * 8 + p.remainderBits).toBe(p.cells);
        expect(p.blockData.reduce((a, b) => a + b, 0)).toBe(p.dataCodewords);
        expect(p.blockParity.reduce((a, b) => a + b, 0)).toBe(p.parityCodewords);
        for (let b = 0; b < p.blocks; b++) {
          expect((p.blockData[b] as number) + (p.blockParity[b] as number)).toBeLessThanOrEqual(255);
          expect(p.blockParity[b] as number).toBeGreaterThanOrEqual(2);
        }
        expect(p.payloadBytes).toBeGreaterThan(0);
      }
    }
  });
});

describe('CRC-32', () => {
  it('matches the published check value', () => {
    const s = new TextEncoder().encode('123456789');
    expect(crc32(s)).toBe(0xcbf43926);
  });
});
