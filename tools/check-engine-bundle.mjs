/**
 * Node-side gate for the Android engine bundle.
 *
 * Loads apps/android/app/src/main/assets/engine.js the way the QuickJS VM will
 * (bare globalThis, no DOM, no WebCrypto) and replays the same differential
 * vectors the Kotlin JVM tests assert, plus the full app protocol: encode,
 * raster round trip, sealed/locked/unlock, gray+fast+inverted decode, SVG,
 * decodeBits and failure paths. Run after tools/build-engine.mjs.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(here, '../apps/android/app/src/main/assets/engine.js');
const vectorsPath = resolve(here, '../apps/android/app/src/test/resources/vectors.json');
const resDir = resolve(here, '../apps/android/app/src/test/resources');

(0, eval)(readFileSync(bundlePath, 'utf8'));
const E = globalThis.SimurghEngine;
if (!E || typeof E.call !== 'function' || typeof E.decodeBits !== 'function') {
  console.error('SimurghEngine.call/decodeBits not published by the bundle');
  process.exit(1);
}
const call = (o) => JSON.parse(E.call(JSON.stringify(o)));
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8'));

let fails = 0;
let checks = 0;
const check = (label, cond, extra = '') => {
  checks++;
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ' | ' + extra : ''}`);
};

/* ---- protocol smoke -------------------------------------------------- */
const spec = call({ op: 'spec' });
check('spec frozen', spec.name === 'SiMurgh Code' && spec.id === 'SMC' && spec.version === vectors.spec.version, JSON.stringify(spec));
const themes = call({ op: 'themes' });
check('8 themes, all printable', themes.themes.length === 8 && themes.themes.every((t) => t.printable && t.contrast >= 7), themes.themes.map((t) => t.id).join(','));

const enc = call({ op: 'encode', text: 'https://simurgh.code/fa/native', ecc: 'M', scale: 7 });
check('encode', enc.ok === true && enc.raster.width > 100, `v${enc.version} cells=${enc.cells}`);
const dec = call({ op: 'decode', rgbaB64: enc.raster.rgbaB64, width: enc.raster.width, height: enc.raster.height });
check('raster round trip', dec.ok === true && dec.text === 'https://simurgh.code/fa/native' && dec.diag.teeth === '63/63' && dec.diag.crc === true, `${dec.ms} ms`);

const sealed = call({ op: 'encode', text: 'رمز گاوصندوق ۴۷۱۲', ecc: 'H', secure: { pass: 'correct horse', iterations: 4096, saltHex: '00112233445566778899aabbccddeeff', nonceHex: '000102030405060708090a0b' }, scale: 7 });
const sealed2 = call({ op: 'encode', text: 'رمز گاوصندوق ۴۷۱۲', ecc: 'H', secure: { pass: 'correct horse', iterations: 4096, saltHex: '00112233445566778899aabbccddeeff', nonceHex: '000102030405060708090a0b' }, scale: 7 });
check('envelope deterministic', sealed.ok && sealed2.raster.rgbaB64 === sealed.raster.rgbaB64 && sealed.secure.keyId.length === 8, `keyId ${sealed.secure.keyId}`);
const locked = call({ op: 'decode', rgbaB64: sealed.raster.rgbaB64, width: sealed.raster.width, height: sealed.raster.height });
check('locked without key', locked.ok === true && locked.encrypted === true && locked.unlocked === false);
const wrong = call({ op: 'decode', rgbaB64: sealed.raster.rgbaB64, width: sealed.raster.width, height: sealed.raster.height, pass: 'nope' });
check('wrong pass stays locked', wrong.ok === true && wrong.unlocked === false);
const opened = call({ op: 'decode', rgbaB64: sealed.raster.rgbaB64, width: sealed.raster.width, height: sealed.raster.height, pass: 'correct horse' });
check('opens with pass', opened.ok === true && opened.unlocked === true && opened.text === 'رمز گاوصندوق ۴۷۱۲');

