/**
 * ============================================================================
 *  SiMurgh Code -- BITSTREAM DECODER
 * ============================================================================
 *
 * Takes the printed (masked) value of every data cell -- plus an optional
 * confidence/erasure map -- and recovers the payload.
 *
 * Order of operations is the exact inverse of the encoder:
 *
 *   printed cells ─▶ un-mask ─▶ pi^-1 (scattering stride) ─▶ bit stream
 *                 ─▶ de-interleave ─▶ per-block Reed-Solomon (errors+erasures)
 *                 ─▶ data codewords ─▶ CRC-32 check ─▶ inflate (if flagged)
 *                 ─▶ segment parse
 *
 * Soft decisions: any cell whose sampled confidence is below a threshold is
 * declared an *erasure*. Reed-Solomon fixes an erasure for the price of one
 * parity symbol instead of two, so telling the decoder "I am not sure about
 * these cells" literally doubles the damage the symbol can absorb. This is the
 * single biggest robustness win over hard-decision decoders.
 */
import { deinterleave, interleavedLayout, planBlocks, type BlockPlan } from './blocks.js';
import { crc32 } from './crc.js';
import { inflateRaw } from './deflate.js';
import { decodeFormatCrown, encodeFormatCrown, formatCandidates, type FormatCandidate } from './format.js';
import {
  ECC_LEVELS,
  getLattice,
  maskArray,
  unpackFormat,
  type EccLevel,
  type FormatBits,
} from './geometry.js';
import { rsDecode } from './reed-solomon.js';
import {
  decodePayloadBytes,
  payloadToText,
  unwrapSecure,
  type Payload,
  type SecureDecodeOptions,
  type SecureSegment,
  type Segment,
} from './segments.js';
import { hexEncode } from './sha256.js';

export interface DecodeInput {
  /** Printed value (0/1) of every data cell, in lattice order, length N. */
  dataBits: ArrayLike<number>;
  /**
   * Per-cell confidence in [0,1]. Cells below `erasureThreshold` are treated as
   * erasures. Omit for hard decisions.
   */
  confidence?: ArrayLike<number>;
  /** Explicit erasure cell indices (unioned with the confidence-derived set). */
  erasures?: ArrayLike<number>;
  /** Format, when already known (bit-exact decoding, or a decoded Crown). */
  format?: FormatBits;
  /** 24 sampled beads, used when `format` is absent. */
  beads?: ArrayLike<number>;
}

export interface DecodeOptions {
  /** Confidence below which a cell becomes an erasure. Default 0.28. */
  erasureThreshold?: number;
  /**
   * Fraction of the total parity budget that may be spent on erasures.
   * Default 0.85. Cells are ranked by confidence and the budget goes to the
   * least confident ones first.
   */
  maxErasureFraction?: number;
  /** Inflate implementation, required when the format's compression bit is set. */
  decompress?: (raw: Uint8Array) => Uint8Array;
  /** Versions to brute-force when the Crown is unreadable. */
  candidateVersions?: number[];
  /** Give up after this many candidate formats (0 = no limit). */
  maxCandidates?: number;
  /** Called with progress information during a brute-force search. */
  onCandidate?: (c: FormatCandidate) => void;
  /**
   * Keys for opening SECURE envelopes. Omit to read a symbol's structure
   * without its contents: the decode still succeeds, reports `encrypted: true`
   * and yields the ciphertext metadata (key id, KDF cost, size) and nothing more.
   */
  secure?: SecureDecodeOptions;
}

/** What a reader can learn from an encrypted envelope without the key. */
export interface SecureEnvelopeInfo {
  /** 0 = PBKDF2 passphrase, 1 = raw 32-byte key. */
  suite: number;
  /** Hex key identifier printed in the envelope (empty string when absent). */
  keyId: string;
  /** PBKDF2 iteration count (0 for the raw-key suite). */
  iterations: number;
  /** Hex salt (empty for the raw-key suite). */
  salt: string;
  /** Ciphertext length excluding the 16-byte tag, i.e. the plaintext length. */
  plaintextBytes: number;
}

