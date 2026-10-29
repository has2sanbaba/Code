(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // packages/core/src/bits.ts
  var BitWriter = class {
    constructor() {
      __publicField(this, "buf", []);
      __publicField(this, "acc", 0);
      __publicField(this, "n", 0);
    }
    /** Number of bits written so far. */
    get length() {
      return this.buf.length * 8 + this.n;
    }
    writeBit(b) {
      this.acc = (this.acc << 1 | b & 1) & 255;
      this.n++;
      if (this.n === 8) {
        this.buf.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
    writeBits(value, count) {
      if (count < 0 || count > 32) throw new RangeError("writeBits: count must be in [0,32]");
      for (let i = count - 1; i >= 0; i--) this.writeBit(value >>> i & 1);
    }
    /** Writes an arbitrarily wide non-negative integer (BigInt), MSB first. */
    writeBigInt(value, count) {
      if (value < /* @__PURE__ */ BigInt("0")) throw new RangeError("writeBigInt: negative value");
      const mask = (/* @__PURE__ */ BigInt("1") << BigInt(count)) - /* @__PURE__ */ BigInt("1");
      if (value > mask) throw new RangeError(`writeBigInt: value needs more than ${count} bits`);
      for (let i = count - 1; i >= 0; i--) this.writeBit(Number(value >> BigInt(i) & /* @__PURE__ */ BigInt("1")));
    }
    writeBytes(bytes) {
      for (let i = 0; i < bytes.length; i++) this.writeBits(bytes[i], 8);
    }
    /** Number of bits needed to represent `value` (0 needs 0 bits). */
    static bitLength(value) {
      const v = typeof value === "bigint" ? value : BigInt(value);
      if (v <= /* @__PURE__ */ BigInt("0")) return 0;
      let n = 0;
      let x = v;
      while (x > /* @__PURE__ */ BigInt("0")) {
        n++;
        x >>= /* @__PURE__ */ BigInt("1");
      }
      return n;
    }
    /** Flushes the tail with zero bits and returns the byte array. */
    toBytes() {
      const out = new Uint8Array(this.buf.length + (this.n > 0 ? 1 : 0));
      out.set(this.buf, 0);
      if (this.n > 0) out[this.buf.length] = this.acc << 8 - this.n & 255;
      return out;
    }
    /** Flushes the tail with zero bits and returns a copy of the raw bit array. */
    toBitArray() {
      const out = new Uint8Array(this.length);
      const bytes = this.toBytes();
      for (let i = 0; i < out.length; i++) out[i] = bytes[i >> 3] >>> 7 - (i & 7) & 1;
      return out;
    }
  };
  var BitReader = class {
    constructor(data, bitLength = data.length * 8) {
      this.data = data;
      this.bitLength = bitLength;
      __publicField(this, "pos", 0);
    }
    get position() {
      return this.pos;
    }
    get remaining() {
      return this.bitLength - this.pos;
    }
    seek(pos) {
      if (pos < 0 || pos > this.bitLength) throw new RangeError("BitReader.seek out of range");
      this.pos = pos;
    }
    readBit() {
      if (this.pos >= this.bitLength) throw new RangeError("BitReader: read past end");
      const byte = this.data[this.pos >> 3];
      const bit = byte >>> 7 - (this.pos & 7) & 1;
      this.pos++;
      return bit;
    }
    readBits(count) {
      if (count > 32) throw new RangeError("readBits: count must be <= 32");
      let v = 0;
      for (let i = 0; i < count; i++) v = v << 1 | this.readBit();
      return v >>> 0;
    }
    readBigInt(count) {
      let v = /* @__PURE__ */ BigInt("0");
      for (let i = 0; i < count; i++) v = v << /* @__PURE__ */ BigInt("1") | BigInt(this.readBit());
      return v;
    }
    readBytes(count) {
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) out[i] = this.readBits(8);
      return out;
    }
    peekBits(count) {
      const p = this.pos;
      const v = this.readBits(count);
      this.pos = p;
      return v;
    }
  };

  // packages/core/src/gf256.ts
  var GF_PRIMITIVE_POLY = 285;
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 256) x ^= GF_PRIMITIVE_POLY;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  }
  function exp(a) {
    return EXP[(a % 255 + 255) % 255];
  }
  function mul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }
  function inv(a) {
    if (a === 0) throw new RangeError("zero has no inverse in GF(256)");
    return EXP[255 - LOG[a]];
  }
  function polyMul(a, b) {
    if (a.length === 0 || b.length === 0) return new Uint8Array(0);
    const out = new Uint8Array(a.length + b.length - 1);
    for (let i = 0; i < a.length; i++) {
      const ai = a[i];
      if (ai === 0) continue;
      const lai = LOG[ai];
      for (let j = 0; j < b.length; j++) {
        const bj = b[j];
        if (bj === 0) continue;
        out[i + j] = out[i + j] ^ EXP[lai + LOG[bj]];
      }
    }
    return out;
  }
  function rsGeneratorPoly(nK) {
    let g2 = Uint8Array.from([1]);
    for (let i = 0; i < nK; i++) {
      g2 = polyMul(g2, Uint8Array.from([1, exp(i)]));
    }
    return g2;
  }

  // packages/core/src/reed-solomon.ts
  function polyEval(poly, x) {
    let acc = 0;
    for (let i = 0; i < poly.length; i++) acc = mul(acc, x) ^ poly[i];
    return acc;
  }
  function syndromes(codeword, nK) {
    const s = new Uint8Array(nK);
    for (let i = 0; i < nK; i++) s[i] = polyEval(codeword, exp(i));
    return s;
  }
  function rsParity(data, nK) {
    const gen = rsGeneratorPoly(nK);
    const buf = new Uint8Array(data.length + nK);
    buf.set(data, 0);
    for (let i = 0; i < data.length; i++) {
      const coef = buf[i];
      if (coef === 0) continue;
      const lc = LOG[coef];
      for (let j = 1; j < gen.length; j++) {
        const g2 = gen[j];
        if (g2 === 0) continue;
        buf[i + j] = buf[i + j] ^ EXP[lc + LOG[g2]];
      }
    }
    return buf.slice(data.length);
  }
  function polyMulLow(a, b) {
    const out = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === 0) continue;
      for (let j = 0; j < b.length; j++) {
        if (b[j] === 0) continue;
        out[i + j] = out[i + j] ^ mul(a[i], b[j]);
      }
    }
    return out;
  }
  function erasureLocator(n, erasures) {
    let s = [1];
    for (const p of erasures) {
      const X = exp(n - 1 - p);
      s = polyMulLow(s, [1, X]);
    }
    return s;
  }
  function berlekampMassey(T) {
    var _a;
    let C = [1];
    let B = [1];
    let L = 0;
    let m = 1;
    let b = 1;
    for (let n = 0; n < T.length; n++) {
      let d = T[n];
      for (let i = 1; i <= L; i++) {
        d ^= mul((_a = C[i]) != null ? _a : 0, T[n - i]);
      }
      if (d === 0) {
        m++;
        continue;
      }
      const Tm = C.slice();
      const scale = mul(d, inv(b));
      for (let i = 0; i < B.length; i++) {
        const idx = i + m;
        const v = mul(scale, B[i]);
        while (Tm.length <= idx) Tm.push(0);
        Tm[idx] = Tm[idx] ^ v;
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
  function chienSearch(sigma, n) {
    const positions = [];
    for (let p = 0; p < n; p++) {
      const xInv = exp(p - (n - 1));
      let acc = 0;
      for (let j = 0; j < sigma.length; j++) {
        const c = sigma[j];
        if (c === 0) continue;
        acc ^= j === 0 ? c : mul(c, exp(LOG[xInv] * j));
      }
      if (acc === 0) positions.push(p);
    }
    return positions;
  }
  function solveMagnitudes(S, n, positions) {
    const m = positions.length;
    if (m === 0) return new Uint8Array(0);
    if (m > S.length) return null;
    const A = [];
    const b = [];
    for (let i = 0; i < m; i++) {
      const row = new Array(m);
      for (let j = 0; j < m; j++) {
        const X = exp(n - 1 - positions[j]);
        row[j] = i === 0 ? 1 : exp(LOG[X] * i);
      }
      A.push(row);
      b.push(S[i]);
    }
    for (let col = 0; col < m; col++) {
      let piv = -1;
      for (let r = col; r < m; r++) {
        if (A[r][col] !== 0) {
          piv = r;
          break;
        }
      }
      if (piv < 0) return null;
      if (piv !== col) {
        const t = A[col];
        A[col] = A[piv];
        A[piv] = t;
        const tb = b[col];
        b[col] = b[piv];
        b[piv] = tb;
      }
      const ip = inv(A[col][col]);
      for (let j = 0; j < m; j++) A[col][j] = mul(A[col][j], ip);
      b[col] = mul(b[col], ip);
      for (let r = 0; r < m; r++) {
        if (r === col) continue;
        const f = A[r][col];
        if (f === 0) continue;
        for (let j = 0; j < m; j++) A[r][j] = A[r][j] ^ mul(f, A[col][j]);
        b[r] = b[r] ^ mul(f, b[col]);
      }
    }
    return Uint8Array.from(b);
  }
  function rsDecode(codeword, nK, erasures = []) {
    const n = codeword.length;
    if (nK <= 0) return { ok: true, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: 0 };
    if (n > 255) throw new RangeError(`RS block length ${n} exceeds the GF(256) limit of 255`);
    const uniqErasures = Array.from(new Set(erasures.filter((p) => p >= 0 && p < n))).sort((a, b) => a - b);
    if (uniqErasures.length > nK) {
      return { ok: false, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: 0, reason: "too many erasures" };
    }
    const S = syndromes(codeword, nK);
    let allZero = true;
    for (let i = 0; i < nK; i++) if (S[i] !== 0) {
      allZero = false;
      break;
    }
    if (allZero && uniqErasures.length === 0) {
      return { ok: true, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: 0 };
    }
    let sigma;
    if (uniqErasures.length > 0) {
      const sigmaE = erasureLocator(n, uniqErasures);
      if (allZero) {
        sigma = sigmaE;
      } else {
        const nu = uniqErasures.length;
        const T = new Array(nK - nu);
        for (let i = nu; i < nK; i++) {
          let acc = 0;
          for (let j = 0; j < sigmaE.length; j++) {
            const sj = S[i - j];
            if (sj === 0) continue;
            acc ^= mul(sigmaE[j], sj);
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
      return { ok: false, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: uniqErasures.length, reason: "no error locator" };
    }
    if (degree > nK) {
      return { ok: false, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: uniqErasures.length, reason: "locator degree exceeds parity" };
    }
    const positions = chienSearch(sigma, n);
    if (positions.length !== degree) {
      return {
        ok: false,
        corrected: codeword.slice(),
        errorsFixed: 0,
        erasuresFixed: uniqErasures.length,
        reason: `chien search found ${positions.length} of ${degree} roots`
      };
    }
    const mags = solveMagnitudes(S, n, positions);
    if (!mags) {
      return { ok: false, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: uniqErasures.length, reason: "singular magnitude system" };
    }
    const corrected = codeword.slice();
    const erasureSet = new Set(uniqErasures);
    let errorsFixed = 0;
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      corrected[p] = corrected[p] ^ mags[i];
      if (!erasureSet.has(p)) errorsFixed++;
    }
    const S2 = syndromes(corrected, nK);
    for (let i = 0; i < nK; i++) {
      if (S2[i] !== 0) {
        return { ok: false, corrected: codeword.slice(), errorsFixed: 0, erasuresFixed: uniqErasures.length, reason: "residual syndrome" };
      }
    }
    return { ok: true, corrected, errorsFixed, erasuresFixed: uniqErasures.length };
  }

  // packages/core/src/golay.ts
  var G23 = 3189;
  function popcount32(x) {
    let v = x >>> 0;
    v = v - (v >>> 1 & 1431655765);
    v = (v & 858993459) + (v >>> 2 & 858993459);
    v = v + (v >>> 4) & 252645135;
    return Math.imul(v, 16843009) >>> 24 & 63;
  }
  function parity11(data12) {
    let r = data12 << 11 >>> 0;
    for (let i = 22; i >= 11; i--) {
      if (r >>> i & 1) r ^= G23 << i - 11;
    }
    return r & 2047;
  }
  function golayEncode(data12) {
    if (data12 < 0 || data12 > 4095) throw new RangeError("golayEncode: data must be 12 bits");
    const w23 = (data12 << 11 | parity11(data12)) >>> 0;
    return (w23 << 1 | popcount32(w23) & 1) >>> 0;
  }
  var TABLE = null;
  function golayTable() {
    if (TABLE) return TABLE;
    const t = new Uint32Array(4096);
    for (let i = 0; i < 4096; i++) t[i] = golayEncode(i);
    TABLE = t;
    return t;
  }
  function golayDecode(word24) {
    const table = golayTable();
    const w = word24 >>> 0;
    let best = -1;
    let bestD = 25;
    let ambiguous = false;
    for (let i = 0; i < 4096; i++) {
      const d = popcount32(table[i] ^ w);
      if (d < bestD) {
        bestD = d;
        best = i;
        ambiguous = false;
      } else if (d === bestD) {
        ambiguous = true;
      }
    }
    if (bestD > 3) return { ok: false, data: best >= 0 ? best : 0, distance: bestD, ambiguous };
    return { ok: true, data: best, distance: bestD, ambiguous };
  }

  // packages/core/src/crc.ts
  var CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(data, seed = 0) {
    let c = (seed ^ 4294967295) >>> 0;
    for (let i = 0; i < data.length; i++) c = CRC32_TABLE[(c ^ data[i]) & 255] ^ c >>> 8;
    return (c ^ 4294967295) >>> 0;
  }
  var CRC16_TABLE = (() => {
    const t = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i << 8;
      for (let k = 0; k < 8; k++) c = c & 32768 ? (c << 1 ^ 4129) & 65535 : c << 1 & 65535;
      t[i] = c;
    }
    return t;
  })();

  // packages/core/src/deflate.ts
  var InflateError = class extends Error {
    constructor(message) {
      super(`inflate: ${message}`);
      this.name = "InflateError";
    }
  };
  var BitWriterLSB = class {
    constructor() {
      __publicField(this, "out", []);
      __publicField(this, "acc", 0);
      __publicField(this, "n", 0);
    }
    /** Write `len` bits of `value`, least significant bit of the code first. */
    put(value, len) {
      for (let i = 0; i < len; i++) {
        this.acc |= (value >>> i & 1) << this.n;
        this.n++;
        if (this.n === 8) {
          this.out.push(this.acc);
          this.acc = 0;
          this.n = 0;
        }
      }
    }
    /** Write a Huffman code: its most significant bit goes into the stream first. */
    putCode(code, len) {
      for (let i = len - 1; i >= 0; i--) {
        this.acc |= (code >>> i & 1) << this.n;
        this.n++;
        if (this.n === 8) {
          this.out.push(this.acc);
          this.acc = 0;
          this.n = 0;
        }
      }
    }
    alignToByte() {
      if (this.n > 0) {
        this.out.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
    writeBytes(data, off, len) {
      this.alignToByte();
      for (let i = 0; i < len; i++) this.out.push(data[off + i]);
    }
    finish() {
      this.alignToByte();
      return Uint8Array.from(this.out);
    }
    get bitLength() {
      return this.out.length * 8 + this.n;
    }
  };
  var BitReaderLSB = class {
    constructor(data) {
      this.data = data;
      __publicField(this, "pos", 0);
      __publicField(this, "acc", 0);
      __publicField(this, "n", 0);
    }
    get bitsRead() {
      return this.pos * 8 - this.n;
    }
    need(k) {
      while (this.n < k) {
        if (this.pos >= this.data.length) throw new InflateError("unexpected end of stream");
        this.acc |= this.data[this.pos++] << this.n;
        this.n += 8;
      }
    }
    /** Read `k` bits, least significant bit first (used for lengths and headers). */
    bits(k) {
      if (k === 0) return 0;
      this.need(k);
      const v = this.acc & (1 << k) - 1;
      this.acc >>>= k;
      this.n -= k;
      return v;
    }
    /** Read one bit at a time, as a Huffman decoder must. */
    bit() {
      this.need(1);
      const v = this.acc & 1;
      this.acc >>>= 1;
      this.n -= 1;
      return v;
    }
    alignToByte() {
      const drop = this.bitsRead % 8;
      if (drop) this.bits(8 - drop);
    }
    byte() {
      this.alignToByte();
      if (this.pos >= this.data.length) throw new InflateError("unexpected end of stream");
      return this.data[this.pos++];
    }
  };
  function buildHuffman(lengths) {
    let maxLen = 0;
    for (let i = 0; i < lengths.length; i++) if (lengths[i] > maxLen) maxLen = lengths[i];
    if (maxLen === 0) return { tree: Int32Array.from([-1]), maxLen: 0 };
    let kraft = 0;
    for (let i = 0; i < lengths.length; i++) {
      const L = lengths[i];
      if (L > 0) kraft += 1 << 15 - L;
    }
    const full = 1 << 15;
    if (kraft > full) throw new InflateError("over-subscribed Huffman code");
    const order = [];
    for (let L = 1; L <= maxLen; L++) {
      for (let s = 0; s < lengths.length; s++) if (lengths[s] === L) order.push(s);
    }
    const size = 2 << maxLen;
    const tree = new Int32Array(size).fill(0);
    let nodes = 1;
    let code = 0;
    let prevLen = 0;
    for (const sym of order) {
      const L = lengths[sym];
      code <<= L - prevLen;
      prevLen = L;
      let node = 0;
      for (let b = L - 1; b >= 0; b--) {
        const bit = code >> b & 1;
        const slot = node * 2 + bit;
        const child = tree[slot];
        if (b === 0) {
          if (child !== 0) throw new InflateError(`duplicate Huffman code at symbol ${sym}`);
          tree[slot] = -1 - sym;
          break;
        }
        if (child === 0) {
          if (nodes >= size / 2) throw new InflateError("Huffman tree overflow");
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
  function decodeSymbol(br, h) {
    let node = 0;
    for (let i = 0; i <= h.maxLen; i++) {
      const v = h.tree[node * 2 + br.bit()];
      if (v < 0) return -1 - v;
      if (v === 0) throw new InflateError("invalid Huffman code (ran off the tree)");
      node = v;
    }
    throw new InflateError("Huffman code longer than max length");
  }
  var LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  function fixedLiteralTree() {
    const L = new Uint8Array(288);
    for (let i = 0; i <= 143; i++) L[i] = 8;
    for (let i = 144; i <= 255; i++) L[i] = 9;
    for (let i = 256; i <= 279; i++) L[i] = 7;
    for (let i = 280; i <= 287; i++) L[i] = 8;
    return buildHuffman(L);
  }
  function fixedDistanceTree() {
    const L = new Uint8Array(30).fill(5);
    return buildHuffman(L);
  }
  function fixedLiteralCode(sym) {
    if (sym <= 143) return [48 + sym, 8];
    if (sym <= 255) return [400 + sym - 144, 9];
    if (sym <= 279) return [sym - 256, 7];
    return [192 + sym - 280, 8];
  }
  var MIN_MATCH = 3;
  var MAX_MATCH = 258;
  var WINDOW = 32768;
  function hash3(d, i) {
    return (d[i] << 10 ^ d[i + 1] << 5 ^ d[i + 2]) & 32767;
  }
  function findMatch(d, pos, head, prev, maxChain) {
    const remaining = d.length - pos;
    if (remaining < MIN_MATCH) return { len: 0, dist: 0 };
    const maxLen = Math.min(MAX_MATCH, remaining);
    const h = hash3(d, pos);
    void h;
    let best = { len: 0, dist: 0 };
    let cand = prev[pos & WINDOW - 1];
    let tries = maxChain;
    const lowLimit = pos > WINDOW ? pos - WINDOW : 0;
    while (cand >= lowLimit && tries-- > 0) {
      const dist = pos - cand;
      if (dist <= 0 || dist > WINDOW) break;
      if (best.len > 0 && d[cand + best.len] !== d[pos + best.len]) {
        cand = prev[cand & WINDOW - 1];
        continue;
      }
      let len = 0;
      while (len < maxLen && d[cand + len] === d[pos + len]) len++;
      if (len > best.len) {
        best = { len, dist };
        if (len >= maxLen) break;
      }
      cand = prev[cand & WINDOW - 1];
    }
    return best.len >= MIN_MATCH ? best : { len: 0, dist: 0 };
  }
  function lengthCode(len) {
    for (let i = LEN_BASE.length - 1; i >= 0; i--) {
      if (len >= LEN_BASE[i]) {
        return { sym: 257 + i, extra: len - LEN_BASE[i], extraBits: LEN_EXTRA[i] };
      }
    }
    return { sym: 257, extra: 0, extraBits: 0 };
  }
  function distCode(dist) {
    for (let i = DIST_BASE.length - 1; i >= 0; i--) {
      if (dist >= DIST_BASE[i]) {
        return { sym: i, extra: dist - DIST_BASE[i], extraBits: DIST_EXTRA[i] };
      }
    }
    return { sym: 0, extra: 0, extraBits: 0 };
  }
  function deflateRaw(input, opt = {}) {
    var _a, _b, _c;
    const level = (_a = opt.level) != null ? _a : 6;
    if (level === 0 || input.length === 0) return storedBlocks(input);
    const maxChain = (_b = opt.maxChain) != null ? _b : level <= 1 ? 8 : 128;
    const bw = new BitWriterLSB();
    const head = new Int32Array(32768).fill(-1);
    const prev = new Int32Array(WINDOW).fill(-1);
    const emit = (final, from, to) => {
      bw.put(final ? 1 : 0, 1);
      bw.put(1, 2);
      let p = from;
      while (p < to) {
        if (p + MIN_MATCH <= input.length) {
          const h = hash3(input, p);
          prev[p & WINDOW - 1] = head[h];
          head[h] = p;
        }
        const m = findMatch(input, p, head, prev, maxChain);
        if (m.len >= MIN_MATCH) {
          for (let k = 1; k < m.len && p + k + MIN_MATCH <= input.length; k++) {
            const hh = hash3(input, p + k);
            prev[p + k & WINDOW - 1] = head[hh];
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
          const sym = input[p];
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
    const stored = storedBlocks(input);
    if (stored.length < out.length && stored.length <= input.length * ((_c = opt.giveUpRatio) != null ? _c : 1) + 8) return stored;
    return out;
  }
  function storedBlocks(input) {
    const bw = new BitWriterLSB();
    const CHUNK = 65535;
    let off = 0;
    for (; ; ) {
      const len = Math.min(CHUNK, input.length - off);
      const last = off + len >= input.length ? 1 : 0;
      bw.put(last, 1);
      bw.put(0, 2);
      bw.alignToByte();
      bw.put(len & 255, 8);
      bw.put(len >> 8 & 255, 8);
      bw.put(~len & 255, 8);
      bw.put(~len >> 8 & 255 | 0, 8);
      bw.writeBytes(input, off, len);
      off += len;
      if (last) break;
    }
    return bw.finish();
  }
  function inflateRaw(input, opt = {}) {
    var _a;
    const maxOutput = (_a = opt.maxOutput) != null ? _a : 1 << 24;
    const br = new BitReaderLSB(input);
    let out = new Uint8Array(Math.max(64, Math.min(maxOutput, input.length * 3 + 64)));
    let n = 0;
    const push = (b) => {
      if (n === out.length) {
        if (n >= maxOutput) throw new InflateError(`output exceeds the ${maxOutput} byte limit`);
        const bigger = new Uint8Array(Math.min(maxOutput, out.length * 2));
        bigger.set(out);
        out = bigger;
      }
      out[n++] = b;
    };
    const copyBack = (dist, len) => {
      var _a2;
      if (dist > n) throw new InflateError(`distance ${dist} references data before the start of the stream`);
      if (dist > WINDOW) throw new InflateError(`distance ${dist} exceeds the 32768 byte window`);
      if (n + len > maxOutput) throw new InflateError(`output exceeds the ${maxOutput} byte limit`);
      for (let i = 0; i < len; i++) push(out[n - dist]);
      (_a2 = opt.onProgress) == null ? void 0 : _a2.call(opt, n);
    };
    let final = 0;
    let guard = 0;
    while (!final) {
      if (++guard > 1 << 20) throw new InflateError("too many blocks");
      final = br.bits(1);
      const type = br.bits(2);
      if (type === 0) {
        br.alignToByte();
        const len = br.byte() | br.byte() << 8;
        const nlen = br.byte() | br.byte() << 8;
        if ((len ^ 65535) !== nlen) throw new InflateError("stored block length complement mismatch");
        for (let i = 0; i < len; i++) push(br.byte());
      } else if (type === 1 || type === 2) {
        let litTree;
        let distTree;
        if (type === 1) {
          litTree = fixedLiteralTree();
          distTree = fixedDistanceTree();
        } else {
          const hlit = br.bits(5) + 257;
          const hdist = br.bits(5) + 1;
          const hclen = br.bits(4) + 4;
          if (hlit > 286 || hdist > 30) throw new InflateError("alphabet size out of range");
          const clen = new Uint8Array(19);
          for (let i2 = 0; i2 < hclen; i2++) clen[CLEN_ORDER[i2]] = br.bits(3);
          const clenTree = buildHuffman(clen);
          const lengths = new Uint8Array(hlit + hdist);
          let i = 0;
          while (i < lengths.length) {
            const sym = decodeSymbol(br, clenTree);
            if (sym < 16) {
              lengths[i++] = sym;
            } else if (sym === 16) {
              if (i === 0) throw new InflateError("repeat code 16 with no previous length");
              const prevLen = lengths[i - 1];
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
            if (i > lengths.length) throw new InflateError("code lengths overflow the declared alphabets");
          }
          litTree = buildHuffman(lengths.subarray(0, hlit));
          distTree = buildHuffman(lengths.subarray(hlit, hlit + hdist));
        }
        for (; ; ) {
          const sym = decodeSymbol(br, litTree);
          if (sym < 256) {
            push(sym);
          } else if (sym === 256) {
            break;
          } else {
            if (sym > 285) throw new InflateError(`invalid length code ${sym}`);
            const li = sym - 257;
            const len = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
            const dsym = decodeSymbol(br, distTree);
            if (dsym > 29) throw new InflateError(`invalid distance code ${dsym}`);
            const dist = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
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
  function deflateIfSmaller(input, opt = {}) {
    const c = deflateRaw(input, opt);
    return c.length < input.length ? c : null;
  }

  // packages/core/src/sha256.ts
  var K = new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var H0 = new Uint32Array([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  var rotr = (x, n) => (x >>> n | x << 32 - n) >>> 0;
  function compress(state, block, off) {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i++) {
      w[i] = block[off + i * 4] << 24 | block[off + i * 4 + 1] << 16 | block[off + i * 4 + 2] << 8 | block[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ x >>> 3) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ y >>> 10) >>> 0;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 >>> 0;
    }
    let a = state[0];
    let b = state[1];
    let c = state[2];
    let d = state[3];
    let e = state[4];
    let f = state[5];
    let g2 = state[6];
    let h = state[7];
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = (e & f ^ ~e & g2) >>> 0;
      const t1 = h + S1 + ch + K[i] + w[i] >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = (a & b ^ a & c ^ b & c) >>> 0;
      const t2 = S0 + maj >>> 0;
      h = g2;
      g2 = f;
      f = e;
      e = d + t1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 >>> 0;
    }
    state[0] = state[0] + a >>> 0;
    state[1] = state[1] + b >>> 0;
    state[2] = state[2] + c >>> 0;
    state[3] = state[3] + d >>> 0;
    state[4] = state[4] + e >>> 0;
    state[5] = state[5] + f >>> 0;
    state[6] = state[6] + g2 >>> 0;
    state[7] = state[7] + h >>> 0;
  }
  function sha256(msg) {
    const state = H0.slice();
    const bitLen = msg.length * 8;
    const withPad = new Uint8Array(msg.length + 9 + 63 >> 6 << 6);
    withPad.set(msg);
    withPad[msg.length] = 128;
    const dv = new DataView(withPad.buffer);
    dv.setUint32(withPad.length - 8, Math.floor(bitLen / 4294967296), false);
    dv.setUint32(withPad.length - 4, bitLen >>> 0, false);
    for (let off = 0; off < withPad.length; off += 64) compress(state, withPad, off);
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, state[i], false);
    return out;
  }
  function hmacSha256(key, msg) {
    let k = key;
    if (k.length > 64) k = sha256(k);
    const padded = new Uint8Array(64);
    padded.set(k);
    const inner = new Uint8Array(64 + msg.length);
    const outer = new Uint8Array(64 + 32);
    for (let i = 0; i < 64; i++) {
      inner[i] = padded[i] ^ 54;
      outer[i] = padded[i] ^ 92;
    }
    inner.set(msg, 64);
    const ih = sha256(inner);
    outer.set(ih, 64);
    return sha256(outer);
  }
  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }
  function utf8Encode(s) {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let cp = s.codePointAt(i);
      if (cp > 65535) i++;
      if (cp < 128) out.push(cp);
      else if (cp < 2048) out.push(192 | cp >> 6, 128 | cp & 63);
      else if (cp < 65536) out.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
      else out.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
    }
    return Uint8Array.from(out);
  }
  function utf8Decode(b) {
    let out = "";
    let i = 0;
    while (i < b.length) {
      const c = b[i];
      let cp;
      let len;
      if (c < 128) {
        cp = c;
        len = 1;
      } else if ((c & 224) === 192) {
        cp = c & 31;
        len = 2;
      } else if ((c & 240) === 224) {
        cp = c & 15;
        len = 3;
      } else {
        cp = c & 7;
        len = 4;
      }
      for (let k = 1; k < len; k++) cp = cp << 6 | b[i + k] & 63;
      out += String.fromCodePoint(cp);
      i += len;
    }
    return out;
  }
  function hexEncode(b) {
    let s = "";
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
    return s;
  }
  function hexDecode(s) {
    const clean = s.replace(/[^0-9a-fA-F]/g, "");
    const out = new Uint8Array(clean.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  // packages/core/src/chacha20.ts
  var SIGMA = [1634760805, 857760878, 2036477234, 1797285236];
  function rotl32(v, n) {
    return (v << n | v >>> 32 - n) >>> 0;
  }
  function quarterRound(s, a, b, c, d) {
    s[a] = s[a] + s[b] >>> 0;
    s[d] = rotl32(s[d] ^ s[a], 16);
    s[c] = s[c] + s[d] >>> 0;
    s[b] = rotl32(s[b] ^ s[c], 12);
    s[a] = s[a] + s[b] >>> 0;
    s[d] = rotl32(s[d] ^ s[a], 8);
    s[c] = s[c] + s[d] >>> 0;
    s[b] = rotl32(s[b] ^ s[c], 7);
  }
  function readLE32(b, i) {
    return (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) >>> 0;
  }
  function chacha20Block(key, counter, nonce) {
    if (key.length !== 32) throw new RangeError("ChaCha20 key must be 32 bytes");
    if (nonce.length !== 12) throw new RangeError("ChaCha20 nonce must be 12 bytes");
    const state = new Uint32Array(16);
    for (let i = 0; i < 4; i++) state[i] = SIGMA[i];
    for (let i = 0; i < 8; i++) state[4 + i] = readLE32(key, i * 4);
    state[12] = counter >>> 0;
    for (let i = 0; i < 3; i++) state[13 + i] = readLE32(nonce, i * 4);
    const work = Uint32Array.from(state);
    for (let i = 0; i < 10; i++) {
      quarterRound(work, 0, 4, 8, 12);
      quarterRound(work, 1, 5, 9, 13);
      quarterRound(work, 2, 6, 10, 14);
      quarterRound(work, 3, 7, 11, 15);
      quarterRound(work, 0, 5, 10, 15);
      quarterRound(work, 1, 6, 11, 12);
      quarterRound(work, 2, 7, 8, 13);
      quarterRound(work, 3, 4, 9, 14);
    }
    const out = new Uint8Array(64);
    for (let i = 0; i < 16; i++) {
      const v = work[i] + state[i] >>> 0;
      out[i * 4] = v & 255;
      out[i * 4 + 1] = v >>> 8 & 255;
      out[i * 4 + 2] = v >>> 16 & 255;
      out[i * 4 + 3] = v >>> 24 & 255;
    }
    return out;
  }
  function chacha20Xor(key, counter, nonce, data) {
    const out = new Uint8Array(data.length);
    for (let off = 0; off < data.length; off += 64) {
      const block = chacha20Block(key, counter + Math.floor(off / 64) >>> 0, nonce);
      const end = Math.min(64, data.length - off);
      for (let i = 0; i < end; i++) out[off + i] = data[off + i] ^ block[i];
    }
    return out;
  }
  var P1305 = (/* @__PURE__ */ BigInt("1") << /* @__PURE__ */ BigInt("130")) - /* @__PURE__ */ BigInt("5");
  function clampR(r) {
    const t = Uint8Array.from(r);
    t[3] = t[3] & 15;
    t[7] = t[7] & 15;
    t[11] = t[11] & 15;
    t[15] = t[15] & 15;
    t[4] = t[4] & 252;
    t[8] = t[8] & 252;
    t[12] = t[12] & 252;
    let v = /* @__PURE__ */ BigInt("0");
    for (let i = 15; i >= 0; i--) v = v << /* @__PURE__ */ BigInt("8") | BigInt(t[i]);
    return v;
  }
  function leBytesToBigInt(b) {
    let v = /* @__PURE__ */ BigInt("0");
    for (let i = b.length - 1; i >= 0; i--) v = v << /* @__PURE__ */ BigInt("8") | BigInt(b[i]);
    return v;
  }
  function bigIntToLE16(v) {
    const out = new Uint8Array(16);
    let x = v;
    for (let i = 0; i < 16; i++) {
      out[i] = Number(x & /* @__PURE__ */ BigInt("0xff"));
      x >>= /* @__PURE__ */ BigInt("8");
    }
    return out;
  }
  function poly1305Mac(key, msg) {
    if (key.length !== 32) throw new RangeError("Poly1305 key must be 32 bytes");
    const r = clampR(key.subarray(0, 16));
    const s = leBytesToBigInt(key.subarray(16, 32));
    let acc = /* @__PURE__ */ BigInt("0");
    for (let off = 0; off < msg.length; off += 16) {
      const block = msg.subarray(off, Math.min(off + 16, msg.length));
      const n = leBytesToBigInt(block) | /* @__PURE__ */ BigInt("1") << BigInt(8 * block.length);
      acc = (acc + n) * r % P1305;
    }
    return bigIntToLE16(acc + s & (/* @__PURE__ */ BigInt("1") << /* @__PURE__ */ BigInt("128")) - /* @__PURE__ */ BigInt("1"));
  }
  function poly1305KeyGen(key, nonce) {
    return chacha20Block(key, 0, nonce).subarray(0, 32);
  }
  var AEAD_TAG_BYTES = 16;
  var AEAD_NONCE_BYTES = 12;
  var AEAD_KEY_BYTES = 32;
  function pad16(parts, data) {
    parts.push(data);
    const rem = data.length % 16;
    if (rem !== 0) parts.push(new Uint8Array(16 - rem));
  }
  function le64(n) {
    const out = new Uint8Array(8);
    let x = BigInt(n >>> 0);
    for (let i = 0; i < 8; i++) {
      out[i] = Number(x & /* @__PURE__ */ BigInt("0xff"));
      x >>= /* @__PURE__ */ BigInt("8");
    }
    return out;
  }
  function concat(parts) {
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
  function aeadEncrypt(key, nonce, plaintext, aad = new Uint8Array(0)) {
    if (key.length !== AEAD_KEY_BYTES) throw new RangeError("AEAD key must be 32 bytes");
    if (nonce.length !== AEAD_NONCE_BYTES) throw new RangeError("AEAD nonce must be 12 bytes");
    const otk = poly1305KeyGen(key, nonce);
    const ciphertext = chacha20Xor(key, 1, nonce, plaintext);
    const macData = [];
    pad16(macData, aad);
    pad16(macData, ciphertext);
    macData.push(le64(aad.length));
    macData.push(le64(ciphertext.length));
    const tag = poly1305Mac(otk, concat(macData));
    return concat([ciphertext, tag]);
  }
  function aeadDecrypt(key, nonce, blob, aad = new Uint8Array(0)) {
    if (key.length !== AEAD_KEY_BYTES) throw new RangeError("AEAD key must be 32 bytes");
    if (nonce.length !== AEAD_NONCE_BYTES) throw new RangeError("AEAD nonce must be 12 bytes");
    if (blob.length < AEAD_TAG_BYTES) return null;
    const ciphertext = blob.subarray(0, blob.length - AEAD_TAG_BYTES);
    const tag = blob.subarray(blob.length - AEAD_TAG_BYTES);
    const otk = poly1305KeyGen(key, nonce);
    const macData = [];
    pad16(macData, aad);
    pad16(macData, ciphertext);
    macData.push(le64(aad.length));
    macData.push(le64(ciphertext.length));
    const expected = poly1305Mac(otk, concat(macData));
    if (!timingSafeEqual(expected, tag)) return null;
    return chacha20Xor(key, 1, nonce, ciphertext);
  }
  function pbkdf2Sha256(password, salt, iterations, dkLen = 32) {
    if (iterations < 1) throw new RangeError("iterations must be >= 1");
    const blocks = Math.ceil(dkLen / 32);
    const out = new Uint8Array(blocks * 32);
    for (let i = 1; i <= blocks; i++) {
      const intBlock = new Uint8Array(4);
      intBlock[0] = i >>> 24 & 255;
      intBlock[1] = i >>> 16 & 255;
      intBlock[2] = i >>> 8 & 255;
      intBlock[3] = i & 255;
      let u = hmacSha256(password, concat([salt, intBlock]));
      const t = Uint8Array.from(u);
      for (let j = 1; j < iterations; j++) {
        u = hmacSha256(password, u);
        for (let k = 0; k < 32; k++) t[k] = t[k] ^ u[k];
      }
      out.set(t, (i - 1) * 32);
    }
    return out.subarray(0, dkLen);
  }
  var PBKDF2_ITERATIONS = 21e4;
  function randomBytes(n) {
    const out = new Uint8Array(n);
    const c = globalThis.crypto;
    if (!c || typeof c.getRandomValues !== "function") {
      throw new Error("no cryptographically secure random source available (WebCrypto is required)");
    }
    c.getRandomValues(out);
    return out;
  }
  function randomNonce() {
    return randomBytes(AEAD_NONCE_BYTES);
  }
  function deriveKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
    const pass = typeof passphrase === "string" ? new TextEncoder().encode(passphrase) : passphrase;
    const key = pbkdf2Sha256(pass, salt, iterations, AEAD_KEY_BYTES);
    const keyId = hmacSha256(new TextEncoder().encode("SiMurgh key id v1"), key).subarray(0, 4);
    return { key, keyId: Uint8Array.from(keyId), salt: Uint8Array.from(salt), iterations };
  }
  function randomSalt() {
    return randomBytes(16);
  }

  // packages/core/src/geometry.ts
  var CELL_AREA = Math.sqrt(3) / 2;
  var CELL_CIRCUMRADIUS = 1 / Math.sqrt(3);
  var DOT_RADIUS = 0.46;
  var CORE_RADIUS = 2;
  var CORE_CELLS = 1 + 3 * CORE_RADIUS * (CORE_RADIUS + 1);
  var MIN_VERSION = 1;
  var MAX_VERSION = 40;
  function dataRings(version) {
    if (version < MIN_VERSION || version > MAX_VERSION) throw new RangeError(`version ${version} out of range`);
    return 2 * version + 12;
  }
  function buildSerpentine(K2, ringOffset, N) {
    const serpentine = new Int32Array(N);
    const spiralIndexOfCell = new Int32Array(N);
    let p = 0;
    for (let d = CORE_RADIUS + 1; d <= K2; d++) {
      const base = ringOffset[d];
      const len = 6 * d;
      const reverse = d % 2 === 0;
      for (let k = 0; k < len; k++) {
        const j = reverse ? len - 1 - k : k;
        const cell = base + j;
        serpentine[p] = cell;
        spiralIndexOfCell[cell] = p;
        p++;
      }
    }
    return { serpentine, spiralIndexOfCell };
  }
  function buildNeighbours(cells, N) {
    const key = /* @__PURE__ */ new Map();
    const pack = (q, r) => q + 1024 << 11 | r + 1024;
    for (let i = 0; i < N; i++) key.set(pack(cells[i].q, cells[i].r), i);
    const out = new Int32Array(N * 6).fill(-1);
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, -1],
      [-1, 1]
    ];
    for (let i = 0; i < N; i++) {
      const c = cells[i];
      for (let k = 0; k < 6; k++) {
        const d = dirs[k];
        const j = key.get(pack(c.q + d[0], c.r + d[1]));
        out[i * 6 + k] = j === void 0 ? -1 : j;
      }
    }
    return out;
  }
  function hexDistance(q, r) {
    return (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
  }
  function axialToXY(q, r) {
    return { x: q + r / 2, y: Math.sqrt(3) / 2 * r };
  }
  function xyToAngleDeg(x, y) {
    const a = Math.atan2(y, x) * 180 / Math.PI;
    return a < 0 ? a + 360 : a;
  }
  function ringCell(d, j) {
    const side = Math.floor(j / d);
    const k = j - side * d;
    const c = ringCellRaw(d, side, k);
    return { q: c.q + 0, r: c.r + 0 };
  }
  function ringCellRaw(d, side, k) {
    switch (side) {
      case 0:
        return { q: d - k, r: k };
      case 1:
        return { q: -k, r: d };
      case 2:
        return { q: -d, r: d - k };
      case 3:
        return { q: -d + k, r: -k };
      case 4:
        return { q: k, r: -d };
      case 5:
        return { q: d, r: -d + k };
      default:
        throw new RangeError(`ring side ${side} out of range for ring ${d}`);
    }
  }
  function buildOffsets(K2) {
    const off = new Int32Array(K2 + 2);
    let acc = 0;
    for (let d = CORE_RADIUS + 1; d <= K2; d++) {
      off[d] = acc;
      acc += 6 * d;
    }
    off[K2 + 1] = acc;
    return off;
  }
  var latticeCache = /* @__PURE__ */ new Map();
  function getLattice(version) {
    const cached = latticeCache.get(version);
    if (cached) return cached;
    const K2 = dataRings(version);
    const ringOffset = buildOffsets(K2);
    const N = ringOffset[K2 + 1];
    const cells = new Array(N);
    const xy = new Float64Array(2 * N);
    const angles = new Float64Array(N);
    const dist = new Uint16Array(N);
    for (let d = CORE_RADIUS + 1; d <= K2; d++) {
      const base = ringOffset[d];
      for (let j = 0; j < 6 * d; j++) {
        const c = ringCell(d, j);
        const i = base + j;
        cells[i] = c;
        const p = axialToXY(c.q, c.r);
        xy[2 * i] = p.x;
        xy[2 * i + 1] = p.y;
        angles[i] = xyToAngleDeg(p.x, p.y);
        dist[i] = d;
      }
    }
    const { serpentine, spiralIndexOfCell } = buildSerpentine(K2, ringOffset, N);
    const neighbours = buildNeighbours(cells, N);
    const lat = { version, K: K2, N, cells, xy, angles, dist, ringOffset, serpentine, spiralIndexOfCell, neighbours };
    latticeCache.set(version, lat);
    return lat;
  }
  function crown(K2) {
    const haloInner = K2 + 0.9;
    const haloOuter = K2 + 1.2;
    const teethInner = K2 + 3.1;
    const teethOuter = K2 + 4.1;
    const limbusInner = K2 + 4.7;
    const limbusOuter = K2 + 5;
    return {
      haloInner,
      haloOuter,
      haloRadius: (haloInner + haloOuter) / 2,
      beadRadius: K2 + 2.2,
      beadSize: 0.38,
      teethInner,
      teethOuter,
      teethRadius: (teethInner + teethOuter) / 2,
      limbusInner,
      limbusOuter,
      limbusRadius: (limbusInner + limbusOuter) / 2,
      beakRadius: limbusInner,
      outerRadius: limbusOuter,
      quietZone: 2.5,
      canvasRadius: limbusOuter + 2.5
    };
  }
  var ANGLE_TRACK = Object.freeze([
    1,
    1,
    1,
    1,
    1,
    1,
    0,
    1,
    0,
    1,
    0,
    1,
    1,
    0,
    0,
    1,
    1,
    0,
    1,
    1,
    1,
    0,
    1,
    1,
    0,
    1,
    0,
    0,
    1,
    0,
    0,
    1,
    1,
    1,
    0,
    0,
    0,
    1,
    0,
    1,
    1,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0,
    1,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0
  ]);
  var TEETH = 63;
  var TOOTH_DEG = 360 / TEETH;
  var BEADS = 24;
  var BEAD_DEG = 360 / BEADS;
  var ECC_LEVELS = ["L", "M", "Q", "H"];
  var ECC_PARITY_FRACTION = { L: 0.16, M: 0.28, Q: 0.4, H: 0.55 };
  function packFormat(f) {
    return (f.versionIndex & 63) << 6 | (f.ecc & 3) << 4 | (f.mask & 7) << 1 | f.compression & 1;
  }
  function unpackFormat(v) {
    return {
      versionIndex: v >>> 6 & 63,
      ecc: v >>> 4 & 3,
      mask: v >>> 1 & 7,
      compression: v & 1
    };
  }
  var MASK_COUNT = 8;
  function mix32(a, b, c, d) {
    let h = 2654435769;
    h = Math.imul(h ^ a + 374761393, 2246822507);
    h ^= h >>> 13;
    h = Math.imul(h ^ b + 3266489909, 668265263);
    h ^= h >>> 16;
    h = Math.imul(h ^ c + 625341585, 2246822507);
    h ^= h >>> 13;
    h = Math.imul(h ^ d + 2654435769, 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  }
  var mod = (x, m) => (x % m + m) % m;
  function maskBit(maskId, q, r, version) {
    switch (maskId) {
      case 0:
        return mod(q, 3) === 0 ? 1 : 0;
      case 1:
        return mod(r, 3) === 0 ? 1 : 0;
      case 2:
        return mod(q + r, 3) === 0 ? 1 : 0;
      case 3:
        return mod(q - r, 2) === 0 ? 1 : 0;
      case 4:
        return mod(hexDistance(q, r), 2) === 0 ? 1 : 0;
      case 5:
        return mod(q * q + 3 * r, 5) < 2 ? 1 : 0;
      case 6:
        return mix32(q, r, version, 6) & 1;
      case 7:
        return mix32(q * 7 + 3, r * 11 + 5, version * 13 + 1, 7) & 1;
      default:
        throw new RangeError(`unknown mask ${maskId}`);
    }
  }
  function maskArray(version, maskId) {
    const lat = getLattice(version);
    const out = new Uint8Array(lat.N);
    for (let i = 0; i < lat.N; i++) {
      const c = lat.cells[i];
      out[i] = maskBit(maskId, c.q, c.r, version);
    }
    return out;
  }
  function maskPenalty(version, maskId, bits) {
    const lat = getLattice(version);
    const N = lat.N;
    const v = new Uint8Array(N);
    for (let i = 0; i < N; i++) v[i] = bits[i] ^ maskBit(maskId, lat.cells[i].q, lat.cells[i].r, version);
    let dark = 0;
    for (let i = 0; i < N; i++) dark += v[i];
    const p1 = Math.abs(dark / N - 0.5) * 2e3;
    const key = /* @__PURE__ */ new Map();
    for (let i = 0; i < N; i++) key.set(lat.cells[i].q + 512 << 10 | lat.cells[i].r + 512, i);
    let same = 0;
    let pairs = 0;
    for (let i = 0; i < N; i++) {
      const c = lat.cells[i];
      for (const nb of [
        { q: c.q + 1, r: c.r },
        { q: c.q, r: c.r + 1 },
        { q: c.q + 1, r: c.r - 1 }
      ]) {
        const j = key.get(nb.q + 512 << 10 | nb.r + 512);
        if (j === void 0) continue;
        pairs++;
        if (v[i] === v[j]) same++;
      }
    }
    const p2 = same / Math.max(1, pairs) * 1200;
    let worstRun = 0;
    for (let d = CORE_RADIUS + 1; d <= lat.K; d++) {
      const base = lat.ringOffset[d];
      const len = 6 * d;
      let run = 1;
      for (let j = 1; j <= len; j++) {
        const a = v[base + (j - 1) % len];
        const b = v[base + j % len];
        if (a === b) run++;
        else {
          if (run > worstRun) worstRun = run;
          run = 1;
        }
      }
      if (run > worstRun) worstRun = run;
    }
    const p3 = Math.max(0, worstRun - 6) * 40;
    return p1 + p2 + p3;
  }
  function bestMask(version, bits) {
    const scores = [];
    let best = 0;
    let bestPenalty = Infinity;
    for (let m = 0; m < MASK_COUNT; m++) {
      const p = maskPenalty(version, m, bits);
      scores.push(p);
      if (p < bestPenalty) {
        bestPenalty = p;
        best = m;
      }
    }
    return { mask: best, penalty: bestPenalty, scores };
  }
  function xyToAxialF(x, y) {
    const r = 2 * y / Math.sqrt(3);
    return { q: x - r / 2, r };
  }
  function axialRound(q, r) {
    const x = q;
    const z = r;
    const y = -x - z;
    let rx = Math.round(x);
    let ry = Math.round(y);
    let rz = Math.round(z);
    const dx = Math.abs(rx - x);
    const dy = Math.abs(ry - y);
    const dz = Math.abs(rz - z);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy > dz) ry = -rx - rz;
    else rz = -rx - ry;
    return { q: rx + 0, r: rz + 0 };
  }
  function ringIndexOf(q, r, d) {
    if (q + r === d && r >= 0 && r < d) return r;
    if (r === d && q <= 0 && q > -d) return d - q;
    if (q === -d && r > 0 && r <= d) return 3 * d - r;
    if (q + r === -d && q >= -d) return 3 * d - r;
    if (r === -d && q >= 0 && q < d) return 4 * d + q;
    if (q === d && r < 0) return 6 * d + r;
    throw new RangeError(`cell (${q},${r}) is not on ring ${d}`);
  }
  function coreIsDark(d) {
    return d !== 1;
  }

  // packages/core/src/format.ts
  function encodeFormatCrown(fb) {
    const word = golayEncode(packFormat(fb));
    const beads = new Uint8Array(BEADS);
    for (let i = 0; i < BEADS; i++) beads[i] = word >>> 23 - i & 1;
    return { word, beads };
  }
  function decodeFormatCrown(beads) {
    let word = 0;
    for (let i = 0; i < BEADS; i++) word = word << 1 | (beads[i] ? 1 : 0);
    const res = golayDecode(word >>> 0);
    if (!res.ok) return { ok: false, format: null, distance: res.distance, word: word >>> 0 };
    const f = unpackFormat(res.data);
    if (f.versionIndex > MAX_VERSION - MIN_VERSION) return { ok: false, format: null, distance: res.distance, word: word >>> 0 };
    return { ok: true, format: f, distance: res.distance, word: word >>> 0 };
  }
  function formatCandidates(versions = defaultVersionRange()) {
    const out = [];
    for (const v of versions) {
      for (let e = 0; e < ECC_LEVELS.length; e++) {
        for (let mask = 0; mask < MASK_COUNT; mask++) {
          for (const compression of [0, 1]) {
            const formatBits = packFormat({ versionIndex: v - MIN_VERSION, ecc: e, mask, compression });
            out.push({ version: v, ecc: ECC_LEVELS[e], mask, compression, formatBits });
          }
        }
      }
    }
    return out;
  }
  function defaultVersionRange() {
    const out = [];
    for (let v = MIN_VERSION; v <= MAX_VERSION; v++) out.push(v);
    return out;
  }

  // packages/core/src/blocks.ts
  var TARGET_BLOCK_LENGTH = 192;
  function planBlocks(version, ecc) {
    const lat = getLattice(version);
    const cells = lat.N;
    const codewords = Math.floor(cells / 8);
    const remainderBits = cells - codewords * 8;
    const rho = ECC_PARITY_FRACTION[ecc];
    let parity = Math.round(codewords * rho);
    parity = Math.max(2, Math.min(codewords - 5, parity));
    const data = codewords - parity;
    let blocks = Math.max(1, Math.ceil(codewords / TARGET_BLOCK_LENGTH));
    while (blocks > 1 && Math.floor(parity / blocks) < 2) blocks--;
    while (Math.ceil(codewords / blocks) > 255) blocks++;
    const dPer = Math.floor(data / blocks);
    const dExtra = data - dPer * blocks;
    const pPer = Math.floor(parity / blocks);
    const pExtra = parity - pPer * blocks;
    const blockData = [];
    const blockParity = [];
    for (let b = 0; b < blocks; b++) {
      blockData.push(dPer + (b < dExtra ? 1 : 0));
      blockParity.push(pPer + (b < pExtra ? 1 : 0));
    }
    return {
      version,
      ecc,
      cells,
      codewords,
      remainderBits,
      dataCodewords: data,
      parityCodewords: parity,
      blocks,
      blockData,
      blockParity,
      payloadBytes: data - 4,
      payloadBits: (data - 4) * 8
    };
  }
  function interleave(dataBlocks, parityBlocks) {
    const totalData = dataBlocks.reduce((a, b) => a + b.length, 0);
    const totalParity = parityBlocks.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(totalData + totalParity);
    let p = 0;
    const maxData = Math.max(0, ...dataBlocks.map((b) => b.length));
    for (let i = 0; i < maxData; i++) {
      for (const b of dataBlocks) {
        if (i < b.length) out[p++] = b[i];
      }
    }
    const maxParity = Math.max(0, ...parityBlocks.map((b) => b.length));
    for (let i = 0; i < maxParity; i++) {
      for (const b of parityBlocks) {
        if (i < b.length) out[p++] = b[i];
      }
    }
    return out;
  }
  function deinterleave(stream, blockData, blockParity) {
    const B = blockData.length;
    const dataBlocks = blockData.map((n) => new Uint8Array(n));
    const parityBlocks = blockParity.map((n) => new Uint8Array(n));
    let p = 0;
    const maxData = Math.max(0, ...blockData);
    for (let i = 0; i < maxData; i++) {
      for (let b = 0; b < B; b++) {
        if (i < blockData[b]) dataBlocks[b][i] = stream[p++];
      }
    }
    const maxParity = Math.max(0, ...blockParity);
    for (let i = 0; i < maxParity; i++) {
      for (let b = 0; b < B; b++) {
        if (i < blockParity[b]) parityBlocks[b][i] = stream[p++];
      }
    }
    return { dataBlocks, parityBlocks };
  }
  function interleavedLayout(blockData, blockParity) {
    const B = blockData.length;
    const out = [];
    const maxData = Math.max(0, ...blockData);
    for (let i = 0; i < maxData; i++) {
      for (let b = 0; b < B; b++) if (i < blockData[b]) out.push({ block: b, index: i });
    }
    const maxParity = Math.max(0, ...blockParity);
    for (let i = 0; i < maxParity; i++) {
      for (let b = 0; b < B; b++) {
        if (i < blockParity[b]) out.push({ block: b, index: blockData[b] + i });
      }
    }
    return out;
  }

  // packages/core/src/segments.ts
  var MODE_TERMINATOR = 0;
  var MODE_NUMERIC = 1;
  var MODE_C64 = 2;
  var MODE_TEXT = 3;
  var MODE_BYTE = 4;
  var MODE_URL = 5;
  var MODE_GEO = 6;
  var MODE_FRAME = 7;
  var MODE_MAC = 8;
  var MODE_SIGNATURE = 9;
  var MODE_SECURE = 10;
  var MODE_VENDOR = 15;
  var C64 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";
  var C64_ESCAPE = 63;
  var U64 = "abcdefghijklmnopqrstuvwxyz0123456789-._/?=&%:#+~@,;()!$'*[] ";
  var U64_UPPER_SHIFT = 60;
  var U64_ESCAPE = 63;
  var AUTH39 = "abcdefghijklmnopqrstuvwxyz0123456789-.:";
  function authBits(n) {
    const max = /* @__PURE__ */ BigInt("39") ** BigInt(n) - /* @__PURE__ */ BigInt("1");
    let bits = 0;
    let v = max;
    while (v > /* @__PURE__ */ BigInt("0")) {
      bits++;
      v >>= /* @__PURE__ */ BigInt("1");
    }
    return bits;
  }
  var c64Index = /* @__PURE__ */ new Map();
  for (let i = 0; i < C64.length; i++) c64Index.set(C64[i], i);
  var u64Index = /* @__PURE__ */ new Map();
  for (let i = 0; i < U64.length; i++) u64Index.set(U64[i], i);
  var auth39Index = /* @__PURE__ */ new Map();
  for (let i = 0; i < AUTH39.length; i++) auth39Index.set(AUTH39[i], i);
  function utf8LengthOf(s) {
    return utf8Encode(s).length;
  }
  function numericBits(digits) {
    const groups = Math.floor(digits / 3);
    const rem = digits - groups * 3;
    return groups * 10 + (rem === 2 ? 7 : rem === 1 ? 4 : 0);
  }
  function c64DataBits(s) {
    let bits = 0;
    for (const ch of s) {
      bits += c64Index.has(ch) ? 6 : 6 + 8 * utf8Encode(ch).length;
    }
    return bits;
  }
  function urlSplit(url) {
    const m = /^(https?):\/\/([^/?#\s]*)([\s\S]*)$/i.exec(url);
    if (!m) return null;
    const scheme = m[1].toLowerCase();
    const authority = m[2].toLowerCase();
    for (const ch of authority) if (!auth39Index.has(ch)) return null;
    return { scheme, authority, rest: m[3] };
  }
  function u64DataBits(s) {
    let bits = 0;
    for (const ch of s) {
      if (u64Index.has(ch)) bits += 6;
      else if (u64Index.has(ch.toLowerCase()) && ch.toLowerCase() !== ch && /[a-z]/.test(ch.toLowerCase())) bits += 12;
      else bits += 6 + 8 * utf8Encode(ch).length;
    }
    return bits;
  }
  function segmentBits(seg) {
    switch (seg.kind) {
      case "numeric":
        return 4 + 14 + numericBits(seg.value.length);
      case "c64":
        return 4 + 14 + c64DataBits(seg.value);
      case "text":
        return 4 + 16 + 8 * utf8LengthOf(seg.value);
      case "byte":
        return 4 + 16 + 8 * seg.value.length;
      case "url": {
        const parts = urlSplit(seg.value);
        if (!parts) return Infinity;
        return 4 + 3 + 8 + authBits(parts.authority.length) + 14 + u64DataBits(parts.rest);
      }
      case "geo":
        return 4 + 32 + 32 + 16 + 8;
      case "frame":
        return 4 + 32 + 12 + 12;
      case "mac":
        return 4 + 4 + 12 + 8 * seg.value.length;
      case "signature":
        return 4 + 4 + 12 + 8 * seg.value.length;
      case "vendor":
        return 4 + 16 + 16 + 8 * seg.value.length;
      case "secure":
        return 4 + 4 + 4 + 8 + 8 * seg.salt.length + 32 + 4 + 8 * seg.keyId.length + 96 + 16 + 8 * seg.ciphertext.length;
    }
  }
  function writeSegment(w, seg) {
    switch (seg.kind) {
      case "numeric": {
        if (!/^[0-9]*$/.test(seg.value)) throw new Error("NUMERIC segment contains a non-digit");
        if (seg.value.length > 16383) throw new Error("NUMERIC segment too long");
        w.writeBits(MODE_NUMERIC, 4);
        w.writeBits(seg.value.length, 14);
        let i = 0;
        for (; i + 3 <= seg.value.length; i += 3) w.writeBits(parseInt(seg.value.substr(i, 3), 10), 10);
        const rem = seg.value.length - i;
        if (rem === 2) w.writeBits(parseInt(seg.value.substr(i, 2), 10), 7);
        else if (rem === 1) w.writeBits(parseInt(seg.value.substr(i, 1), 10), 4);
        return;
      }
      case "c64": {
        const chars = Array.from(seg.value);
        if (chars.length > 16383) throw new Error("C64 segment too long");
        w.writeBits(MODE_C64, 4);
        w.writeBits(chars.length, 14);
        for (const ch of chars) {
          const idx = c64Index.get(ch);
          if (idx === void 0) {
            w.writeBits(C64_ESCAPE, 6);
            for (const b of utf8Encode(ch)) w.writeBits(b, 8);
          } else w.writeBits(idx, 6);
        }
        return;
      }
      case "text": {
        const bytes = utf8Encode(seg.value);
        w.writeBits(MODE_TEXT, 4);
        w.writeBits(bytes.length, 16);
        w.writeBytes(bytes);
        return;
      }
      case "byte": {
        w.writeBits(MODE_BYTE, 4);
        w.writeBits(seg.value.length, 16);
        w.writeBytes(seg.value);
        return;
      }
      case "url": {
        const parts = urlSplit(seg.value);
        if (!parts) throw new Error("not an http(s) URL expressible in URL mode");
        w.writeBits(MODE_URL, 4);
        w.writeBits(parts.scheme === "https" ? 0 : 1, 3);
        w.writeBits(parts.authority.length, 8);
        if (parts.authority.length > 0) {
          let v = /* @__PURE__ */ BigInt("0");
          for (const ch of parts.authority) v = v * /* @__PURE__ */ BigInt("39") + BigInt(auth39Index.get(ch));
          w.writeBigInt(v, authBits(parts.authority.length));
        }
        const chars = Array.from(parts.rest);
        if (chars.length > 16383) throw new Error("URL body too long");
        w.writeBits(chars.length, 14);
        for (const ch of chars) {
          const idx = u64Index.get(ch);
          if (idx !== void 0) {
            w.writeBits(idx, 6);
            continue;
          }
          const lower = ch.toLowerCase();
          const lidx = u64Index.get(lower);
          if (lidx !== void 0 && lidx < 26 && lower !== ch) {
            w.writeBits(U64_UPPER_SHIFT, 6);
            w.writeBits(lidx, 6);
            continue;
          }
          w.writeBits(U64_ESCAPE, 6);
          for (const b of utf8Encode(ch)) w.writeBits(b, 8);
        }
        return;
      }
      case "geo": {
        const g2 = seg.value;
        w.writeBits(MODE_GEO, 4);
        const lat = Math.round(g2.lat * 1e7);
        const lon = Math.round(g2.lon * 1e7);
        if (Math.abs(lat) > 9e8 || Math.abs(lon) > 18e8) throw new RangeError("geo out of range");
        w.writeBits(lat >>> 0 | 0, 32);
        w.writeBits(lon >>> 0 | 0, 32);
        const alt = Math.max(-1e3, Math.min(31767, Math.round(g2.alt)));
        w.writeBits(alt + 1e3 & 65535, 16);
        w.writeBits(g2.flags & 255, 8);
        return;
      }
      case "frame": {
        w.writeBits(MODE_FRAME, 4);
        w.writeBits(seg.streamId >>> 0, 32);
        w.writeBits(seg.index & 4095, 12);
        w.writeBits(seg.count & 4095, 12);
        return;
      }
      case "mac":
      case "signature": {
        const mode = seg.kind === "mac" ? MODE_MAC : MODE_SIGNATURE;
        if (seg.value.length > 4095) throw new Error("signature segment too long");
        w.writeBits(mode, 4);
        w.writeBits(seg.algo & 15, 4);
        w.writeBits(seg.value.length, 12);
        w.writeBytes(seg.value);
        return;
      }
      case "vendor": {
        w.writeBits(MODE_VENDOR, 4);
        w.writeBits(seg.id & 65535, 16);
        w.writeBits(seg.value.length, 16);
        w.writeBytes(seg.value);
        return;
      }
      case "secure": {
        if (seg.salt.length > 255) throw new RangeError("SECURE salt too long");
        if (seg.keyId.length > 15) throw new RangeError("SECURE keyId too long (max 15 bytes)");
        if (seg.nonce.length !== AEAD_NONCE_BYTES) throw new RangeError("SECURE nonce must be 12 bytes");
        if (seg.ciphertext.length > 65535) throw new RangeError("SECURE payload too long");
        w.writeBits(MODE_SECURE, 4);
        w.writeBits(seg.suite & 15, 4);
        w.writeBits(seg.flags & 15, 4);
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
  var SegmentDecodeError = class extends Error {
  };
  function readSegments(r, maxSegments = 4096) {
    var _a, _b;
    const out = [];
    while (r.remaining >= 4 && out.length < maxSegments) {
      const mode = r.readBits(4);
      if (mode === MODE_TERMINATOR) break;
      switch (mode) {
        case MODE_NUMERIC: {
          const count = r.readBits(14);
          if (r.remaining < numericBits(count)) throw new SegmentDecodeError("truncated NUMERIC");
          let s = "";
          let i = 0;
          for (; i + 3 <= count; i += 3) s += String(r.readBits(10)).padStart(3, "0");
          const rem = count - i;
          if (rem === 2) s += String(r.readBits(7)).padStart(2, "0");
          else if (rem === 1) s += String(r.readBits(4));
          out.push({ kind: "numeric", value: s });
          break;
        }
        case MODE_C64: {
          const count = r.readBits(14);
          let s = "";
          for (let i = 0; i < count; i++) {
            if (r.remaining < 6) throw new SegmentDecodeError("truncated C64");
            const c = r.readBits(6);
            if (c === C64_ESCAPE) {
              const bytes = [];
              const b0 = r.readBits(8);
              bytes.push(b0);
              const extra = b0 >= 240 ? 3 : b0 >= 224 ? 2 : b0 >= 192 ? 1 : 0;
              for (let k = 0; k < extra; k++) bytes.push(r.readBits(8));
              s += utf8Decode(Uint8Array.from(bytes));
            } else s += (_a = C64[c]) != null ? _a : "\uFFFD";
          }
          out.push({ kind: "c64", value: s });
          break;
        }
        case MODE_TEXT: {
          const count = r.readBits(16);
          if (r.remaining < count * 8) throw new SegmentDecodeError("truncated TEXT");
          out.push({ kind: "text", value: utf8Decode(r.readBytes(count)) });
          break;
        }
        case MODE_BYTE: {
          const count = r.readBits(16);
          if (r.remaining < count * 8) throw new SegmentDecodeError("truncated BYTE");
          out.push({ kind: "byte", value: r.readBytes(count) });
          break;
        }
        case MODE_URL: {
          const scheme = r.readBits(3);
          if (scheme > 1) throw new SegmentDecodeError("reserved URL scheme");
          const authLen = r.readBits(8);
          let v = authLen > 0 ? r.readBigInt(authBits(authLen)) : /* @__PURE__ */ BigInt("0");
          let authority = "";
          for (let i = authLen - 1; i >= 0; i--) {
            authority = AUTH39[Number(v % /* @__PURE__ */ BigInt("39"))] + authority;
            v /= /* @__PURE__ */ BigInt("39");
          }
          const bodyLen = r.readBits(14);
          let body = "";
          let upper = false;
          for (let i = 0; i < bodyLen; i++) {
            if (r.remaining < 6) throw new SegmentDecodeError("truncated URL body");
            let c = r.readBits(6);
            if (c === U64_ESCAPE) {
              const bytes = [];
              const b0 = r.readBits(8);
              bytes.push(b0);
              const extra = b0 >= 240 ? 3 : b0 >= 224 ? 2 : b0 >= 192 ? 1 : 0;
              for (let k = 0; k < extra; k++) bytes.push(r.readBits(8));
              body += utf8Decode(Uint8Array.from(bytes));
              continue;
            }
            if (c === U64_UPPER_SHIFT) {
              if (upper) throw new SegmentDecodeError("doubled upper-shift in URL body");
              upper = true;
              i--;
              continue;
            }
            if (upper && c < 26) {
              body += String.fromCharCode(65 + c);
              upper = false;
              continue;
            }
            upper = false;
            body += (_b = U64[c]) != null ? _b : "\uFFFD";
          }
          out.push({ kind: "url", value: `${scheme === 0 ? "https" : "http"}://${authority}${body}` });
          break;
        }
        case MODE_GEO: {
          const lat = r.readBits(32) | 0;
          const lon = r.readBits(32) | 0;
          const alt = r.readBits(16) - 1e3;
          const flags = r.readBits(8);
          out.push({ kind: "geo", value: { lat: lat / 1e7, lon: lon / 1e7, alt, flags } });
          break;
        }
        case MODE_FRAME: {
          out.push({ kind: "frame", streamId: r.readBits(32), index: r.readBits(12), count: r.readBits(12) });
          break;
        }
        case MODE_MAC:
        case MODE_SIGNATURE: {
          const algo = r.readBits(4);
          const count = r.readBits(12);
          if (r.remaining < count * 8) throw new SegmentDecodeError("truncated MAC/SIGNATURE");
          const value = r.readBytes(count);
          out.push(mode === MODE_MAC ? { kind: "mac", algo, value } : { kind: "signature", algo, value });
          break;
        }
        case MODE_VENDOR: {
          const id = r.readBits(16);
          const count = r.readBits(16);
          if (r.remaining < count * 8) throw new SegmentDecodeError("truncated VENDOR");
          out.push({ kind: "vendor", id, value: r.readBytes(count) });
          break;
        }
        case MODE_SECURE: {
          const suite = r.readBits(4);
          const flags = r.readBits(4);
          const saltLen = r.readBits(8);
          if (r.remaining < saltLen * 8) throw new SegmentDecodeError("truncated SECURE salt");
          const salt = r.readBytes(saltLen);
          const iterations = r.readBits(32);
          const keyIdLen = r.readBits(4);
          if (r.remaining < keyIdLen * 8) throw new SegmentDecodeError("truncated SECURE key id");
          const keyId = r.readBytes(keyIdLen);
          if (r.remaining < 96) throw new SegmentDecodeError("truncated SECURE nonce");
          const nonce = r.readBytes(12);
          const ctLen = r.readBits(16);
          if (r.remaining < ctLen * 8) throw new SegmentDecodeError("truncated SECURE ciphertext");
          out.push({ kind: "secure", suite, flags, salt, iterations, keyId, nonce, ciphertext: r.readBytes(ctLen) });
          break;
        }
        default:
          throw new SegmentDecodeError(`reserved mode ${mode}`);
      }
    }
    return out;
  }
  var MAX_SEGMENT_SCAN = 1024;
  function autoSegments(text, preferUrl = true) {
    if (text.length === 0) return [];
    if (preferUrl) {
      const parts = urlSplit(text.trim());
      if (parts) {
        const seg = { kind: "url", value: text.trim() };
        if (segmentBits(seg) <= segmentBits({ kind: "text", value: text })) return [seg];
      }
    }
    const chars = Array.from(text);
    const n = chars.length;
    const utf8Len = chars.map((c) => utf8Encode(c).length);
    const isDigit = chars.map((c) => c >= "0" && c <= "9");
    const INF = Number.POSITIVE_INFINITY;
    const cost = new Float64Array(n + 1).fill(INF);
    const choice = new Array(n + 1).fill(null);
    cost[n] = 0;
    for (let i2 = n - 1; i2 >= 0; i2--) {
      let c64 = 4 + 14;
      let txt = 4 + 16;
      let num = 4 + 14;
      let allDigits = true;
      for (let j = i2; j < Math.min(n, i2 + MAX_SEGMENT_SCAN); j++) {
        const ch = chars[j];
        c64 += c64Index.has(ch) ? 6 : 6 + 8 * utf8Len[j];
        txt += 8 * utf8Len[j];
        if (!isDigit[j]) allDigits = false;
        if (allDigits) {
          const digits = j - i2 + 1;
          const cand = num + numericBits(digits) + cost[j + 1];
          if (cand < cost[i2]) {
            cost[i2] = cand;
            choice[i2] = { j: j + 1, seg: { kind: "numeric", value: chars.slice(i2, j + 1).join("") } };
          }
        }
        if (c64 + cost[j + 1] < cost[i2]) {
          cost[i2] = c64 + cost[j + 1];
          choice[i2] = { j: j + 1, seg: { kind: "c64", value: chars.slice(i2, j + 1).join("") } };
        }
        if (txt + cost[j + 1] < cost[i2]) {
          cost[i2] = txt + cost[j + 1];
          choice[i2] = { j: j + 1, seg: { kind: "text", value: chars.slice(i2, j + 1).join("") } };
        }
        const numCand = allDigits ? num + numericBits(j - i2 + 1) : INF;
        if (c64 >= cost[i2] && txt >= cost[i2] && numCand >= cost[i2]) break;
      }
    }
    const out = [];
    let i = 0;
    while (i < n) {
      const c = choice[i];
      if (!c) {
        out.push({ kind: "text", value: chars.slice(i).join("") });
        break;
      }
      out.push(c.seg);
      i = c.j;
    }
    return out;
  }
  var PAD_BYTE_1 = 236;
  var PAD_BYTE_2 = 17;
  function segmentsToBytes(segments) {
    const w = new BitWriter();
    for (const s of segments) writeSegment(w, s);
    for (let i = 0; i < 4; i++) w.writeBit(0);
    while (w.length % 8 !== 0) w.writeBit(0);
    return w.toBytes();
  }
  function encodePayloadBytes(segments, payloadBytes) {
    const w = new BitWriter();
    for (const s of segments) writeSegment(w, s);
    const capacityBits = payloadBytes * 8;
    if (w.length > capacityBits) {
      throw new RangeError(`payload needs ${w.length} bits but only ${capacityBits} are available`);
    }
    const term = Math.min(4, capacityBits - w.length);
    for (let i = 0; i < term; i++) w.writeBit(0);
    while (w.length % 8 !== 0 && w.length < capacityBits) w.writeBit(0);
    const bytes = w.toBytes();
    const out = new Uint8Array(payloadBytes);
    out.set(bytes.subarray(0, Math.min(bytes.length, payloadBytes)));
    let p = bytes.length;
    let toggle = 0;
    while (p < payloadBytes) out[p++] = toggle++ % 2 === 0 ? PAD_BYTE_1 : PAD_BYTE_2;
    return out;
  }
  function decodePayloadBytes(bytes) {
    const r = new BitReader(bytes);
    const segments = readSegments(r);
    return { segments };
  }
  function payloadToText(p) {
    return p.segments.map((s) => {
      switch (s.kind) {
        case "numeric":
        case "c64":
        case "text":
        case "url":
          return s.value;
        case "byte":
          return `[${s.value.length} bytes]`;
        case "geo":
          return `geo:${s.value.lat},${s.value.lon}${s.value.alt !== -1e3 ? `?alt=${s.value.alt}` : ""}`;
        case "frame":
          return `[frame ${s.index + 1}/${s.count}]`;
        case "mac":
          return `[mac:${s.algo} ${s.value.length}B]`;
        case "signature":
          return `[sig:${s.algo} ${s.value.length}B]`;
        case "vendor":
          return `[vendor:${s.id} ${s.value.length}B]`;
        case "secure":
          return `[encrypted:${s.keyId.length ? hexEncode(s.keyId) : "no-id"} ${s.ciphertext.length - AEAD_TAG_BYTES}B]`;
      }
    }).join("");
  }
  var SECURE_SUITE_PBKDF2 = 0;
  var SECURE_SUITE_RAW = 1;
  var SECURE_AAD_DOMAIN = "SMC1-SECURE";
  function toBytes(v) {
    return typeof v === "string" ? utf8Encode(v) : v;
  }
  function secureAad(seg, context) {
    const parts = [
      utf8Encode(SECURE_AAD_DOMAIN),
      Uint8Array.from([seg.suite & 255, seg.keyId.length & 255]),
      seg.keyId,
      seg.nonce
    ];
    if (context !== void 0) parts.push(toBytes(context));
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
  function expandSecureKey(seg, key) {
    if (typeof key !== "string" && key.length === AEAD_KEY_BYTES) return key;
    if (seg.suite === SECURE_SUITE_RAW) {
      return null;
    }
    if (seg.suite === SECURE_SUITE_PBKDF2) {
      const d = deriveKey(toBytes(key), seg.salt, Math.max(1, seg.iterations));
      return d.key;
    }
    return null;
  }
  var SECURE_FLAG_DEFLATE = 1;
  function wrapSecure(inner, opt) {
    var _a, _b, _c, _d, _e;
    const plain = segmentsToBytes(inner);
    const deflated = opt.compress !== false ? deflateIfSmaller(plain) : null;
    const plaintext = deflated != null ? deflated : plain;
    const raw = typeof opt.key !== "string";
    let suite;
    let salt;
    let iterations;
    let key;
    let keyId;
    if (raw) {
      const bytes = opt.key;
      if (bytes.length !== AEAD_KEY_BYTES) {
        throw new RangeError(`a raw SECURE key must be exactly ${AEAD_KEY_BYTES} bytes, got ${bytes.length}`);
      }
      suite = SECURE_SUITE_RAW;
      salt = new Uint8Array(0);
      iterations = 0;
      key = bytes;
      keyId = (_a = opt.keyId) != null ? _a : Uint8Array.from(hmacSha256(utf8Encode(SECURE_AAD_DOMAIN), key).subarray(0, 4));
    } else {
      suite = SECURE_SUITE_PBKDF2;
      salt = (_b = opt.salt) != null ? _b : randomSalt();
      iterations = (_c = opt.iterations) != null ? _c : PBKDF2_ITERATIONS;
      const d = deriveKey(opt.key, salt, iterations);
      key = d.key;
      keyId = (_d = opt.keyId) != null ? _d : d.keyId;
    }
    const nonce = (_e = opt.nonce) != null ? _e : randomNonce();
    if (nonce.length !== AEAD_NONCE_BYTES) throw new RangeError("SECURE nonce must be 12 bytes");
    const seg = { kind: "secure", suite, flags: deflated ? SECURE_FLAG_DEFLATE : 0, salt, iterations, keyId, nonce, ciphertext: new Uint8Array(0) };
    seg.ciphertext = aeadEncrypt(key, nonce, plaintext, secureAad(seg, opt.context));
    return seg;
  }
  function unwrapSecure(seg, opt = {}) {
    var _a;
    const candidates = [];
    if (opt.key !== void 0) candidates.push(opt.key);
    for (const k of (_a = opt.keys) != null ? _a : []) {
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
        continue;
      }
    }
    return null;
  }
  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // packages/core/src/encoder.ts
  function buildSegments(opt) {
    const segs = [];
    if (opt.frame) segs.push({ kind: "frame", ...opt.frame });
    if (opt.segments) segs.push(...opt.segments);
    if (opt.url !== void 0) {
      const s = { kind: "url", value: opt.url };
      segs.push(Number.isFinite(segmentBits(s)) ? s : { kind: "text", value: opt.url });
    }
    if (opt.text !== void 0) segs.push(...autoSegments(opt.text));
    if (opt.data) segs.push({ kind: "byte", value: opt.data });
    if (opt.geo) segs.push({ kind: "geo", value: opt.geo });
    if (opt.mac) segs.push({ kind: "mac", algo: opt.mac.algo, value: opt.mac.value });
    if (opt.signature) segs.push({ kind: "signature", algo: opt.signature.algo, value: opt.signature.value });
    if (opt.vendor) segs.push({ kind: "vendor", id: opt.vendor.id, value: opt.vendor.value });
    return segs;
  }
  function segmentsToCoreBytes(segments) {
    return segmentsToBytes(segments);
  }
  var CapacityError = class extends Error {
    constructor(message, neededBits, availableBits) {
      super(message);
      this.neededBits = neededBits;
      this.availableBits = availableBits;
    }
  };
  var MIN_COMPRESS_BYTES = 24;
  function encode(opt = {}) {
    var _a, _b, _c;
    const ecc = (_a = opt.ecc) != null ? _a : "M";
    let segments = buildSegments(opt);
    let secure;
    if (opt.secure) {
      const clear = segments.filter((x) => x.kind === "frame");
      const sealed = segments.filter((x) => x.kind !== "frame");
      secure = wrapSecure(sealed, opt.secure);
      segments = [...clear, secure];
    }
    const core = segmentsToCoreBytes(segments);
    const compress2 = (_b = opt.compress) != null ? _b : (raw) => deflateRaw(raw);
    const useCompression = !secure && opt.compression !== false && core.length >= MIN_COMPRESS_BYTES;
    let compressed = null;
    if (useCompression) {
      const c = compress2(core);
      if (c && c.length < core.length) compressed = c;
    }
    const bodyBytes = compressed != null ? compressed : core;
    const compressionFlag = compressed ? 1 : 0;
    const needBits = bodyBytes.length * 8;
    const versions = opt.version !== void 0 ? [opt.version] : Array.from({ length: MAX_VERSION - MIN_VERSION + 1 }, (_, i) => i + MIN_VERSION);
    let chosen = null;
    for (const v of versions) {
      const plan2 = planBlocks(v, ecc);
      if (plan2.payloadBytes * 8 >= needBits) {
        chosen = { version: v, plan: plan2 };
        break;
      }
    }
    if (!chosen) {
      const ceiling = opt.version !== void 0 ? opt.version : MAX_VERSION;
      const plan2 = planBlocks(ceiling, ecc);
      const label = opt.version !== void 0 ? `${ceiling} (the requested version)` : `${ceiling} (the largest)`;
      const note = compressed ? ` (${core.length} bytes before DEFLATE)` : "";
      throw new CapacityError(
        `payload of ${needBits} bits${note} does not fit in SiMurgh version ${label} at ECC ${ecc}`,
        needBits,
        plan2.payloadBytes * 8
      );
    }
    const { version, plan } = chosen;
    const payloadBytes = new Uint8Array(plan.payloadBytes);
    payloadBytes.set(bodyBytes.subarray(0, Math.min(bodyBytes.length, plan.payloadBytes)));
    if (compressed) {
    } else {
      const padded = encodePayloadBytes(segments, plan.payloadBytes);
      payloadBytes.set(padded);
    }
    const crc = crc32(payloadBytes);
    const dataCodewords = new Uint8Array(plan.dataCodewords);
    dataCodewords.set(payloadBytes, 0);
    dataCodewords[plan.payloadBytes + 0] = crc >>> 24 & 255;
    dataCodewords[plan.payloadBytes + 1] = crc >>> 16 & 255;
    dataCodewords[plan.payloadBytes + 2] = crc >>> 8 & 255;
    dataCodewords[plan.payloadBytes + 3] = crc & 255;
    const dataBlocks = [];
    const parityBlocks = [];
    let off = 0;
    for (let b = 0; b < plan.blocks; b++) {
      const d = plan.blockData[b];
      const p = plan.blockParity[b];
      const blk = dataCodewords.slice(off, off + d);
      off += d;
      dataBlocks.push(blk);
      parityBlocks.push(rsParity(blk, p));
    }
    const stream = interleave(dataBlocks, parityBlocks);
    if (stream.length !== plan.codewords) throw new Error(`interleave produced ${stream.length} != ${plan.codewords}`);
    const lat = getLattice(version);
    const N = lat.N;
    const bitCount = stream.length * 8;
    const rawBits = new Uint8Array(N);
    for (let i = 0; i < bitCount; i++) {
      const bit = stream[i >> 3] >>> 7 - (i & 7) & 1;
      rawBits[lat.serpentine[i]] = bit;
    }
    let maskId = (_c = opt.mask) != null ? _c : -1;
    let maskScores = [];
    if (maskId < 0) {
      const sel = bestMask(version, rawBits);
      maskId = sel.mask;
      maskScores = sel.scores;
    } else {
      maskScores = Array.from({ length: 8 }, (_, m) => m === maskId ? 0 : Infinity);
    }
    const mask = maskArray(version, maskId);
    const dataBits = new Uint8Array(N);
    let dark = 0;
    for (let i = 0; i < N; i++) {
      dataBits[i] = rawBits[i] ^ mask[i];
      dark += dataBits[i];
    }
    const fb = {
      versionIndex: version - 1,
      ecc: ECC_LEVELS.indexOf(ecc),
      mask: maskId,
      compression: compressionFlag
    };
    const formatBits = packFormat(fb);
    const { word: formatWord, beads } = encodeFormatCrown(fb);
    return {
      version,
      ecc,
      mask: maskId,
      compression: compressionFlag,
      formatBits,
      formatWord,
      plan,
      segments,
      payloadBytes,
      codewords: stream,
      dataBits,
      maskBits: mask,
      rawBits,
      teeth: Uint8Array.from(ANGLE_TRACK),
      beads,
      maskScores,
      inkCoverage: dark / N,
      ...secure ? { secure } : {}
    };
  }

  // packages/core/src/decoder.ts
  function describeSecure(seg) {
    return {
      suite: seg.suite,
      keyId: hexEncode(seg.keyId),
      iterations: seg.iterations,
      salt: hexEncode(seg.salt),
      plaintextBytes: Math.max(0, seg.ciphertext.length - 16)
    };
  }
  function openEnvelopes(payload, opt) {
    let sawEnvelope = false;
    let unlocked = false;
    const out = [];
    for (const seg of payload.segments) {
      if (seg.kind !== "secure") {
        out.push(seg);
        continue;
      }
      sawEnvelope = true;
      const inner = opt ? unwrapSecure(seg, opt) : null;
      if (inner) {
        out.push(...inner);
        unlocked = true;
      } else {
        out.push(seg);
      }
    }
    return sawEnvelope ? { payload: { segments: out }, unlocked } : { payload, unlocked };
  }
  function decodeWithFormat(input, format, opt = {}) {
    var _a, _b, _c;
    const version = format.versionIndex + 1;
    const ecc = ECC_LEVELS[format.ecc];
    const plan = planBlocks(version, ecc);
    const lat = getLattice(version);
    const N = lat.N;
    if (input.dataBits.length < N) return null;
    const threshold = (_a = opt.erasureThreshold) != null ? _a : 0.28;
    const mask = maskArray(version, format.mask);
    const serpentine = lat.serpentine;
    const bitCount = plan.codewords * 8;
    const stream = new Uint8Array(plan.codewords);
    const cellToSymbol = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      const j = serpentine[i];
      const raw = input.dataBits[j] & 1 ^ mask[j];
      if (i >= bitCount) continue;
      if (raw) stream[i >> 3] = stream[i >> 3] | 1 << 7 - (i & 7);
      cellToSymbol[j] = i >> 3;
    }
    const layout = interleavedLayout(plan.blockData, plan.blockParity);
    const frac = (_b = opt.maxErasureFraction) != null ? _b : 0.85;
    const blockBudget = plan.blockParity.map((nk) => Math.max(0, Math.floor(nk * frac)));
    const blockErasedCount = new Int32Array(plan.blockData.length);
    const erasedSymbol = new Uint8Array(plan.codewords);
    let erasedSymbols = 0;
    let erasureCells = 0;
    let budgetBlocked = 0;
    const claimSymbol = (sym) => {
      var _a2, _b2;
      if (sym < 0) return false;
      if (erasedSymbol[sym]) return true;
      const b = (_b2 = (_a2 = layout[sym]) == null ? void 0 : _a2.block) != null ? _b2 : -1;
      if (b >= 0 && blockErasedCount[b] >= blockBudget[b]) {
        budgetBlocked++;
        return false;
      }
      erasedSymbol[sym] = 1;
      if (b >= 0) blockErasedCount[b] = blockErasedCount[b] + 1;
      erasedSymbols++;
      return true;
    };
    const claim = (j) => {
      const sym = cellToSymbol[j];
      if (sym < 0) return false;
      const had = erasedSymbol[sym] === 1;
      if (!claimSymbol(sym)) return false;
      if (!had || true) erasureCells++;
      return true;
    };
    if (input.erasures) {
      for (let k = 0; k < input.erasures.length; k++) {
        const j = input.erasures[k];
        if (j >= 0 && j < N) claim(j);
      }
    }
    if (input.confidence) {
      const weak = [];
      for (let j = 0; j < N; j++) {
        if (input.confidence[j] < threshold && cellToSymbol[j] >= 0) weak.push(j);
      }
      if (weak.length > 0) {
        const conf = input.confidence;
        const hits = new Int32Array(plan.codewords);
        const worst = new Float32Array(plan.codewords).fill(2);
        for (const j of weak) {
          const sym = cellToSymbol[j];
          if (sym < 0) continue;
          hits[sym] = hits[sym] + 1;
          const c = conf[j];
          if (c < worst[sym]) worst[sym] = c;
        }
        const order = [];
        for (let sym = 0; sym < plan.codewords; sym++) if (hits[sym] > 0) order.push(sym);
        order.sort((a, b) => {
          const d = hits[b] - hits[a];
          if (d !== 0) return d;
          return worst[a] - worst[b];
        });
        let refusals = 0;
        for (const sym of order) {
          if (erasedSymbol[sym]) continue;
          if (claimSymbol(sym)) {
            erasureCells += hits[sym];
            refusals = 0;
            continue;
          }
          refusals++;
          if (refusals > order.length) break;
          let anyRoom = false;
          for (let b = 0; b < blockBudget.length; b++) {
            if (blockErasedCount[b] < blockBudget[b]) {
              anyRoom = true;
              break;
            }
          }
          if (!anyRoom) break;
        }
      }
    }
    const blockErasures = plan.blockData.map(() => []);
    for (let s = 0; s < layout.length; s++) {
      if (erasedSymbol[s]) {
        const l = layout[s];
        blockErasures[l.block].push(l.index);
      }
    }
    const { dataBlocks, parityBlocks } = deinterleave(stream, plan.blockData, plan.blockParity);
    let errorsFixed = 0;
    let erasuresFixed = 0;
    let blocksFailed = 0;
    const fixedData = [];
    for (let b = 0; b < plan.blocks; b++) {
      const cw = new Uint8Array(dataBlocks[b].length + parityBlocks[b].length);
      cw.set(dataBlocks[b], 0);
      cw.set(parityBlocks[b], dataBlocks[b].length);
      const res = rsDecode(cw, plan.blockParity[b], blockErasures[b]);
      if (!res.ok) {
        blocksFailed++;
        continue;
      }
      errorsFixed += res.errorsFixed;
      erasuresFixed += res.erasuresFixed;
      fixedData.push(res.corrected.slice(0, dataBlocks[b].length));
    }
    if (blocksFailed > 0) {
      return {
        ok: false,
        error: `${blocksFailed} of ${plan.blocks} Reed-Solomon block(s) beyond correction`,
        stats: {
          crownOk: true,
          crownDistance: 0,
          candidatesTried: 1,
          errorsFixed,
          erasuresFixed,
          erasureCells,
          erasureSymbols: erasedSymbols,
          erasureBudget: blockBudget.reduce((a, b) => a + b, 0),
          erasureBudgetBlocked: budgetBlocked,
          blocksFailed,
          crcOk: false
        }
      };
    }
    const dataCodewords = new Uint8Array(plan.dataCodewords);
    let off = 0;
    for (const blk of fixedData) {
      dataCodewords.set(blk, off);
      off += blk.length;
    }
    const payloadBytes = dataCodewords.slice(0, plan.payloadBytes);
    const crcExpected = (dataCodewords[plan.payloadBytes] << 24 | dataCodewords[plan.payloadBytes + 1] << 16 | dataCodewords[plan.payloadBytes + 2] << 8 | dataCodewords[plan.payloadBytes + 3]) >>> 0;
    const crcActual = crc32(payloadBytes);
    const crcOk = crcExpected === crcActual;
    if (!crcOk) {
      return {
        ok: false,
        error: "CRC-32 mismatch after Reed-Solomon (wrong format candidate, or damage beyond correction)",
        stats: {
          crownOk: true,
          crownDistance: 0,
          candidatesTried: 1,
          errorsFixed,
          erasuresFixed,
          erasureCells,
          erasureSymbols: erasedSymbols,
          erasureBudget: blockBudget.reduce((a, b) => a + b, 0),
          erasureBudgetBlocked: budgetBlocked,
          blocksFailed: 0,
          crcOk: false
        }
      };
    }
    const stats = {
      crownOk: true,
      crownDistance: 0,
      candidatesTried: 1,
      errorsFixed,
      erasuresFixed,
      erasureCells,
      erasureSymbols: erasedSymbols,
      erasureBudget: blockBudget.reduce((a, b) => a + b, 0),
      erasureBudgetBlocked: budgetBlocked,
      blocksFailed: 0,
      crcOk: true,
      codewords: dataCodewords
    };
    let core = payloadBytes;
    if (format.compression === 1) {
      const inflate = (_c = opt.decompress) != null ? _c : (raw) => inflateRaw(raw);
      if (!inflate) {
        return {
          ok: false,
          error: "payload is compressed but no decompressor was supplied",
          version,
          ecc,
          mask: format.mask,
          compression: 1,
          format,
          stats
        };
      }
      try {
        core = inflate(payloadBytes);
      } catch (e) {
        return { ok: false, error: `inflate failed: ${e.message}`, version, ecc, mask: format.mask, compression: 1, format, stats };
      }
    }
    let payload;
    try {
      payload = decodePayloadBytes(core);
    } catch (e) {
      return { ok: false, error: `segment parse failed: ${e.message}`, version, ecc, mask: format.mask, compression: format.compression, format, stats, bytes: core };
    }
    const firstEnvelope = payload.segments.find((s) => s.kind === "secure");
    const opened = openEnvelopes(payload, opt.secure);
    payload = opened.payload;
    return {
      ok: true,
      version,
      ecc,
      mask: format.mask,
      compression: format.compression,
      format,
      payload,
      segments: payload.segments,
      text: payloadToText(payload),
      bytes: core,
      stats,
      ...firstEnvelope ? { encrypted: true, secureUnlocked: opened.unlocked, secureInfo: describeSecure(firstEnvelope) } : {}
    };
  }
  function decode(input, opt = {}) {
    var _a, _b, _c, _d;
    let lastCrownError = "";
    let format = (_a = input.format) != null ? _a : null;
    const explicit = !!input.format;
    let crownOk = false;
    let crownDistance2 = 0;
    if (!format && input.beads) {
      const res = decodeFormatCrown(input.beads);
      crownDistance2 = res.distance;
      if (res.ok && res.format) {
        format = res.format;
        crownOk = true;
      }
    }
    let crownStats;
    const considerCrown = (st) => {
      if (st) crownStats = st;
    };
    if (format) {
      const r = decodeWithFormat(input, format, opt);
      if (r == null ? void 0 : r.ok) {
        if (r.stats) {
          r.stats.crownOk = crownOk;
          r.stats.crownDistance = crownDistance2;
        }
        return r;
      }
      considerCrown(r == null ? void 0 : r.stats);
      if (explicit) {
        return { ok: false, error: (_b = r == null ? void 0 : r.error) != null ? _b : "decode failed", format, stats: r == null ? void 0 : r.stats };
      }
      if (r == null ? void 0 : r.error) lastCrownError = r.error;
    }
    const lastCrownError2 = lastCrownError;
    const versions = (_c = opt.candidateVersions) != null ? _c : guessVersions(input, opt);
    const candidates = formatCandidates(versions);
    const limit = opt.maxCandidates && opt.maxCandidates > 0 ? Math.min(candidates.length, opt.maxCandidates) : candidates.length;
    let lastError = "no candidate format produced a CRC-valid payload";
    let bestStats;
    const rank = (st) => st.erasureSymbols * 100 - st.blocksFailed * 1e4;
    const consider = (st) => {
      if (!st) return;
      if (!bestStats || rank(st) > rank(bestStats)) bestStats = st;
    };
    for (let i = 0; i < limit; i++) {
      const c = candidates[i];
      (_d = opt.onCandidate) == null ? void 0 : _d.call(opt, c);
      const f = { versionIndex: c.version - 1, ecc: ECC_LEVELS.indexOf(c.ecc), mask: c.mask, compression: c.compression };
      const r = decodeWithFormat(input, f, opt);
      if (r && r.ok) {
        if (r.stats) {
          r.stats.crownOk = false;
          r.stats.crownDistance = crownDistance2;
          r.stats.candidatesTried = i + 1;
        }
        return r;
      }
      if (r == null ? void 0 : r.error) lastError = r.error;
      consider(r == null ? void 0 : r.stats);
    }
    const fallback = {
      crownOk,
      crownDistance: crownDistance2,
      candidatesTried: limit,
      errorsFixed: 0,
      erasuresFixed: 0,
      erasureCells: 0,
      erasureSymbols: 0,
      erasureBudget: 0,
      erasureBudgetBlocked: 0,
      blocksFailed: 0,
      crcOk: false
    };
    const best = bestStats != null ? bestStats : crownStats;
    return {
      ok: false,
      error: lastCrownError2 ? `${lastError} (crown attempt: ${lastCrownError2})` : lastError,
      stats: best ? { ...best, crownOk, crownDistance: crownDistance2, candidatesTried: limit } : fallback
    };
  }
  function guessVersions(input, opt) {
    if (opt.candidateVersions && opt.candidateVersions.length) return opt.candidateVersions;
    const n = input.dataBits.length;
    const out = [];
    for (let v = 1; v <= 40; v++) {
      if (getLattice(v).N <= n) out.push(v);
    }
    out.sort((a, b) => Math.abs(getLattice(a).N - n) - Math.abs(getLattice(b).N - n));
    return out.slice(0, 6);
  }

  // packages/core/src/model.ts
  function toModel(sym, textPreview = "") {
    const lat = getLattice(sym.version);
    const g2 = crown(lat.K);
    const core = [];
    {
      core.push({ x: 0, y: 0, dark: true });
      const push = (d, count, dark) => {
        for (let j = 0; j < count; j++) {
          const c = ringCellXY(d, j);
          core.push({ x: c.x, y: c.y, dark });
        }
      };
      push(1, 6, false);
      push(2, 12, true);
    }
    const cellX = new Float64Array(lat.N);
    const cellY = new Float64Array(lat.N);
    for (let i = 0; i < lat.N; i++) {
      cellX[i] = lat.xy[2 * i];
      cellY[i] = lat.xy[2 * i + 1];
    }
    return {
      version: sym.version,
      K: lat.K,
      crown: g2,
      core,
      cellX,
      cellY,
      cellDark: sym.dataBits.slice(),
      cellCount: lat.N,
      teeth: sym.teeth.slice(),
      beads: sym.beads.slice(),
      outerRadius: g2.outerRadius,
      canvasRadius: g2.canvasRadius,
      meta: {
        ecc: sym.ecc,
        mask: sym.mask,
        compression: sym.compression,
        formatBits: sym.formatBits,
        formatWord: sym.formatWord,
        cells: sym.plan.cells,
        codewords: sym.plan.codewords,
        dataCodewords: sym.plan.dataCodewords,
        parityCodewords: sym.plan.parityCodewords,
        blocks: sym.plan.blocks,
        payloadBytes: sym.plan.payloadBytes,
        inkCoverage: sym.inkCoverage,
        textPreview
      }
    };
  }
  function ringCellXY(d, j) {
    const side = Math.floor(j / d);
    const k = j - side * d;
    let q = 0;
    let r = 0;
    switch (side) {
      case 0:
        q = d - k;
        r = k;
        break;
      case 1:
        q = -k;
        r = d;
        break;
      case 2:
        q = -d;
        r = d - k;
        break;
      case 3:
        q = -d + k;
        r = -k;
        break;
      case 4:
        q = k;
        r = -d;
        break;
      default:
        q = d;
        r = -d + k;
        break;
    }
    return { x: q + r / 2, y: Math.sqrt(3) / 2 * r };
  }

  // packages/core/src/render/theme.ts
  var THEMES = {
    ink: { id: "ink", fa: "\u0645\u0631\u06A9\u0627\u0628", en: "Ink on paper", ink: "#111418", crown: "#111418", paper: "#ffffff" },
    lapis: { id: "lapis", fa: "\u0644\u0627\u062C\u0648\u0631\u062F", en: "Lapis lazuli", ink: "#123a72", crown: "#0d2a55", paper: "#f7f3e6" },
    turquoise: { id: "turquoise", fa: "\u0641\u06CC\u0631\u0648\u0632\u0647\u200C\u0627\u06CC", en: "Turquoise", ink: "#0b5d5f", crown: "#083f45", paper: "#fbf8ef" },
    saffron: { id: "saffron", fa: "\u0632\u0639\u0641\u0631\u0627\u0646", en: "Saffron", ink: "#6b3a06", crown: "#4d2803", paper: "#fff8e6" },
    rosewater: { id: "rosewater", fa: "\u06AF\u0644\u0627\u0628", en: "Rosewater", ink: "#7d2340", crown: "#5c1730", paper: "#fdf2f5" },
    pistachio: { id: "pistachio", fa: "\u067E\u0633\u062A\u0647\u200C\u0627\u06CC", en: "Pistachio", ink: "#2f4f16", crown: "#22390f", paper: "#f7f8ef" },
    pomegranate: { id: "pomegranate", fa: "\u0627\u0646\u0627\u0631", en: "Pomegranate", ink: "#6d0f1c", crown: "#4c0912", paper: "#fff5f2" },
    night: { id: "night", fa: "\u0634\u0628", en: "Night (screen only)", ink: "#e9d9a5", crown: "#f3e6bd", paper: "#0e1116" }
  };
  var THEME_IDS = Object.keys(THEMES);
  var PRINT_CONTRAST_FLOOR = 7;
  var SCAN_CONTRAST_FLOOR = 4.5;
  function parseHex(hex) {
    const h = hex.trim().replace(/^#/, "");
    const expand = (c) => parseInt(c + c, 16);
    if (h.length === 3) return [expand(h[0]), expand(h[1]), expand(h[2])];
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    throw new RangeError(`not a hex colour: ${hex}`);
  }
  function relativeLuminance(hex) {
    const [r, g2, b] = parseHex(hex).map((v) => v / 255);
    const lin = (c) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g2) + 0.0722 * lin(b);
  }
  function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }
  function themeContrast(theme) {
    const ink = contrastRatio(theme.ink, theme.paper);
    const crown3 = contrastRatio(theme.crown, theme.paper);
    const worst = Math.min(ink, crown3);
    const printable = worst >= PRINT_CONTRAST_FLOOR;
    const scannable = worst >= SCAN_CONTRAST_FLOOR;
    const verdict = printable ? "print-safe" : scannable ? "screen-safe only: below the 7:1 print floor" : "unscannable: below 4.5:1, a camera will not reliably threshold this";
    return { ink, crown: crown3, worst, printable, scannable, verdict };
  }
  var THEME_CONTRAST = Object.fromEntries(
    Object.values(THEMES).map((t) => [t.id, themeContrast(t)])
  );
  function resolveTheme(theme) {
    if (!theme) return THEMES.ink;
    if (typeof theme !== "string") return theme;
    const t = THEMES[theme];
    if (!t) throw new RangeError(`unknown theme '${theme}' (try: ${THEME_IDS.join(", ")})`);
    return t;
  }

  // packages/core/src/render/raster.ts
  var HEX_NORMALS = (() => {
    const n = [];
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 180 * (60 * k);
      n.push([Math.cos(a), Math.sin(a)]);
    }
    return n;
  })();
  function shapeDistance(dx, dy, shape, gap) {
    switch (shape) {
      case "dot":
        return Math.hypot(dx, dy) - DOT_RADIUS * gap;
      case "hex": {
        const rr = CELL_CIRCUMRADIUS * gap;
        const inradius = rr * (Math.sqrt(3) / 2);
        let m = -Infinity;
        for (const [nx, ny] of HEX_NORMALS) {
          const d = dx * nx + dy * ny - inradius;
          if (d > m) m = d;
        }
        return m;
      }
      case "square": {
        const h = 0.5 * gap;
        return Math.max(Math.abs(dx) - h, Math.abs(dy) - h);
      }
      default: {
        throw new RangeError(`unknown module shape '${String(shape)}' (expected dot | hex | square)`);
      }
    }
  }
  function crownDistance(m, x, y) {
    const g2 = m.crown;
    const r = Math.hypot(x, y);
    let best = Infinity;
    best = Math.min(best, Math.max(g2.limbusInner - r, r - g2.limbusOuter));
    best = Math.min(best, Math.max(g2.haloInner - r, r - g2.haloOuter));
    const ang = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    {
      const tf = ang / TOOTH_DEG;
      const ti = (Math.round(tf) % 63 + 63) % 63;
      const u = tf - Math.round(tf);
      const arc = TOOTH_DEG * Math.PI / 180 * r;
      const angular = (Math.abs(u) - 0.5) * arc;
      const outer = ti === 0 ? g2.beakRadius : g2.teethOuter;
      if (ANGLE_TRACK[ti] === 1 && r <= outer + 1 && r >= g2.teethInner - 1) {
        best = Math.min(best, Math.max(g2.teethInner - r, r - outer, angular));
      }
    }
    {
      const bd = 360 / BEADS;
      const bi = Math.round((ang - bd / 2) / bd);
      for (let k = -1; k <= 1; k++) {
        const i = ((bi + k) % BEADS + BEADS) % BEADS;
        if (m.beads[i] !== 1) continue;
        const a = (i * bd + bd / 2) * Math.PI / 180;
        const cx = g2.beadRadius * Math.cos(a);
        const cy = g2.beadRadius * Math.sin(a);
        const d = Math.hypot(x - cx, y - cy) - g2.beadSize;
        if (d < best) best = d;
      }
    }
    return best;
  }
  function fieldDistance(m, x, y, shape, gap) {
    const g2 = m.crown;
    const r = Math.hypot(x, y);
    let best = Infinity;
    if (r <= g2.haloInner + 0.6) {
      const f = xyToAxialF(x, y);
      const c = axialRound(f.q, f.r);
      const d = hexDistance(c.q, c.r);
      const lat = getLattice(m.version);
      let dark = false;
      let cx = 0;
      let cy = 0;
      if (d <= 2) {
        dark = coreIsDark(d);
        cx = c.q + c.r / 2;
        cy = Math.sqrt(3) / 2 * c.r;
      } else if (d <= lat.K) {
        const idx = lat.ringOffset[d] + ringIndexOf(c.q, c.r, d);
        dark = m.cellDark[idx] === 1;
        cx = lat.xy[2 * idx];
        cy = lat.xy[2 * idx + 1];
      }
      if (dark) {
        const sd = shapeDistance(x - cx, y - cy, shape, gap);
        if (sd < best) best = sd;
      }
    }
    return best;
  }
  function renderRGBA(m, opt = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i;
    const theme = resolveTheme(opt.theme);
    const ink = (_a = opt.inkColour) != null ? _a : opt.dark !== void 0 ? grayToHex(opt.dark) : theme.ink;
    const paper = (_b = opt.paperColour) != null ? _b : opt.light !== void 0 ? grayToHex(opt.light) : theme.paper;
    const crownHex = (_c = opt.crownColour) != null ? _c : theme.crown;
    const scale = (_d = opt.scale) != null ? _d : 8;
    const shape = (_e = opt.shape) != null ? _e : "dot";
    const quiet = (_f = opt.quiet) != null ? _f : m.crown.quietZone;
    const ss = Math.max(1, Math.round((_g = opt.supersample) != null ? _g : scale < 5 ? 4 : scale < 8 ? 2 : 1));
    const gap = (_h = opt.cellGap) != null ? _h : shape === "dot" ? 1 : 0.94;
    const rot = ((_i = opt.rotateDeg) != null ? _i : 0) * Math.PI / 180;
    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const radius = m.outerRadius + quiet;
    const size = Math.max(8, Math.ceil(radius * scale * 2));
    const img = { width: size, height: size, data: new Uint8Array(size * size * 4) };
    const [pr, pg, pb] = parseHex(paper);
    const inkRgb = parseHex(ink);
    const crownRgb = parseHex(crownHex);
    const cx = size / 2;
    const cy = size / 2;
    const px = 1 / scale;
    const soft = px * (ss === 1 ? 1 : 1 / ss) * 0.95;
    for (let py = 0; py < size; py++) {
      for (let pxi = 0; pxi < size; pxi++) {
        const o = (py * size + pxi) * 4;
        img.data[o] = pr;
        img.data[o + 1] = pg;
        img.data[o + 2] = pb;
        img.data[o + 3] = 255;
        let inkAcc = 0;
        let crownAcc = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const ox = ss === 1 ? 0.5 : (sx + 0.5) / ss;
            const oy = ss === 1 ? 0.5 : (sy + 0.5) / ss;
            const ix = (pxi + ox - cx) * px;
            const iy = (cy - (py + oy)) * px;
            const x = ix * cos - iy * sin;
            const y = ix * sin + iy * cos;
            const dc = crownDistance(m, x, y);
            const df = fieldDistance(m, x, y, shape, gap);
            const near = dc <= df ? dc : df;
            const cov = 0.5 - near / soft;
            if (cov <= 0) continue;
            const c = cov >= 1 ? 1 : cov;
            if (dc <= df) crownAcc += c;
            else inkAcc += c;
          }
        }
        const n = ss * ss;
        if (crownAcc > 0) blend(img.data, o, crownRgb, crownAcc / n);
        if (inkAcc > 0) blend(img.data, o, inkRgb, inkAcc / n);
      }
    }
    return img;
  }
  function blend(dst, o, rgb, t) {
    dst[o] = Math.round(dst[o] + (rgb[0] - dst[o]) * t);
    dst[o + 1] = Math.round(dst[o + 1] + (rgb[1] - dst[o + 1]) * t);
    dst[o + 2] = Math.round(dst[o + 2] + (rgb[2] - dst[o + 2]) * t);
  }
  function grayToHex(v) {
    const h = Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return `#${h}${h}${h}`;
  }

  // packages/core/src/render/svg.ts
  var fmt = (n, p) => {
    const s = n.toFixed(p);
    return s.replace(/\.?0+$/, "") || "0";
  };
  function polar(r, deg) {
    const a = deg * Math.PI / 180;
    return [r * Math.cos(a), -r * Math.sin(a)];
  }
  function annularSector(rIn, rOut, a0, a1, p) {
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    const [x0, y0] = polar(rOut, a0);
    const [x1, y1] = polar(rOut, a1);
    const [x2, y2] = polar(rIn, a1);
    const [x3, y3] = polar(rIn, a0);
    return [
      `M${fmt(x0, p)},${fmt(y0, p)}`,
      `A${fmt(rOut, p)},${fmt(rOut, p)} 0 ${large} 0 ${fmt(x1, p)},${fmt(y1, p)}`,
      `L${fmt(x2, p)},${fmt(y2, p)}`,
      `A${fmt(rIn, p)},${fmt(rIn, p)} 0 ${large} 1 ${fmt(x3, p)},${fmt(y3, p)}`,
      "Z"
    ].join("");
  }
  function polygonPath(cx, cy, r, sides, rotDeg, p) {
    let d = "";
    for (let i = 0; i < sides; i++) {
      const a = (rotDeg + 360 * i / sides) * Math.PI / 180;
      const x = cx + r * Math.cos(a);
      const y = cy - r * Math.sin(a);
      d += (i === 0 ? "M" : "L") + fmt(x, p) + "," + fmt(y, p);
    }
    return d + "Z";
  }
  function renderSVG(m, opt = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
    const p = (_a = opt.precision) != null ? _a : 3;
    const shape = (_b = opt.shape) != null ? _b : "dot";
    const theme = resolveTheme(opt.theme);
    const dark = (_c = opt.dark) != null ? _c : theme.ink;
    const crownInk = (_d = opt.crownColour) != null ? _d : opt.dark !== void 0 ? opt.dark : theme.crown;
    const light = (_e = opt.light) != null ? _e : theme.paper;
    const quietZone = opt.quietZone !== false;
    const quiet = (_f = opt.quiet) != null ? _f : quietZone ? m.crown.quietZone : 0;
    const gap = (_g = opt.cellGap) != null ? _g : shape === "dot" ? 1 : 0.94;
    const g2 = m.crown;
    const caption = (_h = opt.caption) != null ? _h : null;
    const captionH = caption ? (_i = opt.captionHeight) != null ? _i : 4 : 0;
    const half = m.outerRadius + quiet;
    const w = 2 * half;
    const h = 2 * half + captionH;
    const unit = (_j = opt.unit) != null ? _j : "px";
    const scale = (_k = opt.scale) != null ? _k : 1;
    const physW = fmt(w * scale, 2);
    const physH = fmt(h * scale, 2);
    const out = [];
    out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
    out.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${physW}${unit}" height="${physH}${unit}" viewBox="${fmt(-half, p)} ${fmt(-half, p)} ${fmt(w, p)} ${fmt(h, p)}" shape-rendering="geometricPrecision">`
    );
    if (opt.metadata !== false) {
      const meta = m.meta;
      out.push("<!--");
      const tc = themeContrast({ ...theme, ink: dark, crown: crownInk, paper: light });
      out.push(`  SiMurgh Code (SMC)  spec 1.1`);
      out.push(`  theme ${theme.id}  ink ${dark}  crown ${crownInk}  paper ${light}  contrast ${tc.worst.toFixed(2)}:1 (${tc.verdict})`);
      out.push(`  version ${m.version}  K=${m.K}  ECC ${meta.ecc}  mask ${meta.mask}  compression ${meta.compression}`);
      out.push(`  cells ${meta.cells}  codewords ${meta.codewords} (${meta.dataCodewords} data + ${meta.parityCodewords} parity) in ${meta.blocks} RS blocks`);
      out.push(`  payload ${meta.payloadBytes} bytes  ink coverage ${(meta.inkCoverage * 100).toFixed(1)}%`);
      out.push(`  format bits 0b${meta.formatBits.toString(2).padStart(12, "0")}  Golay(24,12) word 0x${meta.formatWord.toString(16).toUpperCase().padStart(6, "0")}`);
      out.push(`  geometry: halo ${fmt(g2.haloInner, 2)}-${fmt(g2.haloOuter, 2)}, beads ${fmt(g2.beadRadius, 2)}, teeth ${fmt(g2.teethInner, 2)}-${fmt(g2.teethOuter, 2)}, limbus ${fmt(g2.limbusInner, 2)}-${fmt(g2.limbusOuter, 2)}, quiet ${fmt(quiet, 2)}`);
      out.push("-->");
    }
    out.push(`<rect x="${fmt(-half, p)}" y="${fmt(-half, p)}" width="${fmt(w, p)}" height="${fmt(h, p)}" fill="${light}"/>`);
    const ring = (rIn, rOut) => {
      const rr = (rIn + rOut) / 2;
      return `<circle cx="0" cy="0" r="${fmt(rr, p)}" fill="none" stroke="${crownInk}" stroke-width="${fmt(rOut - rIn, p)}"/>`;
    };
    out.push(ring(g2.limbusInner, g2.limbusOuter));
    out.push(ring(g2.haloInner, g2.haloOuter));
    {
      const halfTooth = TOOTH_DEG / 2;
      const teethPaths = [];
      for (let i = 0; i < TEETH; i++) {
        if (ANGLE_TRACK[i] !== 1) continue;
        const c = i * TOOTH_DEG;
        const rOut = i === 0 ? g2.beakRadius : g2.teethOuter;
        teethPaths.push(annularSector(g2.teethInner, rOut, c - halfTooth, c + halfTooth, p));
      }
      out.push(`<path d="${teethPaths.join(" ")}" fill="${crownInk}"/>`);
      void halfTooth;
    }
    {
      const bd = 360 / BEADS;
      const beads = [];
      for (let i = 0; i < BEADS; i++) {
        if (m.beads[i] !== 1) continue;
        const [x, y] = polar(g2.beadRadius, i * bd + bd / 2);
        beads.push(`M${fmt(x - g2.beadSize, p)},${fmt(y, p)}a${fmt(g2.beadSize, p)},${fmt(g2.beadSize, p)} 0 1,0 ${fmt(2 * g2.beadSize, p)},0a${fmt(g2.beadSize, p)},${fmt(g2.beadSize, p)} 0 1,0 ${fmt(-2 * g2.beadSize, p)},0`);
      }
      out.push(`<path d="${beads.join("")}" fill="${crownInk}"/>`);
    }
    const dotR = 0.46 * gap;
    const hexR = 1 / Math.sqrt(3) * gap;
    const sqH = 0.5 * gap;
    if (shape === "dot") {
      out.push(`<defs><circle id="smc-d" r="${fmt(dotR, p)}"/></defs>`);
    } else if (shape === "hex") {
      out.push(`<defs><path id="smc-d" d="${polygonPath(0, 0, hexR, 6, 30, p)}"/></defs>`);
    } else {
      out.push(`<defs><rect id="smc-d" x="${fmt(-sqH, p)}" y="${fmt(-sqH, p)}" width="${fmt(2 * sqH, p)}" height="${fmt(2 * sqH, p)}"/></defs>`);
    }
    const parts = [];
    for (const c of m.core) {
      if (!c.dark) continue;
      parts.push(`<use href="#smc-d" x="${fmt(c.x, p)}" y="${fmt(-c.y, p)}"/>`);
    }
    for (let i = 0; i < m.cellCount; i++) {
      if (m.cellDark[i] !== 1) continue;
      parts.push(`<use href="#smc-d" x="${fmt(m.cellX[i], p)}" y="${fmt(-m.cellY[i], p)}"/>`);
    }
    out.push(`<g fill="${dark}">${parts.join("")}</g>`);
    if (opt.showGeometry) {
      const rs = [g2.haloRadius, g2.beadRadius, g2.teethRadius, g2.limbusRadius];
      const circles = rs.map((r) => `<circle cx="0" cy="0" r="${fmt(r, p)}" fill="none" stroke="#e11" stroke-width="0.06" stroke-dasharray="0.3 0.3"/>`).join("");
      const axes = `<path d="M${fmt(-m.outerRadius, p)},0H${fmt(m.outerRadius, p)}M0,${fmt(-m.outerRadius, p)}V${fmt(m.outerRadius, p)}" stroke="#06c" stroke-width="0.06" stroke-dasharray="0.3 0.3"/>`;
      out.push(`<g opacity="0.8">${circles}${axes}</g>`);
    }
    if (caption) {
      const y = half + captionH * 0.72;
      const safe = caption.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      out.push(
        `<text x="0" y="${fmt(y, p)}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="${fmt(captionH * 0.6, p)}" fill="${(_l = theme.caption) != null ? _l : dark}" direction="auto">${safe}</text>`
      );
    }
    out.push("</svg>");
    return out.join("\n");
  }

  // packages/core/src/imaging/image.ts
  function sampleBilinear(img, x, y) {
    if (x < 0 || y < 0 || x > img.width - 1 || y > img.height - 1) return NaN;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const w = img.width;
    const p00 = img.data[y0 * w + x0];
    const p10 = img.data[y0 * w + x0 + 1];
    const p01 = img.data[(y0 + 1) * w + x0];
    const p11 = img.data[(y0 + 1) * w + x0 + 1];
    const top = p00 + (p10 - p00) * fx;
    const bot = p01 + (p11 - p01) * fx;
    return top + (bot - top) * fy;
  }
  var DISC_KERNEL = (() => {
    const pts = [[0, 0]];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 1; i < 13; i++) {
      const rr = Math.sqrt(i / 13) * 0.92;
      const a = i * golden;
      pts.push([rr * Math.cos(a), rr * Math.sin(a)]);
    }
    return pts;
  })();
  function sampleDisc(img, cx, cy, r) {
    let sum = 0;
    let n = 0;
    let min = 255;
    let max = 0;
    let outside = 0;
    for (const [kx, ky] of DISC_KERNEL) {
      const v = sampleBilinear(img, cx + kx * r, cy + ky * r);
      if (Number.isNaN(v)) {
        outside++;
        continue;
      }
      sum += v;
      n++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return { mean: n ? sum / n : 255, min: n ? min : 255, max: n ? max : 0, n, outside: outside / DISC_KERNEL.length };
  }
  function otsuThreshold(img) {
    const hist = new Int32Array(256);
    for (let i = 0; i < img.data.length; i++) {
      const v = img.data[i];
      hist[v] = hist[v] + 1;
    }
    const total = img.data.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0;
    let wB = 0;
    let best = 0;
    let bestT = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) {
        best = between;
        bestT = t;
      }
    }
    return bestT;
  }
  function darkFraction(img) {
    const t = otsuThreshold(img);
    let dark = 0;
    for (let i = 0; i < img.data.length; i++) if (img.data[i] <= t) dark++;
    return dark / Math.max(1, img.data.length);
  }
  function invertImage(img) {
    const out = new Uint8Array(img.data.length);
    for (let i = 0; i < out.length; i++) out[i] = 255 - img.data[i];
    return { width: img.width, height: img.height, data: out };
  }
  function detectPolarity(img) {
    return darkFraction(img) > 0.5 ? "inverted" : "normal";
  }
  function binarize(img, t) {
    const out = new Uint8Array(img.data.length);
    for (let i = 0; i < img.data.length; i++) out[i] = img.data[i] <= t ? 1 : 0;
    return out;
  }
  function blur(img, radius) {
    if (radius <= 0) return img;
    let cur = img;
    for (let pass = 0; pass < radius; pass++) {
      const tmp = new Uint8Array(cur.data.length);
      const { width: w, height: h } = cur;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const l = cur.data[i - (x > 0 ? 1 : 0)];
          const c = cur.data[i];
          const r = cur.data[i + (x < w - 1 ? 1 : 0)];
          tmp[i] = l + 2 * c + r >> 2;
        }
      }
      const out = new Uint8Array(tmp.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const u = tmp[i - (y > 0 ? w : 0)];
          const c = tmp[i];
          const d = tmp[i + (y < h - 1 ? w : 0)];
          out[i] = u + 2 * c + d >> 2;
        }
      }
      cur = { width: w, height: h, data: out };
    }
    return cur;
  }

  // packages/core/src/imaging/locate.ts
  function contrastRange(img) {
    const hist = new Int32Array(256);
    for (let i = 0; i < img.data.length; i++) {
      const v = img.data[i];
      hist[v] = hist[v] + 1;
    }
    const total = img.data.length;
    let acc = 0;
    let lo = 0;
    let hi = 255;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= total * 0.02) {
        lo = v;
        break;
      }
    }
    acc = 0;
    for (let v = 255; v >= 0; v--) {
      acc += hist[v];
      if (acc >= total * 0.02) {
        hi = v;
        break;
      }
    }
    if (hi - lo < 12) {
      const t = otsuThreshold(img);
      lo = Math.max(0, t - 40);
      hi = Math.min(255, t + 40);
    }
    return { lo, hi };
  }
  function inkOf(v, lo, hi) {
    if (Number.isNaN(v)) return 0;
    const x = (hi - v) / (hi - lo);
    return x <= 0 ? 0 : x >= 1 ? 1 : x;
  }
  function radialProfile(img, cx, cy, opt = {}) {
    var _a, _b, _c;
    const rays = (_a = opt.rays) != null ? _a : 256;
    const step = (_b = opt.step) != null ? _b : 0.5;
    const rmax = (_c = opt.rmax) != null ? _c : Math.hypot(Math.max(cx, img.width - cx), Math.max(cy, img.height - cy));
    const range = opt.lo !== void 0 && opt.hi !== void 0 ? { lo: opt.lo, hi: opt.hi } : contrastRange(img);
    const bins = Math.ceil(rmax / step) + 2;
    const acc = new Float64Array(bins);
    const n = new Int32Array(bins);
    for (let k = 0; k < rays; k++) {
      const a = 2 * Math.PI * k / rays;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (let r = 0; r < rmax; r += step) {
        const v = sampleBilinear(img, cx + ca * r, cy + sa * r);
        if (Number.isNaN(v)) continue;
        const b = r / step | 0;
        acc[b] = acc[b] + inkOf(v, range.lo, range.hi);
        n[b] = n[b] + 1;
      }
    }
    const rho = new Float64Array(bins);
    const rr = new Float64Array(bins);
    for (let b = 0; b < bins; b++) {
      rho[b] = n[b] > 0 ? acc[b] / n[b] : 0;
      rr[b] = (b + 0.5) * step;
    }
    return { r: rr, rho, n, step, cx, cy, lo: range.lo, hi: range.hi };
  }
  function bandMean(p, r0, r1) {
    const b0 = Math.max(0, Math.floor(r0 / p.step));
    const b1 = Math.min(p.rho.length - 1, Math.ceil(r1 / p.step));
    if (b1 < b0) return { mean: 0, n: 0 };
    let s = 0;
    let n = 0;
    for (let b = b0; b <= b1; b++) {
      if (p.n[b] === 0) continue;
      s += p.rho[b];
      n++;
    }
    return { mean: n ? s / n : 0, n };
  }
  function scoreHypothesis(p, version, pitch) {
    const K2 = dataRings(version);
    const g2 = crown(K2);
    const P = (x) => x * pitch;
    const radii = {
      halo: P(g2.haloRadius),
      beads: P(g2.beadRadius),
      teethInner: P(g2.teethInner),
      teethOuter: P(g2.teethOuter),
      limbus: P(g2.limbusRadius),
      outer: P(g2.outerRadius)
    };
    if (radii.outer > p.r[p.r.length - 1] || radii.halo < 4) return { score: Infinity, radii };
    const bands = [
      // model r0, r1, target ink, weight.
      // Wide bands with hard targets carry most of the discrimination: the four
      // light gaps and the quiet zone cannot be faked by a random round blob.
      [2.6, K2 + 0.577, 0.38, 0.6],
      // data field: ~50% of 77%-filled dots
      [K2 + 0.577, g2.haloInner, 0.02, 3],
      // gap
      [g2.haloInner, g2.haloOuter, 0.85, 2.5],
      // HALO (0.3 p thin: allow for AA)
      [g2.haloOuter, g2.beadRadius - g2.beadSize, 0.02, 3],
      // gap
      [g2.beadRadius - g2.beadSize, g2.beadRadius + g2.beadSize, 0.16, 0.7],
      // BEADS
      [g2.beadRadius + g2.beadSize, g2.teethInner, 0.02, 3],
      // gap
      [g2.teethInner, g2.teethOuter, 0.51, 1.6],
      // ANGLE TRACK
      [g2.teethOuter, g2.limbusInner, 0.04, 3],
      // gap (only the Beak is inked)
      [g2.limbusInner, g2.limbusOuter, 0.85, 2.5],
      // LIMBUS
      [g2.limbusOuter, g2.limbusOuter + 2, 0.02, 3]
      // quiet zone
    ];
    let score = 0;
    let totalW = 0;
    for (const [m0, m1, target, w] of bands) {
      const meas = bandMean(p, P(m0), P(m1));
      if (meas.n === 0) return { score: Infinity, radii };
      score += w * Math.abs(meas.mean - target);
      totalW += w;
    }
    return { score: score / totalW, radii };
  }
  function findSharpRings(p, minRho = 0.5) {
    const out = [];
    const rho = p.rho;
    for (let b = 2; b < rho.length - 2; b++) {
      const y1 = rho[b];
      if (y1 < minRho) continue;
      if (!(y1 >= rho[b - 1] && y1 > rho[b + 1])) continue;
      const y0 = rho[b - 1];
      const y2 = rho[b + 1];
      const den = y0 - 2 * y1 + y2;
      const d = Math.abs(den) < 1e-9 ? 0 : 0.5 * (y0 - y2) / den;
      out.push(p.r[b] + Math.max(-1, Math.min(1, d)) * p.step);
    }
    return out;
  }
  var LEGAL_K = (() => {
    const out = [];
    for (let v = MIN_VERSION; v <= MAX_VERSION; v++) out.push(dataRings(v));
    return out;
  })();
  function refineFromRingPairs(p, minRho = 0.5) {
    const peaks = findSharpRings(p, minRho);
    const out = [];
    for (let i = 0; i < peaks.length; i++) {
      for (let j = i + 1; j < peaks.length; j++) {
        const Ri = peaks[i];
        const Ro = peaks[j];
        const gap = Ro - Ri;
        if (gap < 3) continue;
        const pitch = gap / 3.8;
        if (pitch < 0.35 || pitch > 200) continue;
        const Kf = Ri / pitch - 1.05;
        if (Kf < 12 || Kf > 96) continue;
        let bestK = LEGAL_K[0];
        let bestD = Infinity;
        for (const K2 of LEGAL_K) {
          const d = Math.abs(K2 - Kf);
          if (d < bestD) {
            bestD = d;
            bestK = K2;
          }
        }
        if (bestD > 1.4) continue;
        const version = (bestK - 12) / 2;
        const pitch2 = (Ri / (bestK + 1.05) + Ro / (bestK + 4.85)) / 2;
        const sc = scoreHypothesis(p, version, pitch2);
        if (!Number.isFinite(sc.score)) continue;
        out.push({ version, K: bestK, pitch: pitch2, score: sc.score, radii: sc.radii });
      }
    }
    out.sort((a, b) => a.score - b.score);
    return out;
  }
  var LIMBUS_OFFSET = 4.85;
  function traceOuterRing(img, cx, cy, lo, hi, nAngles = 180, opt = {}) {
    var _a, _b, _c, _d;
    const inkOn = (_a = opt.inkOn) != null ? _a : 0.55;
    const inkOff = (_b = opt.inkOff) != null ? _b : 0.35;
    const maxThickFrac = (_c = opt.maxThicknessFrac) != null ? _c : 0.07;
    const rmax = (_d = opt.rmax) != null ? _d : Math.hypot(Math.max(cx, img.width - cx), Math.max(cy, img.height - cy));
    const angles = new Float64Array(nAngles);
    const radius = new Float64Array(nAngles).fill(NaN);
    const thickness = new Float64Array(nAngles).fill(NaN);
    const ink = new Float64Array(nAngles);
    const step = Math.max(0.35, rmax / 900);
    let found = 0;
    const radiiList = [];
    for (let k = 0; k < nAngles; k++) {
      const a = 2 * Math.PI * k / nAngles;
      angles[k] = a;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let rOut = NaN;
      for (let r = rmax; r > 3; r -= step) {
        const v = sampleBilinear(img, cx + ca * r, cy + sa * r);
        if (Number.isNaN(v)) continue;
        if (inkOf(v, lo, hi) >= inkOn) {
          let light = 0;
          let probes = 0;
          for (const dr of [1.2, 2.4, 3.6, 5]) {
            const rr = r + dr * Math.max(1, step * 2);
            const vv = sampleBilinear(img, cx + ca * rr, cy + sa * rr);
            if (Number.isNaN(vv)) continue;
            probes++;
            if (inkOf(vv, lo, hi) < inkOff) light++;
          }
          if (probes > 0 && light / probes >= 0.6) {
            rOut = r;
            break;
          }
        }
      }
      if (!Number.isFinite(rOut)) continue;
      let rIn = rOut;
      let peak = 0;
      for (let r = rOut; r > rOut - Math.max(4, rOut * maxThickFrac * 3); r -= step) {
        const v = sampleBilinear(img, cx + ca * r, cy + sa * r);
        if (Number.isNaN(v)) break;
        const ik = inkOf(v, lo, hi);
        if (ik > peak) peak = ik;
        if (ik < 0.4) {
          rIn = r;
          break;
        }
        rIn = r;
      }
      const thick = rOut - rIn;
      if (thick > Math.max(3, rOut * maxThickFrac)) continue;
      const mid = (rOut + rIn) / 2;
      radius[k] = mid;
      thickness[k] = thick;
      ink[k] = peak;
      radiiList.push(mid);
      found++;
    }
    radiiList.sort((a, b) => a - b);
    return {
      n: nAngles,
      angles,
      radius,
      thickness,
      ink,
      coverage: found / nAngles,
      median: radiiList.length ? radiiList[radiiList.length >> 1] : NaN
    };
  }
  function ringRadiusAt(trace, angleRad) {
    if (trace.n === 0) return NaN;
    const a = (angleRad % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const f = a / (2 * Math.PI) * trace.n;
    const i0 = Math.floor(f) % trace.n;
    const i1 = (i0 + 1) % trace.n;
    const t = f - Math.floor(f);
    const r0 = trace.radius[i0];
    const r1 = trace.radius[i1];
    if (!Number.isFinite(r0)) return Number.isFinite(r1) ? r1 : trace.median;
    if (!Number.isFinite(r1)) return r0;
    return r0 + (r1 - r0) * t;
  }
  function inkInBand(img, cx, cy, trace, m0, m1, limbusModules, lo, hi) {
    let sum = 0;
    let n = 0;
    const NS = 5;
    for (let k = 0; k < trace.n; k++) {
      const R = trace.radius[k];
      if (!Number.isFinite(R)) continue;
      const pitch = R / limbusModules;
      const a = trace.angles[k];
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let acc = 0;
      let m = 0;
      for (let i = 0; i < NS; i++) {
        const t = i / (NS - 1);
        const r = pitch * (m0 + (m1 - m0) * t);
        if (r < 1) continue;
        const v = sampleBilinear(img, cx + ca * r, cy + sa * r);
        if (Number.isNaN(v)) continue;
        acc += inkOf(v, lo, hi);
        m++;
      }
      if (m === 0) continue;
      sum += acc / m;
      n++;
    }
    return { ink: n ? sum / n : 0, n };
  }
  function fitRadialHarmonics(trace, order = 2) {
    const idx = [];
    for (let k = 0; k < trace.n; k++) if (Number.isFinite(trace.radius[k])) idx.push(k);
    const P = 1 + 2 * order;
    if (idx.length < P + 4) return null;
    const A = [];
    for (let i = 0; i < P; i++) A.push(new Array(P + 1).fill(0));
    const basis = (a) => {
      const b = [1];
      for (let h = 1; h <= order; h++) b.push(Math.cos(h * a), Math.sin(h * a));
      return b;
    };
    for (const k of idx) {
      const a = trace.angles[k];
      const r = trace.radius[k];
      const b = basis(a);
      for (let i = 0; i < P; i++) {
        for (let j = 0; j < P; j++) A[i][j] += b[i] * b[j];
        A[i][P] += b[i] * r;
      }
    }
    const x = solveNormal(A, P);
    if (!x) return null;
    let se = 0;
    for (const k of idx) {
      const b = basis(trace.angles[k]);
      let pred = 0;
      for (let i = 0; i < P; i++) pred += b[i] * x[i];
      se += (pred - trace.radius[k]) ** 2;
    }
    return {
      c0: x[0],
      a1: x[1],
      b1: x[2],
      a2: order >= 2 ? x[3] : 0,
      b2: order >= 2 ? x[4] : 0,
      rms: Math.sqrt(se / idx.length),
      n: idx.length
    };
  }
  function solveNormal(A, P) {
    const M = A.map((row) => row.slice());
    for (let i = 0; i < P; i++) M[i][i] += 1e-9;
    for (let col = 0; col < P; col++) {
      let piv = col;
      for (let r = col + 1; r < P; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      const tmp = M[col];
      M[col] = M[piv];
      M[piv] = tmp;
      for (let r = 0; r < P; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        if (f === 0) continue;
        for (let c = col; c <= P; c++) M[r][c] -= f * M[col][c];
      }
    }
    const out = new Array(P);
    for (let i = 0; i < P; i++) out[i] = M[i][P] / M[i][i];
    return out;
  }
  function matchCrownByAngles(img, cx, cy, trace, lo, hi, versions) {
    if (trace.coverage < 0.35 || !Number.isFinite(trace.median)) return null;
    const R = trace.median;
    let best = null;
    const list = versions != null ? versions : LEGAL_K.map((K2) => (K2 - 12) / 2);
    for (const version of list) {
      if (version < MIN_VERSION || version > MAX_VERSION) continue;
      const K2 = dataRings(version);
      const g2 = crown(K2);
      const bands = [
        ["dataOuter", Math.max(3, K2 - 0.6), K2 + 0.577, 0.38, 0.7],
        ["gapCore", K2 + 0.577, g2.haloInner, 0.02, 3],
        ["halo", g2.haloInner, g2.haloOuter, 0.85, 2.5],
        ["gap1", g2.haloOuter, g2.beadRadius - g2.beadSize, 0.02, 3],
        ["beads", g2.beadRadius - g2.beadSize, g2.beadRadius + g2.beadSize, 0.16, 0.7],
        ["gap2", g2.beadRadius + g2.beadSize, g2.teethInner, 0.02, 3],
        ["teeth", g2.teethInner, g2.teethOuter, 0.51, 1.8],
        ["gap3", g2.teethOuter, g2.limbusInner, 0.05, 3]
      ];
      let score = 0;
      let totalW = 0;
      const detail = {};
      for (const [name, m0, m1, target, w] of bands) {
        const meas = inkInBand(img, cx, cy, trace, m0, m1, K2 + LIMBUS_OFFSET, lo, hi);
        if (meas.n < trace.n * 0.3) {
          score = Infinity;
          break;
        }
        detail[name] = meas.ink;
        score += w * Math.abs(meas.ink - target);
        totalW += w;
      }
      if (!Number.isFinite(score) || totalW === 0) continue;
      const s = score / totalW;
      if (!best || s < best.score) best = { version, K: K2, pitch: R / (K2 + 4.85), score: s, detail };
    }
    return best;
  }
  function fitCircle(pts) {
    const n = pts.length / 2;
    if (n < 3) return { cx: NaN, cy: NaN, r: NaN, rms: NaN };
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let sxz = 0;
    let syz = 0;
    let szz = 0;
    for (let i = 0; i < n; i++) {
      const x = pts[2 * i];
      const y = pts[2 * i + 1];
      const z = x * x + y * y;
      sx += x;
      sy += y;
      sz += z;
      sxx += x * x;
      sxy += x * y;
      syy += y * y;
      sxz += x * z;
      syz += y * z;
      szz += z * z;
    }
    const A = [
      [sxx, sxy, sx, -sxz],
      [sxy, syy, sy, -syz],
      [sx, sy, n, -sz]
    ];
    const sol = solve3(A);
    if (!sol) return { cx: NaN, cy: NaN, r: NaN, rms: NaN };
    const D = sol[0];
    const E = sol[1];
    const F = sol[2];
    const cx = -D / 2;
    const cy = -E / 2;
    const r2 = D * D / 4 + E * E / 4 - F;
    const r = Math.sqrt(Math.max(0, r2));
    let se = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(pts[2 * i] - cx, pts[2 * i + 1] - cy) - r;
      se += d * d;
    }
    return { cx, cy, r, rms: Math.sqrt(se / n) };
  }
  function solve3(A) {
    const M = A.map((row) => row.slice());
    for (let c = 0; c < 3; c++) {
      let piv = -1;
      let best = 1e-12;
      for (let r = c; r < 3; r++) {
        if (Math.abs(M[r][c]) > best) {
          best = Math.abs(M[r][c]);
          piv = r;
        }
      }
      if (piv < 0) return null;
      const t = M[c];
      M[c] = M[piv];
      M[piv] = t;
      const d = M[c][c];
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = M[r][c] / d;
        if (f === 0) continue;
        for (let k = c; k < 4; k++) M[r][k] = M[r][k] - f * M[c][k];
      }
    }
    return [0, 1, 2].map((i) => M[i][3] / M[i][i]);
  }
  function traceRing(img, cx, cy, r0, halfWidth, lo, hi, rays = 360) {
    return traceRingAngular(img, cx, cy, () => r0, halfWidth, lo, hi, rays);
  }
  function traceRingAngular(img, cx, cy, predict, halfWidth, lo, hi, rays = 360) {
    const ptsList = [];
    const radii = new Float64Array(rays);
    const angles = new Float64Array(rays);
    let found = 0;
    const steps = Math.max(3, Math.ceil(2 * halfWidth / 0.4));
    for (let k = 0; k < rays; k++) {
      const a = 2 * Math.PI * k / rays;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const r0 = predict(a);
      if (!Number.isFinite(r0) || r0 < 2) {
        angles[k] = a;
        radii[k] = NaN;
        continue;
      }
      let wsum = 0;
      let rsum = 0;
      let peak = 0;
      for (let s = 0; s <= steps; s++) {
        const r = r0 - halfWidth + 2 * halfWidth * s / steps;
        if (r < 1) continue;
        const v = sampleBilinear(img, cx + ca * r, cy + sa * r);
        const ink = inkOf(v, lo, hi);
        const w = ink * Math.exp(-((r - r0) ** 2) / (2 * (halfWidth / 1.6) ** 2));
        wsum += w;
        rsum += w * r;
        if (ink > peak) peak = ink;
      }
      angles[k] = a;
      if (wsum > 0.35 && peak > 0.5) {
        const r = rsum / wsum;
        radii[k] = r;
        ptsList.push(cx + ca * r, cy + sa * r);
        found++;
      } else {
        radii[k] = NaN;
      }
    }
    return { pts: Float64Array.from(ptsList), coverage: found / rays, radii, angles };
  }
  function candidateCentres(img) {
    const t = otsuThreshold(img);
    const dark = binarize(img, t);
    let sx = 0;
    let sy = 0;
    let n = 0;
    const q = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ];
    const hw = img.width / 2;
    const hh = img.height / 2;
    for (let y = 0; y < img.height; y++) {
      const qy = y < hh ? 0 : 2;
      for (let x = 0; x < img.width; x++) {
        if (!dark[y * img.width + x]) continue;
        sx += x;
        sy += y;
        n++;
        const i = qy + (x < hw ? 0 : 1);
        const cell = q[i];
        cell[0] = cell[0] + x;
        cell[1] = cell[1] + y;
        cell[2] = cell[2] + 1;
      }
    }
    const out = [];
    if (n > 0) out.push({ x: sx / n, y: sy / n });
    out.push({ x: hw, y: hh });
    for (const c of q) if (c[2] > 0) out.push({ x: c[0] / c[2], y: c[1] / c[2] });
    for (let gy = 1; gy <= 3; gy++) for (let gx = 1; gx <= 3; gx++) out.push({ x: img.width * gx / 4, y: img.height * gy / 4 });
    return out;
  }
  function locate(img0, opt = {}) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    const img = ((_a = opt.blur) != null ? _a : 1) > 0 ? blur(img0, (_b = opt.blur) != null ? _b : 1) : img0;
    const vMin = (_c = opt.minVersion) != null ? _c : MIN_VERSION;
    const vMax = (_d = opt.maxVersion) != null ? _d : MAX_VERSION;
    const maxScore = (_e = opt.maxScore) != null ? _e : 0.45;
    const candidates = (_f = opt.candidates) != null ? _f : candidateCentres(img);
    const maxDim = Math.max(img.width, img.height);
    const pLo = 0.35;
    const pHi = Math.max(1.5, maxDim / 11);
    const steps = 110;
    const pitches = new Float64Array(steps);
    for (let i = 0; i < steps; i++) pitches[i] = pLo * Math.pow(pHi / pLo, i / (steps - 1));
    const gridSearch = (profile) => {
      let bestScore = Infinity;
      let bestV = 0;
      let bestP = 0;
      for (let v = vMin; v <= vMax; v++) {
        for (let i = 0; i < steps; i++) {
          const s = scoreHypothesis(profile, v, pitches[i]).score;
          if (s < bestScore) {
            bestScore = s;
            bestV = v;
            bestP = pitches[i];
          }
        }
      }
      if (bestV === 0) return null;
      let p0 = bestP;
      for (let refine = 0; refine < 3; refine++) {
        const span = p0 * 0.06;
        let bs = Infinity;
        let bp = p0;
        for (let i = -6; i <= 6; i++) {
          const p = p0 + span * i / 6;
          if (p <= 0.05) continue;
          const s = scoreHypothesis(profile, bestV, p).score;
          if (s < bs) {
            bs = s;
            bp = p;
          }
        }
        p0 = bp;
        bestScore = bs;
      }
      for (const dv of [-1, 1]) {
        const v = bestV + dv;
        if (v < vMin || v > vMax) continue;
        const s = scoreHypothesis(profile, v, p0).score;
        if (s < bestScore) {
          bestScore = s;
          bestV = v;
        }
      }
      const scored = scoreHypothesis(profile, bestV, p0);
      return { version: bestV, K: dataRings(bestV), pitch: p0, score: bestScore, radii: scored.radii };
    };
    let best = null;
    for (const c of candidates) {
      let cx = c.x;
      let cy = c.y;
      let range = contrastRange(img);
      let profile = radialProfile(img, cx, cy, { rays: (_g = opt.rays) != null ? _g : 256, step: (_h = opt.step) != null ? _h : 0.5, rmax: maxDim, lo: range.lo, hi: range.hi });
      let hyp = null;
      for (let iter = 0; iter < 3; iter++) {
        const list = [];
        const coarse = gridSearch(profile);
        if (coarse) list.push(coarse);
        list.push(...refineFromRingPairs(profile, 0.5).slice(0, 6));
        list.push(...refineFromRingPairs(profile, 0.38).slice(0, 6));
        if (list.length === 0) break;
        list.sort((a, b) => a.score - b.score);
        hyp = list[0];
        const trace2 = traceRing(img, cx, cy, hyp.radii.limbus, Math.max(1.6, hyp.pitch * 0.6), range.lo, range.hi, 360);
        if (trace2.coverage < 0.25 || trace2.pts.length < 12) break;
        const fit2 = fitCircle(trace2.pts);
        if (!Number.isFinite(fit2.cx)) break;
        const moved = Math.hypot(fit2.cx - cx, fit2.cy - cy);
        const scaleChanged = Math.abs(fit2.r - hyp.radii.limbus) / Math.max(1, hyp.radii.limbus);
        cx = fit2.cx;
        cy = fit2.cy;
        if (Number.isFinite(fit2.r) && fit2.r > 2 && scaleChanged < 0.25) {
          const pitch3 = fit2.r / (hyp.K + 4.85);
          const sc = scoreHypothesis(profile, hyp.version, pitch3);
          if (Number.isFinite(sc.score)) {
            hyp = { ...hyp, pitch: pitch3, radii: sc.radii };
          }
        }
        if (moved < 0.04 * hyp.pitch) break;
        profile = radialProfile(img, cx, cy, { rays: (_i = opt.rays) != null ? _i : 256, step: (_j = opt.step) != null ? _j : 0.5, rmax: maxDim, lo: range.lo, hi: range.hi });
      }
      if (!hyp) continue;
      const trace = traceRing(img, cx, cy, hyp.radii.limbus, Math.max(1.6, hyp.pitch * 0.55), range.lo, range.hi, 360);
      const fit = fitCircle(trace.pts);
      if (Number.isFinite(fit.cx)) {
        cx = fit.cx;
        cy = fit.cy;
        if (Number.isFinite(fit.r) && fit.r > 2 && Math.abs(fit.r - hyp.radii.limbus) / Math.max(1, hyp.radii.limbus) < 0.2) {
          const pitch4 = fit.r / (hyp.K + 4.85);
          const scored = scoreHypothesis(profile, hyp.version, pitch4);
          hyp = { ...hyp, pitch: pitch4, radii: scored.radii, score: Number.isFinite(scored.score) ? scored.score : hyp.score };
        }
      }
      let res = {
        ...hyp,
        acceptable: hyp.score < maxScore,
        cx,
        cy,
        profile,
        ringPoints: trace.pts,
        ringCoverage: trace.coverage,
        iterations: 3,
        lo: range.lo,
        hi: range.hi
      };
      const outer = traceOuterRing(img, cx, cy, range.lo, range.hi, 180);
      res.outer = outer;
      if (outer.coverage >= 0.5) {
        const h = fitRadialHarmonics(outer, 2);
        if (h && h.rms < 0.35 * h.c0) {
          const dx = h.a1;
          const dy = h.b1;
          if (Math.hypot(dx, dy) < 0.2 * h.c0) {
            const cx2 = cx + dx;
            const cy2 = cy + dy;
            const outer2 = traceOuterRing(img, cx2, cy2, range.lo, range.hi, 180);
            const h2 = fitRadialHarmonics(outer2, 2);
            if (outer2.coverage >= outer.coverage && (!h2 || h2.rms <= h.rms)) {
              cx = cx2;
              cy = cy2;
              res.outer = outer2;
            }
          }
        }
        const m = matchCrownByAngles(img, cx, cy, res.outer, range.lo, range.hi);
        if (m) {
          const sc = scoreHypothesis(profile, m.version, m.pitch);
          res = {
            ...res,
            cx,
            cy,
            version: m.version,
            K: m.K,
            pitch: m.pitch,
            radii: Number.isFinite(sc.score) ? sc.radii : res.radii,
            score: Math.min(res.score, m.score),
            angularScore: m.score
          };
        }
      }
      if (!best || res.score < best.score) best = res;
    }
    return best;
  }

  // packages/core/src/imaging/orient.ts
  var Transform = class _Transform {
    constructor(m) {
      __publicField(this, "m");
      __publicField(this, "inv", null);
      __publicField(this, "kind", "similarity");
      this.m = new Float64Array(9);
      for (let i = 0; i < 9; i++) this.m[i] = m[i];
    }
    static identity() {
      return new _Transform([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    }
    apply(x, y) {
      const m = this.m;
      const w = m[6] * x + m[7] * y + m[8];
      const u = m[0] * x + m[1] * y + m[2];
      const v = m[3] * x + m[4] * y + m[5];
      if (w === 0) return { x: NaN, y: NaN };
      return { x: u / w, y: v / w };
    }
    applyInverse(px, py) {
      if (!this.inv) this.inv = invert3x3(this.m);
      const m = this.inv;
      const w = m[6] * px + m[7] * py + m[8];
      const u = m[0] * px + m[1] * py + m[2];
      const v = m[3] * px + m[4] * py + m[5];
      if (w === 0) return { x: NaN, y: NaN };
      return { x: u / w, y: v / w };
    }
    /** Uniform scale (pixels per module), from the linear part. */
    get scale() {
      const m = this.m;
      return Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3]));
    }
    /** Rotation of the symbol in image space, degrees clockwise from +x. */
    get rotationDeg() {
      const m = this.m;
      return Math.atan2(m[3], m[0]) * 180 / Math.PI;
    }
  };
  function invert3x3(m) {
    const a = m[0];
    const b = m[1];
    const c = m[2];
    const d = m[3];
    const e = m[4];
    const f = m[5];
    const g2 = m[6];
    const h = m[7];
    const i = m[8];
    const A = e * i - f * h;
    const B = -(d * i - f * g2);
    const C = d * h - e * g2;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) throw new Error("singular transform");
    const id = 1 / det;
    return Float64Array.from([
      A * id,
      (c * h - b * i) * id,
      (b * f - c * e) * id,
      B * id,
      (a * i - c * g2) * id,
      (c * d - a * f) * id,
      C * id,
      (b * g2 - a * h) * id,
      (a * e - b * d) * id
    ]);
  }
  function similarity(cx, cy, p, phiDeg) {
    const a = phiDeg * Math.PI / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const t = new Transform([p * cos, -p * sin, cx, -p * sin, -p * cos, cy, 0, 0, 1]);
    t.kind = "similarity";
    return t;
  }
  function estimateRotation(img, loc, cx, cy, opt = {}) {
    var _a, _b, _c;
    const sub = (_a = opt.sub) != null ? _a : 16;
    const M = TEETH * sub;
    const lo = (_b = opt.lo) != null ? _b : loc.lo;
    const hi = (_c = opt.hi) != null ? _c : loc.hi;
    const g2 = loc.radii;
    const rIn = (g2.teethInner + g2.teethOuter) / 2;
    const spread = (g2.teethOuter - g2.teethInner) * 0.32;
    const teethRatio = (g2.teethInner + g2.teethOuter) / 2 / loc.pitch / (loc.K + LIMBUS_OFFSET);
    const radiusAt = (a) => loc.outer && loc.outer.coverage >= 0.4 ? ringRadiusAt(loc.outer, a) * teethRatio : rIn;
    const signal = new Float64Array(M);
    for (let k = 0; k < M; k++) {
      const a = -(2 * Math.PI * k) / M;
      const rr = radiusAt(a);
      let acc = 0;
      let n = 0;
      for (const dr of [-spread, -spread / 2, 0, spread / 2, spread]) {
        const v = sampleBilinear(img, cx + Math.cos(a) * (rr + dr), cy + Math.sin(a) * (rr + dr));
        if (Number.isNaN(v)) continue;
        acc += inkOf(v, lo, hi);
        n++;
      }
      signal[k] = n ? acc / n * 2 - 1 : 0;
    }
    const ref = new Float64Array(M);
    for (let k = 0; k < M; k++) {
      const tooth = Math.round(k / sub) % TEETH;
      ref[k] = ANGLE_TRACK[tooth] === 1 ? 1 : -1;
    }
    let best = -Infinity;
    let bestS = 0;
    let second = -Infinity;
    const scores = new Float64Array(M);
    for (let s = 0; s < M; s++) {
      let acc = 0;
      for (let k = 0; k < M; k++) {
        acc += signal[k] * ref[(k - s + M) % M];
      }
      scores[s] = acc;
      if (acc > best) {
        best = acc;
        bestS = s;
      }
    }
    for (let s = 0; s < M; s++) if (s !== bestS && scores[s] > second) second = scores[s];
    const y0 = scores[(bestS - 1 + M) % M];
    const y1 = best;
    const y2 = scores[(bestS + 1) % M];
    const denom = y0 - 2 * y1 + y2;
    const delta = Math.abs(denom) < 1e-9 ? 0 : 0.5 * (y0 - y2) / denom;
    const sFine = bestS + Math.max(-1, Math.min(1, delta));
    const phi = sFine * 360 / M;
    return { phi: (phi % 360 + 360) % 360, score: best, margin: best - second, sub, signal, radius: rIn };
  }
  function mat3(A, B) {
    const out = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += A[i * 3 + k] * B[k * 3 + j];
        out[i * 3 + j] = s;
      }
    }
    return out;
  }
  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let piv = -1;
      let best = 1e-14;
      for (let r = c; r < n; r++) {
        const v = Math.abs(M[r][c]);
        if (v > best) {
          best = v;
          piv = r;
        }
      }
      if (piv < 0) return null;
      const tmp = M[c];
      M[c] = M[piv];
      M[piv] = tmp;
      const d = M[c][c];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / d;
        if (f === 0) continue;
        for (let k = c; k <= n; k++) M[r][k] = M[r][k] - f * M[c][k];
      }
    }
    return Array.from({ length: n }, (_, i) => M[i][n] / M[i][i]);
  }
  function fitRadialHomography(rings, G0, opt = {}) {
    var _a, _b, _c, _d;
    const pts = [];
    const rho = [];
    for (const r2 of rings) {
      for (let i = 0; i < r2.n; i++) {
        pts.push(r2.xs[i], r2.ys[i]);
        rho.push(r2.rho);
      }
    }
    const n = rho.length;
    const g0 = Array.from({ length: 9 }, (_, i) => G0[i] / (G0[8] || 1));
    const fail = {
      G: g0,
      H: new Transform((_a = invert3x3(Float64Array.from(g0))) != null ? _a : new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1])),
      rms: Infinity,
      points: n,
      inliers: 0,
      iterations: 0,
      ok: false
    };
    if (n < 24) return fail;
    const P = 8;
    let p = g0.slice(0, P);
    let w = new Float64Array(n).fill(1);
    const r = new Float64Array(n);
    const rp = new Float64Array(n);
    const rm = new Float64Array(n);
    const residual = (par, out) => {
      for (let i = 0; i < n; i++) {
        const x = pts[2 * i];
        const y = pts[2 * i + 1];
        const a = par[0] * x + par[1] * y + par[2];
        const b = par[3] * x + par[4] * y + par[5];
        const c2 = par[6] * x + par[7] * y + 1;
        if (Math.abs(c2) < 1e-12) {
          out[i] = 1e6;
          continue;
        }
        out[i] = Math.hypot(a / c2, b / c2) - rho[i];
      }
    };
    const cost = (rr) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += w[i] * rr[i] ** 2;
      return s;
    };
    const step = (lambda2) => {
      const J = [];
      for (let i = 0; i < n; i++) J.push(new Array(P).fill(0));
      for (let k = 0; k < P; k++) {
        const h = 1e-7 * Math.max(1e-3, Math.abs(p[k]));
        const save = p[k];
        p[k] = save + h;
        residual(p, rp);
        p[k] = save - h;
        residual(p, rm);
        p[k] = save;
        for (let i = 0; i < n; i++) J[i][k] = (rp[i] - rm[i]) / (2 * h);
      }
      const A = [];
      const b = new Array(P).fill(0);
      for (let i = 0; i < P; i++) A.push(new Array(P).fill(0));
      for (let i = 0; i < n; i++) {
        const wi = w[i];
        if (wi === 0) continue;
        const row = J[i];
        const ri = r[i];
        for (let a = 0; a < P; a++) {
          b[a] = b[a] - wi * row[a] * ri;
          for (let bb = 0; bb < P; bb++) A[a][bb] = A[a][bb] + wi * row[a] * row[bb];
        }
      }
      const Ad = A.map((row, i) => row.map((v, j) => i === j ? v * (1 + lambda2) + 1e-12 : v));
      const d = solveLinear(Ad, b);
      if (!d) return null;
      return { p: p.map((v, i) => v + d[i]), c: 0 };
    };
    residual(p, r);
    let c = cost(r);
    let lambda = (_b = opt.lambda0) != null ? _b : 1e-4;
    const maxIt = (_c = opt.maxIterations) != null ? _c : 40;
    let iters = 0;
    for (let it = 0; it < maxIt; it++) {
      iters = it + 1;
      let improved = false;
      for (let tries = 0; tries < 8 && !improved; tries++) {
        const cand = step(lambda);
        if (!cand) {
          lambda *= 8;
          continue;
        }
        residual(cand.p, rp);
        const cc = cost(rp);
        if (Number.isFinite(cc) && cc < c) {
          const rel = (c - cc) / Math.max(1e-12, c);
          p = cand.p;
          residual(p, r);
          c = cc;
          lambda = Math.max(1e-9, lambda / 6);
          improved = true;
          if (rel < 1e-10) it = maxIt;
        } else {
          lambda *= 8;
        }
      }
      if (!improved) break;
    }
    let inliers = n;
    const rounds = 2;
    for (let round = 0; round < rounds; round++) {
      residual(p, r);
      const abs = Array.from(r).map(Math.abs).sort((a, b) => a - b);
      const med = (_d = abs[abs.length >> 1]) != null ? _d : 0;
      const sigma = Math.max(0.05, 1.4826 * med);
      const cut = 3.5 * sigma;
      inliers = 0;
      for (let i = 0; i < n; i++) {
        const t = Math.abs(r[i]) / cut;
        if (t >= 1) w[i] = 0;
        else {
          w[i] = (1 - t * t) ** 2;
          inliers++;
        }
      }
      if (inliers < 24) {
        w = new Float64Array(n).fill(1);
        inliers = n;
        break;
      }
      residual(p, r);
      let c2 = cost(r);
      for (let it = 0; it < 12; it++) {
        const cand = step(1e-4);
        if (!cand) break;
        residual(cand.p, rp);
        const cc = cost(rp);
        if (!Number.isFinite(cc) || cc >= c2) break;
        c2 = cc;
        p = cand.p;
        residual(p, r);
      }
    }
    residual(p, r);
    const G = [...p, 1];
    let se = 0;
    inliers = 0;
    for (let i = 0; i < n; i++) {
      if (w[i] === 0) continue;
      se += r[i] ** 2;
      inliers++;
    }
    const rms = Math.sqrt(se / Math.max(1, inliers));
    const Hm = invert3x3(Float64Array.from(G));
    if (!Hm) return { ...fail, G, rms, iterations: iters };
    const H = new Transform(Hm);
    H.kind = "homography";
    const det = H.m[0] * H.m[4] - H.m[1] * H.m[3];
    const ok = Number.isFinite(rms) && rms < 4 && det < 0 && H.scale > 1e-3;
    return { G, H, rms, points: n, inliers, iterations: iters, ok };
  }
  function composeModelRotation(H, psiDeg) {
    const a = psiDeg * Math.PI / 180;
    const R = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
    const t = new Transform(mat3(H.m, R));
    t.kind = H.kind;
    return t;
  }
  function estimateRotationMapped(img, loc, H, opt = {}) {
    var _a, _b, _c;
    const sub = (_a = opt.sub) != null ? _a : 16;
    const M = TEETH * sub;
    const lo = (_b = opt.lo) != null ? _b : loc.lo;
    const hi = (_c = opt.hi) != null ? _c : loc.hi;
    const g2 = loc.radii;
    const rhoT = (g2.teethInner + g2.teethOuter) / 2 / loc.pitch;
    const spread = (g2.teethOuter - g2.teethInner) / loc.pitch * 0.3;
    const signal = new Float64Array(M);
    let live = 0;
    for (let k = 0; k < M; k++) {
      const beta = 2 * Math.PI * k / M;
      const cb = Math.cos(beta);
      const sb = Math.sin(beta);
      let acc = 0;
      let nn = 0;
      for (const dr of [-spread, 0, spread]) {
        const q = H.apply((rhoT + dr) * cb, (rhoT + dr) * sb);
        if (!Number.isFinite(q.x)) continue;
        const v = sampleBilinear(img, q.x, q.y);
        if (Number.isNaN(v)) continue;
        acc += inkOf(v, lo, hi);
        nn++;
      }
      if (nn === 0) continue;
      signal[k] = acc / nn * 2 - 1;
      live++;
    }
    const ref = new Float64Array(M);
    for (let k = 0; k < M; k++) ref[k] = ANGLE_TRACK[Math.round(k / sub) % TEETH] === 1 ? 1 : -1;
    let best = -Infinity;
    let bestS = 0;
    let second = -Infinity;
    const scores = new Float64Array(M);
    for (let s = 0; s < M; s++) {
      let acc = 0;
      for (let k = 0; k < M; k++) acc += signal[k] * ref[(k - s + M) % M];
      scores[s] = acc;
      if (acc > best) {
        best = acc;
        bestS = s;
      }
    }
    for (let s = 0; s < M; s++) if (s !== bestS && scores[s] > second) second = scores[s];
    const y0 = scores[(bestS - 1 + M) % M];
    const y2 = scores[(bestS + 1) % M];
    const denom = y0 - 2 * best + y2;
    const delta = Math.abs(denom) < 1e-9 ? 0 : 0.5 * (y0 - y2) / denom;
    const sFine = bestS + Math.max(-1, Math.min(1, delta));
    const psi = -sFine * 360 / M;
    return {
      phi: (-psi % 360 + 360) % 360,
      psi,
      score: best * (live / M),
      margin: best - second,
      sub,
      signal,
      radius: rhoT * loc.pitch
    };
  }
  function collectCrownRings(img, loc, pole, rays = 180) {
    const modelHalo = loc.K + 1.05;
    const modelLimb = loc.K + LIMBUS_OFFSET;
    const useLoc = pole.x === loc.cx && pole.y === loc.cy && !!loc.outer && loc.outer.coverage >= 0.4;
    const outer = useLoc ? loc.outer : traceOuterRing(img, pole.x, pole.y, loc.lo, loc.hi, rays);
    if (outer.coverage < 0.25 || !Number.isFinite(outer.median)) return [];
    const limbus = { xs: new Float64Array(outer.n), ys: new Float64Array(outer.n), n: 0, rho: modelLimb };
    for (let k = 0; k < outer.n; k++) {
      const rr = outer.radius[k];
      if (!Number.isFinite(rr)) continue;
      const a = outer.angles[k];
      limbus.xs[limbus.n] = pole.x + Math.cos(a) * rr;
      limbus.ys[limbus.n] = pole.y + Math.sin(a) * rr;
      limbus.n++;
    }
    const haloTrace = traceRingAngular(
      img,
      pole.x,
      pole.y,
      (a) => ringRadiusAt(outer, a) * (modelHalo / modelLimb),
      Math.max(0.9, loc.pitch * 0.45),
      loc.lo,
      loc.hi,
      rays
    );
    const halo = { xs: new Float64Array(haloTrace.radii.length), ys: new Float64Array(haloTrace.radii.length), n: 0, rho: modelHalo };
    for (let k = 0; k < haloTrace.radii.length; k++) {
      const rr = haloTrace.radii[k];
      if (!Number.isFinite(rr)) continue;
      const a = haloTrace.angles[k];
      halo.xs[halo.n] = pole.x + Math.cos(a) * rr;
      halo.ys[halo.n] = pole.y + Math.sin(a) * rr;
      halo.n++;
    }
    const out = [];
    if (limbus.n >= 12) out.push(limbus);
    if (halo.n >= 12) out.push(halo);
    return out;
  }
  function refineTransform(img, loc, t0, iterations = 3) {
    const G0m = invert3x3(similarity(loc.cx, loc.cy, loc.pitch, 0).m);
    if (!G0m) return { transform: t0, rms: Infinity, used: "similarity", points: 0, rotationDeg: t0.rotationDeg };
    let G = Array.from(G0m);
    let H = t0;
    let rms = Infinity;
    let used = "similarity";
    let usedPoints = 0;
    let rotDeg = t0.rotationDeg;
    let rotScore = 0;
    for (let it = 0; it < iterations; it++) {
      const pole = it === 0 ? { x: loc.cx, y: loc.cy } : H.apply(0, 0);
      if (!Number.isFinite(pole.x)) break;
      const rings = collectCrownRings(img, loc, pole, 180);
      if (rings.length === 0) break;
      const fit = fitRadialHomography(rings, G);
      if (!fit.ok) break;
      const scaleRatio = fit.H.scale / loc.pitch;
      if (!(scaleRatio > 0.55 && scaleRatio < 1.8)) break;
      if (it > 0 && fit.rms * loc.pitch > rms) break;
      G = fit.G;
      rms = fit.rms * loc.pitch;
      used = "homography";
      usedPoints = fit.inliers;
      const rot = estimateRotationMapped(img, loc, fit.H);
      rotScore = rot.score;
      if (rot.score > 6) {
        H = composeModelRotation(fit.H, -rot.psi);
        rotDeg = H.rotationDeg;
      } else {
        H = fit.H;
      }
    }
    if (used === "similarity") {
      H = t0;
      rotDeg = t0.rotationDeg;
    }
    return { transform: H, rms, used, points: usedPoints, rotationDeg: rotDeg, rotationScore: rotScore };
  }

  // packages/core/src/imaging/damage.ts
  var HOOD = 19;
  function neighbourhoods(version) {
    const lat = getLattice(version);
    const N = lat.N;
    const hood = new Int32Array(N * HOOD).fill(-1);
    const count = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const set = /* @__PURE__ */ new Set([i]);
      for (let k = 0; k < 6; k++) {
        const a = lat.neighbours[i * 6 + k];
        if (a < 0) continue;
        set.add(a);
        for (let m = 0; m < 6; m++) {
          const b = lat.neighbours[a * 6 + m];
          if (b >= 0) set.add(b);
        }
      }
      let n = 0;
      for (const j of set) {
        if (n >= HOOD) break;
        hood[i * HOOD + n++] = j;
      }
      count[i] = n;
    }
    return { hood, count };
  }
  function applyMaskPrior(version, bits, confidence, opt = {}) {
    var _a, _b, _c, _d;
    const mean = () => {
      let s = 0;
      for (let i = 0; i < confidence.length; i++) s += confidence[i];
      return confidence.length ? s / confidence.length : 0;
    };
    if (opt.disabled) return { flagged: 0, seeds: 0, meanConfidence: mean() };
    const lat = getLattice(version);
    const N = lat.N;
    const extremePenalty = (_a = opt.extremePenalty) != null ? _a : 0.02;
    const nearPenalty = (_b = opt.nearPenalty) != null ? _b : 0.35;
    const farPenalty = (_c = opt.farPenalty) != null ? _c : 0.7;
    const strict = (_d = opt.strictCount) != null ? _d : 3;
    const { hood, count } = neighbourhoods(version);
    const dark = new Uint8Array(N);
    const full = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const n = count[i];
      full[i] = n >= HOOD - 1 ? 1 : 0;
      if (n < 10) continue;
      let d = 0;
      for (let k = 0; k < n; k++) d += bits[hood[i * HOOD + k]];
      dark[i] = d;
    }
    const seed = new Uint8Array(N);
    let seeds = 0;
    for (let i = 0; i < N; i++) {
      if (!full[i]) continue;
      const n = count[i];
      const d = dark[i];
      if (d <= strict || d >= n - strict) {
        seed[i] = 1;
        seeds++;
      }
    }
    if (seeds === 0) return { flagged: 0, seeds: 0, meanConfidence: mean(), darkCount: dark };
    const pen = new Float32Array(N).fill(1);
    const set = new Float32Array(N).fill(NaN);
    for (let i = 0; i < N; i++) {
      if (!seed[i]) continue;
      const n = count[i];
      const d = dark[i];
      const excess = d <= strict ? strict - d : d - (n - strict);
      set[i] = Math.max(5e-4, extremePenalty - 6e-3 * excess);
      pen[i] = extremePenalty;
    }
    for (let i = 0; i < N; i++) {
      if (!seed[i]) continue;
      for (let k = 0; k < 6; k++) {
        const j = lat.neighbours[i * 6 + k];
        if (j < 0) continue;
        if (!seed[j]) pen[j] = Math.min(pen[j], nearPenalty);
        for (let m = 0; m < 6; m++) {
          const b = lat.neighbours[j * 6 + m];
          if (b < 0 || seed[b]) continue;
          pen[b] = Math.min(pen[b], farPenalty);
        }
      }
    }
    let flagged = 0;
    for (let i = 0; i < N; i++) {
      const sev = set[i];
      const p = pen[i];
      if (Number.isFinite(sev)) {
        confidence[i] = Math.min(confidence[i], sev);
        flagged++;
      } else if (p < 1) {
        confidence[i] = confidence[i] * p;
        flagged++;
      }
    }
    return { flagged, seeds, meanConfidence: mean(), darkCount: dark };
  }

  // packages/core/src/imaging/sample.ts
  function localScale(t, x, y) {
    const e = 0.35;
    const a = t.apply(x + e, y);
    const b = t.apply(x - e, y);
    const c = t.apply(x, y + e);
    const d = t.apply(x, y - e);
    if (!Number.isFinite(a.x) || !Number.isFinite(c.x)) return t.scale;
    const jx = Math.hypot(a.x - b.x, a.y - b.y) / (2 * e);
    const jy = Math.hypot(c.x - d.x, c.y - d.y) / (2 * e);
    return Math.sqrt(jx * jy) || t.scale;
  }
  function twoClusterCut(values) {
    const n = values.length;
    if (n === 0) return { cut: 0.5, span: 0.5 };
    const sorted = Array.from(values).sort((a, b) => a - b);
    const k = Math.max(1, Math.floor(n * 0.15));
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < k; i++) lo += sorted[i];
    for (let i = n - k; i < n; i++) hi += sorted[i];
    lo /= k;
    hi /= k;
    if (hi - lo < 1e-6) return { cut: lo, span: 0.02 };
    return { cut: (lo + hi) / 2, span: (hi - lo) / 2 };
  }
  function sampleSymbol(img, loc, t, opt = {}) {
    var _a, _b, _c;
    const shape = (_a = opt.shape) != null ? _a : "dot";
    const baseRadius = (_b = opt.sampleRadius) != null ? _b : shape === "dot" ? 0.4 : shape === "hex" ? 0.44 : 0.42;
    const weakThreshold = (_c = opt.weakThreshold) != null ? _c : 0.3;
    const useLocal = opt.localScale !== false;
    const version = loc.version;
    const lat = getLattice(version);
    const g2 = crown(dataRings(version));
    const values = new Float64Array(lat.N);
    const outside = new Float32Array(lat.N);
    for (let i = 0; i < lat.N; i++) {
      const mx = lat.xy[2 * i];
      const my = lat.xy[2 * i + 1];
      const p = t.apply(mx, my);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        values[i] = 0.5;
        outside[i] = 1;
        continue;
      }
      const s = useLocal ? localScale(t, mx, my) : t.scale;
      const smp = sampleDisc(img, p.x, p.y, Math.max(0.6, s * baseRadius));
      values[i] = smp.n ? inkOf(smp.mean, loc.lo, loc.hi) : 0.5;
      outside[i] = smp.outside;
    }
    const { cut, span } = twoClusterCut(values);
    const dataBits = new Uint8Array(lat.N);
    const confidence = new Float32Array(lat.N);
    for (let i = 0; i < lat.N; i++) {
      dataBits[i] = values[i] >= cut ? 1 : 0;
      let c = Math.min(1, Math.abs(values[i] - cut) / span);
      c *= 1 - outside[i];
      confidence[i] = c;
    }
    let maskPriorFlagged = 0;
    let maskPriorSeeds = 0;
    if (opt.maskPrior !== false) {
      const mp = typeof opt.maskPrior === "object" ? opt.maskPrior : {};
      const pr = applyMaskPrior(version, dataBits, confidence, mp);
      maskPriorFlagged = pr.flagged;
      maskPriorSeeds = pr.seeds;
    }
    let sum = 0;
    let weak = 0;
    for (let i = 0; i < lat.N; i++) {
      sum += confidence[i];
      if (confidence[i] < weakThreshold) weak++;
    }
    const beadValues = new Float64Array(BEADS);
    for (let i = 0; i < BEADS; i++) {
      const a = (i * 360 / BEADS + 360 / BEADS / 2) * (Math.PI / 180);
      const p = t.apply(g2.beadRadius * Math.cos(a), g2.beadRadius * Math.sin(a));
      const s = useLocal ? localScale(t, g2.beadRadius * Math.cos(a), g2.beadRadius * Math.sin(a)) : t.scale;
      const smp = sampleDisc(img, p.x, p.y, Math.max(0.5, s * g2.beadSize * 0.85));
      beadValues[i] = smp.n ? inkOf(smp.mean, loc.lo, loc.hi) : 0.5;
    }
    const bc = twoClusterCut(beadValues);
    const beads = new Uint8Array(BEADS);
    const beadConfidence = new Float32Array(BEADS);
    for (let i = 0; i < BEADS; i++) {
      beads[i] = beadValues[i] >= bc.cut ? 1 : 0;
      beadConfidence[i] = Math.min(1, Math.abs(beadValues[i] - bc.cut) / bc.span);
    }
    const teeth = new Uint8Array(63);
    const toothConfidence = new Float32Array(63);
    sampleTeethInto(img, loc, t, teeth, toothConfidence, useLocal);
    const core = new Uint8Array(19);
    const coreConfidence = new Float32Array(19);
    {
      let k = 0;
      const push = (mx, my) => {
        const p = t.apply(mx, my);
        const s = useLocal ? localScale(t, mx, my) : t.scale;
        const smp = sampleDisc(img, p.x, p.y, Math.max(0.6, s * baseRadius));
        const v = smp.n ? inkOf(smp.mean, loc.lo, loc.hi) : 0.5;
        core[k] = v >= cut ? 1 : 0;
        coreConfidence[k] = Math.min(1, Math.abs(v - cut) / span) * (1 - smp.outside);
        k++;
      };
      push(0, 0);
      for (let j = 0; j < 6; j++) {
        const c = ringXY(1, j);
        push(c.x, c.y);
      }
      for (let j = 0; j < 12; j++) {
        const c = ringXY(2, j);
        push(c.x, c.y);
      }
    }
    return {
      version,
      dataBits,
      confidence,
      beads,
      beadConfidence,
      teeth,
      toothConfidence,
      core,
      coreConfidence,
      transform: t,
      loc,
      meanConfidence: sum / lat.N,
      weakFraction: weak / lat.N,
      maskPriorFlagged,
      maskPriorSeeds
    };
  }
  function ringXY(d, j) {
    const side = Math.floor(j / d);
    const k = j - side * d;
    let q = 0;
    let r = 0;
    if (side === 0) {
      q = d - k;
      r = k;
    } else if (side === 1) {
      q = -k;
      r = d;
    } else if (side === 2) {
      q = -d;
      r = d - k;
    } else if (side === 3) {
      q = -d + k;
      r = -k;
    } else if (side === 4) {
      q = k;
      r = -d;
    } else {
      q = d;
      r = -d + k;
    }
    return { x: q + r / 2, y: Math.sqrt(3) / 2 * r };
  }
  function sampleTeethInto(img, loc, t, bits, conf, useLocal = true) {
    const g2 = crown(dataRings(loc.version));
    const toothDeg = 360 / 63;
    const values = new Float64Array(63);
    for (let i = 0; i < 63; i++) {
      let acc = 0;
      let n = 0;
      for (let ka = -2; ka <= 2; ka++) {
        const a = (i * toothDeg + ka * toothDeg / 10) * Math.PI / 180;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        for (let kr = -2; kr <= 2; kr++) {
          const rho = (g2.teethInner + g2.teethOuter) / 2 + kr * (g2.teethOuter - g2.teethInner) * 0.16;
          const p = t.apply(rho * ca, rho * sa);
          const v = sampleBilinear(img, p.x, p.y);
          if (Number.isNaN(v)) continue;
          acc += inkOf(v, loc.lo, loc.hi);
          n++;
        }
      }
      values[i] = n ? acc / n : 0.5;
      void useLocal;
    }
    const c = twoClusterCut(values);
    for (let i = 0; i < 63; i++) {
      bits[i] = values[i] >= c.cut ? 1 : 0;
      conf[i] = Math.min(1, Math.abs(values[i] - c.cut) / c.span);
    }
  }
  var DEFAULT_SAMPLE_RADIUS = DOT_RADIUS * 0.87;

  // packages/core/src/imaging/decode.ts
  function alignTeeth(sampled) {
    let bestShift = 0;
    let bestMatches = -1;
    for (let s = 0; s < 63; s++) {
      let m = 0;
      for (let i = 0; i < 63; i++) {
        if ((sampled[i] ? 1 : 0) === ANGLE_TRACK[(i + s) % 63]) m++;
      }
      if (m > bestMatches) {
        bestMatches = m;
        bestShift = s;
      }
    }
    return { shift: bestShift, matches: bestMatches };
  }
  function rebuildLoc(loc, version, img) {
    const K2 = dataRings(version);
    const g2 = crown(K2);
    const trace = traceRing(img, loc.cx, loc.cy, loc.radii.limbus, Math.max(1.5, loc.pitch * 0.6), loc.lo, loc.hi, 360);
    const fit = fitCircle(trace.pts);
    const cx = Number.isFinite(fit.cx) ? fit.cx : loc.cx;
    const cy = Number.isFinite(fit.cy) ? fit.cy : loc.cy;
    const rLimb = Number.isFinite(fit.r) && fit.r > 1 ? fit.r : loc.radii.limbus;
    const pitch = rLimb / (K2 + 4.85);
    const radii = {
      halo: pitch * g2.haloRadius,
      beads: pitch * g2.beadRadius,
      teethInner: pitch * g2.teethInner,
      teethOuter: pitch * g2.teethOuter,
      limbus: pitch * g2.limbusRadius,
      outer: pitch * g2.outerRadius
    };
    return {
      ...loc,
      version,
      K: K2,
      pitch,
      cx,
      cy,
      radii,
      score: loc.score,
      ringCoverage: trace.coverage,
      ringPoints: trace.pts
    };
  }
  function decodeOnce(img, opt, inverted) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
    const diag = {
      width: img.width,
      height: img.height,
      locate: null,
      locatedVersion: 0,
      pitch: 0,
      rotationDeg: 0,
      rotationMargin: 0,
      transformKind: "none",
      transformRms: NaN,
      teethMatches: 0,
      teethShift: 0,
      crownOk: false,
      golayDistance: 0,
      format: null,
      meanConfidence: 0,
      weakFraction: 0,
      erasureCells: 0,
      attempts: 0,
      coreMatches: 0,
      maskPriorFlagged: 0,
      maskPriorSeeds: 0,
      inverted,
      polarityRetries: 0
    };
    (_a = opt.onStage) == null ? void 0 : _a.call(opt, "locate");
    const loc0 = locate(img, opt.locate);
    if (!loc0) {
      return { ok: false, error: "no SiMurgh symbol found (radial matched filter scored too low)", diagnostics: diag };
    }
    diag.locate = loc0;
    diag.locatedVersion = loc0.version;
    diag.pitch = loc0.pitch;
    (_b = opt.onStage) == null ? void 0 : _b.call(opt, "orient", { version: loc0.version, pitch: loc0.pitch, score: loc0.score });
    let rot = estimateRotation(img, loc0, loc0.cx, loc0.cy);
    diag.rotationDeg = rot.phi;
    diag.rotationMargin = rot.margin;
    if (rot.score < 6) {
      return {
        ok: false,
        error: `Angle Track correlation too weak (score ${rot.score.toFixed(1)}, need >= 6): is the outer ring intact?`,
        diagnostics: diag
      };
    }
    let loc = loc0;
    let t = similarity(loc.cx, loc.cy, loc.pitch, rot.phi);
    if (!opt.noRectify) {
      (_c = opt.onStage) == null ? void 0 : _c.call(opt, "rectify");
      const refined = refineTransform(img, loc, t);
      diag.transformKind = refined.used;
      diag.transformRms = refined.rms;
      if (refined.transform) t = refined.transform;
      if (refined.used === "homography" && Number.isFinite(refined.rotationDeg) && ((_d = refined.rotationScore) != null ? _d : 0) > 6) {
        rot = { ...rot, phi: (-refined.rotationDeg % 360 + 360) % 360 };
        diag.rotationDeg = rot.phi;
      }
    } else {
      diag.transformKind = "similarity";
    }
    (_e = opt.onStage) == null ? void 0 : _e.call(opt, "sample");
    let sampled = sampleSymbol(img, loc, t, opt.sample);
    const align = alignTeeth(sampled.teeth);
    diag.teethMatches = align.matches;
    diag.teethShift = align.shift;
    if (align.matches >= 40 && align.shift !== 0) {
      const delta = align.shift <= 31 ? align.shift : align.shift - 63;
      (_f = opt.onStage) == null ? void 0 : _f.call(opt, "rotation-fix", { delta });
      t = composeModelRotation(t, -delta * (360 / 63));
      sampled = sampleSymbol(img, loc, t, opt.sample);
      const a2 = alignTeeth(sampled.teeth);
      diag.teethMatches = a2.matches;
      diag.teethShift = a2.shift;
    }
    {
      const expected = [1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
      let m = 0;
      for (let i = 0; i < 19; i++) if (sampled.core[i] === expected[i]) m++;
      diag.coreMatches = m;
    }
    const crownRes = decodeFormatCrown(sampled.beads);
    diag.crownOk = crownRes.ok;
    diag.golayDistance = crownRes.distance;
    if (crownRes.ok && crownRes.format) {
      diag.format = {
        version: crownRes.format.versionIndex + 1,
        ecc: crownRes.format.ecc,
        mask: crownRes.format.mask,
        compression: crownRes.format.compression
      };
      const v = crownRes.format.versionIndex + 1;
      if (v !== loc.version) {
        (_g = opt.onStage) == null ? void 0 : _g.call(opt, "version-fix", { from: loc.version, to: v });
        loc = rebuildLoc(loc, v, img);
        diag.pitch = loc.pitch;
        diag.locatedVersion = v;
        const delta = diag.teethShift <= 31 ? diag.teethShift : diag.teethShift - 63;
        t = similarity(loc.cx, loc.cy, loc.pitch, rot.phi - delta * (360 / 63));
        if (!opt.noRectify) {
          const refined = refineTransform(img, loc, t);
          if (refined.transform) t = refined.transform;
          diag.transformKind = refined.used;
          diag.transformRms = refined.rms;
        }
        if (delta !== 0) t = composeModelRotation(t, -delta * (360 / 63));
        sampled = sampleSymbol(img, loc, t, opt.sample);
      }
    }
    if (!diag.crownOk && diag.teethMatches < 40 && diag.meanConfidence < 0.3) {
      return {
        ok: false,
        error: `image does not resolve a SiMurgh symbol: mean module confidence ${diag.meanConfidence.toFixed(2)}, Angle Track ${diag.teethMatches}/63, Format Crown unreadable (resolution too low, or no symbol present)`,
        diagnostics: diag,
        sampled
      };
    }
    diag.meanConfidence = sampled.meanConfidence;
    diag.weakFraction = sampled.weakFraction;
    diag.maskPriorFlagged = sampled.maskPriorFlagged;
    diag.maskPriorSeeds = sampled.maskPriorSeeds;
    const win = (_h = opt.versionWindow) != null ? _h : 1;
    const versions = [];
    for (let v = loc.version - win; v <= loc.version + win; v++) if (v >= MIN_VERSION && v <= MAX_VERSION) versions.push(v);
    if (!versions.includes(loc.version)) versions.unshift(loc.version);
    const workBound = Math.max(8, Math.min(512, Math.floor(4e5 / Math.max(1, sampled.dataBits.length))));
    const decodeOpts = {
      erasureThreshold: (_i = opt.erasureThreshold) != null ? _i : 0.28,
      decompress: opt.decompress,
      candidateVersions: versions,
      maxCandidates: (_j = opt.maxCandidates) != null ? _j : workBound,
      secure: opt.secure
    };
    const attempts = [
      {
        label: "crown+soft",
        run: () => decode({ dataBits: sampled.dataBits, confidence: sampled.confidence, beads: sampled.beads }, decodeOpts)
      },
      {
        /*
         * The 0.85 budget factor deliberately holds back 15% of each block's parity
         * to pay for errors the sampler did not notice. When the damage detector has
         * fired hard, that reserve is the wrong bet: the flagged cells are almost
         * certainly real damage, and a symbol left out of the erasure list costs two
         * parity symbols instead of one. So spend the whole parity budget on
         * erasures and let the CRC-32 decide.
         */
        label: "crown+full-erasure",
        run: () => decode(
          { dataBits: sampled.dataBits, confidence: sampled.confidence, beads: sampled.beads },
          { ...decodeOpts, maxErasureFraction: 1 }
        )
      },
      {
        label: "brute+soft",
        run: () => decode({ dataBits: sampled.dataBits, confidence: sampled.confidence }, { ...decodeOpts })
      },
      {
        label: "brute+hard",
        run: () => decode({ dataBits: sampled.dataBits }, { ...decodeOpts })
      },
      {
        label: "brute+soft+wide-erasure",
        run: () => {
          var _a2;
          return decode(
            { dataBits: sampled.dataBits, confidence: sampled.confidence },
            { ...decodeOpts, erasureThreshold: ((_a2 = opt.erasureThreshold) != null ? _a2 : 0.28) * 1.7 }
          );
        }
      }
    ];
    const retries = (_k = opt.retries) != null ? _k : attempts.length;
    let last = { ok: false, error: "no attempt produced a result" };
    for (let i = 0; i < Math.min(retries, attempts.length); i++) {
      diag.attempts = i + 1;
      (_l = opt.onStage) == null ? void 0 : _l.call(opt, `decode:${attempts[i].label}`);
      const r = attempts[i].run();
      last = r;
      if (r.ok) {
        const er = (_n = (_m = r.stats) == null ? void 0 : _m.erasureCells) != null ? _n : 0;
        diag.erasureCells = er;
        return { ...r, diagnostics: diag, sampled };
      }
    }
    return { ...last, ok: false, diagnostics: diag, sampled };
  }
  function decodeImage(img0, opt = {}) {
    var _a;
    const mode = (_a = opt.polarity) != null ? _a : "auto";
    const guess = mode === "auto" ? detectPolarity(img0) : mode;
    const firstInverted = guess === "inverted";
    const first = firstInverted ? invertImage(img0) : img0;
    let res = decodeOnce(first, opt, firstInverted);
    if (res.ok || mode !== "auto" || opt.noPolarityRetry) return res;
    const second = firstInverted ? img0 : invertImage(img0);
    const retry = decodeOnce(second, opt, !firstInverted);
    retry.diagnostics.polarityRetries = 1;
    if (retry.ok) return retry;
    const depth = (r) => {
      var _a2, _b;
      const d = r.diagnostics;
      if (!d.locate) return 0;
      if (d.teethMatches === 0) return 1;
      if (!d.format) return 2;
      return 3 + ((_b = (_a2 = r.stats) == null ? void 0 : _a2.erasureSymbols) != null ? _b : 0) / 1e3;
    };
    return depth(retry) > depth(res) ? retry : res;
  }
  function decodeRGBA(data, width, height, opt = {}) {
    const out = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      const r = data[p];
      const g2 = data[p + 1];
      const b = data[p + 2];
      const a = data[p + 3];
      const luma = 0.2126 * r + 0.7152 * g2 + 0.0722 * b;
      out[i] = Math.round(luma * a / 255 + 255 * (1 - a / 255));
    }
    return decodeImage({ width, height, data: out }, opt);
  }

  // packages/core/src/version.ts
  var SYMBOLOGY_NAME = "SiMurgh Code";
  var SYMBOLOGY_ID = "SMC";
  var SPEC_VERSION = "1.1.0";
  var SPEC_DATE = "2026-10-29";

  // tools/engine-entry.ts
  function b64ToBytes(b64) {
    const AL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let o = 0;
    let buf = 0;
    let bits = 0;
    for (const ch of clean) {
      const v = AL.indexOf(ch);
      if (v < 0) continue;
      buf = buf << 6 | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = buf >> bits & 255;
      }
    }
    return out.subarray(0, o);
  }
  function bytesToB64(bytes) {
    const AL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i];
      const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      out += AL[b0 >> 2] + AL[(b0 & 3) << 4 | b1 >> 4];
      out += i + 1 < bytes.length ? AL[(b1 & 15) << 2 | b2 >> 6] : "=";
      out += i + 2 < bytes.length ? AL[b2 & 63] : "=";
    }
    return out;
  }
  function encodeOp(req) {
    var _a, _b, _c, _d, _e, _f, _g;
    const opt = { ecc: (_a = req.ecc) != null ? _a : "M" };
    if (req.version !== void 0) opt.version = req.version;
    if (req.mask !== void 0) opt.mask = req.mask;
    if (req.dataHex) opt.data = hexDecode(req.dataHex);
    else if (req.geo) opt.geo = req.geo;
    else if (req.url) opt.url = req.url;
    else opt.text = (_b = req.text) != null ? _b : "";
    if (req.secure && (req.secure.pass || req.secure.keyHex)) {
      opt.secure = {
        key: req.secure.keyHex ? hexDecode(req.secure.keyHex) : req.secure.pass,
        ...req.secure.iterations !== void 0 ? { iterations: req.secure.iterations } : {},
        ...req.secure.saltHex ? { salt: hexDecode(req.secure.saltHex) } : {},
        ...req.secure.nonceHex ? { nonce: hexDecode(req.secure.nonceHex) } : {},
        ...req.secure.context !== void 0 ? { context: req.secure.context } : {},
        ...req.secure.compress !== void 0 ? { compress: req.secure.compress } : {}
      };
    }
    const sym = encode(opt);
    const model = toModel(sym);
    const rgba = renderRGBA(model, {
      theme: (_c = req.theme) != null ? _c : "ink",
      shape: (_d = req.shape) != null ? _d : "dot",
      scale: (_e = req.scale) != null ? _e : 8
    });
    return {
      ok: true,
      version: sym.version,
      ecc: sym.ecc,
      mask: sym.mask,
      cells: model.cellCount,
      payloadBytes: sym.plan.payloadBytes,
      codewords: sym.plan.codewords,
      blocks: sym.plan.blocks,
      formatWord: sym.formatWord,
      formatBits: sym.formatBits,
      dataBitsHex: hexEncode(sym.dataBits),
      beadsHex: hexEncode(sym.beads),
      inkCoverage: sym.inkCoverage,
      compressed: sym.compression === 1,
      segments: sym.segments.map((s) => s.kind),
      secure: sym.secure ? {
        keyId: hexEncode(sym.secure.keyId),
        salt: hexEncode(sym.secure.salt),
        iterations: sym.secure.iterations,
        nonce: hexEncode(sym.secure.nonce),
        ciphertextBytes: sym.secure.ciphertext.length,
        plaintextBytes: sym.secure.ciphertext.length - 16,
        ciphertextHex: hexEncode(sym.secure.ciphertext)
      } : null,
      raster: { width: rgba.width, height: rgba.height, rgbaB64: bytesToB64(rgba.data) },
      ...req.wantSvg ? {
        svg: renderSVG(model, {
          theme: (_f = req.theme) != null ? _f : "ink",
          shape: (_g = req.shape) != null ? _g : "dot",
          scale: 6,
          unit: "mm",
          caption: req.caption === void 0 ? null : req.caption
        })
      } : {}
    };
  }
  function decodeOp(req) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o;
    const secure = req.pass || req.keyHex || req.context ? {
      ...req.keyHex ? { key: hexDecode(req.keyHex) } : {},
      ...req.pass && !req.keyHex ? { key: req.pass } : {},
      ...req.context !== void 0 ? { context: req.context } : {}
    } : void 0;
    const options = {
      ...secure ? { secure } : {},
      ...req.fast ? { retries: 2, noPolarityRetry: true, versionWindow: 0, maxCandidates: 24 } : {}
    };
    const t0 = Date.now();
    const result = req.grayB64 ? decodeImage(
      { width: (_a = req.width) != null ? _a : 0, height: (_b = req.height) != null ? _b : 0, data: b64ToBytes(req.grayB64) },
      options
    ) : decodeRGBA(b64ToBytes((_c = req.rgbaB64) != null ? _c : ""), (_d = req.width) != null ? _d : 0, (_e = req.height) != null ? _e : 0, options);
    const ms = Date.now() - t0;
    const d = result.diagnostics;
    return {
      ok: result.ok,
      ms,
      ...result.ok ? {
        text: (_f = result.text) != null ? _f : "",
        encrypted: result.encrypted === true,
        unlocked: result.secureUnlocked === true,
        secureInfo: (_g = result.secureInfo) != null ? _g : null,
        segments: ((_h = result.segments) != null ? _h : []).map((s) => s.kind)
      } : { error: (_i = result.error) != null ? _i : "decode failed" },
      diag: {
        version: (_j = result.version) != null ? _j : 0,
        ecc: (_k = result.ecc) != null ? _k : "-",
        mask: (_l = result.mask) != null ? _l : 0,
        teeth: `${d.teethMatches}/63`,
        crown: d.crownOk ? "crown" : `brute(${d.golayDistance})`,
        confidence: Number(d.meanConfidence.toFixed(3)),
        rotationDeg: Number(d.rotationDeg.toFixed(1)),
        pitch: Number(d.pitch.toFixed(2)),
        inverted: d.inverted,
        polarityRetries: d.polarityRetries,
        erasures: d.erasureCells,
        errorsFixed: (_n = (_m = result.stats) == null ? void 0 : _m.errorsFixed) != null ? _n : 0,
        crc: ((_o = result.stats) == null ? void 0 : _o.crcOk) === true,
        transform: `${d.transformKind} rms=${Number.isFinite(d.transformRms) ? d.transformRms.toFixed(2) : "-"}`
      }
    };
  }
  function themesOp() {
    return {
      themes: THEME_IDS.map((id) => {
        const t = THEMES[id];
        const c = themeContrast(t);
        return { id, fa: t.fa, en: t.en, ink: t.ink, crown: t.crown, paper: t.paper, contrast: Number(c.worst.toFixed(2)), printable: c.printable };
      })
    };
  }
  function specOp() {
    return { name: SYMBOLOGY_NAME, id: SYMBOLOGY_ID, version: SPEC_VERSION, date: SPEC_DATE };
  }
  function call(requestJson) {
    try {
      const req = JSON.parse(requestJson);
      switch (req.op) {
        case "encode":
          return JSON.stringify(encodeOp(req));
        case "decode":
          return JSON.stringify(decodeOp(req));
        case "themes":
          return JSON.stringify(themesOp());
        case "spec":
          return JSON.stringify(specOp());
        default:
          return JSON.stringify({ ok: false, error: `unknown op ${req.op}` });
      }
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message });
    }
  }
  var g = globalThis;
  g.SimurghEngine = { call };
  var exposed = g.SimurghEngine;
  exposed.decodeBits = (dataBitsHex, beadsHex, secureJson) => {
    var _a, _b, _c, _d, _e, _f, _g;
    try {
      const dataBits = hexDecode(dataBitsHex);
      const beads = hexDecode(beadsHex);
      const secure = secureJson ? JSON.parse(secureJson) : void 0;
      const r = decode(
        { dataBits, beads },
        {
          decompress: (raw) => inflateRaw(raw, { maxOutput: 65536 }),
          ...secure ? {
            secure: {
              ...secure.keyHex ? { key: hexDecode(secure.keyHex) } : {},
              ...secure.pass ? { key: secure.pass } : {},
              ...secure.context !== void 0 ? { context: secure.context } : {}
            }
          } : {}
        }
      );
      return JSON.stringify({
        ok: r.ok,
        text: r.ok ? (_a = r.text) != null ? _a : "" : null,
        version: (_b = r.version) != null ? _b : 0,
        ecc: (_c = r.ecc) != null ? _c : "-",
        encrypted: r.encrypted === true,
        unlocked: r.secureUnlocked === true,
        errorsFixed: (_e = (_d = r.stats) == null ? void 0 : _d.errorsFixed) != null ? _e : 0,
        crcOk: ((_f = r.stats) == null ? void 0 : _f.crcOk) === true,
        error: r.ok ? null : (_g = r.error) != null ? _g : "decode failed"
      });
    } catch (e) {
      return JSON.stringify({ ok: false, error: e.message });
    }
  };
})();