const night = call({ op: 'encode', text: 'وارون', theme: 'night', scale: 8 });
const rgba = Buffer.from(night.raster.rgbaB64, 'base64');
const gray = Buffer.alloc(rgba.length / 4);
for (let i = 0; i < gray.length; i++) gray[i] = Math.round(0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]);
const gd = call({ op: 'decode', grayB64: gray.toString('base64'), width: night.raster.width, height: night.raster.height, fast: true });
check('gray + fast + inverted', gd.ok === true && gd.text === 'وارون' && gd.diag.inverted === true, `${gd.ms} ms`);
const svgReq = call({ op: 'encode', text: 'svg', wantSvg: true, theme: 'lapis' });
check('svg on demand', typeof svgReq.svg === 'string' && svgReq.svg.includes('<svg'));
check('garbage fails cleanly', call({ op: 'decode', grayB64: 'AAAA', width: 2, height: 2 }).ok === false);
check('unknown op fails cleanly', call({ op: 'nope' }).ok === false);

/* ---- differential vectors (mirror of EngineVectorsTest.kt) ----------- */
for (const v of vectors.encode) {
  const r = call({ op: 'encode', ...v.req });
  const e = v.expect;
  check(`vector ${v.name}`, r.ok === true && r.version === e.version && r.ecc === e.ecc && r.mask === e.mask &&
    r.formatWord === e.formatWord && r.payloadBytes === e.payloadBytes && r.codewords === e.codewords &&
    r.dataBitsHex === e.dataBitsHex && r.beadsHex === e.beadsHex, `v${r.version}/${r.ecc} mask ${r.mask}`);
  const bits = JSON.parse(E.decodeBits(e.dataBitsHex, e.beadsHex));
  check(`vector ${v.name} decodeBits`, bits.ok === true && bits.crcOk === true, (bits.text ?? '').slice(0, 24));
}
for (const v of vectors.secure) {
  const r = call({ op: 'encode', ...v.req });
  check(`secure ${v.name}`, r.ok === true && r.secure && r.secure.keyId === v.expect.keyId &&
    r.secure.ciphertextHex === v.expect.ciphertextHex && r.dataBitsHex === v.expect.dataBitsHex, `keyId ${v.expect.keyId}`);
  const openReq = { pass: v.openWith.pass, keyHex: v.openWith.keyHex, context: v.openWith.context };
  const openedBits = JSON.parse(E.decodeBits(v.expect.dataBitsHex, '', JSON.stringify(openReq)));
  // dataBits-only path re-reads the crown from beads; feed the real beads too.
  const enc2 = r;
  const openedFull = JSON.parse(E.decodeBits(enc2.dataBitsHex, enc2.beadsHex, JSON.stringify(openReq)));
  check(`secure ${v.name} opens`, openedFull.ok === true && openedFull.unlocked === true && openedFull.text === v.text, openedFull.text ?? '');
  const lockedFull = JSON.parse(E.decodeBits(enc2.dataBitsHex, enc2.beadsHex));
  check(`secure ${v.name} locked`, lockedFull.ok === true && lockedFull.encrypted === true && lockedFull.unlocked === false);
  void openedBits;
}
for (const v of vectors.images) {
  const buf = readFileSync(resolve(resDir, v.file));
  const nl = (from) => buf.indexOf(10, from);
  const dataStart = nl(nl(nl(0) + 1) + 1) + 1;
  const grayBytes = buf.subarray(dataStart);
  const r = call({ op: 'decode', grayB64: grayBytes.toString('base64'), width: v.width, height: v.height });
  check(`image ${v.name}`, r.ok === true && r.text === v.text && r.diag.teeth === '63/63' && r.diag.version === v.version &&
    r.diag.inverted === (v.theme === 'night'), `${r.ms} ms conf ${r.diag.confidence}`);
}

console.log(fails === 0 ? `\nENGINE BUNDLE: ${checks}/${checks} PASSED` : `\nENGINE BUNDLE: ${fails}/${checks} FAILURES`);
process.exit(fails ? 1 : 0);
