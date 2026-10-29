/**
 * Minimal PNG codec -- enough of ISO/IEC 15948 to write SiMurgh symbols and to
 * read back anything a scanner, a phone or an image editor produces.
 *
 * Writing needs only greyscale. *Reading* does not get that luxury: a real
 * workflow hands us 24-bit colour, 32-bit RGBA, palette images with
 * transparency, 16-bit depth and 1-bit fax scans, all of which are legal PNG.
 * A decoder that only understood its own encoder's output would be a demo, so
 * every colour type and bit depth in the specification is handled here.
 *
 * Compression is delegated to node:zlib, which is part of the runtime; the
 * symbology itself stays dependency-free (its DEFLATE lives in
 * `@simurgh/core` and is used for payloads, not for files).
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface RawImage {
  width: number;
  height: number;
  /** Samples per pixel after expansion: 1 = grey, 2 = grey+alpha, 3 = RGB, 4 = RGBA. */
  channels: 1 | 2 | 3 | 4;
  /** Bits per channel as stored in the file. */
  depth: number;
  /** `channels * height * width` samples, left to right, top to bottom. */
  data: Uint8Array;
}

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG's CRC-32 is the same reflected polynomial the symbology uses for payloads. */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i] as number;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ writer */

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

export interface PngWriteOptions {
  /** 1 = greyscale (default), 3 = RGB, 4 = RGBA. */
  channels?: 1 | 3 | 4;
  /** zlib level 0-9. Default 9: these images are flat-coloured and love it. */
  level?: number;
}

/**
 * Write a PNG. `samples` holds `width * height * channels` bytes for 8-bit
 * output; for greyscale a `GrayImage`-shaped `{width, height, data}` works as is.
 */
export function encodePNG(
  width: number,
  height: number,
  samples: Uint8Array,
  opt: PngWriteOptions = {},
): Uint8Array {
  const channels = opt.channels ?? 1;
  const want = width * height * channels;
  if (samples.length < want) throw new RangeError(`expected ${want} samples, got ${samples.length}`);

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6; // colour type
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline. Filtering would help photographs;
  // a two-level symbol gains almost nothing and None keeps this readable.
  const raw = new Uint8Array(height * (1 + width * channels));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * channels);
    raw[rowStart] = 0;
    raw.set(samples.subarray(y * width * channels, (y + 1) * width * channels), rowStart + 1);
  }

  const idat = deflateSync(raw, { level: opt.level ?? 9 });
  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', Uint8Array.from(idat)), chunk('IEND', new Uint8Array(0))];
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

/* ------------------------------------------------------------------ reader */

