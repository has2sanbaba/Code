#!/usr/bin/env node
/**
 * simurgh -- command line encoder and decoder for the SiMurgh Code symbology.
 *
 *   simurgh encode "https://example.com/fa/سلام" -o symbol.svg
 *   simurgh encode --file payload.bin -o symbol.png --scale 12 --ecc H
 *   simurgh decode scan.png --json
 *   simurgh capacity --ecc H
 *   simurgh bench
 *   simurgh spec
 *
 * Everything here is plain Node: no argument-parsing library, no image library.
 * The PNG codec next door is about two hundred lines and reads what the rest of
 * the world writes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pbkdf2Sync } from 'node:crypto';
import { extname, resolve } from 'node:path';
import {
  AIM_PREFIX,
  ANGLE_TRACK,
  ECC_LEVELS,
  SPEC_DATE,
  SPEC_VERSION,
  SYMBOLOGY_ID,
  SYMBOLOGY_NAME,
  capacityTable,
  crown,
  decode,
  encode,
  getLattice,
  hexDecode,
  hexEncode,
  payloadToText,
  toModel,
  unpackFormat,
  type EccLevel,
  type Payload,
  type SecureDecodeOptions,
  type SecureEncodeOptions,
} from '@simurgh/core';
import { renderAscii, renderRaster, renderRGBA, renderSVG, resolveTheme } from '@simurgh/core/render';
import { decodeImage } from '@simurgh/core/imaging';
import { inflateRaw } from '@simurgh/core';
import { decodePNG, encodePNG, pngToGray } from './png.js';

/* ------------------------------------------------------------- arg parsing */

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = 'encode';
  const commands = new Set(['encode', 'decode', 'capacity', 'bench', 'spec', 'help', 'version']);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (i === 0 && commands.has(a)) {
      command = a;
      continue;
    }
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
      continue;
    }
    if (a.startsWith('-') && a.length === 2) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
      continue;
    }
    positional.push(a);
  }
  return { command, positional, flags };
}

