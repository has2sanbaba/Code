/**
 * Terminal renderer. Samples the same signed-distance field as the rasteriser
 * so what you see in the shell is geometrically identical to what gets printed.
 */
import { inkDistance, type RasterOptions } from './raster.js';
import type { ModuleShape, SymbolModel } from '../model.js';

export interface AsciiOptions {
  shape?: ModuleShape;
  /** Characters per module pitch horizontally. Default 1. */
  columnsPerModule?: number;
  /** Use half-block shading for anti-aliasing. Default true. */
  shade?: boolean;
  cellGap?: number;
  quiet?: number;
}

const RAMP = ' .:-=+*#%@';

export function renderAscii(m: SymbolModel, opt: AsciiOptions = {}): string {
  const cpm = opt.columnsPerModule ?? 1;
  const shade = opt.shade !== false;
  const shape = (opt.shape ?? 'dot') as ModuleShape;
  const gap = opt.cellGap ?? (shape === 'dot' ? 1 : 0.94);
  const quiet = opt.quiet ?? m.crown.quietZone;
  const half = m.outerRadius + quiet;
  // terminal glyphs are about twice as tall as wide
  const cols = Math.ceil(half * 2 * cpm);
  const rows = Math.ceil((half * 2 * cpm) / 2);
  const lines: string[] = [];
  for (let ry = 0; ry < rows; ry++) {
    let line = '';
    for (let rx = 0; rx < cols; rx++) {
      const x = (rx + 0.5) / cpm - half;
      const y = half - (ry + 0.5) / cpm;
      const d = inkDistance(m, x, y, shape, gap);
      const cov = Math.min(1, Math.max(0, 0.5 - d));
      if (!shade) line += cov >= 0.5 ? '██' : '  ';
      else {
        const idx = Math.round(cov * (RAMP.length - 1));
        const ch = RAMP[idx] as string;
        line += ch + ch;
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export type { RasterOptions };
