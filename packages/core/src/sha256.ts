/**
 * SHA-256 + HMAC-SHA256, synchronous and dependency-free.
 *
 * SiMurgh Code reserves an optional SIGNATURE segment in the payload so a code
 * can carry an anti-counterfeit tag. HMAC-SHA256 (truncated to 64 or 128 bits)
 * is implemented here so the whole stack stays synchronous and portable across
 * Node, Deno, Bun, workers and browsers without WebCrypto's async API.
 *
 * A full Ed25519/ECDSA signature can also be embedded: the SIGNATURE segment
 * is length-prefixed and algorithm-agnostic.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

function compress(state: Uint32Array, block: Uint8Array, off: number): void {
  const w = new Uint32Array(64);
  for (let i = 0; i < 16; i++) {
    w[i] =
      ((block[off + i * 4] as number) << 24) |
      ((block[off + i * 4 + 1] as number) << 16) |
      ((block[off + i * 4 + 2] as number) << 8) |
      (block[off + i * 4 + 3] as number);
  }
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15] as number;
    const y = w[i - 2] as number;
    const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
    const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
    w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
  }
  let a = state[0] as number;
  let b = state[1] as number;
  let c = state[2] as number;
  let d = state[3] as number;
  let e = state[4] as number;
  let f = state[5] as number;
  let g = state[6] as number;
  let h = state[7] as number;
  for (let i = 0; i < 64; i++) {
    const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
    const ch = ((e & f) ^ (~e & g)) >>> 0;
    const t1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
    const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
    const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
    const t2 = (S0 + maj) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  state[0] = (state[0] as number) + a >>> 0;
  state[1] = (state[1] as number) + b >>> 0;
  state[2] = (state[2] as number) + c >>> 0;
  state[3] = (state[3] as number) + d >>> 0;
  state[4] = (state[4] as number) + e >>> 0;
  state[5] = (state[5] as number) + f >>> 0;
  state[6] = (state[6] as number) + g >>> 0;
  state[7] = (state[7] as number) + h >>> 0;
}

/** SHA-256 digest (32 bytes). */
export function sha256(msg: Uint8Array): Uint8Array {
  const state = H0.slice();
  const bitLen = msg.length * 8;
  const withPad = new Uint8Array((((msg.length + 9 + 63) >> 6) << 6));
  withPad.set(msg);
  withPad[msg.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 4294967296), false);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
  for (let off = 0; off < withPad.length; off += 64) compress(state, withPad, off);
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, state[i] as number, false);
  return out;
}

/** HMAC-SHA256 (32 bytes). */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > 64) k = sha256(k);
  const padded = new Uint8Array(64);
  padded.set(k);
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = (padded[i] as number) ^ 0x36;
    outer[i] = (padded[i] as number) ^ 0x5c;
  }
  inner.set(msg, 64);
  const ih = sha256(inner);
  outer.set(ih, 64);
  return sha256(outer);
}

/** Truncated HMAC used as a compact anti-counterfeit tag. */
export function macTag(key: Uint8Array, msg: Uint8Array, bytes: 8 | 16): Uint8Array {
  return hmacSha256(key, msg).slice(0, bytes);
}

/** Constant-time comparison of two byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** UTF-8 encode without pulling in node:buffer (keeps the core browser-safe). */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.codePointAt(i) as number;
    if (cp > 0xffff) i++;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i] as number;
    let cp: number;
    let len: number;
    if (c < 0x80) {
      cp = c;
      len = 1;
    } else if ((c & 0xe0) === 0xc0) {
      cp = c & 0x1f;
      len = 2;
    } else if ((c & 0xf0) === 0xe0) {
      cp = c & 0x0f;
      len = 3;
    } else {
      cp = c & 0x07;
      len = 4;
    }
    for (let k = 1; k < len; k++) cp = (cp << 6) | ((b[i + k] as number) & 0x3f);
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

export function hexEncode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] as number).toString(16).padStart(2, '0');
  return s;
}

export function hexDecode(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