/** Resolve the short and long spellings of one flag. */
function flag(args: Args, ...names: string[]): string | boolean | undefined {
  for (const n of names) if (args.flags[n] !== undefined) return args.flags[n];
  return undefined;
}
function strFlag(args: Args, ...names: string[]): string | undefined {
  const v = flag(args, ...names);
  return typeof v === 'string' ? v : undefined;
}
function numFlag(args: Args, fallback: number, ...names: string[]): number {
  const v = strFlag(args, ...names);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${names[0]} expects a number, got '${v}'`);
  return n;
}
function boolFlag(args: Args, ...names: string[]): boolean {
  const v = flag(args, ...names);
  if (v === undefined) return false;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return true;
}

/* ------------------------------------------------------------------ payload */

function readPayload(args: Args): { text?: string; url?: string; data?: Uint8Array } {
  const file = strFlag(args, 'file', 'f');
  const stdin = boolFlag(args, 'stdin');
  const url = strFlag(args, 'url', 'u');
  const raw = boolFlag(args, 'binary', 'raw');
  const positional = args.positional[args.command === 'encode' ? 0 : 0];

  if (stdin) {
    const bytes = new Uint8Array(readFileSync(0));
    return raw ? { data: bytes } : { text: new TextDecoder().decode(bytes).replace(/\n$/, '') };
  }
  if (file) {
    const bytes = readFileSync(resolve(file));
    return raw ? { data: bytes } : { text: new TextDecoder().decode(bytes).replace(/\n$/, '') };
  }
  if (url) return { url };
  if (positional !== undefined) {
    // A positional that looks like a URL goes through URL mode, which encodes
    // a hostname in 5.29 bits per character instead of 8.
    return /^https?:\/\//i.test(positional) ? { url: positional } : { text: positional };
  }
  throw new Error('nothing to encode: pass text, --url, --file or --stdin');
}

/* ------------------------------------------------------------------ encode */

function cmdEncode(args: Args): number {
  const payload = readPayload(args);
  const ecc = (strFlag(args, 'ecc', 'e') ?? 'M').toUpperCase() as EccLevel;
  if (!ECC_LEVELS.includes(ecc)) throw new Error(`--ecc must be one of ${ECC_LEVELS.join(', ')}`);

  const versionFlag = strFlag(args, 'version', 'V');
  const maskFlag = strFlag(args, 'mask', 'm');
  const compression = !boolFlag(args, 'no-compress', 'no-compression');
  const secure = secureEncodeOptions(args);

  const sym = encode({
    ...payload,
    ecc,
    version: versionFlag === undefined ? undefined : Number(versionFlag),
    mask: maskFlag === undefined ? undefined : Number(maskFlag),
    compression,
    ...(secure ? { secure } : {}),
  });

  const out = strFlag(args, 'out', 'o');
  const format = (strFlag(args, 'format') ?? (out ? extname(out).slice(1).toLowerCase() : 'ascii')) || 'ascii';
  const scale = numFlag(args, out && format === 'png' ? 12 : 8, 'scale', 's');
  const shape = (strFlag(args, 'shape') ?? 'dot') as 'dot' | 'hex' | 'square';
  const themeFlag = strFlag(args, 'theme');
  const theme = themeFlag === undefined ? undefined : resolveTheme(themeFlag);
  const quiet = numFlag(args, -1, 'quiet', 'q');
  const caption = strFlag(args, 'caption');
  /*
   * `text` is what may be *shown*: for a sealed symbol that is the envelope
   * placeholder, never the secret -- the caption is printed next to the symbol,
   * so putting the plaintext there would undo the encryption. `plainText` is the
   * real content, recovered with the key we were just given, and is used only to
   * check the self-test.
   */
  const recovered = decode(
    { dataBits: sym.dataBits, beads: sym.beads, format: unpackFormat(sym.formatBits) },
    secure ? { secure: secureDecodeOptions(args, sym.secure!) } : {},
  );
  const plainText = recovered.ok ? payloadToText(recovered.payload!) : '';
  const text = secure
    ? `[encrypted ${sym.secure!.ciphertext.length - 16} B, key id ${hexEncode(sym.secure!.keyId)}]`
    : (payload.text ?? payload.url ?? plainText);

  const model = toModel(sym, caption ?? text.slice(0, 60));

  let bytes: Uint8Array | null = null;
  let string: string | null = null;

  switch (format) {
    case 'svg':
      string = renderSVG(model, {
        scale: numFlag(args, 4, 'unit-scale'),
        unit: (strFlag(args, 'unit') ?? 'mm') as 'mm' | 'px' | 'pt' | 'in',
        shape,
        theme,
        caption: sym.secure ? null : caption ?? (boolFlag(args, 'no-caption') ? null : text.slice(0, 96)),
        quiet: quiet >= 0 ? quiet : undefined,
        showGeometry: boolFlag(args, 'geometry'),
      });
      break;
    case 'png': {
      if (theme) {
        /*
         * A themed PNG keeps its colours: RGBA straight into the encoder. The
         * grayscale path below is left exactly as it was, so --dark/--light still
         * mean what they always meant.
         */
        const rgba = renderRGBA(model, { scale, shape, quiet: quiet >= 0 ? quiet : undefined, theme });
        bytes = encodePNG(rgba.width, rgba.height, rgba.data, { channels: 4, level: 9 });
      } else {
        const img = renderRaster(model, {
          scale,
          shape,
          quiet: quiet >= 0 ? quiet : undefined,
          dark: numFlag(args, 0, 'dark'),
          light: numFlag(args, 255, 'light'),
        });
        bytes = encodePNG(img.width, img.height, img.data, { channels: 1, level: 9 });
      }
      break;
    }
    case 'pgm': {
      const img = renderRaster(model, { scale, shape, quiet: quiet >= 0 ? quiet : undefined });
      string = `P5\n${img.width} ${img.height}\n255\n`;
      bytes = new Uint8Array(string.length + img.data.length);
      bytes.set(new TextEncoder().encode(string));
      bytes.set(img.data, string.length);
      string = null;
      break;
    }
    case 'ascii':
    case 'term':
    case 'terminal':
      string = renderAscii(model, {
        shape,
        columnsPerModule: numFlag(args, 1, 'columns'),
        shade: !boolFlag(args, 'no-shade'),
        quiet: quiet >= 0 ? quiet : undefined,
      });
      break;
    case 'json':
      string = JSON.stringify(symbolRecord(sym, text), null, 2);
      break;
    default:
      throw new Error(`unknown output format '${format}' (svg | png | pgm | ascii | json)`);
  }

  if (out) {
    if (bytes) writeFileSync(resolve(out), bytes);
    else writeFileSync(resolve(out), string as string);
    process.stderr.write(`${SYMBOLOGY_ID} v${sym.version}/${sym.ecc} mask=${sym.mask} ${latticeOf(sym.version).N} cells -> ${out}\n`);
  } else if (bytes) {
    process.stdout.write(Buffer.from(bytes));
  } else {
    process.stdout.write((string as string) + '\n');
  }

  if (out || format === 'ascii') process.stderr.write(summaryLine(sym, text));

  // --selftest renders the symbol, reads it back as pixels and reports whether
  // the imaging pipeline agrees with the encoder. It is the cheapest possible
  // end-to-end check that a print setting is actually scannable.
  if (boolFlag(args, 'selftest', 'verify')) {
    const img = renderRaster(model, { scale: numFlag(args, 10, 'selftest-scale'), shape });
    const t0 = Date.now();
    const res = decodeImage(img, secure ? { secure: secureDecodeOptions(args, sym.secure!) } : {});
    const ms = Date.now() - t0;
    const d = res.diagnostics;
    if (!res.ok) {
      process.stderr.write(`selftest FAILED after ${ms} ms: ${res.error}\n`);
      return 1;
    }
    if (secure && !res.secureUnlocked) {
      process.stderr.write(`selftest FAILED: the symbol decoded but the envelope stayed sealed -- wrong key?\n`);
      return 1;
    }
    const got = payloadToText(res.payload!);
    const expect = secure ? plainText : text;
    const ok = got === expect;
    process.stderr.write(
      `selftest ${ok ? 'ok' : 'MISMATCH'} in ${ms} ms: teeth ${d.teethMatches}/63 crown=${d.crownOk ? 'yes' : 'no'} ` +
        `pitch=${d.pitch.toFixed(2)} rot=${d.rotationDeg.toFixed(1)} conf=${d.meanConfidence.toFixed(2)} erasures=${d.erasureCells}\n`,
    );
    if (!ok) {
      process.stderr.write(`  expected: ${secure ? plainText : text}\n  decoded:  ${got}\n`);
      return 1;
    }
  }
  return 0;
}

function latticeOf(version: number) {
  return getLattice(version);
}

function symbolRecord(sym: ReturnType<typeof encode>, text: string): Record<string, unknown> {
  const g = crown(2 * sym.version + 12);
  return {
    symbology: SYMBOLOGY_NAME,
    id: SYMBOLOGY_ID,
    aimPrefix: AIM_PREFIX,
    specVersion: SPEC_VERSION,
    specDate: SPEC_DATE,
    version: sym.version,
    K: 2 * sym.version + 12,
    cells: getLattice(sym.version).N,
    ecc: sym.ecc,
    mask: sym.mask,
    compression: sym.compression === 1,
    format: unpackFormat(sym.formatBits),
    formatWordHex: sym.formatWord.toString(16).padStart(6, '0'),
    beads: Array.from(sym.beads).join(''),
    teeth: Array.from(sym.teeth).join(''),
    codewords: sym.plan.codewords,
    dataCodewords: sym.plan.payloadBytes + 4,
    userPayloadBytes: sym.plan.payloadBytes,
    parityCodewords: sym.plan.parityCodewords,
    blocks: sym.plan.blocks,
    inkCoverage: Number(sym.inkCoverage.toFixed(4)),
    maskScores: sym.maskScores.map((s) => Number(s.toFixed(1))),
    printedDiameterModules: 2 * (2 * sym.version + 12) + 10,
    crownRadii: {
      halo: [g.haloInner, g.haloOuter],
      beads: g.beadRadius,
      teeth: [g.teethInner, g.teethOuter],
      limbus: [g.limbusInner, g.limbusOuter],
      outer: g.outerRadius,
      canvas: g.canvasRadius,
    },
    segments: sym.segments.map((s) => (s.kind === 'byte' ? { kind: s.kind, bytes: s.value.length } : s)),
    payloadBytes: sym.payloadBytes.length,
    ...(sym.secure
      ? {
          secure: {
            suite: sym.secure.suite === 0 ? 'PBKDF2-HMAC-SHA256 + CHACHA20-POLY1305' : 'raw key + CHACHA20-POLY1305',
            keyId: hexEncode(sym.secure.keyId),
            salt: hexEncode(sym.secure.salt),
            iterations: sym.secure.iterations,
            nonce: hexEncode(sym.secure.nonce),
            ciphertextBytes: sym.secure.ciphertext.length,
            plaintextBytes: sym.secure.ciphertext.length - 16,
            deflated: (sym.secure.flags & 1) !== 0,
          },
        }
      : {}),
    text,
  };
}

function summaryLine(sym: ReturnType<typeof encode>, text: string): string {
  const lat = getLattice(sym.version);
  const preview = text.length > 48 ? `${text.slice(0, 45)}...` : text;
  const seal = sym.secure
    ? `SECURE(key ${hexEncode(sym.secure.keyId)} ${sym.secure.suite === 0 ? `PBKDF2x${sym.secure.iterations}` : 'raw'} ` +
      `${sym.secure.ciphertext.length - 16} B sealed) `
    : '';
  return (
    `${SYMBOLOGY_ID} version ${sym.version} (K=${lat.K}, ${lat.N} cells) ECC ${sym.ecc} mask ${sym.mask} ` +
    `${seal}${sym.compression ? 'DEFLATE ' : ''}${sym.plan.payloadBytes} B payload / ${sym.plan.codewords} cw / ${sym.plan.blocks} block(s) ` +
    `ink ${(sym.inkCoverage * 100).toFixed(1)}% printed diameter ${2 * lat.K + 10} modules\n  "${preview}"\n`
  );
}

/* ------------------------------------------------------------------ secure */

/** Build the encode-side envelope options from --pass / --key-hex and friends. */
function secureEncodeOptions(args: Args): SecureEncodeOptions | null {
  const pass = strFlag(args, 'pass');
  const keyHex = strFlag(args, 'key-hex');
  const keyFile = strFlag(args, 'key-file');
  if (pass === undefined && keyHex === undefined && keyFile === undefined) return null;

  let key: string | Uint8Array;
  if (keyHex !== undefined) key = hexDecode(keyHex.trim());
  else if (keyFile !== undefined) key = new Uint8Array(readFileSync(resolve(keyFile)));
  else key = pass as string;

  const opt: SecureEncodeOptions = { key };
  const iterations = strFlag(args, 'iterations');
  if (iterations !== undefined) opt.iterations = Number(iterations);
  const salt = strFlag(args, 'salt');
  if (salt !== undefined) opt.salt = hexDecode(salt.trim());
  const keyId = strFlag(args, 'key-id');
  if (keyId !== undefined) opt.keyId = hexDecode(keyId.trim());
  const context = strFlag(args, 'context');
  if (context !== undefined) opt.context = context;
  if (boolFlag(args, 'no-secure-compress')) opt.compress = false;
  return opt;
}

/**
 * Build the decode-side key options from --pass / --key-hex / --key-file / --keys.
 *
 * `hint` supplies the envelope's own salt and iteration count, which are only
 * known after the symbol has been read; with it the CLI derives through
 * node:crypto (native, ~30 ms at 210 000 iterations) instead of the portable
 * implementation (~3 s).
 */
function secureDecodeOptions(args: Args, hint?: { salt: Uint8Array; iterations: number }): SecureDecodeOptions {
  const opt: SecureDecodeOptions = {};
  const pass = strFlag(args, 'pass');
  const keyHex = strFlag(args, 'key-hex');
  const keyFile = strFlag(args, 'key-file');
  const context = strFlag(args, 'context');
  if (context !== undefined) opt.context = context;

  if (keyHex !== undefined) {
    opt.key = hexDecode(keyHex.trim());
  } else if (keyFile !== undefined) {
    opt.key = new Uint8Array(readFileSync(resolve(keyFile)));
  } else if (pass !== undefined) {
    opt.key = hint
      ? new Uint8Array(pbkdf2Sync(pass, Buffer.from(hint.salt), Math.max(1, hint.iterations), 32, 'sha256'))
      : pass;
  }

  const ring = strFlag(args, 'keys');
  if (ring !== undefined) {
    // One key per line: "<hex key id>=<passphrase>" or just "<passphrase>".
    opt.keys = readFileSync(resolve(ring), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .map((line) => {
        const eq = line.indexOf('=');
        if (eq < 0) return { key: line };
        return { keyId: hexDecode(line.slice(0, eq).trim()), key: line.slice(eq + 1) };
      });
  }
  return opt;
}

/** True when any key material was supplied on the command line. */
function wantsKey(args: Args): boolean {
  return (
    strFlag(args, 'pass') !== undefined ||
    strFlag(args, 'key-hex') !== undefined ||
    strFlag(args, 'key-file') !== undefined ||
    strFlag(args, 'keys') !== undefined
  );
}

/* ------------------------------------------------------------------ decode */

function cmdDecode(args: Args): number {
  const files = args.positional;
  if (files.length === 0) throw new Error('decode needs at least one image file (PNG)');
  const asJson = boolFlag(args, 'json', 'j');
  const verbose = boolFlag(args, 'verbose', 'v');
  let failures = 0;

  for (const file of files) {
    const bytes = readFileSync(resolve(file));
    const ext = extname(file).toLowerCase();
    let gray: { width: number; height: number; data: Uint8Array };
    if (ext === '.pgm') {
      gray = readPGM(bytes);
    } else {
      gray = pngToGray(decodePNG(bytes));
    }
    const keyed = wantsKey(args);
    const t0 = Date.now();
    let res = decodeImage(gray, keyed ? { secure: secureDecodeOptions(args) } : {});

    /*
     * A passphrase cannot become a key until the envelope has been read (its salt
     * and iteration count are printed in the symbol). So read once, and if that
     * yielded a sealed payload, derive natively and re-open from the bits already
     * sampled -- no second pass over the image.
     */
    if (res.ok && res.encrypted && !res.secureUnlocked && keyed && res.sampled && res.secureInfo) {
      const info = res.secureInfo;
      const reopened = decode(
        {
          dataBits: res.sampled.dataBits,
          confidence: res.sampled.confidence,
          beads: res.sampled.beads,
          format: res.format,
        },
        {
          decompress: (raw) => inflateRaw(raw),
          secure: secureDecodeOptions(args, { salt: hexDecode(info.salt), iterations: info.iterations }),
        },
      );
      if (reopened.ok) res = { ...reopened, diagnostics: res.diagnostics, sampled: res.sampled };
    }
    const ms = Date.now() - t0;

    if (!res.ok) {
      failures++;
      if (asJson) {
        process.stdout.write(`${JSON.stringify({ file, ok: false, error: res.error, ms }, null, 2)}\n`);
      } else {
        process.stdout.write(`${file}: FAILED (${ms} ms) ${res.error}\n`);
      }
      continue;
    }

    const text = payloadToText(res.payload!);
    if (res.encrypted && !res.secureUnlocked) {
      const info = res.secureInfo!;
      const line =
        `LOCKED: ${info.plaintextBytes} B sealed with ` +
        `${info.suite === 0 ? `PBKDF2-HMAC-SHA256 (${info.iterations} iterations)` : 'a raw 256-bit key'} + ChaCha20-Poly1305, ` +
        `key id ${info.keyId || '(none)'}`;
      if (asJson) {
        process.stdout.write(
          `${JSON.stringify({ file, ok: true, encrypted: true, unlocked: false, secure: info, ms, diagnostics: res.diagnostics }, null, 2)}\n`,
        );
      } else {
        process.stdout.write(`${line}\n`);
        process.stderr.write(`  ${file}: ${line}\n  pass --pass <passphrase>, --key-hex <64 hex> or --keys <ring file> to open it\n`);
      }
      continue;
    }
    if (asJson) {
      process.stdout.write(
        `${JSON.stringify(
          {
            file,
            ok: true,
            ms,
            aimPrefix: AIM_PREFIX,
            symbology: SYMBOLOGY_ID,
            version: res.version,
            ecc: res.ecc,
            mask: res.mask,
            compressed: res.compression === 1,
            ...(res.encrypted ? { encrypted: true, unlocked: res.secureUnlocked === true, secure: res.secureInfo } : {}),
            segments: res.payload!.segments.map((s) => (s.kind === 'byte' ? { kind: s.kind, bytes: s.value.length } : s)),
            text,
            bytes: binaryOf(res.payload!),
            diagnostics: res.diagnostics,
          },
          null,
          2,
        )}\n`,
      );
      continue;
    }

    process.stdout.write(text + '\n');
    if (verbose || files.length > 1) {
      const d = res.diagnostics;
      process.stderr.write(
        `  ${file}: v${res.version} ${res.ecc} mask=${res.mask}${res.compression ? ' DEFLATE' : ''}${res.encrypted ? (res.secureUnlocked ? ' SECURE(opened)' : ' SECURE(locked)') : ''} in ${ms} ms | ` +
          `${d.width}x${d.height}px pitch=${d.pitch.toFixed(2)} rot=${d.rotationDeg.toFixed(1)}deg ${d.transformKind} rms=${d.transformRms.toFixed(2)} | ` +
          `teeth=${d.teethMatches}/63 crown=${d.crownOk ? 'ok' : 'no'} golay-d=${d.golayDistance} conf=${d.meanConfidence.toFixed(2)} ` +
          `erasures=${d.erasureCells} (seeds ${d.maskPriorSeeds}) errors-fixed=${res.stats?.errorsFixed ?? 0} crc=${res.stats?.crcOk ? 'ok' : 'BAD'}\n`,
      );
    }
  }
  return failures > 0 && files.length === failures ? 1 : 0;
}

function binaryOf(payload: Payload): number[] | undefined {
  for (const seg of payload.segments) if (seg.kind === 'byte') return Array.from(seg.value);
  return undefined;
}

/** Tiny PGM (P5) reader, for pipelines that would rather not use PNG. */
function readPGM(bytes: Uint8Array): { width: number; height: number; data: Uint8Array } {
  let i = 0;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x35) throw new Error('not a binary PGM (P5) file');
  i = 2;
  const nums: number[] = [];
  while (nums.length < 3 && i < bytes.length) {
    while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x09 || bytes[i] === 0x0d)) i++;
    if (bytes[i] === 0x23) {
      while (i < bytes.length && bytes[i] !== 0x0a) i++;
      continue;
    }
    let n = 0;
    while (i < bytes.length && (bytes[i] as number) >= 0x30 && (bytes[i] as number) <= 0x39) n = n * 10 + ((bytes[i++] as number) - 0x30);
    nums.push(n);
    i++;
  }
  const [width = 0, height = 0, max = 255] = nums;
  if (!width || !height) throw new Error('bad PGM header');
  const data = bytes.subarray(i, i + width * height);
  if (max !== 255) {
    const scaled = new Uint8Array(data.length);
    for (let k = 0; k < data.length; k++) scaled[k] = Math.round(((data[k] as number) / max) * 255);
    return { width, height, data: scaled };
  }
  return { width, height, data: Uint8Array.from(data) };
}

/* ---------------------------------------------------------------- capacity */

function cmdCapacity(args: Args): number {
  const onlyEcc = (strFlag(args, 'ecc', 'e') ?? '').toUpperCase();
  const onlyVersion = numFlag(args, 0, 'version', 'V');
  const table = capacityTable();
  const eccs = onlyEcc ? ([onlyEcc] as EccLevel[]) : ECC_LEVELS;
  for (const e of eccs) {
    if (!ECC_LEVELS.includes(e)) throw new Error(`unknown ECC level '${e}'`);
  }

  const rows = onlyVersion ? table.filter((r) => r.version === onlyVersion) : table;
  if (rows.length === 0) throw new Error(`no such version: ${onlyVersion}`);

  const head = ['ver', 'K', 'modules', 'cells', ...eccs.map((e) => `${e} bytes`)];
  process.stdout.write(head.map((h) => h.padStart(9)).join('') + '\n');
  process.stdout.write('-'.repeat(head.length * 9) + '\n');
  for (const row of rows) {
    const K = 2 * row.version + 12;
    const cells: (string | number)[] = [row.version, K, row.modules, row.cells];
    for (const e of eccs) cells.push(row.perEcc[e].payloadBytes);
    process.stdout.write(cells.map((c) => String(c).padStart(9)).join('') + '\n');
  }
  if (!onlyVersion) {
    process.stdout.write(
      `\nBytes are user payload (the four CRC-32 codewords are already excluded).\n` +
        `modules = printed diameter in module pitches = 2K + 10; quiet zone of 2.5 modules is extra.\n`,
    );
  }
  return 0;
}

/* -------------------------------------------------------------------- bench */

function cmdBench(args: Args): number {
  const rounds = numFlag(args, 3, 'rounds', 'n');
  const text = strFlag(args, 'text') ?? 'The quick brown fox jumps over the lazy dog. '.repeat(40);
  process.stdout.write(`${SYMBOLOGY_NAME} ${SPEC_VERSION} -- benchmark\n`);
  process.stdout.write(`payload: ${text.length} characters\n\n`);

  for (const ecc of ECC_LEVELS) {
    const t0 = Date.now();
    let sym!: ReturnType<typeof encode>;
    for (let i = 0; i < rounds; i++) sym = encode({ text, ecc });
    const encMs = (Date.now() - t0) / rounds;
    const lat = getLattice(sym.version);

    const t1 = Date.now();
    for (let i = 0; i < rounds; i++) decode({ dataBits: sym.dataBits, format: unpackFormat(sym.formatBits) });
    const decMs = (Date.now() - t1) / rounds;

    const img = renderRaster(toModel(sym), { scale: 8 });
    const t2 = Date.now();
    renderRaster(toModel(sym), { scale: 8 });
    const renderMs = Date.now() - t2;

    const t3 = Date.now();
    const res = decodeImage(img);
    const imgMs = Date.now() - t3;

    process.stdout.write(
      `ECC ${ecc}  v${String(sym.version).padStart(2)}  ${String(lat.N).padStart(6)} cells  ` +
        `encode ${encMs.toFixed(1).padStart(7)} ms  bit-decode ${decMs.toFixed(2).padStart(6)} ms  ` +
        `raster ${renderMs.toFixed(0).padStart(4)} ms  image-decode ${imgMs.toFixed(0).padStart(5)} ms ${res.ok ? 'ok' : 'FAIL'}  ` +
        `(${img.width}px)\n`,
    );
  }

  /*
   * What compression is actually worth: not a byte ratio, but a *version* ratio.
   * Symbols come in discrete sizes, so removing repetition from the payload can
   * move it down several versions and shrink the printed disc by an order of
   * magnitude. A short URL is the honest counter-example: it is already in V1 and
   * DEFLATE changes nothing, so both cases are printed.
   */
  const line = (label: string, o: Parameters<typeof encode>[0]) => {
    const s = encode(o);
    const K = 2 * s.version + 12;
    return (
      `  ${label.padEnd(28)} v${String(s.version).padStart(2)}  ` +
      `${String(getLattice(s.version).N).padStart(6)} cells  ` +
      `${String(2 * K + 10).padStart(3)} modules across  ` +
      `${String(s.plan.payloadBytes).padStart(5)} B capacity  ` +
      `${s.compression ? 'DEFLATE' : 'raw    '}\n`
    );
  };
  process.stdout.write(`\ncompression, measured in versions rather than bytes:\n`);
  process.stdout.write(line(`${text.length}-char prose`, { text, ecc: 'M' }));
  process.stdout.write(line('  same, uncompressed', { text, ecc: 'M', compression: false }));
  const fa = 'سیمرغ پرنده‌ای افسانه‌ای است که در ادبیات پارسی نماد خرد و رستاخیز به شمار می‌رود. '.repeat(3);
  process.stdout.write(line(`${fa.length}-char Persian prose`, { text: fa, ecc: 'M' }));
  process.stdout.write(line('  same, uncompressed', { text: fa, ecc: 'M', compression: false }));
  const url = 'https://simurgh.example/products/12345?ref=search';
  process.stdout.write(line('49-char URL', { url, ecc: 'M' }));
  process.stdout.write(line('  same, uncompressed', { url, ecc: 'M', compression: false }));
  return 0;
}

/* --------------------------------------------------------------------- spec */

function cmdSpec(): number {
  const g = crown(14);
  process.stdout.write(
    `${SYMBOLOGY_NAME} (${SYMBOLOGY_ID}) specification ${SPEC_VERSION}, ${SPEC_DATE}\n` +
      `AIM-style prefix: ${AIM_PREFIX}\n\n` +
      `Lattice: triangular, pitch 1, axial (q, r) -> x = q + r/2, y = (sqrt(3)/2) r.\n` +
      `Versions 1..40, outermost data ring K = 2V + 12, data cells N = 3K(K+1) - 18.\n` +
      `V1: K=14, N=612. V40: K=92, N=25650.\n` +
      `Placement: serpentine over rings 3..K, forward on odd rings, reversed on even,\n` +
      `so every consecutive pair of modules in the bit stream are lattice neighbours.\n\n` +
      `Border (Crown), radii in module pitches beyond K:\n` +
      `  Halo   [K+0.90, K+1.20]  thin ring, 0.30 wide\n` +
      `  Beads  24 discs, r=0.38, at K+2.20, every 15 degrees -- extended Golay(24,12)\n` +
      `  Teeth  [K+3.10, K+4.10]  63 sectors -- order-6 m-sequence, p(x)=x^6+x+1\n` +
      `  Beak   tooth 0 extended to K+4.70 -- the phase reference\n` +
      `  Limbus [K+4.70, K+5.00]  the measurement ring; outer radius K+5.00\n` +
      `  Quiet  2.5 modules, canvas radius K+7.50\n` +
      `  Halo-to-Limbus distance is exactly 3.80 modules, which is what the\n` +
      `  perspective solver divides a traced radius by to recover the local pitch.\n\n` +
      `Core rosette (d <= 2, 19 cells): dark, light ring, dark ring. Fixed pattern,\n` +
      `rotationally symmetric, so it is a visual anchor and not an orientation one.\n\n` +
      `Angle Track (63 teeth, MSB first from tooth 0):\n  ${ANGLE_TRACK.join('')}\n` +
      `  hex 0x${trackHex()}\n` +
      `  cyclic autocorrelation -1 for every non-zero shift; every 6-window unique.\n\n` +
      `Format Crown: 12 information bits = version(6) | ECC(2) | mask(3) | compression(1),\n` +
      `  encoded as extended Golay(24,12), minimum distance 8: corrects 3, detects 4,\n` +
      `  covering radius 4 (the extended code is deliberately not perfect).\n` +
      `ECC parity fractions: ${ECC_LEVELS.map((e, i) => `${e}=${[0.16, 0.28, 0.4, 0.55][i]}`).join(' ')}.\n` +
      `Payload: interleaved Reed-Solomon over GF(256), p(x)=x^8+x^4+x^3+x^2+1, alpha=2,\n` +
      `  block length <= 255, CRC-32 over the payload as the last four data codewords.\n` +
      `Compression: raw DEFLATE (RFC 1951), implemented in the core, no dependencies.\n` +
      `Modes: TERMINATOR NUMERIC C64 TEXT BYTE URL GEO FRAME MAC SIGNATURE VENDOR.\n` +
      `Masks: 8 lattice-aware patterns, chosen by a penalty over ink balance,\n` +
      `  same-colour neighbours and the longest monochrome ring arc.\n\n` +
      `Crown geometry for K=14 (version 1):\n  ${JSON.stringify(g)}\n`,
  );
  return 0;
}

function trackHex(): string {
  let bits = 0;
  let value = 0;
  let hex = '';
  for (const t of ANGLE_TRACK) {
    value = (value << 1) | (t ? 1 : 0);
    bits++;
    if (bits === 4) {
      hex += value.toString(16).toUpperCase();
      bits = 0;
      value = 0;
    }
  }
  if (bits > 0) hex += (value << (4 - bits)).toString(16).toUpperCase();
  return hex;
}

/* --------------------------------------------------------------------- help */

const HELP = `${SYMBOLOGY_NAME} (${SYMBOLOGY_ID}) ${SPEC_VERSION} -- command line tools

Usage
  simurgh encode <text> [options]     encode text (default command)
  simurgh decode <image...> [options] read a symbol back out of a PNG or PGM
  simurgh capacity [options]          print the payload capacity table
  simurgh bench [options]             time the encoder, decoder and imager
  simurgh spec                        print the frozen specification constants

Encode
  -o, --out <file>          write to a file; the extension picks the format
      --format <fmt>        svg | png | pgm | ascii | json   (default ascii)
  -s, --scale <n>           pixels (or units) per module pitch (default 8; png 12)
      --shape <s>           dot | hex | square               (default dot)
      --theme <id>          palette for svg/png: ink, lapis, turquoise, saffron,
                            rosewater, pistachio, pomegranate, night
                            (contrast is checked; see docs/05)
  -e, --ecc <L|M|Q|H>       error correction level           (default M)
  -V, --version <1..40>     pin the symbol size
  -m, --mask <0..7>         pin the data mask
      --no-compress         disable DEFLATE (it is on by default)
  -u, --url <url>           force URL mode
  -f, --file <path>         read the payload from a file
      --stdin               read the payload from stdin
      --binary              treat the file/stdin payload as raw bytes
  -q, --quiet <n>           quiet zone in modules (default 2.5)
      --caption <text>      SVG caption (default: the payload)
      --unit <mm|px|pt|in>  SVG unit (default mm)
      --geometry            draw the Crown's measurement radii (SVG)
      --selftest            render, then read the image back and verify

Encryption (SECURE envelope, AEAD_CHACHA20_POLY1305 -- RFC 8439)
      --pass <passphrase>   seal the payload with this passphrase
      --key-hex <64 hex>    seal with a raw 256-bit key instead
      --key-file <path>     read the 32-byte raw key from a file
      --iterations <n>      PBKDF2 cost (default 210000, the OWASP 2023 figure)
      --salt <hex>          fix the PBKDF2 salt (default: 16 random bytes)
      --key-id <hex>        override the printed key identifier
      --context <text>      authenticate out-of-band data that is NOT printed
      --no-secure-compress  do not DEFLATE the plaintext inside the envelope

  The same flags open a symbol again on the decode side. A sealed symbol still
  decodes as a symbol without any key -- its shape, version, ECC and the size of
  the secret are readable -- but its contents are ciphertext, and a damaged
  sealed symbol cannot be completed by calculation: the Reed-Solomon layer
  repairs the *ciphertext*, never the plaintext.

Decode
  -j, --json                machine-readable output, diagnostics included
  -v, --verbose             print pose, confidence and correction statistics
      --pass <passphrase>   open a SECURE envelope
      --key-hex <64 hex>    open with a raw 256-bit key
      --key-file <path>     read the 32-byte raw key from a file
      --keys <ring file>    try several keys; lines are "<hex key id>=<pass>"
      --context <text>      the out-of-band context the encoder authenticated

Bench
  -n, --rounds <n>          repetitions per measurement (default 3)
      --text <text>         payload to benchmark

Examples
  simurgh encode "https://example.com/fa/سلام" -o symbol.svg --selftest
  cat payload.bin | simurgh encode --stdin --binary -o symbol.png -e H -s 16
  simurgh decode scan.png --json | jq .text
  simurgh encode "رمز گاوصندوق ۴۷۱۲" --pass 'correct horse' -o vault.png --selftest
  simurgh decode vault.png                     # -> LOCKED: 23 B sealed with PBKDF2...
  simurgh decode vault.png --pass 'correct horse'
  simurgh capacity --ecc H --version 10
`;

/* --------------------------------------------------------------------- main */

function main(argv: string[]): number {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'help':
      process.stdout.write(HELP);
      return 0;
    case 'version':
      process.stdout.write(`${SYMBOLOGY_NAME} ${SPEC_VERSION} (${SPEC_DATE}), CLI for ${SYMBOLOGY_ID}\n`);
      return 0;
    case 'encode':
      return cmdEncode(args);
    case 'decode':
      return cmdDecode(args);
    case 'capacity':
      return cmdCapacity(args);
    case 'bench':
      return cmdBench(args);
    case 'spec':
      return cmdSpec();
    default:
      process.stderr.write(`unknown command '${args.command}'\n${HELP}`);
      return 2;
  }
}

/*
 * `simurgh encode ... | head` closes the pipe early, and Node turns that into an
 * unhandled 'error' event that kills the process with a stack trace. Nothing is
 * wrong: the reader is simply done. Swallowing EPIPE on both streams is what
 * every well-behaved CLI does.
 */
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EPIPE') throw e;
});
process.stderr.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EPIPE') throw e;
});

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  const err = e as { name?: string; message: string; neededBits?: number; availableBits?: number };
  process.stderr.write(`simurgh: ${err.message}\n`);
  if (err.name === 'CapacityError' && err.neededBits !== undefined) {
    process.stderr.write(
      `  the payload needs ${err.neededBits} bits but ${err.availableBits} are available.\n` +
        `  try a lower --ecc, a bigger --version, or leave compression enabled (the default).\n`,
    );
  }
  process.exitCode = 1;
}
