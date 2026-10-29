/**
 * ============================================================================
 *  SiMurgh Code -- PAYLOAD SEGMENTS ("what can actually go inside the code")
 * ============================================================================
 *
 * A SiMurgh payload is a sequence of self-describing segments:
 *
 *      segment = MODE (4 bits) | COUNT (mode specific) | DATA
 *
 * and ends with a 4-bit terminator. Because segments can be freely mixed, one
 * single code can hold a URL *and* a Persian paragraph *and* a binary blob *and*
 * a geo fix *and* an anti-counterfeit MAC, in that order, with no separators.
 *
 * MODES
 *   0  TERMINATOR   end of stream
 *   1  NUMERIC      3 digits -> 10 bits (3.33 bits/digit)
 *   2  C64          6-bit mixed-case alphanumeric + space, escape for the rest
 *   3  TEXT         raw UTF-8 bytes (any script, emoji, RTL, control chars)
 *   4  BYTE         arbitrary binary
 *   5  URL          scheme + base-39 packed authority + 6-bit URL body
 *   6  GEO          WGS-84 fix: lat/lon at 1e-7 deg + altitude + flags
 *   7  FRAME        multi-code stream header (payload bigger than one disc)
 *   8  MAC          keyed anti-counterfeit tag (HMAC-SHA256 truncated, ...)
 *   9  SIGNATURE    detached signature (Ed25519 / ECDSA / anything)
 *  10  SECURE       an encrypted envelope (AEAD_CHACHA20_POLY1305, RFC 8439)
 *                  that wraps any other segment list -- readable only with
 *                  the key, and provably not reconstructable without it
 *  15  VENDOR       application-defined extension
 *
 * DENSITY (bits per character, no segment overhead)
 *   digits                 3.33   (NUMERIC)
 *   URL body               6.00   (URL)
 *   Latin prose            6.00   (C64)
 *   hostname               5.29   (URL authority, base 39)
 *   any UTF-8              8.00   (TEXT)
 *
 * The encoder runs a dynamic program over the input to pick the cheapest split
 * between NUMERIC / C64 / TEXT, so mixed content is automatically compacted.
 */
import { BitReader, BitWriter } from './bits.js';
import { deflateIfSmaller, inflateRaw } from './deflate.js';
import { hexEncode, hmacSha256, utf8Decode, utf8Encode } from './sha256.js';
import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  PBKDF2_ITERATIONS,
  aeadDecrypt,
  aeadEncrypt,
  deriveKey,
  randomNonce,
  randomSalt,
} from './chacha20.js';

export const MODE_TERMINATOR = 0;
export const MODE_NUMERIC = 1;
export const MODE_C64 = 2;
export const MODE_TEXT = 3;
export const MODE_BYTE = 4;
export const MODE_URL = 5;
export const MODE_GEO = 6;
export const MODE_FRAME = 7;
export const MODE_MAC = 8;
export const MODE_SIGNATURE = 9;
export const MODE_SECURE = 10;
export const MODE_VENDOR = 15;

export const MODE_NAMES: Record<number, string> = {
  0: 'TERMINATOR',
  1: 'NUMERIC',
  2: 'C64',
  3: 'TEXT',
  4: 'BYTE',
  5: 'URL',
  6: 'GEO',
  7: 'FRAME',
  8: 'MAC',
  9: 'SIGNATURE',
  10: 'SECURE',
  15: 'VENDOR',
};

/* ---------------------------------------------------------------- charsets */

/** 6-bit general charset: a-z A-Z 0-9 space, code 63 = escape (8 raw bits). */
export const C64 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
export const C64_ESCAPE = 63;

/**
 * 6-bit URL body charset. Codes 0..59 are literal, 60 = upper-shift (the next
 * code 0..25 is read as A-Z), 63 = escape (8 raw bits). 61/62 are reserved and
 * must never be emitted.
 */
export const U64 = "abcdefghijklmnopqrstuvwxyz0123456789-._/?=&%:#+~@,;()!$'*[] ";
export const U64_UPPER_SHIFT = 60;
export const U64_ESCAPE = 63;

/** 39-character authority alphabet, packed as a big integer (5.285 bits/char). */
export const AUTH39 = 'abcdefghijklmnopqrstuvwxyz0123456789-.:';
/** Exact bit width needed to hold a base-39 integer of `n` digits. */
export function authBits(n: number): number {
  // ceil(n * log2(39)) computed exactly with BigInt
  const max = 39n ** BigInt(n) - 1n;
  let bits = 0;
  let v = max;
  while (v > 0n) {
    bits++;
    v >>= 1n;
  }
  return bits;
}

