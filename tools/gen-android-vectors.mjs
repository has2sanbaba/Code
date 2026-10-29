/**
 * Differential vectors for the native Android app's JVM tests.
 *
 * The Kotlin side runs the bundled engine in QuickJS; these vectors pin it to the
 * reference implementation bit for bit: exact `dataBits` and Crown beads for a set
 * of payloads, exact sealed envelopes for fixed salt/nonce, and rendered grayscale
 * images (PGM) whose decode must reproduce the payload and the diagnostics.
 *
 *   node tools/gen-android-vectors.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../apps/android/app/src/test/resources');
mkdirSync(outDir, { recursive: true });

const core = await import(resolve(here, '../packages/core/dist/index.js'));
const render = await import(resolve(here, '../packages/core/dist/render/index.js'));

const hex = (u8) => Buffer.from(u8).toString('hex');

const payloads = [
  { name: 'url-fa', req: { url: 'https://simurgh.code/fa/سلام-世界', ecc: 'M' } },
  { name: 'text-en', req: { text: 'The quick brown fox jumps over the lazy dog.', ecc: 'L' } },
  { name: 'text-fa-H', req: { text: 'سیمرغ‌کد: نمادنگاری شعاعی شش‌گوش با تاج قالب.', ecc: 'H' } },
  { name: 'binary', req: { dataHex: '000102030405060708090a0b0c0d0e0fffee', ecc: 'Q' } },
  { name: 'geo', req: { geo: { lat: 35.6892, lon: 51.389, alt: 1180, flags: 0 }, ecc: 'M' } },
  { name: 'mixed-Q-v5', req: { text: 'x'.repeat(300), ecc: 'Q', version: 8 } },
];

const encodeVectors = payloads.map(({ name, req }) => {
  const opt = { ecc: req.ecc };
  if (req.url) opt.url = req.url;
  if (req.text) opt.text = req.text;
  if (req.dataHex) opt.data = core.hexDecode(req.dataHex);
  if (req.geo) opt.geo = req.geo;
  if (req.version) opt.version = req.version;
  const sym = core.encode(opt);
  return {
    name,
    req,
    expect: {
      version: sym.version,
      ecc: sym.ecc,
      mask: sym.mask,
      formatBits: sym.formatBits,
      formatWord: sym.formatWord,
      payloadBytes: sym.plan.payloadBytes,
      codewords: sym.plan.codewords,
      dataBitsHex: hex(sym.dataBits),
      beadsHex: hex(sym.beads),
    },
  };
});

// Sealed envelopes with everything fixed: the envelope must be reproducible.
const secureVectors = [
  { name: 'pass-fixed', pass: 'correct horse', iterations: 4096, saltHex: '00112233445566778899aabbccddeeff', nonceHex: '000102030405060708090a0b', text: 'vault pin 4712' },
  { name: 'pass-context', pass: 'k', iterations: 8192, saltHex: 'ffffffffffffffffffffffffffffffff', nonceHex: '0102030405060708090a0b0c', context: 'invoice-4711', text: 'bound secret' },
  { name: 'raw-key', keyHex: '2a'.repeat(32), saltHex: '00ff00ff00ff00ff00ff00ff00ff00ff', nonceHex: '0a0b0c0d0e0f000102030405', text: 'raw key payload' },
].map((v) => {
  const sym = core.encode({
    text: v.text,
    ecc: 'M',
    secure: {
      key: v.keyHex ? core.hexDecode(v.keyHex) : v.pass,
      iterations: v.iterations,
      salt: v.saltHex ? core.hexDecode(v.saltHex) : undefined,
      nonce: core.hexDecode(v.nonceHex),
      ...(v.context ? { context: v.context } : {}),
    },
  });
  return {
    name: v.name,
    req: { text: v.text, ecc: 'M', secure: { pass: v.pass, keyHex: v.keyHex, iterations: v.iterations, saltHex: v.saltHex, nonceHex: v.nonceHex, context: v.context } },
    expect: {
      keyId: hex(sym.secure.keyId),
      ciphertextHex: hex(sym.secure.ciphertext),
      dataBitsHex: hex(sym.dataBits),
    },
    openWith: { pass: v.pass, keyHex: v.keyHex, context: v.context },
    text: v.text,
  };
});

// Rendered images: what the camera pipeline must read back.
const imageVectors = [
  { name: 'ink-v1', text: 'https://simurgh.code/fa/native', theme: 'ink', scale: 7, ecc: 'M' },
  { name: 'night-inverted', text: 'نماد وارون روشن روی تیره', theme: 'night', scale: 7, ecc: 'M' },
  { name: 'lapis-v4', text: 'پالت لاجورد با کنتراست ده به یک', theme: 'lapis', scale: 6, ecc: 'Q' },
].map((v) => {
  const sym = core.encode({ text: v.text, ecc: v.ecc });
  const model = core.toModel(sym);
  const rgba = render.renderRGBA(model, { theme: v.theme, scale: v.scale });
  const gray = new Uint8Array(rgba.width * rgba.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(0.2126 * rgba.data[i * 4] + 0.7152 * rgba.data[i * 4 + 1] + 0.0722 * rgba.data[i * 4 + 2]);
  }
  const pgm = `P5\n${rgba.width} ${rgba.height}\n255\n`;
  const buf = Buffer.concat([Buffer.from(pgm, 'ascii'), Buffer.from(gray)]);
  const file = `img-${v.name}.pgm`;
  writeFileSync(resolve(outDir, file), buf);
  return { name: v.name, file, width: rgba.width, height: rgba.height, text: v.text, version: sym.version, theme: v.theme };
});

const vectors = {
  spec: { version: core.SPEC_VERSION, date: core.SPEC_DATE },
  encode: encodeVectors,
  secure: secureVectors,
  images: imageVectors,
};
writeFileSync(resolve(outDir, 'vectors.json'), JSON.stringify(vectors, null, 1));
console.log(`wrote vectors.json (${encodeVectors.length} encode, ${secureVectors.length} secure, ${imageVectors.length} images) + ${imageVectors.length} PGM files`);