export interface DecodeStats {
  /** Format was read from the Crown rather than brute-forced. */
  crownOk: boolean;
  /** Bead errors corrected by Golay. */
  crownDistance: number;
  /** Number of formats attempted. */
  candidatesTried: number;
  errorsFixed: number;
  erasuresFixed: number;
  erasureCells: number;
  /** Distinct codewords that were handed to Reed-Solomon as erasures. */
  erasureSymbols: number;
  /** Total erasure budget across all blocks, in codewords. */
  erasureBudget: number;
  /** Cells that could not be declared erased because their block's budget was spent. */
  erasureBudgetBlocked: number;
  blocksFailed: number;
  crcOk: boolean;
  /** Corrected codeword stream (for diagnostics). */
  codewords?: Uint8Array;
}

export interface DecodeResult {
  ok: boolean;
  error?: string;
  version?: number;
  ecc?: EccLevel;
  mask?: number;
  compression?: number;
  format?: FormatBits;
  payload?: Payload;
  segments?: Segment[];
  /** Concatenated human-readable content of the payload. */
  text?: string;
  /** Raw payload bytes (after inflation, before segment parsing). */
  bytes?: Uint8Array;
  stats?: DecodeStats;
  /** The payload contains at least one SECURE envelope. */
  encrypted?: boolean;
  /** An envelope was opened with a supplied key and its segments are inlined. */
  secureUnlocked?: boolean;
  /** Metadata of the first envelope, readable without any key. */
  secureInfo?: SecureEnvelopeInfo;
}

/** Describe an envelope using only what is printed in the symbol. */
export function describeSecure(seg: SecureSegment): SecureEnvelopeInfo {
  return {
    suite: seg.suite,
    keyId: hexEncode(seg.keyId),
    iterations: seg.iterations,
    salt: hexEncode(seg.salt),
    plaintextBytes: Math.max(0, seg.ciphertext.length - 16),
  };
}

/**
 * Replace every SECURE envelope that a supplied key opens with its plaintext
 * segments. Envelopes that stay closed are left in place -- they remain part of
 * the payload, still unreadable, exactly as they were printed.
 */