const c64Index = new Map<string, number>();
for (let i = 0; i < C64.length; i++) c64Index.set(C64[i] as string, i);
const u64Index = new Map<string, number>();
for (let i = 0; i < U64.length; i++) u64Index.set(U64[i] as string, i);
const auth39Index = new Map<string, number>();
for (let i = 0; i < AUTH39.length; i++) auth39Index.set(AUTH39[i] as string, i);

/* ------------------------------------------------------------------ types */

export interface GeoFix {
  lat: number;
  lon: number;
  /** metres above the WGS-84 ellipsoid; -1000 means "no altitude". */
  alt: number;
  flags: number;
}

export type Segment =
  | { kind: 'numeric'; value: string }
  | { kind: 'c64'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'byte'; value: Uint8Array }
  | { kind: 'url'; value: string }
  | { kind: 'geo'; value: GeoFix }
  | { kind: 'frame'; streamId: number; index: number; count: number }
  | { kind: 'mac'; algo: number; value: Uint8Array }
  | { kind: 'signature'; algo: number; value: Uint8Array }
  | { kind: 'vendor'; id: number; value: Uint8Array }
  /**
   * An encrypted envelope. Everything inside it is opaque to a reader that does
   * not hold the key: the modules still decode (the Reed-Solomon and CRC layers
   * work on ciphertext exactly as they do on plaintext), but the payload cannot
   * be recovered, completed or guessed from a photograph of the symbol.
   */
  | {
      kind: 'secure';
      /** 0 = PBKDF2-HMAC-SHA256 passphrase, 1 = raw 32-byte key. */
      suite: number;
      /**
       * Bit 0: the plaintext is a raw DEFLATE stream (compress-then-encrypt --
       * the only order that works, since ciphertext is incompressible).
       */
      flags: number;
      salt: Uint8Array;
      iterations: number;
      keyId: Uint8Array;
      nonce: Uint8Array;
      /** Ciphertext with the 16-byte Poly1305 tag appended. */
      ciphertext: Uint8Array;
    };

export interface Payload {
  segments: Segment[];
}

/* ------------------------------------------------------------- bit costs */

function utf8LengthOf(s: string): number {
  return utf8Encode(s).length;
}

export function numericBits(digits: number): number {
  const groups = Math.floor(digits / 3);
  const rem = digits - groups * 3;
  return groups * 10 + (rem === 2 ? 7 : rem === 1 ? 4 : 0);
}

function c64DataBits(s: string): number {
  let bits = 0;
  for (const ch of s) {
    // An escape costs its own 6-bit code plus *every* byte of the character's
    // UTF-8 encoding. Charging a flat 8 bits here -- which is right for Latin-1
    // and wrong for everything else -- makes the cost model optimistic, so the
    // encoder picks a version that cannot actually hold a CJK payload and then
    // fails while serialising it. The write path already emits all the bytes;
    // the accounting has to agree with it.
    bits += c64Index.has(ch) ? 6 : 6 + 8 * utf8Encode(ch).length;
  }
  return bits;
}