export class PngError extends Error {}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode any non-interlaced PNG into 8-bit-per-channel samples. */
export function decodePNG(bytes: Uint8Array): RawImage {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new PngError('not a PNG file (bad signature)');
  }

  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  const idat: Uint8Array[] = [];

  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
    const len = view.getUint32(0);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    const stored = new DataView(bytes.buffer, bytes.byteOffset + pos + 8 + len, 4).getUint32(0);
    const joined = new Uint8Array(4 + len);
    joined.set(bytes.subarray(pos + 4, pos + 8 + len));
    if (crc32(joined) !== stored) throw new PngError(`chunk ${type} failed its CRC`);

    switch (type) {
      case 'IHDR': {
        const v = new DataView(body.buffer, body.byteOffset, body.length);
        width = v.getUint32(0);
        height = v.getUint32(4);
        depth = body[8]!;
        colourType = body[9]!;
        if (body[10] !== 0) throw new PngError('unsupported compression method');
        if (body[11] !== 0) throw new PngError('unsupported filter method');
        interlace = body[12]!;
        if (interlace !== 0) throw new PngError('interlaced (Adam7) PNG is not supported');
        break;
      }
      case 'PLTE':
        palette = body;
        break;
      case 'tRNS':
        transparency = body;
        break;
      case 'IDAT':
        idat.push(body);
        break;
      case 'IEND':
        pos = bytes.length;
        continue;
      default:
        break; // ancillary chunks (gAMA, pHYs, tEXt, ...) are ignored
    }
    pos += 12 + len;
  }

  if (!width || !height) throw new PngError('missing IHDR');
  if (idat.length === 0) throw new PngError('no IDAT chunk');

  const channelCount = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 3 ? 1 : colourType === 4 ? 2 : 4;
  const bpp = Math.max(1, (channelCount * depth) >> 3); // bytes per complete pixel
  const stride = Math.ceil((width * channelCount * depth) / 8);
  const compressed = new Uint8Array(idat.reduce((a, b) => a + b.length, 0));
  {
    let off = 0;
    for (const part of idat) {
      compressed.set(part, off);
      off += part.length;
    }
  }
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(inflateSync(compressed));
  } catch (e) {
    throw new PngError(`IDAT inflate failed: ${(e as Error).message}`);
  }
  if (raw.length < height * (stride + 1)) {
    throw new PngError(`truncated image data: have ${raw.length}, need ${height * (stride + 1)}`);
  }

  // --- reverse the per-scanline filters -------------------------------------
  const unfiltered = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = unfiltered.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const cur = line[x]!;
      const a = x >= bpp ? (out[x - bpp] as number) : 0; // left
      const b = prev[x] as number; // up
      const c = x >= bpp ? (prev[x - bpp] as number) : 0; // up-left
      let v = cur;
      switch (filter) {
        case 0:
          break;
        case 1:
          v = cur + a;
          break;
        case 2:
          v = cur + b;
          break;
        case 3:
          v = cur + ((a + b) >> 1);
          break;
        case 4:
          v = cur + paeth(a, b, c);
          break;
        default:
          throw new PngError(`unknown filter type ${filter} on row ${y}`);
      }
      out[x] = v & 0xff;
    }
    prev = out;
  }

  // --- expand to 8-bit samples per channel ----------------------------------
  const outChannels: 1 | 2 | 3 | 4 = colourType === 3 ? 3 : (channelCount as 1 | 2 | 3 | 4);
  const data = new Uint8Array(width * height * outChannels);
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : depth === 16 ? 1 / 257 : 1;

  const sampleAt = (rowStart: number, index: number): number => {
    if (depth === 8) return unfiltered[rowStart + index] as number;
    if (depth === 16) return unfiltered[rowStart + index * 2] as number; // high byte is enough for 8-bit work
    const perByte = 8 / depth;
    const byte = unfiltered[rowStart + Math.floor(index / perByte)] as number;
    const shift = (perByte - 1 - (index % perByte)) * depth;
    return Math.round(((byte >> shift) & ((1 << depth) - 1)) * scale);
  };

  if (colourType === 3) {
    if (!palette) throw new PngError('palette image without a PLTE chunk');
    for (let p = 0; p < width * height; p++) {
      const idx = sampleAt(Math.floor(p / width) * stride, p % width);
      data[p * 3] = palette[idx * 3] ?? 0;
      data[p * 3 + 1] = palette[idx * 3 + 1] ?? 0;
      data[p * 3 + 2] = palette[idx * 3 + 2] ?? 0;
    }
    // A palette entry can be fully transparent; composite it over substrate so
    // the symbology's "0 = ink, 255 = substrate" convention stays honest.
    if (transparency) {
      for (let p = 0; p < width * height; p++) {
        const idx = sampleAt(Math.floor(p / width) * stride, p % width);
        const alpha = transparency[idx] ?? 255;
        if (alpha !== 255) {
          const t = alpha / 255;
          for (let k = 0; k < 3; k++) data[p * 3 + k] = Math.round((data[p * 3 + k] as number) * t + 255 * (1 - t));
        }
      }
    }
    return { width, height, channels: 3, depth: 8, data };
  }

  for (let p = 0; p < width * height; p++) {
    const rowStart = Math.floor(p / width) * stride;
    const col = p % width;
    for (let k = 0; k < channelCount; k++) data[p * channelCount + k] = sampleAt(rowStart, col * channelCount + k);
  }

  // Alpha is not carried through: the symbology reader wants substrate-vs-ink,
  // and a transparent pixel *is* substrate for any print or screen behind it.
  if (channelCount === 2 || channelCount === 4) {
    const kept = channelCount === 2 ? 1 : 3;
    const flat = new Uint8Array(width * height * kept);
    for (let p = 0; p < width * height; p++) {
      const alpha = data[p * channelCount + channelCount - 1] as number;
      const t = alpha / 255;
      for (let k = 0; k < kept; k++) {
        const v = data[p * channelCount + k] as number;
        flat[p * kept + k] = Math.round(v * t + 255 * (1 - t));
      }
    }
    return { width, height, channels: kept as 1 | 3, depth: 8, data: flat };
  }

  return { width, height, channels: channelCount as 1 | 2 | 3 | 4, depth: 8, data };
}

/** Rec. 709 luminance of any decoded PNG, as the `GrayImage` the pipeline wants. */
export function pngToGray(img: RawImage): { width: number; height: number; data: Uint8Array } {
  if (img.channels === 1) return { width: img.width, height: img.height, data: img.data };
  const out = new Uint8Array(img.width * img.height);
  for (let p = 0; p < out.length; p++) {
    const r = img.data[p * img.channels] as number;
    const g = img.data[p * img.channels + 1] as number;
    const b = img.data[p * img.channels + 2] as number;
    out[p] = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  return { width: img.width, height: img.height, data: out };
}

/** Build RGBA samples from a greyscale image (for the browser-facing path). */
export function grayToRGBA(img: { width: number; height: number; data: Uint8Array }): Uint8Array {
  const out = new Uint8Array(img.width * img.height * 4);
  for (let i = 0; i < img.data.length; i++) {
    const v = img.data[i] as number;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}
