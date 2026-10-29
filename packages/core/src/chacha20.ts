/**
 * AEAD_CHACHA20_POLY1305 (RFC 8439) and PBKDF2-HMAC-SHA256 (RFC 8018),
 * implemented from the specifications with no dependencies.
 *
 * Why this file exists: a symbology is a *public* data structure. Anyone with a
 * camera can read the modules, so anything written into a symbol is public by
 * default -- exactly like a QR code, which is why a damaged or partially hidden
 * QR can be completed by anyone who knows the format. If the payload must stay
 * secret from the person holding the camera, it has to be encrypted *before* it
 * becomes modules. That is what `MODE_SECURE` in segments.ts does with this AEAD.
 *
 * Design notes that matter for correctness:
 *
 * - The Poly1305 one-time key is generated with counter 0 and the payload is
 *   encrypted starting at counter 1 (RFC 8439 2.8). Reusing counter 0 for both
 *   is the classic way to break the construction.
 * - A nonce must never repeat under the same key. Repeating one leaks the XOR of
 *   the two plaintexts and, worse, the Poly1305 key, which allows forgeries.
 *   `randomNonce` therefore pulls from the platform CSPRNG and never from the
 *   xorshift helper in crc.ts.
 * - Poly1305 arithmetic is modulo 2^130 - 5. It is written with BigInt for
 *   clarity and portability (browser, Node, WASM); the payload sizes involved
 *   are kilobytes, so the cost is irrelevant next to rasterising the symbol.
 * - Tag comparison is constant-time.
 */
import { hmacSha256, sha256, timingSafeEqual } from './sha256.js';

/* ---------------------------------------------------------------- ChaCha20 */

const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]; // "expand 32-byte k"

function rotl32(v: number, n: number): number {
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

function quarterRound(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a]! + s[b]!) >>> 0;
  s[d] = rotl32(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotl32(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]!) >>> 0;
  s[d] = rotl32(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) >>> 0;
  s[b] = rotl32(s[b]! ^ s[c]!, 7);
}

function readLE32(b: Uint8Array, i: number): number {
  return ((b[i] as number) | ((b[i + 1] as number) << 8) | ((b[i + 2] as number) << 16) | ((b[i + 3] as number) << 24)) >>> 0;
}

/** One ChaCha20 block: 64 bytes of keystream (RFC 8439 2.3). */
export function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new RangeError('ChaCha20 key must be 32 bytes');
  if (nonce.length !== 12) throw new RangeError('ChaCha20 nonce must be 12 bytes');

  const state = new Uint32Array(16);
  for (let i = 0; i < 4; i++) state[i] = SIGMA[i] as number;
  for (let i = 0; i < 8; i++) state[4 + i] = readLE32(key, i * 4);
  state[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) state[13 + i] = readLE32(nonce, i * 4);

  const work = Uint32Array.from(state);
  for (let i = 0; i < 10; i++) {
    // column rounds
    quarterRound(work, 0, 4, 8, 12);
    quarterRound(work, 1, 5, 9, 13);
    quarterRound(work, 2, 6, 10, 14);
    quarterRound(work, 3, 7, 11, 15);
    // diagonal rounds
    quarterRound(work, 0, 5, 10, 15);
    quarterRound(work, 1, 6, 11, 12);
    quarterRound(work, 2, 7, 8, 13);
    quarterRound(work, 3, 4, 9, 14);
  }

  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const v = (work[i]! + state[i]!) >>> 0;
    out[i * 4] = v & 0xff;
    out[i * 4 + 1] = (v >>> 8) & 0xff;
    out[i * 4 + 2] = (v >>> 16) & 0xff;
    out[i * 4 + 3] = (v >>> 24) & 0xff;
  }
  return out;
}

/** ChaCha20 encryption/decryption (the operation is its own inverse). */
export function chacha20Xor(key: Uint8Array, counter: number, nonce: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let off = 0; off < data.length; off += 64) {
    const block = chacha20Block(key, (counter + Math.floor(off / 64)) >>> 0, nonce);
    const end = Math.min(64, data.length - off);
    for (let i = 0; i < end; i++) out[off + i] = (data[off + i] as number) ^ (block[i] as number);
  }
  return out;
}

