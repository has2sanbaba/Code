/**
 * ============================================================================
 *  SiMurgh Code -- ENCODER
 * ============================================================================
 *
 * Pipeline
 * --------
 *   segments ─▶ payload bytes ─▶ CRC-32 ─▶ RS blocks ─▶ interleave
 *            ─▶ bit stream ─▶ scattering stride pi ─▶ data mask XOR
 *            ─▶ SymbolModel (core rosette + data cells + Halo + Beads
 *                            + Angle Track + Beak + Limbus)
 *
 * Everything is deterministic: same input + same options ⇒ byte-identical
 * symbol, which is what makes golden-vector regression tests possible.
 */
import { deinterleave, interleavedLayout, interleave, planBlocks, type BlockPlan } from './blocks.js';
import { crc32 } from './crc.js';
import { deflateRaw } from './deflate.js';
import {
  ANGLE_TRACK,
  BEADS,
  CORE_RADIUS,
  ECC_LEVELS,
  MAX_VERSION,
  MIN_VERSION,
  TEETH,
  bestMask,
  coreCells,
  crown,
  dataRings,
  getLattice,
  maskArray,
  packFormat,
  unpackFormat,
  type EccLevel,
  type FormatBits,
} from './geometry.js';
import { encodeFormatCrown } from './format.js';
import { rsParity } from './reed-solomon.js';
import {
  autoSegments,
  encodePayloadBytes,
  segmentBits,
  segmentsToBytes,
  type GeoFix,
  type Segment,
} from './segments.js';

export interface EncodeOptions {
  /** Fixed version 1..40. Omit to pick the smallest version that fits. */
  version?: number;
  /** Error correction level. Default 'M'. */
  ecc?: EccLevel;
  /** Force a data mask 0..7. Omit to pick the best by penalty. */
  mask?: number;
  /** Explicit segment list. Overrides text/url/data. */
  segments?: Segment[];
  /** Convenience: encode this string (automatic mode selection). */
  text?: string;
  /** Convenience: encode as a URL segment (falls back to text if not http(s)). */
  url?: string;
  /** Convenience: encode raw bytes as a BYTE segment. */
  data?: Uint8Array;
  /** Convenience: append a GEO segment. */
  geo?: GeoFix;
  /** Convenience: append a FRAME segment (multi-code streams). */
  frame?: { streamId: number; index: number; count: number };
  /** Convenience: append a MAC segment. */
  mac?: { algo: number; value: Uint8Array };
  /** Convenience: append a SIGNATURE segment. */
  signature?: { algo: number; value: Uint8Array };
  /** Convenience: append a VENDOR segment. */
  vendor?: { id: number; value: Uint8Array };
  /** Try to compress the payload (raw DEFLATE). Default: true. */
  compression?: boolean;
  /** Pluggable compressor. Defaults to the built-in raw DEFLATE encoder. */
  compress?: (raw: Uint8Array) => Uint8Array | null;
}

export interface EncodedSymbol {
  version: number;
  ecc: EccLevel;
  mask: number;
  compression: 0 | 1;
  /** The 12 information bits of the Format Crown. */
  formatBits: number;
  /** The 24-bit extended Golay codeword printed as beads. */
  formatWord: number;
  plan: BlockPlan;
  segments: Segment[];
  /** Exact payload bytes protected by the CRC (before padding semantics). */
  payloadBytes: Uint8Array;
  /** The complete interleaved codeword stream (data + parity). */
  codewords: Uint8Array;
  /** Printed (masked) value of every data cell, length N. */
  dataBits: Uint8Array;
  /** Mask value of every data cell (for diagnostics). */
  maskBits: Uint8Array;
  /** Unmasked bit of every data cell. */
  rawBits: Uint8Array;
  /** Angle Track teeth, length 63. */
  teeth: Uint8Array;
  /** Format Crown beads, length 24. */
  beads: Uint8Array;
  /** Mask penalty scores, indexed by mask id. */
  maskScores: number[];
  /** Dark module ratio of the data field. */
  inkCoverage: number;
}

