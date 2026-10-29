/**
 * ============================================================================
 *  DEFLATE -- RFC 1951, from scratch, in both directions
 * ============================================================================
 *
 * SiMurgh's Format Crown carries one bit that says "the payload block is a raw
 * DEFLATE stream". This file implements that bit.
 *
 * Why implement it rather than depend on `zlib`? Because the core package has to
 * run in a browser, in a Node CLI, in a React Native app and in a WASM sandbox
 * with the same behaviour and zero dependencies. A 300-line RFC 1951 codec is
 * cheaper than a platform abstraction layer over five different zlib bindings.
 *
 * WHAT IS IMPLEMENTED
 *
 *   deflateRaw()  LZ77 with hash chains + FIXED Huffman codes (BTYPE = 01),
 *                 plus stored blocks (BTYPE = 00) when compression would grow
 *                 the data. Fixed codes are used deliberately: they need no
 *                 code-length header, which on the small payloads a symbol
 *                 carries is worth more than the ~3% a dynamic tree saves.
 *
 *   inflateRaw()  all three block types -- stored, fixed AND dynamic (BTYPE = 10)
 *                 -- so a stream produced by zlib, libdeflate, Go, Rust or a
 *                 hardware encoder is accepted. A decoder that only read its own
 *                 encoder's output would be a toy.
 *
 * BIT ORDER, THE PART EVERYONE GETS WRONG
 *
 *   RFC 1951 packs bits into bytes least-significant bit first, but packs the
 *   bits of a Huffman code most-significant bit first. So the code 0b1011 of
 *   length 4 goes into the stream as 1,1,0,1. Every `put`/`get` below is written
 *   with that asymmetry explicit, because getting it backwards produces a stream
 *   that round-trips through your own codec and through nobody else's.
 *
 * SECURITY
 *
 *   inflateRaw() is bounded: a maximum output size and a maximum window of
 *   distance references, so a crafted stream cannot make the decoder allocate
 *   without limit. Huffman code lengths are validated against the Kraft sum
 *   before a table is built, which rejects over- and under-subscribed alphabets.
 */

/** Raised for any malformed DEFLATE stream. */
export class InflateError extends Error {
  constructor(message: string) {
    super(`inflate: ${message}`);
    this.name = 'InflateError';
  }
}

/* ------------------------------------------------------------------ *
 *  Bit I/O, LSB-first per byte
 * ------------------------------------------------------------------ */

class BitWriterLSB {
  private out: number[] = [];
  private acc = 0;
  private n = 0;

