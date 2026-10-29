/**
 * SVG renderer -- print/vector output.
 *
 * The SVG is authored in module-pitch units inside a viewBox, so it scales to
 * any physical size without resampling: the same file can drive a 12 mm label
 * or a 3 m wall graphic. Shapes are emitted as reusable <symbol> instances
 * (<use>) to keep the file small at high versions.
 */
import { ANGLE_TRACK, BEADS, TEETH, TOOTH_DEG } from '../geometry.js';
import type { ModuleShape, SymbolModel } from '../model.js';
import { resolveTheme, themeContrast, type SmcTheme } from './theme.js';

export interface SvgOptions {
  shape?: ModuleShape;
  /** Pixels (or mm/pt/in -- whatever unit you set) per module pitch. */
  scale?: number;
  unit?: 'px' | 'mm' | 'pt' | 'in';
  /** Module ink colour. Overrides the theme. */
  dark?: string;
  /** Substrate colour. Overrides the theme. */
  light?: string;
  /**
   * A built-in palette ('lapis', 'turquoise', 'saffron', ...) or an inline
   * theme. Colour never touches the geometry, so any theme stays scannable as
   * long as its contrast ratio does; see `themeContrast`.
   */
  theme?: string | SmcTheme;
  /** Paint the Format Crown in a second ink. Defaults to the theme's crown. */
  crownColour?: string;
  /** Draw the quiet zone as an explicit light square. Default true. */
  quietZone?: boolean;
  quiet?: number;
  /** Print a human-readable caption under the symbol. */
  caption?: string | null;
  captionHeight?: number;
  /** Embed an XML comment with the full format record. Default true. */
  metadata?: boolean;
  /** Round coordinates to this many decimals. */
  precision?: number;
  cellGap?: number;
  /** Draw a red overlay of the Crown's measurement radii (debug/teaching). */
  showGeometry?: boolean;
}

const fmt = (n: number, p: number) => {
  const s = n.toFixed(p);
  return s.replace(/\.?0+$/, '') || '0';
};

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r * Math.cos(a), -r * Math.sin(a)]; // SVG y grows downwards
}

function annularSector(rIn: number, rOut: number, a0: number, a1: number, p: number): string {
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const [x0, y0] = polar(rOut, a0);
  const [x1, y1] = polar(rOut, a1);
  const [x2, y2] = polar(rIn, a1);
  const [x3, y3] = polar(rIn, a0);
  // SVG angles run clockwise on screen because y is flipped: sweep = 1
  return [
    `M${fmt(x0, p)},${fmt(y0, p)}`,
    `A${fmt(rOut, p)},${fmt(rOut, p)} 0 ${large} 0 ${fmt(x1, p)},${fmt(y1, p)}`,
    `L${fmt(x2, p)},${fmt(y2, p)}`,
    `A${fmt(rIn, p)},${fmt(rIn, p)} 0 ${large} 1 ${fmt(x3, p)},${fmt(y3, p)}`,
    'Z',
  ].join('');
}

function polygonPath(cx: number, cy: number, r: number, sides: number, rotDeg: number, p: number): string {
  let d = '';
  for (let i = 0; i < sides; i++) {
    const a = ((rotDeg + (360 * i) / sides) * Math.PI) / 180;
    const x = cx + r * Math.cos(a);
    const y = cy - r * Math.sin(a);
    d += (i === 0 ? 'M' : 'L') + fmt(x, p) + ',' + fmt(y, p);
  }
  return d + 'Z';
}