/** Build the segment list from the convenience options. */
export function buildSegments(opt: EncodeOptions): Segment[] {
  const segs: Segment[] = [];
  if (opt.frame) segs.push({ kind: 'frame', ...opt.frame });
  if (opt.segments) segs.push(...opt.segments);
  if (opt.url !== undefined) {
    const s: Segment = { kind: 'url', value: opt.url };
    segs.push(Number.isFinite(segmentBits(s)) ? s : { kind: 'text', value: opt.url });
  }
  if (opt.text !== undefined) segs.push(...autoSegments(opt.text));
  if (opt.data) segs.push({ kind: 'byte', value: opt.data });
  if (opt.geo) segs.push({ kind: 'geo', value: opt.geo });
  if (opt.mac) segs.push({ kind: 'mac', algo: opt.mac.algo, value: opt.mac.value });
  if (opt.signature) segs.push({ kind: 'signature', algo: opt.signature.algo, value: opt.signature.value });
  if (opt.vendor) segs.push({ kind: 'vendor', id: opt.vendor.id, value: opt.vendor.value });
  return segs;
}

/** Segment stream as bytes, with no padding (this is what gets compressed). */
export function segmentsToCoreBytes(segments: Segment[]): Uint8Array {
  return segmentsToBytes(segments);
}

export class CapacityError extends Error {
  constructor(
    message: string,
    public readonly neededBits: number,
    public readonly availableBits: number,
  ) {
    super(message);
  }
}

/**
 * Encode a symbol.
 */
/** Below this many payload bytes a DEFLATE block header costs more than it saves. */
export const MIN_COMPRESS_BYTES = 24;

export function encode(opt: EncodeOptions = {}): EncodedSymbol {
  const ecc = opt.ecc ?? 'M';
  const segments = buildSegments(opt);
  const core = segmentsToCoreBytes(segments);

  /*
   * Compression is on by default and uses the built-in RFC 1951 encoder, so a
   * caller who never thinks about it still gets the ~4x payload density that
   * text and URLs allow. It is only ever accepted when it actually shrinks the
   * data: a symbol has already committed to a size, and a symbology that can
   * make a payload *bigger* is worse than one that never tries. The 24-byte
   * floor is where a DEFLATE block header stops paying for itself.
   */
  const compress = opt.compress ?? ((raw: Uint8Array) => deflateRaw(raw));
  const useCompression = opt.compression !== false && core.length >= MIN_COMPRESS_BYTES;
  let compressed: Uint8Array | null = null;
  if (useCompression) {
    const c = compress(core);
    if (c && c.length < core.length) compressed = c;
  }
  const bodyBytes = compressed ?? core;
  const compressionFlag: 0 | 1 = compressed ? 1 : 0;
  /*
   * The symbol is sized from the bytes that will actually be written. Sizing it
   * from the uncompressed core instead -- the obvious mistake, and one that
   * still round-trips, because a decoder stops at BFINAL and never looks at the
   * padding -- silently gives away the entire benefit of the compression bit:
   * 2000 characters of prose would still occupy a version-32 disc.
   */
  const needBits = bodyBytes.length * 8;

  const versions =
    opt.version !== undefined
      ? [opt.version]
      : Array.from({ length: MAX_VERSION - MIN_VERSION + 1 }, (_, i) => i + MIN_VERSION);

  let chosen: { version: number; plan: BlockPlan } | null = null;
  for (const v of versions) {
    const plan = planBlocks(v, ecc);
    if (plan.payloadBytes * 8 >= needBits) {
      chosen = { version: v, plan };
      break;
    }
  }
  if (!chosen) {
    // When the caller pins a version the report must name *that* version: quoting
    // the largest one would send them looking for a capacity that was never asked for.
    const ceiling = opt.version !== undefined ? opt.version : MAX_VERSION;
    const plan = planBlocks(ceiling, ecc);
    const label = opt.version !== undefined ? `${ceiling} (the requested version)` : `${ceiling} (the largest)`;
    const note = compressed ? ` (${core.length} bytes before DEFLATE)` : '';
    throw new CapacityError(
      `payload of ${needBits} bits${note} does not fit in SiMurgh version ${label} at ECC ${ecc}`,
      needBits,
      plan.payloadBytes * 8,
    );
  }

  const { version, plan } = chosen;

  // ---- payload block + CRC -------------------------------------------------
  const payloadBytes = new Uint8Array(plan.payloadBytes);
  payloadBytes.set(bodyBytes.subarray(0, Math.min(bodyBytes.length, plan.payloadBytes)));
  if (compressed) {
    // zero padding after a DEFLATE stream is ignored by the inflater
  } else {
    const padded = encodePayloadBytes(segments, plan.payloadBytes);
    payloadBytes.set(padded);
  }
  const crc = crc32(payloadBytes);
  const dataCodewords = new Uint8Array(plan.dataCodewords);
  dataCodewords.set(payloadBytes, 0);
  dataCodewords[plan.payloadBytes + 0] = (crc >>> 24) & 0xff;
  dataCodewords[plan.payloadBytes + 1] = (crc >>> 16) & 0xff;
  dataCodewords[plan.payloadBytes + 2] = (crc >>> 8) & 0xff;
  dataCodewords[plan.payloadBytes + 3] = crc & 0xff;

  // ---- split into RS blocks ------------------------------------------------
  const dataBlocks: Uint8Array[] = [];
  const parityBlocks: Uint8Array[] = [];
  let off = 0;
  for (let b = 0; b < plan.blocks; b++) {
    const d = plan.blockData[b] as number;
    const p = plan.blockParity[b] as number;
    const blk = dataCodewords.slice(off, off + d);
    off += d;
    dataBlocks.push(blk);
    parityBlocks.push(rsParity(blk, p));
  }
  const stream = interleave(dataBlocks, parityBlocks);
  if (stream.length !== plan.codewords) throw new Error(`interleave produced ${stream.length} != ${plan.codewords}`);

  // ---- bits, scattering stride, mask --------------------------------------
  const lat = getLattice(version);
  const N = lat.N;
  const bitCount = stream.length * 8;

  // write the interleaved codeword stream along the serpentine spiral
  const rawBits = new Uint8Array(N);
  for (let i = 0; i < bitCount; i++) {
    const bit = ((stream[i >> 3] as number) >>> (7 - (i & 7))) & 1;
    rawBits[lat.serpentine[i] as number] = bit;
  }

  let maskId = opt.mask ?? -1;
  let maskScores: number[] = [];
  if (maskId < 0) {
    const sel = bestMask(version, rawBits);
    maskId = sel.mask;
    maskScores = sel.scores;
  } else {
    maskScores = Array.from({ length: 8 }, (_, m) => (m === maskId ? 0 : Infinity));
  }
  const mask = maskArray(version, maskId);
  const dataBits = new Uint8Array(N);
  let dark = 0;
  for (let i = 0; i < N; i++) {
    dataBits[i] = (rawBits[i] as number) ^ (mask[i] as number);
    dark += dataBits[i] as number;
  }

  // ---- Format Crown --------------------------------------------------------
  const fb: FormatBits = {
    versionIndex: version - 1,
    ecc: ECC_LEVELS.indexOf(ecc),
    mask: maskId,
    compression: compressionFlag,
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
  };
}