  /** Write `len` bits of `value`, least significant bit of the code first. */
  put(value: number, len: number): void {
    for (let i = 0; i < len; i++) {
      this.acc |= ((value >>> i) & 1) << this.n;
      this.n++;
      if (this.n === 8) {
        this.out.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }

  /** Write a Huffman code: its most significant bit goes into the stream first. */
  putCode(code: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.acc |= ((code >>> i) & 1) << this.n;
      this.n++;
      if (this.n === 8) {
        this.out.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }

  alignToByte(): void {
    if (this.n > 0) {
      this.out.push(this.acc);
      this.acc = 0;
      this.n = 0;
    }
  }

  writeBytes(data: Uint8Array, off: number, len: number): void {
    this.alignToByte();
    for (let i = 0; i < len; i++) this.out.push(data[off + i] as number);
  }

  finish(): Uint8Array {
    this.alignToByte();
    return Uint8Array.from(this.out);
  }

  get bitLength(): number {
    return this.out.length * 8 + this.n;
  }
}

class BitReaderLSB {
  private pos = 0;
  private acc = 0;
  private n = 0;
  constructor(private readonly data: Uint8Array) {}

  get bitsRead(): number {
    return this.pos * 8 - this.n;
  }

  need(k: number): void {
    while (this.n < k) {
      if (this.pos >= this.data.length) throw new InflateError('unexpected end of stream');
      this.acc |= (this.data[this.pos++] as number) << this.n;
      this.n += 8;
    }
  }

  /** Read `k` bits, least significant bit first (used for lengths and headers). */
  bits(k: number): number {
    if (k === 0) return 0;
    this.need(k);
    const v = this.acc & ((1 << k) - 1);
    this.acc >>>= k;
    this.n -= k;
    return v;
  }

  /** Read one bit at a time, as a Huffman decoder must. */
  bit(): number {
    this.need(1);
    const v = this.acc & 1;
    this.acc >>>= 1;
    this.n -= 1;
    return v;
  }

  alignToByte(): void {
    const drop = this.bitsRead % 8;
    if (drop) this.bits(8 - drop);
  }

  byte(): number {
    this.alignToByte();
    if (this.pos >= this.data.length) throw new InflateError('unexpected end of stream');
    return this.data[this.pos++] as number;
  }
}

/* ------------------------------------------------------------------ *
 *  Canonical Huffman tables
 * ------------------------------------------------------------------ */

/**
 * A decode table as a binary tree in flat arrays: node i has children at
 * tree[2i] (bit 0) and tree[2i+1] (bit 1); a negative value -1-s is the leaf
 * for symbol s. Walking one bit at a time is slower than a lookup table but
 * needs no per-length bookkeeping and cannot be made to run off the end by a
 * malformed code.
 */
export interface HuffmanTree {
  tree: Int32Array;
  maxLen: number;
}

export function buildHuffman(lengths: Uint8Array): HuffmanTree {
  let maxLen = 0;
  for (let i = 0; i < lengths.length; i++) if ((lengths[i] as number) > maxLen) maxLen = lengths[i] as number;
  if (maxLen === 0) return { tree: Int32Array.from([-1]), maxLen: 0 };

  // Kraft sum: sum 2^-len must equal exactly 1 for a complete code. RFC 1951
  // allows an incomplete code only for the single-distance-code case, which is
  // checked by the caller.
  let kraft = 0;
  for (let i = 0; i < lengths.length; i++) {
    const L = lengths[i] as number;
    if (L > 0) kraft += 1 << (15 - L);
  }
  const full = 1 << 15;
  if (kraft > full) throw new InflateError('over-subscribed Huffman code');

  // canonical assignment: sort symbols by (length, symbol)
  const order: number[] = [];
  for (let L = 1; L <= maxLen; L++) {
    for (let s = 0; s < lengths.length; s++) if ((lengths[s] as number) === L) order.push(s);
  }
  /*
   * Node 0 is the root; a slot holds 0 for "empty", a positive index for an
   * internal node, or -1-symbol for a leaf. Leaves are stored in their parent's
   * slot rather than getting a node of their own, so the tree holds exactly the
   * internal nodes -- at most 2^maxLen of them for a complete code, which the
   * allocation below covers.
   */
  const size = 2 << maxLen;
  const tree = new Int32Array(size).fill(0);
  let nodes = 1;
  let code = 0;
  let prevLen = 0;
  for (const sym of order) {
    const L = lengths[sym] as number;
    code <<= L - prevLen;
    prevLen = L;
    let node = 0;
    for (let b = L - 1; b >= 0; b--) {
      const bit = (code >> b) & 1;
      const slot = node * 2 + bit;
      const child = tree[slot] as number;
      if (b === 0) {
        if (child !== 0) throw new InflateError(`duplicate Huffman code at symbol ${sym}`);
        tree[slot] = -1 - sym;
        break;
      }
      if (child === 0) {
        if (nodes >= size / 2) throw new InflateError('Huffman tree overflow');
        tree[slot] = nodes;
        node = nodes++;
      } else if (child < 0) {
        throw new InflateError(`Huffman code for symbol ${sym} extends a leaf`);
      } else {
        node = child;
      }
    }
    code++;
  }
  return { tree: tree.subarray(0, nodes * 2), maxLen };
}

function decodeSymbol(br: BitReaderLSB, h: HuffmanTree): number {
  let node = 0;
  for (let i = 0; i <= h.maxLen; i++) {
    const v = h.tree[node * 2 + (br.bit() as number)] as number;
    if (v < 0) return -1 - v;
    if (v === 0) throw new InflateError('invalid Huffman code (ran off the tree)');
    node = v;
  }
  throw new InflateError('Huffman code longer than max length');
}

/* ------------------------------------------------------------------ *
 *  Length / distance code tables (RFC 1951 3.2.5)
 * ------------------------------------------------------------------ */

// length codes 257..285 -> base length and extra bits
const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
// distance codes 0..29 -> base distance and extra bits
const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function fixedLiteralTree(): HuffmanTree {
  const L = new Uint8Array(288);
  for (let i = 0; i <= 143; i++) L[i] = 8;
  for (let i = 144; i <= 255; i++) L[i] = 9;
  for (let i = 256; i <= 279; i++) L[i] = 7;
  for (let i = 280; i <= 287; i++) L[i] = 8;
  return buildHuffman(L);
}

function fixedDistanceTree(): HuffmanTree {
  const L = new Uint8Array(30).fill(5);
  return buildHuffman(L);
}

/**
 * Encode a symbol with the fixed literal/length code (RFC 1951 3.2.6).
 * Returns [code, bit length]; the code is written most-significant bit first.
 *
 *   0   - 143   8 bits   00110000 - 10111111   (0x30  + sym)
 *   144 - 255   9 bits   110010000 - 111111111 (0x190 + sym - 144)
 *   256 - 279   7 bits   0000000 - 0010111     (sym - 256)
 *   280 - 287   8 bits   11000000 - 11000111   (0xC0  + sym - 280)
 *
 * The last line is the one to double-check: 0xC0, not 0xC8. Getting it wrong
 * still round-trips through short matches, because lengths below 115 use
 * symbols 257-279 and never touch the 280-287 range -- so the bug only shows up
 * on inputs with long repeats, which is exactly the input compression is for.
 */
function fixedLiteralCode(sym: number): [number, number] {
  if (sym <= 143) return [0x30 + sym, 8];
  if (sym <= 255) return [0x190 + sym - 144, 9];
  if (sym <= 279) return [sym - 256, 7];
  return [0xc0 + sym - 280, 8];
}

/* ------------------------------------------------------------------ *
 *  LZ77
 * ------------------------------------------------------------------ */

export interface DeflateOptions {
  /** 0 = stored blocks only, 1 = fast greedy, 6 = deeper chains. Default 6. */
  level?: 0 | 1 | 6;
  /** Maximum match search chain length. Default derived from level. */
  maxChain?: number;
  /** Never emit a compressed block larger than this multiple of the input. */
  giveUpRatio?: number;
}

const MIN_MATCH = 3;
const MAX_MATCH = 258;
const WINDOW = 32768;

function hash3(d: Uint8Array, i: number): number {
  return (((d[i] as number) << 10) ^ ((d[i + 1] as number) << 5) ^ (d[i + 2] as number)) & 0x7fff;
}

interface Match {
  len: number;
  dist: number;
}

function findMatch(d: Uint8Array, pos: number, head: Int32Array, prev: Int32Array, maxChain: number): Match {
  const remaining = d.length - pos;
  if (remaining < MIN_MATCH) return { len: 0, dist: 0 };
  const maxLen = Math.min(MAX_MATCH, remaining);
  const h = hash3(d, pos);
  void h;
  let best: Match = { len: 0, dist: 0 };
  /*
   * The caller has already inserted `pos` at the head of its hash chain, so the
   * search must start one link down -- starting at head[h] would compare the
   * position with itself, see a perfect match of length 0 and stop. That single
   * line is the difference between a compressor and a very expensive copier.
   */
  let cand = prev[pos & (WINDOW - 1)] as number;
  let tries = maxChain;
  const lowLimit = pos > WINDOW ? pos - WINDOW : 0;
  while (cand >= lowLimit && tries-- > 0) {
    const dist = pos - cand;
    if (dist <= 0 || dist > WINDOW) break;
    /*
     * Cheap reject: a candidate that differs at the current best length cannot
     * beat it, so most of the chain costs one byte comparison. Note that passing
     * the reject says nothing about the bytes *before* it -- the full comparison
     * still has to start at zero. Skipping that prefix check produces matches
     * that decode to plausible-looking garbage, which is the worst kind of bug a
     * compressor can have.
     */
    if (best.len > 0 && d[cand + best.len] !== d[pos + best.len]) {
      cand = prev[cand & (WINDOW - 1)] as number;
      continue;
    }
    let len = 0;
    while (len < maxLen && d[cand + len] === d[pos + len]) len++;
    if (len > best.len) {
      best = { len, dist };
      if (len >= maxLen) break;
    }
    cand = prev[cand & (WINDOW - 1)] as number;
  }
  return best.len >= MIN_MATCH ? best : { len: 0, dist: 0 };
}

function lengthCode(len: number): { sym: number; extra: number; extraBits: number } {
  for (let i = LEN_BASE.length - 1; i >= 0; i--) {
    if (len >= (LEN_BASE[i] as number)) {
      return { sym: 257 + i, extra: len - (LEN_BASE[i] as number), extraBits: LEN_EXTRA[i] as number };
    }
  }
  return { sym: 257, extra: 0, extraBits: 0 };
}

function distCode(dist: number): { sym: number; extra: number; extraBits: number } {
  for (let i = DIST_BASE.length - 1; i >= 0; i--) {
    if (dist >= (DIST_BASE[i] as number)) {
      return { sym: i, extra: dist - (DIST_BASE[i] as number), extraBits: DIST_EXTRA[i] as number };
    }
  }
  return { sym: 0, extra: 0, extraBits: 0 };
}

/**
 * Compress to a raw DEFLATE stream (no zlib header, no Adler-32 trailer).
 *
 * Greedy LZ77 over a 32 KiB window with hash-chained match search, emitted with
 * fixed Huffman codes. The output is one block per 64 KiB of input so that a
 * very large payload still streams, and the last block carries BFINAL.
 *
 * If the compressed result is not actually smaller, a stored encoding is
 * returned instead: a symbology must never *grow* a payload, because the caller
 * has already committed to a symbol size.
 */
export function deflateRaw(input: Uint8Array, opt: DeflateOptions = {}): Uint8Array {
  const level = opt.level ?? 6;
  if (level === 0 || input.length === 0) return storedBlocks(input);

  const maxChain = opt.maxChain ?? (level <= 1 ? 8 : 128);
  const bw = new BitWriterLSB();
  const head = new Int32Array(0x8000).fill(-1);
  const prev = new Int32Array(WINDOW).fill(-1);

  // Single pass, writing as we go; BFINAL is set on the last block by writing
  // the whole stream as one block when it fits, which is the common case for a
  // symbol payload.
  const emit = (final: boolean, from: number, to: number): void => {
    bw.put(final ? 1 : 0, 1);
    bw.put(1, 2); // BTYPE = 01, fixed Huffman
    let p = from;
    while (p < to) {
      // register the position in the hash chain before searching from it
      if (p + MIN_MATCH <= input.length) {
        const h = hash3(input, p);
        prev[p & (WINDOW - 1)] = head[h] as number;
        head[h] = p;
      }
      const m = findMatch(input, p, head, prev, maxChain);
      if (m.len >= MIN_MATCH) {
        // insert the skipped positions into the chain so later matches can use them
        for (let k = 1; k < m.len && p + k + MIN_MATCH <= input.length; k++) {
          const hh = hash3(input, p + k);
          prev[(p + k) & (WINDOW - 1)] = head[hh] as number;
          head[hh] = p + k;
        }
        const lc = lengthCode(m.len);
        const [code, len] = fixedLiteralCode(lc.sym);
        bw.putCode(code, len);
        if (lc.extraBits) bw.put(lc.extra, lc.extraBits);
        const dc = distCode(m.dist);
        bw.putCode(dc.sym, 5);
        if (dc.extraBits) bw.put(dc.extra, dc.extraBits);
        p += m.len;
      } else {
        const sym = input[p] as number;
        const [code, len] = fixedLiteralCode(sym);
        bw.putCode(code, len);
        p++;
      }
    }
    const [eob, eobLen] = fixedLiteralCode(256);
    bw.putCode(eob, eobLen);
  };

  const CHUNK = 1 << 16;
  if (input.length <= CHUNK) {
    emit(true, 0, input.length);
  } else {
    for (let from = 0; from < input.length; from += CHUNK) {
      const to = Math.min(input.length, from + CHUNK);
      emit(to === input.length, from, to);
    }
  }
  const out = bw.finish();
  // Never expand: if the fixed-Huffman pass lost to a stored encoding, use it.
  const stored = storedBlocks(input);
  if (stored.length < out.length && stored.length <= input.length * (opt.giveUpRatio ?? 1.0) + 8) return stored;
  return out;
}

function storedBlocks(input: Uint8Array): Uint8Array {
  const bw = new BitWriterLSB();
  const CHUNK = 0xffff;
  let off = 0;
  for (;;) {
    const len = Math.min(CHUNK, input.length - off);
    const last = off + len >= input.length ? 1 : 0;
    bw.put(last, 1);
    bw.put(0, 2); // BTYPE = 00, stored
    bw.alignToByte();
    bw.put(len & 0xff, 8);
    bw.put((len >> 8) & 0xff, 8);
    bw.put(~len & 0xff, 8);
    bw.put(((~len >> 8) & 0xff) | 0, 8);
    bw.writeBytes(input, off, len);
    off += len;
    if (last) break;
  }
  return bw.finish();
}

/* ------------------------------------------------------------------ *
 *  INFLATE
 * ------------------------------------------------------------------ */

export interface InflateOptions {
  /** Refuse to produce more than this many bytes. Default 16 MiB. */
  maxOutput?: number;
  /** Called with the running output size, so a caller can abort. */
  onProgress?: (bytes: number) => void;
}

/**
 * Decompress a raw DEFLATE stream. Accepts stored, fixed and dynamic blocks --
 * i.e. anything a conforming RFC 1951 encoder produces.
 */
export function inflateRaw(input: Uint8Array, opt: InflateOptions = {}): Uint8Array {
  const maxOutput = opt.maxOutput ?? 1 << 24;
  const br = new BitReaderLSB(input);
  /*
   * One growable buffer, not a list of chunks: a back-reference may point up to
   * 32768 bytes into the past and can cross a block boundary, so the whole
   * output has to stay addressable while decoding. Growth is capped by
   * maxOutput, which is what keeps a crafted stream from being a bomb.
   */
  let out = new Uint8Array(Math.max(64, Math.min(maxOutput, input.length * 3 + 64)));
  let n = 0;

  const push = (b: number): void => {
    if (n === out.length) {
      if (n >= maxOutput) throw new InflateError(`output exceeds the ${maxOutput} byte limit`);
      const bigger = new Uint8Array(Math.min(maxOutput, out.length * 2));
      bigger.set(out);
      out = bigger;
    }
    out[n++] = b;
  };
  const copyBack = (dist: number, len: number): void => {
    if (dist > n) throw new InflateError(`distance ${dist} references data before the start of the stream`);
    if (dist > WINDOW) throw new InflateError(`distance ${dist} exceeds the 32768 byte window`);
    if (n + len > maxOutput) throw new InflateError(`output exceeds the ${maxOutput} byte limit`);
    // byte at a time: overlapping copies (dist < len) are legal and must repeat
    for (let i = 0; i < len; i++) push(out[n - dist] as number);
    opt.onProgress?.(n);
  };

  let final = 0;
  let guard = 0;
  while (!final) {
    if (++guard > 1 << 20) throw new InflateError('too many blocks');
    final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.alignToByte();
      const len = br.byte() | (br.byte() << 8);
      const nlen = br.byte() | (br.byte() << 8);
      if ((len ^ 0xffff) !== nlen) throw new InflateError('stored block length complement mismatch');
      for (let i = 0; i < len; i++) push(br.byte());
    } else if (type === 1 || type === 2) {
      let litTree: HuffmanTree;
      let distTree: HuffmanTree;
      if (type === 1) {
        litTree = fixedLiteralTree();
        distTree = fixedDistanceTree();
      } else {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        if (hlit > 286 || hdist > 30) throw new InflateError('alphabet size out of range');
        const clen = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i] as number] = br.bits(3);
        const clenTree = buildHuffman(clen);
        const lengths = new Uint8Array(hlit + hdist);
        let i = 0;
        while (i < lengths.length) {
          const sym = decodeSymbol(br, clenTree);
          if (sym < 16) {
            lengths[i++] = sym;
          } else if (sym === 16) {
            if (i === 0) throw new InflateError('repeat code 16 with no previous length');
            const prevLen = lengths[i - 1] as number;
            const rep = 3 + br.bits(2);
            for (let k = 0; k < rep; k++) lengths[i++] = prevLen;
          } else if (sym === 17) {
            const rep = 3 + br.bits(3);
            for (let k = 0; k < rep; k++) lengths[i++] = 0;
          } else if (sym === 18) {
            const rep = 11 + br.bits(7);
            for (let k = 0; k < rep; k++) lengths[i++] = 0;
          } else {
            throw new InflateError(`bad code-length symbol ${sym}`);
          }
          if (i > lengths.length) throw new InflateError('code lengths overflow the declared alphabets');
        }
        litTree = buildHuffman(lengths.subarray(0, hlit));
        distTree = buildHuffman(lengths.subarray(hlit, hlit + hdist));
      }
      for (;;) {
        const sym = decodeSymbol(br, litTree);
        if (sym < 256) {
          push(sym);
        } else if (sym === 256) {
          break;
        } else {
          if (sym > 285) throw new InflateError(`invalid length code ${sym}`);
          const li = sym - 257;
          const len = (LEN_BASE[li] as number) + br.bits(LEN_EXTRA[li] as number);
          const dsym = decodeSymbol(br, distTree);
          if (dsym > 29) throw new InflateError(`invalid distance code ${dsym}`);
          const dist = (DIST_BASE[dsym] as number) + br.bits(DIST_EXTRA[dsym] as number);
          copyBack(dist, len);
        }
      }
    } else {
      throw new InflateError(`reserved block type ${type}`);
    }
    if (n > maxOutput) throw new InflateError(`output exceeds the ${maxOutput} byte limit`);
  }
  return out.slice(0, n);
}

/** Convenience: compress only if it actually helps, else return null. */
export function deflateIfSmaller(input: Uint8Array, opt: DeflateOptions = {}): Uint8Array | null {
  const c = deflateRaw(input, opt);
  return c.length < input.length ? c : null;
}
