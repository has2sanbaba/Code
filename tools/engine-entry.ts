/**
 * ============================================================================
 *  Engine entry -- the SiMurgh core as a single callable library
 * ============================================================================
 *
 * This file is bundled (tools/build-engine.mjs) into one IIFE that the native
 * Android app loads inside an embedded QuickJS VM. It is *not* a web app: there
 * is no DOM, no window, no network -- just one function,
 *
 *      SimurghEngine.call(requestJson) -> responseJson
 *
 * that the Kotlin side invokes over JNI. Keeping the symbology here, compiled
 * from the very same TypeScript sources the 161 repository tests exercise, means
 * the phone runs bit-identical code to the reference implementation instead of a
 * second, drifting port.
 *
 * The protocol is deliberately one entry point with JSON in both directions:
 * the smallest possible JNI surface, and every field the UI needs is explicit.
 */
import {
  SPEC_DATE,
  SPEC_VERSION,
  SYMBOLOGY_ID,
  SYMBOLOGY_NAME,
  decode,
  encode,
  hexDecode,
  hexEncode,
  inflateRaw,
  toModel,
  type EccLevel,
  type EncodeOptions,
} from '@simurgh/core';
import { THEMES, THEME_IDS, renderRGBA, renderSVG, themeContrast } from '@simurgh/core/render';
import { decodeImage, decodeRGBA } from '@simurgh/core/imaging';

interface Request {
  op: 'encode' | 'decode' | 'themes' | 'spec';
  text?: string;
  url?: string;
  dataHex?: string;
  geo?: { lat: number; lon: number; alt: number; flags: number };
  ecc?: string;
  version?: number;
  mask?: number;
  shape?: 'dot' | 'hex' | 'square';
  theme?: string;
  scale?: number;
  wantSvg?: boolean;
  caption?: string | null;
  secure?: {
    pass?: string;
    keyHex?: string;
    iterations?: number;
    saltHex?: string;
    nonceHex?: string;
    context?: string;
    compress?: boolean;
  };
  grayB64?: string;
  rgbaB64?: string;
  width?: number;
  height?: number;
  pass?: string;
  keyHex?: string;
  context?: string;
  fast?: boolean;
}