function openEnvelopes(payload: Payload, opt?: SecureDecodeOptions): { payload: Payload; unlocked: boolean } {
  let sawEnvelope = false;
  let unlocked = false;
  const out: Segment[] = [];
  for (const seg of payload.segments) {
    if (seg.kind !== 'secure') {
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

/**
 * Decode with a known format. Returns null when the codeword is beyond
 * correction, so the caller can try the next candidate.
 */
export function decodeWithFormat(input: DecodeInput, format: FormatBits, opt: DecodeOptions = {}): DecodeResult | null {
  const version = format.versionIndex + 1;
  const ecc = ECC_LEVELS[format.ecc] as EccLevel;
  const plan: BlockPlan = planBlocks(version, ecc);
  const lat = getLattice(version);
  const N = lat.N;
  if (input.dataBits.length < N) return null;

  const threshold = opt.erasureThreshold ?? 0.28;

  // ---- un-mask + invert the scattering stride ------------------------------
  const mask = maskArray(version, format.mask);
  const serpentine = lat.serpentine;
  const bitCount = plan.codewords * 8;
  const stream = new Uint8Array(plan.codewords);

  /*
   * Read the disc back along the serpentine spiral: path position i lives in
   * cell serpentine[i], so bit i of the codeword stream is cell
   * serpentine[i]'s printed value de-masked.
   */
  const cellToSymbol = new Int32Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    const j = serpentine[i] as number;
    const raw = ((input.dataBits[j] as number) & 1) ^ (mask[j] as number);
    if (i >= bitCount) continue; // remainder cells carry no codeword bit
    if (raw) stream[i >> 3] = (stream[i >> 3] as number) | (1 << (7 - (i & 7)));
    cellToSymbol[j] = i >> 3;
  }

  /*
   * Erasure budget, per block.
   *
   * Declaring an erasure is only useful while the code can still pay for it: a
   * block with nu erasures and e further errors needs nu + 2e <= nK parity
   * symbols. If the sampler is unsure about half the disc, marking all of it
   * unknown blows straight through that budget and turns a recoverable symbol
   * into an unrecoverable one.
   *
   * The budget is therefore kept *per block*, not globally: a hole punched in
   * one part of the disc must not spend the redundancy of a block that is
   * physically untouched. Within a block we spend it on the least confident
   * symbols first, so the cells most likely to be wrong are the ones bought out
   * of the error budget and into the (twice as cheap) erasure budget.
   * Explicitly listed erasures are always honoured first.
   */
  const layout = interleavedLayout(plan.blockData, plan.blockParity);
  const frac = opt.maxErasureFraction ?? 0.85;
  const blockBudget = plan.blockParity.map((nk) => Math.max(0, Math.floor(nk * frac)));
  const blockErasedCount = new Int32Array(plan.blockData.length);
  const erasedSymbol = new Uint8Array(plan.codewords);
  let erasedSymbols = 0;
  let erasureCells = 0;
  let budgetBlocked = 0;
  /**
   * Buy one codeword out of the error budget and into the erasure budget.
   *
   * The unit of cost is the *symbol*, not the module: a Reed-Solomon erasure is a
   * position in the codeword, so one damaged module and eight damaged modules cost
   * exactly the same one parity symbol. That has a consequence for how a scarce
   * budget should be spent -- a symbol with eight flagged modules is almost
   * certainly damaged, while a symbol with a single flagged module is more likely
   * a false positive of the damage detector. Ranking symbols by how much evidence
   * they carry, rather than ranking modules by confidence, spends the budget where
   * it actually buys correction.
   */
  const claimSymbol = (sym: number): boolean => {
    if (sym < 0) return false;
    if (erasedSymbol[sym]) return true;
    const b = layout[sym]?.block ?? -1;
    if (b >= 0 && (blockErasedCount[b] as number) >= (blockBudget[b] as number)) {
      budgetBlocked++;
      return false;
    }
    erasedSymbol[sym] = 1;
    if (b >= 0) blockErasedCount[b] = (blockErasedCount[b] as number) + 1;
    erasedSymbols++;
    return true;
  };
  const claim = (j: number): boolean => {
    const sym = cellToSymbol[j] as number;
    if (sym < 0) return false;
    const had = erasedSymbol[sym] === 1;
    if (!claimSymbol(sym)) return false;
    if (!had || true) erasureCells++;
    return true;
  };

  if (input.erasures) {
    for (let k = 0; k < input.erasures.length; k++) {
      const j = input.erasures[k] as number;
      if (j >= 0 && j < N) claim(j);
    }
  }
  if (input.confidence) {
    const weak: number[] = [];
    for (let j = 0; j < N; j++) {
      if ((input.confidence[j] as number) < threshold && (cellToSymbol[j] as number) >= 0) weak.push(j);
    }
    if (weak.length > 0) {
      const conf = input.confidence;
      // Accumulate the evidence per codeword, then spend the budget on the
      // codewords that carry the most of it.
      const hits = new Int32Array(plan.codewords);
      const worst = new Float32Array(plan.codewords).fill(2);
      for (const j of weak) {
        const sym = cellToSymbol[j] as number;
        if (sym < 0) continue;
        hits[sym] = (hits[sym] as number) + 1;
        const c = conf[j] as number;
        if (c < (worst[sym] as number)) worst[sym] = c;
      }
      const order: number[] = [];
      for (let sym = 0; sym < plan.codewords; sym++) if ((hits[sym] as number) > 0) order.push(sym);
      order.sort((a, b) => {
        const d = (hits[b] as number) - (hits[a] as number);
        if (d !== 0) return d;
        return (worst[a] as number) - (worst[b] as number);
      });
      let refusals = 0;
      for (const sym of order) {
        if (erasedSymbol[sym]) continue;
        if (claimSymbol(sym)) {
          erasureCells += hits[sym] as number;
          refusals = 0;
          continue;
        }
        // A refusal is per block: one saturated block must not stop the others
        // from buying out their own damage.
        refusals++;
        if (refusals > order.length) break;
        let anyRoom = false;
        for (let b = 0; b < blockBudget.length; b++) {
          if ((blockErasedCount[b] as number) < (blockBudget[b] as number)) {
            anyRoom = true;
            break;
          }
        }
        if (!anyRoom) break;
      }
    }
  }

  // ---- de-interleave with erasure positions --------------------------------
  const blockErasures: number[][] = plan.blockData.map(() => []);
  for (let s = 0; s < layout.length; s++) {
    if (erasedSymbol[s]) {
      const l = layout[s]!;
      blockErasures[l.block]!.push(l.index);
    }
  }
  const { dataBlocks, parityBlocks } = deinterleave(stream, plan.blockData, plan.blockParity);

  let errorsFixed = 0;
  let erasuresFixed = 0;
  let blocksFailed = 0;
  const fixedData: Uint8Array[] = [];
  for (let b = 0; b < plan.blocks; b++) {
    const cw = new Uint8Array((dataBlocks[b] as Uint8Array).length + (parityBlocks[b] as Uint8Array).length);
    cw.set(dataBlocks[b] as Uint8Array, 0);
    cw.set(parityBlocks[b] as Uint8Array, (dataBlocks[b] as Uint8Array).length);
    const res = rsDecode(cw, plan.blockParity[b] as number, blockErasures[b] as number[]);
    if (!res.ok) {
      blocksFailed++;
      continue;
    }
    errorsFixed += res.errorsFixed;
    erasuresFixed += res.erasuresFixed;
    fixedData.push(res.corrected.slice(0, (dataBlocks[b] as Uint8Array).length));
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
        crcOk: false,
      },
    };
  }

  // ---- reassemble data codewords ------------------------------------------
  const dataCodewords = new Uint8Array(plan.dataCodewords);
  let off = 0;
  for (const blk of fixedData) {
    dataCodewords.set(blk, off);
    off += blk.length;
  }
  const payloadBytes = dataCodewords.slice(0, plan.payloadBytes);
  const crcExpected =
    (((dataCodewords[plan.payloadBytes] as number) << 24) |
      ((dataCodewords[plan.payloadBytes + 1] as number) << 16) |
      ((dataCodewords[plan.payloadBytes + 2] as number) << 8) |
      (dataCodewords[plan.payloadBytes + 3] as number)) >>>
    0;
  const crcActual = crc32(payloadBytes);
  const crcOk = crcExpected === crcActual;
  if (!crcOk) {
    return {
      ok: false,
      error: 'CRC-32 mismatch after Reed-Solomon (wrong format candidate, or damage beyond correction)',
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
        crcOk: false,
      },
    };
  }

  const stats: DecodeStats = {
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
    codewords: dataCodewords,
  };

  // ---- inflate + parse ----------------------------------------------------
  let core: Uint8Array = payloadBytes;
  if (format.compression === 1) {
    const inflate = opt.decompress ?? ((raw: Uint8Array) => inflateRaw(raw));
    if (!inflate) {
      return {
        ok: false,
        error: 'payload is compressed but no decompressor was supplied',
        version,
        ecc,
        mask: format.mask,
        compression: 1,
        format,
        stats,
      };
    }
    try {
      core = inflate(payloadBytes);
    } catch (e) {
      return { ok: false, error: `inflate failed: ${(e as Error).message}`, version, ecc, mask: format.mask, compression: 1, format, stats };
    }
  }

  let payload: Payload;
  try {
    payload = decodePayloadBytes(core);
  } catch (e) {
    return { ok: false, error: `segment parse failed: ${(e as Error).message}`, version, ecc, mask: format.mask, compression: format.compression, format, stats, bytes: core };
  }

  const firstEnvelope = payload.segments.find((s): s is SecureSegment => s.kind === 'secure');
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
    ...(firstEnvelope
      ? { encrypted: true, secureUnlocked: opened.unlocked, secureInfo: describeSecure(firstEnvelope) }
      : {}),
  };
}

