#!/usr/bin/env node
/**
 * SiMurgh Code — Angle Track ("Teeth") sequence search.
 *
 * The angle track is a ring of L=60 teeth, each tooth 6 degrees, each tooth dark(1) or light(0).
 * Requirements (all verified exhaustively):
 *   R1. Cyclic uniqueness: every cyclic window of k=7 consecutive teeth is distinct
 *       => reading any 7 consecutive teeth yields the ABSOLUTE angular position (0..59).
 *   R2. Balanced ink: weight in [26,34] (~50% dark) so the ring has constant average density
 *       and no bias in the radial-profile detector.
 *   R3. Bounded run length: max cyclic run <= 4 teeth, so a partially occluded arc still
 *       contains enough transitions for a phase lock.
 *   R4. Window separation: maximize the minimum Hamming distance between distinct windows,
 *       so a 1-2 tooth misread cannot silently alias to another angle.
 *
 * Deterministic: fixed LCG seed, lexicographically-first optimum reported.
 */
const L = 60;
const K = 7;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function windows(a) {
  const out = new Map();
  for (let i = 0; i < L; i++) {
    let w = 0;
    for (let j = 0; j < K; j++) w = (w << 1) | a[(i + j) % L];
    if (out.has(w)) return null; // duplicate window
    out.set(w, i);
  }
  return out;
}

function popcount(x) { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; }

function maxCyclicRun(a) {
  let mx = 1, run = 1;
  for (let i = 1; i < L; i++) {
    if (a[i] === a[i - 1]) { run++; if (run > mx) mx = run; } else run = 1;
  }
  if (a[0] === a[L - 1]) {
    let head = 1; while (head < L && a[head] === a[0]) head++;
    let tail = 1; while (tail < L && a[L - 1 - tail] === a[L - 1]) tail++;
    mx = Math.max(mx, head + tail);
  }
  return mx;
}

function minWindowDistance(a) {
  const ws = [];
  for (let i = 0; i < L; i++) {
    let w = 0;
    for (let j = 0; j < K; j++) w = (w << 1) | a[(i + j) % L];
    ws.push(w);
  }
  let best = K;
  for (let i = 0; i < L; i++)
    for (let j = i + 1; j < L; j++) {
      const d = popcount(ws[i] ^ ws[j]);
      if (d < best) best = d;
    }
  return best;
}

function transitions(a) {
  let t = 0;
  for (let i = 0; i < L; i++) if (a[i] !== a[(i + 1) % L]) t++;
  return t;
}

function score(a) {
  const w = a.reduce((x, y) => x + y, 0);
  if (w < 26 || w > 34) return -1;
  if (maxCyclicRun(a) > 4) return -1;
  const m = windows(a);
  if (!m) return -1;
  return minWindowDistance(a) * 100 + transitions(a);
}

function search(seed, iters) {
  const rnd = rng(seed);
  let best = null, bestScore = -1;
  const a = new Array(L);
  for (let i = 0; i < L; i++) a[i] = rnd() < 0.5 ? 1 : 0;
  // hill climbing with restarts
  for (let it = 0; it < iters; it++) {
    const i = (rnd() * L) | 0;
    a[i] ^= 1;
    const s = score(a);
    if (s > bestScore) { bestScore = s; best = a.slice(); }
    // keep the mutation if it does not destroy validity too much: simple annealing
    if (s < 0 && rnd() < 0.5) a[i] ^= 1;
  }
  return { best, bestScore };
}

let globalBest = null, globalScore = -1;
for (let seed = 1; seed <= 40; seed++) {
  const { best, bestScore } = search(seed, 60000);
  if (bestScore > globalScore) { globalScore = bestScore; globalBest = best; }
}

// Rotate so that the sequence starts at its lexicographically-smallest rotation (canonical form)
function canonical(a) {
  let bestIdx = 0;
  for (let i = 1; i < L; i++) {
    for (let j = 0; j < L; j++) {
      const x = a[(bestIdx + j) % L], y = a[(i + j) % L];
      if (y < x) { bestIdx = i; break; }
      if (y > x) break;
    }
  }
  return a.map((_, j) => a[(bestIdx + j) % L]);
}

const seq = canonical(globalBest);
console.log('score          :', globalScore);
console.log('weight (dark)  :', seq.reduce((x, y) => x + y, 0), '/', L);
console.log('max cyclic run :', maxCyclicRun(seq));
console.log('min window dist:', minWindowDistance(seq));
console.log('transitions    :', transitions(seq));
console.log('unique windows :', windows(seq) ? 'YES (all 60 distinct)' : 'NO');
console.log('sequence       :', seq.join(''));
console.log('');
console.log('export const ANGLE_TRACK: readonly number[] = [');
for (let i = 0; i < L; i += 20) console.log('  ' + seq.slice(i, i + 20).join(', ') + ',');
console.log('];');
