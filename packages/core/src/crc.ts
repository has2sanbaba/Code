/**
 * CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) and CRC-16/CCITT-FALSE.
 *
 * The payload of a SiMurgh Code ends with a CRC-32 over the whole segment
 * stream. Reed-Solomon already guarantees algebraic integrity, but RS can
 * (rarely, above its correction radius) return a *different valid codeword*.
 * The CRC-32 is the independent application-layer check that lets the decoder
 * reject such a case with probability 1 - 2^-32, and it is what makes the
 * brute-force format fallback (try all versions/ECC/masks) safe.
 */

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC32_TABLE[(c ^ (data[i] as number)) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();

export function crc16(data: Uint8Array, seed = 0xffff): number {
  let c = seed & 0xffff;
  for (let i = 0; i < data.length; i++) c = ((c << 8) ^ CRC16_TABLE[((c >>> 8) ^ (data[i] as number)) & 0xff]!) & 0xffff;
  return c;
}

/** FNV-1a 32-bit -- used for cheap deterministic hashing (mask seeds, test ids). */
export function fnv1a32(data: Uint8Array, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i] as number;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic 32-bit PRNG (xorshift32) used for mask patterns and for the
 * reference distortion simulator in tests. Never used for security.
 */
export function makeRng(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