/* ---------------------------------------------------------------- Poly1305 */

const P1305 = (1n << 130n) - 5n;

/** Clamp `r` exactly as RFC 8439 2.5 requires. */
function clampR(r: Uint8Array): bigint {
  const t = Uint8Array.from(r);
  t[3] = (t[3] as number) & 0x0f;
  t[7] = (t[7] as number) & 0x0f;
  t[11] = (t[11] as number) & 0x0f;
  t[15] = (t[15] as number) & 0x0f;
  t[4] = (t[4] as number) & 0xfc;
  t[8] = (t[8] as number) & 0xfc;
  t[12] = (t[12] as number) & 0xfc;
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(t[i] as number);
  return v;
}

function leBytesToBigInt(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i] as number);
  return v;
}

function bigIntToLE16(v: bigint): Uint8Array {
  const out = new Uint8Array(16);
  let x = v;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Poly1305 MAC (RFC 8439 2.5). `key` is the 32-byte one-time key r||s. */
export function poly1305Mac(key: Uint8Array, msg: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new RangeError('Poly1305 key must be 32 bytes');
  const r = clampR(key.subarray(0, 16));
  const s = leBytesToBigInt(key.subarray(16, 32));
  let acc = 0n;

  for (let off = 0; off < msg.length; off += 16) {
    const block = msg.subarray(off, Math.min(off + 16, msg.length));
    // Append the 0x01 byte *after* the block, i.e. bit 8*len(block).
    const n = leBytesToBigInt(block) | (1n << BigInt(8 * block.length));
    acc = ((acc + n) * r) % P1305;
  }
  return bigIntToLE16((acc + s) & ((1n << 128n) - 1n));
}

/** The one-time Poly1305 key for (key, nonce): block 0 of ChaCha20. */
export function poly1305KeyGen(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  return chacha20Block(key, 0, nonce).subarray(0, 32);
}

/* -------------------------------------------------------------------- AEAD */

export const AEAD_TAG_BYTES = 16;
export const AEAD_NONCE_BYTES = 12;
export const AEAD_KEY_BYTES = 32;

function pad16(parts: Uint8Array[], data: Uint8Array): void {
  parts.push(data);
  const rem = data.length % 16;
  if (rem !== 0) parts.push(new Uint8Array(16 - rem));
}

function le64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let x = BigInt(n >>> 0);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * AEAD_CHACHA20_POLY1305 encrypt. Returns `ciphertext || tag` (16 extra bytes).
 *
 * `aad` is authenticated but not encrypted. In this project the AAD binds the
 * ciphertext to the symbol that carries it (format bits, spec version), so a
 * ciphertext lifted out of one symbol and re-printed in another with different
 * parameters fails to authenticate even though it is bit-identical.
 */
export function aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (key.length !== AEAD_KEY_BYTES) throw new RangeError('AEAD key must be 32 bytes');
  if (nonce.length !== AEAD_NONCE_BYTES) throw new RangeError('AEAD nonce must be 12 bytes');
  const otk = poly1305KeyGen(key, nonce);
  const ciphertext = chacha20Xor(key, 1, nonce, plaintext);
  const macData: Uint8Array[] = [];
  pad16(macData, aad);
  pad16(macData, ciphertext);
  macData.push(le64(aad.length));
  macData.push(le64(ciphertext.length));
  const tag = poly1305Mac(otk, concat(macData));
  return concat([ciphertext, tag]);
}

/**
 * AEAD_CHACHA20_POLY1305 decrypt. Returns null when the tag does not verify --
 * never the plaintext of an unverified message, because a caller that gets bytes
 * back will assume they are authentic.
 */
