/**
 * Reed-Solomon block plan + interleaving.
 *
 * The payload of a SiMurgh Code is one long codeword stream that is cut into B
 * independent RS blocks. Blocks are then *interleaved* symbol-wise before the
 * Scattering Stride permutation writes them onto the disc. Two independent
 * mechanisms therefore stand between a physical defect and a dead block:
 *
 *   1. interleaving   -- symbol j of every block is printed next to symbol j of
 *                        every other block;
 *   2. the stride     -- consecutive symbols are placed on an arithmetic
 *                        progression across the whole disc.
 *
 * Together they turn any localised damage into a small number of erasures in
 * every block, which is exactly the regime where Reed-Solomon is strongest
 * (an erasure costs half as much redundancy as an error).
 */
import { ECC_PARITY_FRACTION, getLattice, type EccLevel } from './geometry.js';

export interface BlockPlan {
  version: number;
  ecc: EccLevel;
  /** Data cells available on the disc. */
  cells: number;
  /** Total codewords that fit: floor(cells / 8). */
  codewords: number;
  /** Cells that carry no codeword bit (0..7). Filled by the mask only. */
  remainderBits: number;
  /** Data codewords (payload + CRC). */
  dataCodewords: number;
  /** Parity codewords. */
  parityCodewords: number;
  /** Number of RS blocks. */
  blocks: number;
  /** Data symbols per block. */
  blockData: number[];
  /** Parity symbols per block. */
  blockParity: number[];
  /** Bytes available for the segment stream: dataCodewords - 4 (CRC-32). */
  payloadBytes: number;
  /** Payload bits. */
  payloadBits: number;
}

const TARGET_BLOCK_LENGTH = 192;

export function planBlocks(version: number, ecc: EccLevel): BlockPlan {
  const lat = getLattice(version);
  const cells = lat.N;
  const codewords = Math.floor(cells / 8);
  const remainderBits = cells - codewords * 8;
  const rho = ECC_PARITY_FRACTION[ecc];
  let parity = Math.round(codewords * rho);
  parity = Math.max(2, Math.min(codewords - 5, parity));
  const data = codewords - parity;

  let blocks = Math.max(1, Math.ceil(codewords / TARGET_BLOCK_LENGTH));
  // Every block needs at least 2 parity symbols to correct anything.
  while (blocks > 1 && Math.floor(parity / blocks) < 2) blocks--;
  // RS over GF(256) caps the block length at 255 symbols.
  while (Math.ceil(codewords / blocks) > 255) blocks++;

  const dPer = Math.floor(data / blocks);
  const dExtra = data - dPer * blocks;
  const pPer = Math.floor(parity / blocks);
  const pExtra = parity - pPer * blocks;

  const blockData: number[] = [];
  const blockParity: number[] = [];
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
    payloadBits: (data - 4) * 8,
  };
}

/** Interleave block data symbols, then block parity symbols, into one stream. */
export function interleave(dataBlocks: Uint8Array[], parityBlocks: Uint8Array[]): Uint8Array {
  const totalData = dataBlocks.reduce((a, b) => a + b.length, 0);
  const totalParity = parityBlocks.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(totalData + totalParity);
  let p = 0;
  const maxData = Math.max(0, ...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) {
      if (i < b.length) out[p++] = b[i] as number;
    }
  }
  const maxParity = Math.max(0, ...parityBlocks.map((b) => b.length));
  for (let i = 0; i < maxParity; i++) {
    for (const b of parityBlocks) {
      if (i < b.length) out[p++] = b[i] as number;
    }
  }
  return out;
}

/** Inverse of {@link interleave}. */
export function deinterleave(stream: Uint8Array, blockData: number[], blockParity: number[]): {
  dataBlocks: Uint8Array[];
  parityBlocks: Uint8Array[];
} {
  const B = blockData.length;
  const dataBlocks = blockData.map((n) => new Uint8Array(n));
  const parityBlocks = blockParity.map((n) => new Uint8Array(n));
  let p = 0;
  const maxData = Math.max(0, ...blockData);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < B; b++) {
      if (i < (blockData[b] as number)) (dataBlocks[b] as Uint8Array)[i] = stream[p++] as number;
    }
  }
  const maxParity = Math.max(0, ...blockParity);
  for (let i = 0; i < maxParity; i++) {
    for (let b = 0; b < B; b++) {
      if (i < (blockParity[b] as number)) (parityBlocks[b] as Uint8Array)[i] = stream[p++] as number;
    }
  }
  return { dataBlocks, parityBlocks };
}

/** Capacity report for documentation / CLI `--table`. */
export interface CapacityRow {
  version: number;
  modules: number;
  diameter: number;
  cells: number;
  perEcc: Record<EccLevel, { payloadBytes: number; blocks: number; parityPerBlock: number }>;
}

export function capacityTable(): CapacityRow[] {
  const out: CapacityRow[] = [];
  for (let v = 1; v <= 40; v++) {
    const lat = getLattice(v);
    const perEcc = {} as CapacityRow['perEcc'];
    for (const ecc of ['L', 'M', 'Q', 'H'] as EccLevel[]) {
      const p = planBlocks(v, ecc);
      perEcc[ecc] = { payloadBytes: p.payloadBytes, blocks: p.blocks, parityPerBlock: Math.round(p.parityCodewords / p.blocks) };
    }
    out.push({
      version: v,
      modules: 2 * lat.K + 10,
      diameter: 2 * (lat.K + 5),
      cells: lat.N,
      perEcc,
    });
  }
  return out;
}

/**
 * Explicit interleaving layout: for each position of the interleaved stream,
 * which block and which symbol index inside that block it came from.
 * Shared by the encoder, the decoder and the erasure mapper so the three can
 * never disagree.
 */
export function interleavedLayout(blockData: number[], blockParity: number[]): { block: number; index: number }[] {
  const B = blockData.length;
  const out: { block: number; index: number }[] = [];
  const maxData = Math.max(0, ...blockData);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < B; b++) if (i < (blockData[b] as number)) out.push({ block: b, index: i });
  }
  const maxParity = Math.max(0, ...blockParity);
  for (let i = 0; i < maxParity; i++) {
    for (let b = 0; b < B; b++) {
      if (i < (blockParity[b] as number)) out.push({ block: b, index: (blockData[b] as number) + i });
    }
  }
  return out;
}
