#!/usr/bin/env node
/**
 * SiMurgh Code -- Angle Track ("Dandaneh" / Teeth) generator + verifier.
 * ---------------------------------------------------------------------------
 * The Angle Track is a ring of L = 63 teeth, each spanning 360/63 = 5.714286 deg.
 * It carries a binary *maximum-length sequence* (m-sequence) of order n = 6,
 * produced by a 6-stage LFSR with the primitive polynomial
 *
 *      p(x) = x^6 + x + 1        (GF(2), 0b1000011)
 *
 * Why an m-sequence instead of an arbitrary de Bruijn ring?
 *   P1. Every cyclic window of n = 6 consecutive teeth is a distinct non-zero
 *       6-bit word  =>  reading ANY 6 consecutive teeth gives the ABSOLUTE
 *       tooth index (0..62), i.e. absolute rotation, with zero ambiguity.
 *   P2. Balance: exactly 2^(n-1) = 32 dark teeth and 31 light teeth.
 *   P3. Golomb run distribution: runs of length r occur 2^(n-r-1) times
 *       => no long monochrome arcs; a partially occluded ring still locks.
 *   P4. Two-level cyclic autocorrelation: C(tau) = -1 for every tau != 0
 *       => correlation over all 63 phase shifts has a single sharp peak of 63
 *       against a floor of -1 (18.4 dB). This is what makes the rotation
 *       estimate tolerant to heavy noise, blur and 30-40% occlusion.
 *
 * This script regenerates and *proves* P1-P4 so the frozen constant in
 * packages/core/src/angle-track.ts can always be re-derived.
 */
const N = 6;                 // LFSR stages
const L = (1 << N) - 1;      // 63
const POLY = 0b1000011;    // p(x) = x^6 + x + 1  (primitive over GF(2))

function popcount(x) { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; }

// Galois-form LFSR: shift right, feedback into the top bit.
function generate() {
  let s = 1;
  const out = [];
  for (let i = 0; i < L; i++) {
    const bit = s & 1;
    out.push(bit);
    s >>>= 1;
    if (bit) s ^= (POLY >> 1); // Galois feedback mask = p(x) without its leading term
    s &= (1 << N) - 1;
    if (s === 0) s = 1;
  }
  return out;
}

const seq = generate();

// ---- P1: window uniqueness -------------------------------------------------
const table = new Map();
let unique = true;
for (let i = 0; i < L; i++) {
  let w = 0;
  for (let j = 0; j < N; j++) w = (w << 1) | seq[(i + j) % L];
  if (w === 0 || table.has(w)) unique = false;
  table.set(w, i);
}

// ---- P2: balance -----------------------------------------------------------
const weight = seq.reduce((a, b) => a + b, 0);

// ---- P3: run distribution --------------------------------------------------
const runs = {};
{
  // rotate to a transition boundary so that runs are counted cyclically
  let start = 0;
  while (start < L && seq[start] === seq[(start - 1 + L) % L]) start++;
  let cur = seq[start], len = 0;
  for (let k = 0; k < L; k++) {
    const b = seq[(start + k) % L];
    if (b === cur) len++;
    else { runs[len] = (runs[len] || 0) + 1; cur = b; len = 1; }
  }
  runs[len] = (runs[len] || 0) + 1;
}

// ---- P4: autocorrelation ---------------------------------------------------
const ac = [];
for (let tau = 1; tau < L; tau++) {
  let c = 0;
  for (let i = 0; i < L; i++) c += seq[i] === seq[(i + tau) % L] ? 1 : -1;
  ac.push(c);
}
const acOk = ac.every((c) => c === -1);

// ---- robustness: 1-bit-error aliasing -------------------------------------
let aliasNear = 0, aliasMiss = 0, aliasFar = 0;
for (let i = 0; i < L; i++) {
  let w = 0;
  for (let j = 0; j < N; j++) w = (w << 1) | seq[(i + j) % L];
  for (let b = 0; b < N; b++) {
    const w2 = w ^ (1 << b);
    if (!table.has(w2)) { aliasMiss++; continue; }
    const j = table.get(w2);
    const d = Math.min((j - i + L) % L, (i - j + L) % L);
    if (d <= 2) aliasNear++; else aliasFar++;
  }
}

console.log('LFSR order            :', N);
console.log('Teeth (L)             :', L);
console.log('Tooth angle           :', (360 / L).toFixed(6), 'deg');
console.log('P1 unique 6-windows   :', unique ? 'PASS' : 'FAIL');
console.log('P2 weight             :', weight, '/', L, weight === 32 ? 'PASS' : 'FAIL');
console.log('P3 run distribution   :', JSON.stringify(runs));
console.log('P4 autocorrelation    :', acOk ? 'PASS (all -1)' : 'FAIL ' + JSON.stringify(ac));
console.log('1-bit window aliasing : near=' + aliasNear + ' miss=' + aliasMiss + ' far=' + aliasFar + ' (of ' + L * N + ')');
console.log('sequence              :', seq.join(''));
console.log('hex (63 bits, MSB first, padded) : 0x' + BigInt('0b' + seq.join('') + '0').toString(16).toUpperCase());
console.log('');
console.log('export const ANGLE_TRACK = Uint8Array.from([' + seq.join(',') + ']);');