/**
 * Full decode: read the Format Crown when it is intact, otherwise brute-force
 * the (version x ecc x mask x compression) space and accept the first candidate
 * whose payload CRC-32 verifies.
 */
export function decode(input: DecodeInput, opt: DecodeOptions = {}): DecodeResult {
  let lastCrownError = '';
  let format: FormatBits | null = input.format ?? null;
  const explicit = !!input.format;
  let crownOk = false;
  let crownDistance = 0;

  if (!format && input.beads) {
    const res = decodeFormatCrown(input.beads);
    crownDistance = res.distance;
    if (res.ok && res.format) {
      format = res.format;
      crownOk = true;
    }
  }

  let crownStats: DecodeStats | undefined;
  const considerCrown = (st?: DecodeStats): void => {
    if (st) crownStats = st;
  };

  if (format) {
    const r = decodeWithFormat(input, format, opt);
    if (r?.ok) {
      if (r.stats) {
        r.stats.crownOk = crownOk;
        r.stats.crownDistance = crownDistance;
      }
      return r;
    }
    considerCrown(r?.stats);
    // An explicitly supplied format is authoritative: report its failure.
    if (explicit) {
      return { ok: false, error: r?.error ?? 'decode failed', format, stats: r?.stats };
    }
    // Otherwise the Crown may itself have been misread -- fall through and
    // brute-force the format space, using the payload CRC-32 as the oracle.
    if (r?.error) lastCrownError = r.error;
  }

  // ---- brute force ---------------------------------------------------------
  const lastCrownError2 = lastCrownError;
  const versions = opt.candidateVersions ?? guessVersions(input, opt);
  const candidates = formatCandidates(versions);
  const limit = opt.maxCandidates && opt.maxCandidates > 0 ? Math.min(candidates.length, opt.maxCandidates) : candidates.length;
  let lastError = 'no candidate format produced a CRC-valid payload';
  /*
   * Keep the most informative failure. Every candidate reports how far it got,
   * and the one that erased the most symbols while failing the fewest blocks is
   * the one that tells the caller what actually happened -- "zero erasures, all
   * blocks failed" and "17 erasures, CRC mismatch" are very different diagnoses
   * even though both are failures.
   */
  let bestStats: DecodeStats | undefined;
  const rank = (st: DecodeStats): number => st.erasureSymbols * 100 - st.blocksFailed * 10000;
  const consider = (st?: DecodeStats): void => {
    if (!st) return;
    if (!bestStats || rank(st) > rank(bestStats)) bestStats = st;
  };
  for (let i = 0; i < limit; i++) {
    const c = candidates[i]!;
    opt.onCandidate?.(c);
    const f: FormatBits = { versionIndex: c.version - 1, ecc: ECC_LEVELS.indexOf(c.ecc), mask: c.mask, compression: c.compression };
    const r = decodeWithFormat(input, f, opt);
    if (r && r.ok) {
      if (r.stats) {
        r.stats.crownOk = false;
        r.stats.crownDistance = crownDistance;
        r.stats.candidatesTried = i + 1;
      }
      return r;
    }
    if (r?.error) lastError = r.error;
    consider(r?.stats);
  }
  const fallback: DecodeStats = {
    crownOk,
    crownDistance,
    candidatesTried: limit,
    errorsFixed: 0,
    erasuresFixed: 0,
    erasureCells: 0,
    erasureSymbols: 0,
    erasureBudget: 0,
    erasureBudgetBlocked: 0,
    blocksFailed: 0,
    crcOk: false,
  };
  const best = bestStats ?? crownStats;
  return {
    ok: false,
    error: lastCrownError2 ? `${lastError} (crown attempt: ${lastCrownError2})` : lastError,
    stats: best ? { ...best, crownOk, crownDistance, candidatesTried: limit } : fallback,
  };
}

/**
 * When the Crown is gone the version can still be recovered from geometry: the
 * caller passes the number of lattice rings it counted. Absent that, try every
 * version whose cell count matches the sampled bit array.
 */
function guessVersions(input: DecodeInput, opt: DecodeOptions): number[] {
  if (opt.candidateVersions && opt.candidateVersions.length) return opt.candidateVersions;
  const n = input.dataBits.length;
  const out: number[] = [];
  for (let v = 1; v <= 40; v++) {
    if (getLattice(v).N <= n) out.push(v);
  }
  // closest sizes first
  out.sort((a, b) => Math.abs(getLattice(a).N - n) - Math.abs(getLattice(b).N - n));
  return out.slice(0, 6);
}