function b64ToBytes(b64: string): Uint8Array {
  // QuickJS has no atob; a 64-line-free decoder keeps the bundle self-contained.
  const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = AL.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

function bytesToB64(bytes: Uint8Array): string {
  const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    out += AL[b0 >> 2] + AL[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? AL[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? AL[b2 & 63] : '=';
  }
  return out;
}

function encodeOp(req: Request): Record<string, unknown> {
  const opt: EncodeOptions = { ecc: (req.ecc ?? 'M') as EccLevel };
  if (req.version !== undefined) opt.version = req.version;
  if (req.mask !== undefined) opt.mask = req.mask;
  if (req.dataHex) opt.data = hexDecode(req.dataHex);
  else if (req.geo) opt.geo = req.geo;
  else if (req.url) opt.url = req.url;
  else opt.text = req.text ?? '';

  if (req.secure && (req.secure.pass || req.secure.keyHex)) {
    opt.secure = {
      key: req.secure.keyHex ? hexDecode(req.secure.keyHex) : (req.secure.pass as string),
      ...(req.secure.iterations !== undefined ? { iterations: req.secure.iterations } : {}),
      ...(req.secure.saltHex ? { salt: hexDecode(req.secure.saltHex) } : {}),
      ...(req.secure.nonceHex ? { nonce: hexDecode(req.secure.nonceHex) } : {}),
      ...(req.secure.context !== undefined ? { context: req.secure.context } : {}),
      ...(req.secure.compress !== undefined ? { compress: req.secure.compress } : {}),
    };
  }

  const sym = encode(opt);
  const model = toModel(sym);
  const rgba = renderRGBA(model, {
    theme: req.theme ?? 'ink',
    shape: req.shape ?? 'dot',
    scale: req.scale ?? 8,
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
    secure: sym.secure
      ? {
          keyId: hexEncode(sym.secure.keyId),
          salt: hexEncode(sym.secure.salt),
          iterations: sym.secure.iterations,
          nonce: hexEncode(sym.secure.nonce),
          ciphertextBytes: sym.secure.ciphertext.length,
          plaintextBytes: sym.secure.ciphertext.length - 16,
          ciphertextHex: hexEncode(sym.secure.ciphertext),
        }
      : null,
    raster: { width: rgba.width, height: rgba.height, rgbaB64: bytesToB64(rgba.data) },
    ...(req.wantSvg
      ? {
          svg: renderSVG(model, {
            theme: req.theme ?? 'ink',
            shape: req.shape ?? 'dot',
            scale: 6,
            unit: 'mm',
            caption: req.caption === undefined ? null : req.caption,
          }),
        }
      : {}),
  };
}

function decodeOp(req: Request): Record<string, unknown> {
  const secure =
    req.pass || req.keyHex || req.context
      ? {
          ...(req.keyHex ? { key: hexDecode(req.keyHex) } : {}),
          ...(req.pass && !req.keyHex ? { key: req.pass } : {}),
          ...(req.context !== undefined ? { context: req.context } : {}),
        }
      : undefined;
  const options = {
    ...(secure ? { secure } : {}),
    ...(req.fast ? { retries: 2, noPolarityRetry: true, versionWindow: 0, maxCandidates: 24 } : {}),
  };

  const t0 = Date.now();
  const result = req.grayB64
    ? decodeImage(
        { width: req.width ?? 0, height: req.height ?? 0, data: b64ToBytes(req.grayB64) },
        options,
      )
    : decodeRGBA(b64ToBytes(req.rgbaB64 ?? ''), req.width ?? 0, req.height ?? 0, options);
  const ms = Date.now() - t0;

  const d = result.diagnostics;
  return {
    ok: result.ok,
    ms,
    ...(result.ok
      ? {
          text: result.text ?? '',
          encrypted: result.encrypted === true,
          unlocked: result.secureUnlocked === true,
          secureInfo: result.secureInfo ?? null,
          segments: (result.segments ?? []).map((s) => s.kind),
        }
      : { error: result.error ?? 'decode failed' }),
    diag: {
      version: result.version ?? 0,
      ecc: result.ecc ?? '-',
      mask: result.mask ?? 0,
      teeth: `${d.teethMatches}/63`,
      crown: d.crownOk ? 'crown' : `brute(${d.golayDistance})`,
      confidence: Number(d.meanConfidence.toFixed(3)),
      rotationDeg: Number(d.rotationDeg.toFixed(1)),
      pitch: Number(d.pitch.toFixed(2)),
      inverted: d.inverted,
      polarityRetries: d.polarityRetries,
      erasures: d.erasureCells,
      errorsFixed: result.stats?.errorsFixed ?? 0,
      crc: result.stats?.crcOk === true,
      transform: `${d.transformKind} rms=${Number.isFinite(d.transformRms) ? d.transformRms.toFixed(2) : '-'}`,
    },
  };
}

function themesOp(): Record<string, unknown> {
  return {
    themes: THEME_IDS.map((id) => {
      const t = THEMES[id]!;
      const c = themeContrast(t);
      return { id, fa: t.fa, en: t.en, ink: t.ink, crown: t.crown, paper: t.paper, contrast: Number(c.worst.toFixed(2)), printable: c.printable };
    }),
  };
}

function specOp(): Record<string, unknown> {
  return { name: SYMBOLOGY_NAME, id: SYMBOLOGY_ID, version: SPEC_VERSION, date: SPEC_DATE };
}

export function call(requestJson: string): string {
  try {
    const req = JSON.parse(requestJson) as Request;
    switch (req.op) {
      case 'encode':
        return JSON.stringify(encodeOp(req));
      case 'decode':
        return JSON.stringify(decodeOp(req));
      case 'themes':
        return JSON.stringify(themesOp());
      case 'spec':
        return JSON.stringify(specOp());
      default:
        return JSON.stringify({ ok: false, error: `unknown op ${(req as { op?: string }).op}` });
    }
  } catch (e) {
    return JSON.stringify({ ok: false, error: (e as Error).message });
  }
}

/*
 * Published as a single global. The Kotlin bridge evaluates this bundle once and
 * then calls SimurghEngine.call(...) over JNI; nothing else escapes the VM.
 */
const g = globalThis as unknown as { SimurghEngine: { call: typeof call } };
g.SimurghEngine = { call };

// Keep the bit-level decode reachable for tests that feed dataBits directly.
const exposed = g.SimurghEngine as unknown as Record<string, unknown>;
exposed.decodeBits = (dataBitsHex: string, beadsHex: string, secureJson?: string) => {
  try {
    const dataBits = hexDecode(dataBitsHex);
    const beads = hexDecode(beadsHex);
    const secure = secureJson
      ? (JSON.parse(secureJson) as { pass?: string; keyHex?: string; context?: string })
      : undefined;
    const r = decode(
      { dataBits, beads },
      {
        decompress: (raw) => inflateRaw(raw, { maxOutput: 65536 }),
        ...(secure
          ? {
            secure: {
              ...(secure.keyHex ? { key: hexDecode(secure.keyHex) } : {}),
              ...(secure.pass ? { key: secure.pass } : {}),
              ...(secure.context !== undefined ? { context: secure.context } : {}),
            },
          }
          : {}),
      },
    );
    return JSON.stringify({
      ok: r.ok,
      text: r.ok ? (r.text ?? '') : null,
      version: r.version ?? 0,
      ecc: r.ecc ?? '-',
      encrypted: r.encrypted === true,
      unlocked: r.secureUnlocked === true,
      errorsFixed: r.stats?.errorsFixed ?? 0,
      crcOk: r.stats?.crcOk === true,
      error: r.ok ? null : (r.error ?? 'decode failed'),
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: (e as Error).message });
  }
};