function urlSplit(url: string): { scheme: 'https' | 'http'; authority: string; rest: string } | null {
  const m = /^(https?):\/\/([^/?#\s]*)([\s\S]*)$/i.exec(url);
  if (!m) return null;
  const scheme = (m[1] as string).toLowerCase() as 'https' | 'http';
  const authority = (m[2] as string).toLowerCase();
  for (const ch of authority) if (!auth39Index.has(ch)) return null;
  return { scheme, authority, rest: m[3] as string };
}

function u64DataBits(s: string): number {
  let bits = 0;
  for (const ch of s) {
    if (u64Index.has(ch)) bits += 6;
    else if (u64Index.has(ch.toLowerCase()) && ch.toLowerCase() !== ch && /[a-z]/.test(ch.toLowerCase())) bits += 12;
    else bits += 6 + 8 * utf8Encode(ch).length; // same accounting fix as C64
  }
  return bits;
}

/** Total bits for one segment, including the 4-bit mode and count fields. */
export function segmentBits(seg: Segment): number {
  switch (seg.kind) {
    case 'numeric':
      return 4 + 14 + numericBits(seg.value.length);
    case 'c64':
      return 4 + 14 + c64DataBits(seg.value);
    case 'text':
      return 4 + 16 + 8 * utf8LengthOf(seg.value);
    case 'byte':
      return 4 + 16 + 8 * seg.value.length;
    case 'url': {
      const parts = urlSplit(seg.value);
      if (!parts) return Infinity;
      return 4 + 3 + 8 + authBits(parts.authority.length) + 14 + u64DataBits(parts.rest);
    }
    case 'geo':
      return 4 + 32 + 32 + 16 + 8;
    case 'frame':
      return 4 + 32 + 12 + 12;
    case 'mac':
      return 4 + 4 + 12 + 8 * seg.value.length;
    case 'signature':
      return 4 + 4 + 12 + 8 * seg.value.length;
    case 'vendor':
      return 4 + 16 + 16 + 8 * seg.value.length;
    case 'secure':
      return (
        4 + 4 + 4 + 8 + 8 * seg.salt.length + 32 + 4 + 8 * seg.keyId.length + 96 + 16 + 8 * seg.ciphertext.length
      );
  }
}

/* ---------------------------------------------------------------- encode */

export function writeSegment(w: BitWriter, seg: Segment): void {
  switch (seg.kind) {
    case 'numeric': {
      if (!/^[0-9]*$/.test(seg.value)) throw new Error('NUMERIC segment contains a non-digit');
      if (seg.value.length > 16383) throw new Error('NUMERIC segment too long');
      w.writeBits(MODE_NUMERIC, 4);
      w.writeBits(seg.value.length, 14);
      let i = 0;
      for (; i + 3 <= seg.value.length; i += 3) w.writeBits(parseInt(seg.value.substr(i, 3), 10), 10);
      const rem = seg.value.length - i;
      if (rem === 2) w.writeBits(parseInt(seg.value.substr(i, 2), 10), 7);
      else if (rem === 1) w.writeBits(parseInt(seg.value.substr(i, 1), 10), 4);
      return;
    }
    case 'c64': {
      const chars = Array.from(seg.value);
      if (chars.length > 16383) throw new Error('C64 segment too long');
      w.writeBits(MODE_C64, 4);
      w.writeBits(chars.length, 14);
      for (const ch of chars) {
        const idx = c64Index.get(ch);
        if (idx === undefined) {
          w.writeBits(C64_ESCAPE, 6);
          for (const b of utf8Encode(ch)) w.writeBits(b, 8);
        } else w.writeBits(idx, 6);
      }
      return;
    }
    case 'text': {
      const bytes = utf8Encode(seg.value);
      w.writeBits(MODE_TEXT, 4);
      w.writeBits(bytes.length, 16);
      w.writeBytes(bytes);
      return;
    }
    case 'byte': {
      w.writeBits(MODE_BYTE, 4);
      w.writeBits(seg.value.length, 16);
      w.writeBytes(seg.value);
      return;
    }
    case 'url': {
      const parts = urlSplit(seg.value);
      if (!parts) throw new Error('not an http(s) URL expressible in URL mode');
      w.writeBits(MODE_URL, 4);
      w.writeBits(parts.scheme === 'https' ? 0 : 1, 3);
      w.writeBits(parts.authority.length, 8);
      if (parts.authority.length > 0) {
        let v = 0n;
        for (const ch of parts.authority) v = v * 39n + BigInt(auth39Index.get(ch) as number);
        w.writeBigInt(v, authBits(parts.authority.length));
      }
      const chars = Array.from(parts.rest);
      if (chars.length > 16383) throw new Error('URL body too long');
      w.writeBits(chars.length, 14);
      for (const ch of chars) {
        const idx = u64Index.get(ch);
        if (idx !== undefined) {
          w.writeBits(idx, 6);
          continue;
        }
        const lower = ch.toLowerCase();
        const lidx = u64Index.get(lower);
        if (lidx !== undefined && lidx < 26 && lower !== ch) {
          w.writeBits(U64_UPPER_SHIFT, 6);
          w.writeBits(lidx, 6);
          continue;
        }
        w.writeBits(U64_ESCAPE, 6);
        for (const b of utf8Encode(ch)) w.writeBits(b, 8);
      }
      return;
    }
    case 'geo': {
      const g = seg.value;
      w.writeBits(MODE_GEO, 4);
      const lat = Math.round(g.lat * 1e7);
      const lon = Math.round(g.lon * 1e7);
      if (Math.abs(lat) > 900000000 || Math.abs(lon) > 1800000000) throw new RangeError('geo out of range');
      w.writeBits((lat >>> 0) | 0, 32);
      w.writeBits((lon >>> 0) | 0, 32);
      const alt = Math.max(-1000, Math.min(31767, Math.round(g.alt)));
      w.writeBits((alt + 1000) & 0xffff, 16);
      w.writeBits(g.flags & 0xff, 8);
      return;
    }
    case 'frame': {
      w.writeBits(MODE_FRAME, 4);
      w.writeBits(seg.streamId >>> 0, 32);
      w.writeBits(seg.index & 0xfff, 12);
      w.writeBits(seg.count & 0xfff, 12);
      return;
    }
    case 'mac':
    case 'signature': {
      const mode = seg.kind === 'mac' ? MODE_MAC : MODE_SIGNATURE;
      if (seg.value.length > 4095) throw new Error('signature segment too long');
      w.writeBits(mode, 4);
      w.writeBits(seg.algo & 0xf, 4);
      w.writeBits(seg.value.length, 12);
      w.writeBytes(seg.value);
      return;
    }
    case 'vendor': {
      w.writeBits(MODE_VENDOR, 4);
      w.writeBits(seg.id & 0xffff, 16);
      w.writeBits(seg.value.length, 16);
      w.writeBytes(seg.value);
      return;
    }
    case 'secure': {
      if (seg.salt.length > 255) throw new RangeError('SECURE salt too long');
      if (seg.keyId.length > 15) throw new RangeError('SECURE keyId too long (max 15 bytes)');
      if (seg.nonce.length !== AEAD_NONCE_BYTES) throw new RangeError('SECURE nonce must be 12 bytes');
      if (seg.ciphertext.length > 0xffff) throw new RangeError('SECURE payload too long');
      w.writeBits(MODE_SECURE, 4);
      w.writeBits(seg.suite & 0xf, 4);
      w.writeBits(seg.flags & 0xf, 4);
      w.writeBits(seg.salt.length, 8);
      w.writeBytes(seg.salt);
      w.writeBits(seg.iterations >>> 0, 32);
      w.writeBits(seg.keyId.length, 4);
      w.writeBytes(seg.keyId);
      w.writeBytes(seg.nonce);
      w.writeBits(seg.ciphertext.length, 16);
      w.writeBytes(seg.ciphertext);
      return;
    }
  }
}

/* ---------------------------------------------------------------- decode */

export class SegmentDecodeError extends Error {}

export function readSegments(r: BitReader, maxSegments = 4096): Segment[] {
  const out: Segment[] = [];
  while (r.remaining >= 4 && out.length < maxSegments) {
    const mode = r.readBits(4);
    if (mode === MODE_TERMINATOR) break;
    switch (mode) {
      case MODE_NUMERIC: {
        const count = r.readBits(14);
        if (r.remaining < numericBits(count)) throw new SegmentDecodeError('truncated NUMERIC');
        let s = '';
        let i = 0;
        for (; i + 3 <= count; i += 3) s += String(r.readBits(10)).padStart(3, '0');
        const rem = count - i;
        if (rem === 2) s += String(r.readBits(7)).padStart(2, '0');
        else if (rem === 1) s += String(r.readBits(4));
        out.push({ kind: 'numeric', value: s });
        break;
      }
      case MODE_C64: {
        const count = r.readBits(14);
        let s = '';
        for (let i = 0; i < count; i++) {
          if (r.remaining < 6) throw new SegmentDecodeError('truncated C64');
          const c = r.readBits(6);
          if (c === C64_ESCAPE) {
            const bytes: number[] = [];
            const b0 = r.readBits(8);
            bytes.push(b0);
            const extra = b0 >= 0xf0 ? 3 : b0 >= 0xe0 ? 2 : b0 >= 0xc0 ? 1 : 0;
            for (let k = 0; k < extra; k++) bytes.push(r.readBits(8));
            s += utf8Decode(Uint8Array.from(bytes));
          } else s += C64[c] ?? '\uFFFD';
        }
        out.push({ kind: 'c64', value: s });
        break;
      }
      case MODE_TEXT: {
        const count = r.readBits(16);
        if (r.remaining < count * 8) throw new SegmentDecodeError('truncated TEXT');
        out.push({ kind: 'text', value: utf8Decode(r.readBytes(count)) });
        break;
      }
      case MODE_BYTE: {
        const count = r.readBits(16);
        if (r.remaining < count * 8) throw new SegmentDecodeError('truncated BYTE');
        out.push({ kind: 'byte', value: r.readBytes(count) });
        break;
      }
      case MODE_URL: {
        const scheme = r.readBits(3);
        if (scheme > 1) throw new SegmentDecodeError('reserved URL scheme');
        const authLen = r.readBits(8);
        let v = authLen > 0 ? r.readBigInt(authBits(authLen)) : 0n;
        let authority = '';
        for (let i = authLen - 1; i >= 0; i--) {
          authority = (AUTH39[Number(v % 39n)] as string) + authority;
          v /= 39n;
        }
        const bodyLen = r.readBits(14);
        let body = '';
        let upper = false;
        for (let i = 0; i < bodyLen; i++) {
          if (r.remaining < 6) throw new SegmentDecodeError('truncated URL body');
          let c = r.readBits(6);
          if (c === U64_ESCAPE) {
            const bytes: number[] = [];
            const b0 = r.readBits(8);
            bytes.push(b0);
            const extra = b0 >= 0xf0 ? 3 : b0 >= 0xe0 ? 2 : b0 >= 0xc0 ? 1 : 0;
            for (let k = 0; k < extra; k++) bytes.push(r.readBits(8));
            body += utf8Decode(Uint8Array.from(bytes));
            continue;
          }
          if (c === U64_UPPER_SHIFT) {
            if (upper) throw new SegmentDecodeError('doubled upper-shift in URL body');
            upper = true;
            i--; // the shift itself does not consume a character
            continue;
          }
          if (upper && c < 26) {
            body += String.fromCharCode(65 + c);
            upper = false;
            continue;
          }
          upper = false;
          body += U64[c] ?? '\uFFFD';
        }
        out.push({ kind: 'url', value: `${scheme === 0 ? 'https' : 'http'}://${authority}${body}` });
        break;
      }
      case MODE_GEO: {
        const lat = r.readBits(32) | 0;
        const lon = r.readBits(32) | 0;
        const alt = r.readBits(16) - 1000;
        const flags = r.readBits(8);
        out.push({ kind: 'geo', value: { lat: lat / 1e7, lon: lon / 1e7, alt, flags } });
        break;
      }
      case MODE_FRAME: {
        out.push({ kind: 'frame', streamId: r.readBits(32), index: r.readBits(12), count: r.readBits(12) });
        break;
      }
      case MODE_MAC:
      case MODE_SIGNATURE: {
        const algo = r.readBits(4);
        const count = r.readBits(12);
        if (r.remaining < count * 8) throw new SegmentDecodeError('truncated MAC/SIGNATURE');
        const value = r.readBytes(count);
        out.push(mode === MODE_MAC ? { kind: 'mac', algo, value } : { kind: 'signature', algo, value });
        break;
      }
      case MODE_VENDOR: {
        const id = r.readBits(16);
        const count = r.readBits(16);
        if (r.remaining < count * 8) throw new SegmentDecodeError('truncated VENDOR');
        out.push({ kind: 'vendor', id, value: r.readBytes(count) });
        break;
      }
      case MODE_SECURE: {
        const suite = r.readBits(4);
        const flags = r.readBits(4);
        const saltLen = r.readBits(8);
        if (r.remaining < saltLen * 8) throw new SegmentDecodeError('truncated SECURE salt');
        const salt = r.readBytes(saltLen);
        const iterations = r.readBits(32);
        const keyIdLen = r.readBits(4);
        if (r.remaining < keyIdLen * 8) throw new SegmentDecodeError('truncated SECURE key id');
        const keyId = r.readBytes(keyIdLen);
        if (r.remaining < 96) throw new SegmentDecodeError('truncated SECURE nonce');
        const nonce = r.readBytes(12);
        const ctLen = r.readBits(16);
        if (r.remaining < ctLen * 8) throw new SegmentDecodeError('truncated SECURE ciphertext');
        out.push({ kind: 'secure', suite, flags, salt, iterations, keyId, nonce, ciphertext: r.readBytes(ctLen) });
        break;
      }
      default:
        throw new SegmentDecodeError(`reserved mode ${mode}`);
    }
  }
  return out;
}

/* ----------------------------------------------- automatic mode selection */

const MAX_SEGMENT_SCAN = 1024;

/**
 * Choose the cheapest segmentation of `text` by dynamic programming over
 * NUMERIC / C64 / TEXT candidates for every substring length.
 */
export function autoSegments(text: string, preferUrl = true): Segment[] {
  if (text.length === 0) return [];
  if (preferUrl) {
    const parts = urlSplit(text.trim());
    if (parts) {
      const seg: Segment = { kind: 'url', value: text.trim() };
      if (segmentBits(seg) <= segmentBits({ kind: 'text', value: text })) return [seg];
    }
  }
  const chars = Array.from(text);
  const n = chars.length;
  const utf8Len = chars.map((c) => utf8Encode(c).length);
  const isDigit = chars.map((c) => c >= '0' && c <= '9');

  const INF = Number.POSITIVE_INFINITY;
  const cost = new Float64Array(n + 1).fill(INF);
  const choice = new Array<{ j: number; seg: Segment } | null>(n + 1).fill(null);
  cost[n] = 0;

  for (let i = n - 1; i >= 0; i--) {
    let c64 = 4 + 14;
    let txt = 4 + 16;
    let num = 4 + 14;
    let allDigits = true;
    for (let j = i; j < Math.min(n, i + MAX_SEGMENT_SCAN); j++) {
      const ch = chars[j] as string;
      // The escape must be charged for every UTF-8 byte of the character, or
      // the DP will happily pick C64 for Persian and CJK text that TEXT carries
      // more cheaply -- and segmentBits(), which sizes the version, would then
      // disagree with the choice that was actually made.
      c64 += c64Index.has(ch) ? 6 : 6 + 8 * (utf8Len[j] as number);
      txt += 8 * (utf8Len[j] as number);
      if (!(isDigit[j] as boolean)) allDigits = false;
      if (allDigits) {
        const digits = j - i + 1;
        const cand = num + numericBits(digits) + (cost[j + 1] as number);
        if (cand < (cost[i] as number)) {
          cost[i] = cand;
          choice[i] = { j: j + 1, seg: { kind: 'numeric', value: chars.slice(i, j + 1).join('') } };
        }
      }
      if (c64 + (cost[j + 1] as number) < (cost[i] as number)) {
        cost[i] = c64 + (cost[j + 1] as number);
        choice[i] = { j: j + 1, seg: { kind: 'c64', value: chars.slice(i, j + 1).join('') } };
      }
      if (txt + (cost[j + 1] as number) < (cost[i] as number)) {
        cost[i] = txt + (cost[j + 1] as number);
        choice[i] = { j: j + 1, seg: { kind: 'text', value: chars.slice(i, j + 1).join('') } };
      }
      // Both C64 and TEXT grow monotonically with the substring length and
      // cost[j+1] >= 0, so once both exceed the best total found so far no
      // longer substring can win. This turns the DP from O(n^2) into ~O(n).
      const numCand = allDigits ? num + numericBits(j - i + 1) : INF;
      if (c64 >= (cost[i] as number) && txt >= (cost[i] as number) && numCand >= (cost[i] as number)) break;
    }
  }

  const out: Segment[] = [];
  let i = 0;
  while (i < n) {
    const c = choice[i];
    if (!c) {
      out.push({ kind: 'text', value: chars.slice(i).join('') });
      break;
    }
    out.push(c.seg);
    i = c.j;
  }
  return out;
}

/* ----------------------------------------------------- payload byte blocks */

export const PAD_BYTE_1 = 0xec;
export const PAD_BYTE_2 = 0x11;

/**
 * Minimal serialisation: the segments plus a 4-bit terminator, zero-padded to a
 * byte boundary and nothing more. This is exactly the byte string that gets
 * DEFLATE-compressed when the compression flag is used, and exactly what the
 * inflater hands to the segment parser.
 */
export function segmentsToBytes(segments: Segment[]): Uint8Array {
  const w = new BitWriter();
  for (const s of segments) writeSegment(w, s);
  for (let i = 0; i < 4; i++) w.writeBit(0); // TERMINATOR
  while (w.length % 8 !== 0) w.writeBit(0);
  return w.toBytes();
}

/** Serialise segments into exactly `payloadBytes` bytes (terminator + padding). */
export function encodePayloadBytes(segments: Segment[], payloadBytes: number): Uint8Array {
  const w = new BitWriter();
  for (const s of segments) writeSegment(w, s);
  const capacityBits = payloadBytes * 8;
  if (w.length > capacityBits) {
    throw new RangeError(`payload needs ${w.length} bits but only ${capacityBits} are available`);
  }
  // terminator: as many of the 4 zero bits as still fit
  const term = Math.min(4, capacityBits - w.length);
  for (let i = 0; i < term; i++) w.writeBit(0);
  // pad to a byte boundary
  while (w.length % 8 !== 0 && w.length < capacityBits) w.writeBit(0);
  const bytes = w.toBytes();
  const out = new Uint8Array(payloadBytes);
  out.set(bytes.subarray(0, Math.min(bytes.length, payloadBytes)));
  let p = bytes.length;
  let toggle = 0;
  while (p < payloadBytes) out[p++] = toggle++ % 2 === 0 ? PAD_BYTE_1 : PAD_BYTE_2;
  return out;
}

/** Parse the segment stream out of a decoded payload block. */
export function decodePayloadBytes(bytes: Uint8Array): Payload {
  const r = new BitReader(bytes);
  const segments = readSegments(r);
  return { segments };
}

/** Human-readable rendering of a payload. */
export function payloadToText(p: Payload): string {
  return p.segments
    .map((s) => {
      switch (s.kind) {
        case 'numeric':
        case 'c64':
        case 'text':
        case 'url':
          return s.value;
        case 'byte':
          return `[${s.value.length} bytes]`;
        case 'geo':
          return `geo:${s.value.lat},${s.value.lon}${s.value.alt !== -1000 ? `?alt=${s.value.alt}` : ''}`;
        case 'frame':
          return `[frame ${s.index + 1}/${s.count}]`;
        case 'mac':
          return `[mac:${s.algo} ${s.value.length}B]`;
        case 'signature':
          return `[sig:${s.algo} ${s.value.length}B]`;
        case 'vendor':
          return `[vendor:${s.id} ${s.value.length}B]`;
        case 'secure':
          return `[encrypted:${s.keyId.length ? hexEncode(s.keyId) : 'no-id'} ${s.ciphertext.length - AEAD_TAG_BYTES}B]`;
      }
    })
    .join('');
}

/**
 * Split a byte buffer into `count` frames for multi-code streams. Each frame
 * gets a FRAME segment header so a reader can reassemble out of order and
 * detect missing frames.
 */
export function frameSegments(streamId: number, index: number, count: number, data: Segment[]): Segment[] {
  return [{ kind: 'frame', streamId, index, count }, ...data];
}

/* --------------------------------------------------------- secure envelope */

/** Passphrase key agreement: PBKDF2-HMAC-SHA256, then ChaCha20-Poly1305. */
export const SECURE_SUITE_PBKDF2 = 0;
/** Direct key: a 32-byte symmetric key, then ChaCha20-Poly1305. */
export const SECURE_SUITE_RAW = 1;

/**
 * Domain separator for the authenticated additional data. Frozen forever: the
 * AAD must never contain anything a future reader would compute differently
 * (no spec version, no date), or symbols printed today would stop opening.
 */
export const SECURE_AAD_DOMAIN = 'SMC1-SECURE';

export type SecureSegment = Extract<Segment, { kind: 'secure' }>;

export interface SecureEncodeOptions {
  /** Passphrase (suite 0) or a 32-byte key (suite 1). */
  key: string | Uint8Array;
  /** Public key identifier, printed in the symbol. Default: derived from the key. */
  keyId?: Uint8Array;
  /** PBKDF2 salt. Default: 16 random bytes. Ignored by suite 1. */
  salt?: Uint8Array;
  /** PBKDF2 cost. Default `PBKDF2_ITERATIONS`. Stored as 0 by suite 1. */
  iterations?: number;
  /** 12-byte AEAD nonce. Default: random. Never reuse one under the same key. */
  nonce?: Uint8Array;
  /** Compress the plaintext before encrypting (raw DEFLATE, inside the envelope). Default: true. */
  compress?: boolean;
  /**
   * Authenticated but *not printed*: binds the ciphertext to out-of-band data
   * (an invoice number, a device serial, a date). A reader must supply the same
   * string or the tag will not verify.
   */
  context?: string | Uint8Array;
}

export interface SecureDecodeOptions {
  /** A single passphrase or 32-byte key. */
  key?: string | Uint8Array;
  /** A keyring: the reader picks by the printed key id. */
  keys?: { keyId?: Uint8Array; key: string | Uint8Array }[];
  /** Must match the encoder's `context`. */
  context?: string | Uint8Array;
}

function toBytes(v: string | Uint8Array): Uint8Array {
  return typeof v === 'string' ? utf8Encode(v) : v;
}

/** The authenticated additional data for one envelope. */
export function secureAad(seg: SecureSegment, context?: string | Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [
    utf8Encode(SECURE_AAD_DOMAIN),
    Uint8Array.from([seg.suite & 0xff, seg.keyId.length & 0xff]),
    seg.keyId,
    seg.nonce,
  ];
  if (context !== undefined) parts.push(toBytes(context));
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
 * Turn the envelope's key-agreement fields into a 32-byte AEAD key.
 *
 * A 32-byte array is accepted for *both* suites and means "already derived":
 * the caller ran PBKDF2 itself (node:crypto, WebCrypto -- both ~100x faster than
 * the portable implementation) and hands over the result. That is the path a
 * scanner app should take; the passphrase path stays available for callers that
 * want the whole thing done for them.
 */
export function expandSecureKey(seg: SecureSegment, key: string | Uint8Array): Uint8Array | null {
  if (typeof key !== 'string' && key.length === AEAD_KEY_BYTES) return key;
  if (seg.suite === SECURE_SUITE_RAW) {
    return null; // a raw-key envelope needs exactly 32 bytes, handled above
  }
  if (seg.suite === SECURE_SUITE_PBKDF2) {
    const d = deriveKey(toBytes(key), seg.salt, Math.max(1, seg.iterations));
    return d.key;
  }
  return null; // unknown suite: refuse rather than guess
}

/** Wrap a segment list into one encrypted envelope segment. */
export const SECURE_FLAG_DEFLATE = 1;

export function wrapSecure(inner: Segment[], opt: SecureEncodeOptions): SecureSegment {
  /*
   * Compress *before* encrypting. After encryption the bytes are indistinguishable
   * from noise and DEFLATE cannot help; before, a paragraph of prose shrinks ~4x
   * and the whole symbol drops several versions. The flag travels in the envelope
   * header, so the outer format's compression bit stays 0 for encrypted payloads.
   */
  const plain = segmentsToBytes(inner);
  const deflated = opt.compress !== false ? deflateIfSmaller(plain) : null;
  const plaintext = deflated ?? plain;
  const raw = typeof opt.key !== 'string';
  let suite: number;
  let salt: Uint8Array;
  let iterations: number;
  let key: Uint8Array;
  let keyId: Uint8Array;

  if (raw) {
    const bytes = opt.key as Uint8Array;
    if (bytes.length !== AEAD_KEY_BYTES) {
      throw new RangeError(`a raw SECURE key must be exactly ${AEAD_KEY_BYTES} bytes, got ${bytes.length}`);
    }
    suite = SECURE_SUITE_RAW;
    salt = new Uint8Array(0);
    iterations = 0;
    key = bytes;
    keyId = opt.keyId ?? Uint8Array.from(hmacSha256(utf8Encode(SECURE_AAD_DOMAIN), key).subarray(0, 4));
  } else {
    suite = SECURE_SUITE_PBKDF2;
    salt = opt.salt ?? randomSalt();
    iterations = opt.iterations ?? PBKDF2_ITERATIONS;
    const d = deriveKey(opt.key as string, salt, iterations);
    key = d.key;
    keyId = opt.keyId ?? d.keyId;
  }

  const nonce = opt.nonce ?? randomNonce();
  if (nonce.length !== AEAD_NONCE_BYTES) throw new RangeError('SECURE nonce must be 12 bytes');
  const seg: SecureSegment = { kind: 'secure', suite, flags: deflated ? SECURE_FLAG_DEFLATE : 0, salt, iterations, keyId, nonce, ciphertext: new Uint8Array(0) };
  seg.ciphertext = aeadEncrypt(key, nonce, plaintext, secureAad(seg, opt.context));
  return seg;
}

/**
 * Open an envelope. Returns the inner segments, or null when no supplied key
 * authenticates -- a wrong key and a tampered symbol are, by design, the same
 * answer: nothing.
 */
export function unwrapSecure(seg: SecureSegment, opt: SecureDecodeOptions = {}): Segment[] | null {
  const candidates: (string | Uint8Array)[] = [];
  if (opt.key !== undefined) candidates.push(opt.key);
  for (const k of opt.keys ?? []) {
    // A keyring entry that declares an id is only tried if the id matches; an
    // entry without one is a wildcard (useful for "there is only ever one key").
    if (!k.keyId || k.keyId.length === 0 || sameBytes(k.keyId, seg.keyId)) candidates.push(k.key);
  }
  for (const candidate of candidates) {
    const key = expandSecureKey(seg, candidate);
    if (!key) continue;
    const sealed = aeadDecrypt(key, seg.nonce, seg.ciphertext, secureAad(seg, opt.context));
    if (!sealed) continue;
    const plaintext = seg.flags & SECURE_FLAG_DEFLATE ? inflateRaw(sealed, { maxOutput: 1 << 24 }) : sealed;
    try {
      return readSegments(new BitReader(plaintext));
    } catch {
      // The tag verified but the plaintext is not a valid segment stream: the
      // envelope was made by something else. Keep trying the remaining keys.
      continue;
    }
  }
  return null;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Derive a key with the platform's native PBKDF2 when it is available.
 *
 * The synchronous pure-TypeScript path is correct but costs ~1 s at the default
 * 210 000 iterations, which is unacceptable in a scanner that unlocks dozens of
 * symbols a minute. Browsers and Node 19+ both expose WebCrypto, whose PBKDF2 is
 * native; an app should derive once, cache the 32 bytes, and hand *those* to the
 * decoder (suite 1 accepts a raw key directly).
 */
export async function deriveKeyAsync(
  passphrase: string | Uint8Array,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    const d = deriveKey(passphrase, salt, iterations);
    return d.key;
  }
  // Copy into exact-length ArrayBuffers: WebCrypto's BufferSource type does not
  // accept a Uint8Array that might be a view over a larger or shared buffer.
  const material = Uint8Array.from(toBytes(passphrase)).buffer as ArrayBuffer;
  const saltBuffer = Uint8Array.from(salt).buffer as ArrayBuffer;
  const keyMaterial = await subtle.importKey('raw', material, 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBuffer, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}