/* ------------------------------------------------------------------ *
 *  Multi-code streams
 * ------------------------------------------------------------------ */

export interface FrameOptions extends EncodeOptions {
  /** ECC level for the frames (default 'Q': frames are usually handled roughly). */
  ecc?: EccLevel;
}

/**
 * Split an arbitrarily large payload across a *series* of SiMurgh codes.
 *
 * Each code carries a FRAME segment with a 32-bit stream id (the CRC-32 of the
 * whole payload) plus its index and the frame count, so a reader can:
 *   - recognise that a code is one part of a bigger message,
 *   - collect the parts out of order,
 *   - detect a missing part,
 *   - verify the reassembly with the stream id.
 */
export function encodeFrames(data: Uint8Array, perFrameBytes: number, opt: FrameOptions = {}): EncodedSymbol[] {
  if (perFrameBytes < 16) throw new RangeError('frames must carry at least 16 bytes');
  const streamId = crc32(data);
  const count = Math.max(1, Math.ceil(data.length / perFrameBytes));
  if (count > 4095) throw new RangeError('a stream may not exceed 4096 frames');
  const out: EncodedSymbol[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = data.slice(i * perFrameBytes, (i + 1) * perFrameBytes);
    out.push(
      encode({
        ...opt,
        frame: { streamId, index: i, count },
        segments: [{ kind: 'byte', value: chunk }],
      }),
    );
  }
  return out;
}

/** Reassemble frames produced by {@link encodeFrames}. */
export function reassembleFrames(
  frames: { streamId: number; index: number; count: number; data: Uint8Array }[],
): { streamId: number; count: number; data: Uint8Array; missing: number[] } {
  if (frames.length === 0) throw new Error('no frames');
  const { streamId, count } = frames[0]!;
  for (const f of frames) {
    if (f.streamId !== streamId || f.count !== count) throw new Error('frames belong to different streams');
  }
  const parts = new Map<number, Uint8Array>();
  for (const f of frames) parts.set(f.index, f.data);
  const missing: number[] = [];
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    const p = parts.get(i);
    if (!p) {
      missing.push(i);
      chunks.push(new Uint8Array(0));
      continue;
    }
    chunks.push(p);
    total += p.length;
  }
  const data = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    data.set(c, o);
    o += c.length;
  }
  return { streamId, count, data, missing };
}

