/**
 * The printable symbol model: a complete, resolution-independent description
 * of everything that gets inked. Renderers (SVG, raster, ASCII, laser, gerber,
 * ...) consume this and nothing else, so they can never disagree with the
 * encoder.
 *
 * All coordinates are in *module pitch* units with the origin at the disc
 * centre, +x right and +y up (mathematical orientation). Raster renderers flip
 * y themselves.
 */
import { ANGLE_TRACK, BEADS, CELL_CIRCUMRADIUS, TEETH, TOOTH_DEG, crown, getLattice, type CrownGeometry } from './geometry.js';
import type { EncodedSymbol } from './encoder.js';

export type ModuleShape = 'dot' | 'hex' | 'square';

export interface SymbolModel {
  version: number;
  K: number;
  crown: CrownGeometry;
  /** Fixed Core rosette: 19 cells. */
  core: { x: number; y: number; dark: boolean }[];
  /** Data field cell centres and printed values. */
  cellX: Float64Array;
  cellY: Float64Array;
  cellDark: Uint8Array;
  cellCount: number;
  /** Angle Track, 63 teeth, MSB-first around the circle from 0 deg. */
  teeth: Uint8Array;
  /** Format Crown, 24 beads. */
  beads: Uint8Array;
  /** Ink radius (outer edge of the Limbus). */
  outerRadius: number;
  /** Canvas half-size including the quiet zone. */
  canvasRadius: number;
  meta: SymbolMeta;
}

export interface SymbolMeta {
  ecc: string;
  mask: number;
  compression: 0 | 1;
  formatBits: number;
  formatWord: number;
  cells: number;
  codewords: number;
  dataCodewords: number;
  parityCodewords: number;
  blocks: number;
  payloadBytes: number;
  inkCoverage: number;
  textPreview: string;
}

export function toModel(sym: EncodedSymbol, textPreview = ''): SymbolModel {
  const lat = getLattice(sym.version);
  const g = crown(lat.K);
  const core: { x: number; y: number; dark: boolean }[] = [];
  {
    // centre
    core.push({ x: 0, y: 0, dark: true });
    // ring 1 light, ring 2 dark: a hexagonal bullseye
    const push = (d: number, count: number, dark: boolean) => {
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
    cellX[i] = lat.xy[2 * i] as number;
    cellY[i] = lat.xy[2 * i + 1] as number;
  }
  return {
    version: sym.version,
    K: lat.K,
    crown: g,
    core,
    cellX,
    cellY,
    cellDark: sym.dataBits.slice(),
    cellCount: lat.N,
    teeth: sym.teeth.slice(),
    beads: sym.beads.slice(),
    outerRadius: g.outerRadius,
    canvasRadius: g.canvasRadius,
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
      textPreview,
    },
  };
}

/** Cell centre of ring `d`, index `j` (same enumeration as the lattice). */
export function ringCellXY(d: number, j: number): { x: number; y: number } {
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
  return { x: q + r / 2, y: (Math.sqrt(3) / 2) * r };
}

/** Angle (degrees) of tooth `i`'s leading and trailing edge. */
export function toothSpan(i: number): { from: number; to: number; centre: number } {
  const c = (((i % TEETH) + TEETH) % TEETH) * TOOTH_DEG;
  return { from: c - TOOTH_DEG / 2, to: c + TOOTH_DEG / 2, centre: c };
}

/** Angle (degrees) of bead `i`. */
export function beadAngleDeg(i: number): number {
  return (((i % BEADS) + BEADS) % BEADS) * (360 / BEADS) + 360 / BEADS / 2;
}

