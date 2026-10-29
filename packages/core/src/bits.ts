/**
 * Bit-level I/O primitives.
 *
 * SiMurgh Code payloads are bit streams (not byte aligned), so every encoder
 * and decoder path goes through these two classes. MSB-first ordering is used
 * everywhere in the specification.
 */

/** Append-only MSB-first bit buffer. */
export class BitWriter {
  private buf: number[] = [];
  private acc = 0;
  private n = 0;
  /** Number of bits written so far. */
  get length(): number {
    return this.buf.length * 8 + this.n;
  }

  writeBit(b: number): void {
    this.acc = ((this.acc << 1) | (b & 1)) & 0xff;
    this.n++;
    if (this.n === 8) {
      this.buf.push(this.acc);
      this.acc = 0;
      this.n = 0;
    }
  }

  writeBits(value: number, count: number): void {
    if (count < 0 || count > 32) throw new RangeError('writeBits: count must be in [0,32]');
    for (let i = count - 1; i >= 0; i--) this.writeBit((value >>> i) & 1);
  }

  /** Writes an arbitrarily wide non-negative integer (BigInt), MSB first. */
  writeBigInt(value: bigint, count: number): void {
    if (value < 0n) throw new RangeError('writeBigInt: negative value');
    const mask = (1n << BigInt(count)) - 1n;
    if (value > mask) throw new RangeError(`writeBigInt: value needs more than ${count} bits`);
    for (let i = count - 1; i >= 0; i--) this.writeBit(Number((value >> BigInt(i)) & 1n));
  }

  writeBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.writeBits(bytes[i] as number, 8);
  }

  /** Number of bits needed to represent `value` (0 needs 0 bits). */
  static bitLength(value: bigint | number): number {
    const v = typeof value === 'bigint' ? value : BigInt(value);
    if (v <= 0n) return 0;
    let n = 0;
    let x = v;
    while (x > 0n) {
      n++;
      x >>= 1n;
    }
    return n;
  }

  /** Flushes the tail with zero bits and returns the byte array. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(this.buf.length + (this.n > 0 ? 1 : 0));
    out.set(this.buf, 0);
    if (this.n > 0) out[this.buf.length] = (this.acc << (8 - this.n)) & 0xff;
    return out;
  }

  /** Flushes the tail with zero bits and returns a copy of the raw bit array. */
  toBitArray(): Uint8Array {
    const out = new Uint8Array(this.length);
    const bytes = this.toBytes();
    for (let i = 0; i < out.length; i++) out[i] = ((bytes[i >> 3] as number) >>> (7 - (i & 7))) & 1;
    return out;
  }
}

/** Cursor-based MSB-first bit reader over a byte array. */
export class BitReader {
  constructor(
    private readonly data: Uint8Array,
    /** Total readable bit count; defaults to the whole byte array. */
    public readonly bitLength: number = data.length * 8,
  ) {}

  private pos = 0;

  get position(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.bitLength - this.pos;
  }

  seek(pos: number): void {
    if (pos < 0 || pos > this.bitLength) throw new RangeError('BitReader.seek out of range');
    this.pos = pos;
  }

  readBit(): number {
    if (this.pos >= this.bitLength) throw new RangeError('BitReader: read past end');
    const byte = this.data[this.pos >> 3] as number;
    const bit = (byte >>> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return bit;
  }

  readBits(count: number): number {
    if (count > 32) throw new RangeError('readBits: count must be <= 32');
    let v = 0;
    for (let i = 0; i < count; i++) v = (v << 1) | this.readBit();
    return v >>> 0;
  }

  readBigInt(count: number): bigint {
    let v = 0n;
    for (let i = 0; i < count; i++) v = (v << 1n) | BigInt(this.readBit());
    return v;
  }

  readBytes(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = this.readBits(8);
    return out;
  }

  peekBits(count: number): number {
    const p = this.pos;
    const v = this.readBits(count);
    this.pos = p;
    return v;
  }
}

/** Number of bits required to hold values `0 .. n-1`. */
export function bitsFor(n: number): number {
  if (n <= 1) return 0;
  return 32 - Math.clz32(n - 1);
}