export function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, blob: Uint8Array, aad: Uint8Array = new Uint8Array(0)): Uint8Array | null {
  if (key.length !== AEAD_KEY_BYTES) throw new RangeError('AEAD key must be 32 bytes');
  if (nonce.length !== AEAD_NONCE_BYTES) throw new RangeError('AEAD nonce must be 12 bytes');
  if (blob.length < AEAD_TAG_BYTES) return null;
  const ciphertext = blob.subarray(0, blob.length - AEAD_TAG_BYTES);
  const tag = blob.subarray(blob.length - AEAD_TAG_BYTES);
  const otk = poly1305KeyGen(key, nonce);
  const macData: Uint8Array[] = [];
  pad16(macData, aad);
  pad16(macData, ciphertext);
  macData.push(le64(aad.length));
  macData.push(le64(ciphertext.length));
  const expected = poly1305Mac(otk, concat(macData));
  if (!timingSafeEqual(expected, tag)) return null;
  return chacha20Xor(key, 1, nonce, ciphertext);
}

/* ------------------------------------------------------------------ PBKDF2 */

/**
 * PBKDF2-HMAC-SHA256 (RFC 8018 5.2). Used to turn a human passphrase into a
 * 32-byte key.
 *
 * The iteration count is a cost dial, not a magic number: 210 000 is OWASP's
 * 2023 recommendation for PBKDF2-HMAC-SHA256 and takes well under a second on a
 * phone. It is stored in the symbol (see MODE_SECURE), so a reader from ten years
 * from now still knows what the encoder meant.
 */
export function pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iterations: number, dkLen = 32): Uint8Array {
  if (iterations < 1) throw new RangeError('iterations must be >= 1');
  const blocks = Math.ceil(dkLen / 32);
  const out = new Uint8Array(blocks * 32);
  for (let i = 1; i <= blocks; i++) {
    const intBlock = new Uint8Array(4);
    intBlock[0] = (i >>> 24) & 0xff;
    intBlock[1] = (i >>> 16) & 0xff;
    intBlock[2] = (i >>> 8) & 0xff;
    intBlock[3] = i & 0xff;
    let u = hmacSha256(password, concat([salt, intBlock]));
    const t = Uint8Array.from(u);
    for (let j = 1; j < iterations; j++) {
      u = hmacSha256(password, u);
      for (let k = 0; k < 32; k++) t[k] = (t[k] as number) ^ (u[k] as number);
    }
    out.set(t, (i - 1) * 32);
  }
  return out.subarray(0, dkLen);
}

/** Default PBKDF2 cost. Raised over time; the value used is stored per symbol. */
export const PBKDF2_ITERATIONS = 210000;

/* ------------------------------------------------------------- randomness */

/**
 * Cryptographically strong bytes from the platform CSPRNG (WebCrypto in browsers
 * and in Node >= 19). There is deliberately no fallback: a symbology that
 * silently invents nonces from a weak PRNG is worse than one that refuses to run.
 */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('no cryptographically secure random source available (WebCrypto is required)');
  }
  c.getRandomValues(out);
  return out;
}

/** A fresh 12-byte AEAD nonce. Never reuse one under the same key. */
export function randomNonce(): Uint8Array {
  return randomBytes(AEAD_NONCE_BYTES);
}

/* --------------------------------------------------------- key derivation */

export interface DerivedKey {
  key: Uint8Array;
  keyId: Uint8Array;
  salt: Uint8Array;
  iterations: number;
}

/**
 * Derive an encryption key and a short public key id from a passphrase.
 *
 * The id is `HMAC-SHA256("SiMurgh key id v1", key)[0..4]`: a reader can pick the
 * right passphrase out of a keyring *without* trying to decrypt anything, and
 * publishing the id leaks nothing about the key. Domain separation ("SiMurgh
 * key id v1") keeps it from colliding with any other use of the same key.
 */
export function deriveKey(passphrase: string | Uint8Array, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): DerivedKey {
  const pass = typeof passphrase === 'string' ? new TextEncoder().encode(passphrase) : passphrase;
  const key = pbkdf2Sha256(pass, salt, iterations, AEAD_KEY_BYTES);
  const keyId = hmacSha256(new TextEncoder().encode('SiMurgh key id v1'), key).subarray(0, 4);
  return { key, keyId: Uint8Array.from(keyId), salt: Uint8Array.from(salt), iterations };
}

/** A random 16-byte salt for `deriveKey`. */
export function randomSalt(): Uint8Array {
  return randomBytes(16);
}