export function renderSVG(m: SymbolModel, opt: SvgOptions = {}): string {
  const p = opt.precision ?? 3;
  const shape = opt.shape ?? 'dot';
  const theme = resolveTheme(opt.theme);
  const dark = opt.dark ?? theme.ink;
  const crownInk = opt.crownColour ?? (opt.dark !== undefined ? opt.dark : theme.crown);
  const light = opt.light ?? theme.paper;
  const quietZone = opt.quietZone !== false;
  const quiet = opt.quiet ?? (quietZone ? m.crown.quietZone : 0);
  const gap = opt.cellGap ?? (shape === 'dot' ? 1 : 0.94);
  const g = m.crown;
  const caption = opt.caption ?? null;
  const captionH = caption ? (opt.captionHeight ?? 4) : 0;

  const half = m.outerRadius + quiet;
  const w = 2 * half;
  const h = 2 * half + captionH;
  const unit = opt.unit ?? 'px';
  const scale = opt.scale ?? 1;
  const physW = fmt(w * scale, 2);
  const physH = fmt(h * scale, 2);

  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${physW}${unit}" height="${physH}${unit}" viewBox="${fmt(-half, p)} ${fmt(-half, p)} ${fmt(w, p)} ${fmt(h, p)}" shape-rendering="geometricPrecision">`,
  );
  if (opt.metadata !== false) {
    const meta = m.meta;
    out.push('<!--');
    const tc = themeContrast({ ...theme, ink: dark, crown: crownInk, paper: light });
    out.push(`  SiMurgh Code (SMC)  spec 1.1`);
    out.push(`  theme ${theme.id}  ink ${dark}  crown ${crownInk}  paper ${light}  contrast ${tc.worst.toFixed(2)}:1 (${tc.verdict})`);
    out.push(`  version ${m.version}  K=${m.K}  ECC ${meta.ecc}  mask ${meta.mask}  compression ${meta.compression}`);
    out.push(`  cells ${meta.cells}  codewords ${meta.codewords} (${meta.dataCodewords} data + ${meta.parityCodewords} parity) in ${meta.blocks} RS blocks`);
    out.push(`  payload ${meta.payloadBytes} bytes  ink coverage ${(meta.inkCoverage * 100).toFixed(1)}%`);
    out.push(`  format bits 0b${meta.formatBits.toString(2).padStart(12, '0')}  Golay(24,12) word 0x${meta.formatWord.toString(16).toUpperCase().padStart(6, '0')}`);
    out.push(`  geometry: halo ${fmt(g.haloInner, 2)}-${fmt(g.haloOuter, 2)}, beads ${fmt(g.beadRadius, 2)}, teeth ${fmt(g.teethInner, 2)}-${fmt(g.teethOuter, 2)}, limbus ${fmt(g.limbusInner, 2)}-${fmt(g.limbusOuter, 2)}, quiet ${fmt(quiet, 2)}`);
    out.push('-->');
  }
  out.push(`<rect x="${fmt(-half, p)}" y="${fmt(-half, p)}" width="${fmt(w, p)}" height="${fmt(h, p)}" fill="${light}"/>`);

  // --- Crown: Limbus + Halo ------------------------------------------------
  const ring = (rIn: number, rOut: number) => {
    const rr = (rIn + rOut) / 2;
    return `<circle cx="0" cy="0" r="${fmt(rr, p)}" fill="none" stroke="${crownInk}" stroke-width="${fmt(rOut - rIn, p)}"/>`;
  };
  out.push(ring(g.limbusInner, g.limbusOuter));
  out.push(ring(g.haloInner, g.haloOuter));

  // --- Crown: Angle Track (teeth) + Beak -----------------------------------
  {
    const halfTooth = TOOTH_DEG / 2;
    const teethPaths: string[] = [];
    for (let i = 0; i < TEETH; i++) {
      if ((ANGLE_TRACK[i] as number) !== 1) continue;
      const c = i * TOOTH_DEG;
      const rOut = i === 0 ? g.beakRadius : g.teethOuter;
      teethPaths.push(annularSector(g.teethInner, rOut, c - halfTooth, c + halfTooth, p));
    }
    out.push(`<path d="${teethPaths.join(' ')}" fill="${crownInk}"/>`);
    void halfTooth;
  }

  // --- Crown: Format beads -------------------------------------------------
  {
    const bd = 360 / BEADS;
    const beads: string[] = [];
    for (let i = 0; i < BEADS; i++) {
      if ((m.beads[i] as number) !== 1) continue;
      const [x, y] = polar(g.beadRadius, i * bd + bd / 2);
      beads.push(`M${fmt(x - g.beadSize, p)},${fmt(y, p)}a${fmt(g.beadSize, p)},${fmt(g.beadSize, p)} 0 1,0 ${fmt(2 * g.beadSize, p)},0a${fmt(g.beadSize, p)},${fmt(g.beadSize, p)} 0 1,0 ${fmt(-2 * g.beadSize, p)},0`);
    }
    out.push(`<path d="${beads.join('')}" fill="${crownInk}"/>`);
  }

  // --- Modules -------------------------------------------------------------
  const dotR = 0.46 * gap;
  const hexR = (1 / Math.sqrt(3)) * gap;
  const sqH = 0.5 * gap;
  if (shape === 'dot') {
    out.push(`<defs><circle id="smc-d" r="${fmt(dotR, p)}"/></defs>`);
  } else if (shape === 'hex') {
    out.push(`<defs><path id="smc-d" d="${polygonPath(0, 0, hexR, 6, 30, p)}"/></defs>`);
  } else {
    out.push(`<defs><rect id="smc-d" x="${fmt(-sqH, p)}" y="${fmt(-sqH, p)}" width="${fmt(2 * sqH, p)}" height="${fmt(2 * sqH, p)}"/></defs>`);
  }

  const parts: string[] = [];
  for (const c of m.core) {
    if (!c.dark) continue;
    parts.push(`<use href="#smc-d" x="${fmt(c.x, p)}" y="${fmt(-c.y, p)}"/>`);
  }
  for (let i = 0; i < m.cellCount; i++) {
    if ((m.cellDark[i] as number) !== 1) continue;
    parts.push(`<use href="#smc-d" x="${fmt(m.cellX[i] as number, p)}" y="${fmt(-(m.cellY[i] as number), p)}"/>`);
  }
  out.push(`<g fill="${dark}">${parts.join('')}</g>`);

  // --- optional geometry overlay ------------------------------------------
  if (opt.showGeometry) {
    const rs = [g.haloRadius, g.beadRadius, g.teethRadius, g.limbusRadius];
    const circles = rs
      .map((r) => `<circle cx="0" cy="0" r="${fmt(r, p)}" fill="none" stroke="#e11" stroke-width="0.06" stroke-dasharray="0.3 0.3"/>`)
      .join('');
    const axes = `<path d="M${fmt(-m.outerRadius, p)},0H${fmt(m.outerRadius, p)}M0,${fmt(-m.outerRadius, p)}V${fmt(m.outerRadius, p)}" stroke="#06c" stroke-width="0.06" stroke-dasharray="0.3 0.3"/>`;
    out.push(`<g opacity="0.8">${circles}${axes}</g>`);
  }

  if (caption) {
    const y = half + captionH * 0.72;
    const safe = caption.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    out.push(
      `<text x="0" y="${fmt(y, p)}" text-anchor="middle" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="${fmt(captionH * 0.6, p)}" fill="${theme.caption ?? dark}" direction="auto">${safe}</text>`,
    );
  }

  out.push('</svg>');
  return out.join('\n');
}
