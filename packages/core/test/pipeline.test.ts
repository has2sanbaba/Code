import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  AIM_PREFIX,
  CapacityError,
  ECC_LEVELS,
  SPEC_VERSION,
  SYMBOLOGY_NAME,
  autoSegments,
  capacityTable,
  coreCells,
  crc32,
  hexDistance,
  decode,
  deflateIfSmaller,
  deflateRaw,
  encode,
  encodeFrames,
  getLattice,
  inflateRaw,
  makeRng,
  payloadToText,
  planBlocks,
  reassembleFrames,
  segmentBits,
  segmentsToBytes,
  unpackFormat,
  type EccLevel,
} from '@simurgh/core';

/** Deterministic pseudo-random bytes (makeRng is a plain xorshift generator fn). */
function randomBytes(n: number, seed: number): Uint8Array {
  const rng = makeRng(seed);
  return Uint8Array.from({ length: n }, () => Math.floor(rng() * 256));
}

/**
 * `DecodeInput.format` is the *unpacked* 12 information bits, not the integer the
 * encoder publishes -- handing it the raw word silently decodes as version
 * undefined and yields an empty payload with ok=true, which is the kind of
 * mistake a test suite exists to catch in other people's code.
 */
function fmt(sym: ReturnType<typeof encode>) {
  return unpackFormat(sym.formatBits);
}

/** Bit-exact round trip: decode the printed values with the encoder's own format. */
function roundTrip(opt: Parameters<typeof encode>[0]): ReturnType<typeof decode> {
  const sym = encode(opt);
  return decode({ dataBits: sym.dataBits, format: fmt(sym) });
}

function textOf(opt: Parameters<typeof encode>[0]): string {
  const res = roundTrip(opt);
  expect(res.ok, res.error).toBe(true);
  return payloadToText(res.payload!);
}

describe('payload round trips', () => {
  const cases: [string, Parameters<typeof encode>[0], string][] = [
    ['ascii text', { text: 'Hello, SiMurgh!' }, 'Hello, SiMurgh!'],
    ['persian text', { text: 'سیمرغ یک کد دوبعدی شعاعی جدید است' }, 'سیمرغ یک کد دوبعدی شعاعی جدید است'],
    ['mixed scripts', { text: '🦅 سیمرغ si-30 世界 not a bird 🐦' }, '🦅 سیمرغ si-30 世界 not a bird 🐦'],
    ['url', { url: 'https://example.com/products/12345?ref=search' }, 'https://example.com/products/12345?ref=search'],
    // URL mode carries a non-ascii body through its own escape, verbatim:
    // no percent-encoding round trip is invented by the symbology.
    ['http url', { url: 'http://simurgh.example/fa/سلام' }, 'http://simurgh.example/fa/سلام'],
    ['digits', { text: '0123456789'.repeat(4) }, '0123456789'.repeat(4)],
    ['empty text', { text: '' }, ''],
    ['newlines and tabs', { text: 'a\tb\nc\r\nd' }, 'a\tb\nc\r\nd'],
  ];
  for (const [label, opt, want] of cases) {
    it(label, () => {
      expect(textOf(opt)).toBe(want);
    });
  }

  it('binary payload survives byte for byte', () => {
    const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 167 + 13) & 0xff);
    const sym = encode({ data });
    const res = decode({ dataBits: sym.dataBits, format: fmt(sym) });
    expect(res.ok, res.error).toBe(true);
    const bytes = res.payload!.segments.find((s) => s.kind === 'byte');
    expect(bytes).toBeDefined();
    expect(Array.from((bytes as { value: Uint8Array }).value)).toEqual(Array.from(data));
  });

  it('every byte value 0..255 appears in a decoded payload', () => {
    const data = Uint8Array.from({ length: 256 }, (_, i) => i);
    const sym = encode({ data });
    const res = decode({ dataBits: sym.dataBits, format: fmt(sym) });
    expect(res.ok, res.error).toBe(true);
    const bytes = res.payload!.segments.find((s) => s.kind === 'byte') as { value: Uint8Array };
    expect(Array.from(bytes.value)).toEqual(Array.from(data));
  });

  it('geo fixes keep 1e-7 degree resolution', () => {
    const sym = encode({ geo: { lat: 35.6892, lon: 51.389, alt: 1180, flags: 3 } });
    const res = decode({ dataBits: sym.dataBits, format: fmt(sym) });
    expect(res.ok, res.error).toBe(true);
    const g = res.payload!.segments.find((s) => s.kind === 'geo') as {
      value: { lat: number; lon: number; alt: number; flags: number };
    };
    expect(Math.abs(g.value.lat - 35.6892)).toBeLessThan(1e-7);
    expect(Math.abs(g.value.lon - 51.389)).toBeLessThan(1e-7);
    expect(g.value.alt).toBe(1180);
    expect(g.value.flags).toBe(3);
  });

  it('a 2000-character payload round trips', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(45);
    expect(textOf({ text })).toBe(text);
  });
});

describe('automatic mode selection', () => {
  it('uses NUMERIC for digit runs at 3.33 bits per digit', () => {
    const segs = autoSegments('0123456789'.repeat(10));
    expect(segs.every((s) => s.kind === 'numeric')).toBe(true);
    const bits = segs.reduce((a, s) => a + segmentBits(s), 0);
    // 10 bits per 3 digits = 3.33, plus the 18-bit header and the 4-bit tail
    // digit of a 100-digit run: 352 bits total.
    expect(bits).toBe(4 + 14 + 33 * 10 + 4);
    expect(bits / 100).toBeLessThan(3.6);
    expect(bits / 100).toBeGreaterThan(3.3);
  });

  it('uses C64 for latin prose at 6 bits per character', () => {
    const segs = autoSegments('the quick brown fox');
    expect(segs.length).toBe(1);
    expect(segs[0]!.kind).toBe('c64');
    const bits = segmentBits(segs[0]!);
    expect(bits).toBe(4 + 14 + 19 * 6);
  });

  it('uses URL mode for http(s) and beats TEXT on the body', () => {
    const url = 'https://example.com/a/b/c?x=1&y=2';
    const segs = autoSegments(url);
    expect(segs.length).toBe(1);
    expect(segs[0]!.kind).toBe('url');
    expect(segmentBits(segs[0]!)).toBeLessThan(segmentBits({ kind: 'text', value: url }));
  });

  it('charges escapes by their real UTF-8 length, so TEXT wins for non-latin prose', () => {
    // A C64 escape costs 6 bits plus 8 per UTF-8 byte: 22 bits for a 2-byte
    // Persian character against TEXT's 16. The dynamic programme has to charge
    // the same arithmetic segmentBits() does, or it picks a mode that is more
    // expensive than the alternative and the two disagree about the size.
    const fa = autoSegments('سیمرغ');
    expect(fa.length).toBe(1);
    expect(fa[0]!.kind).toBe('text');
    expect(segmentBits(fa[0]!)).toBe(4 + 16 + 10 * 8);
    expect(4 + 14 + 5 * (6 + 16)).toBeGreaterThan(segmentBits(fa[0]!));

    const cjk = autoSegments('世界你好');
    expect(cjk[0]!.kind).toBe('text');
    expect(segmentBits(cjk[0]!)).toBe(4 + 16 + 12 * 8);

    // Latin prose still belongs in C64: 6 bits per character beats 8.
    const latin = autoSegments('hello world');
    expect(latin[0]!.kind).toBe('c64');
    expect(segmentBits(latin[0]!)).toBe(4 + 14 + 11 * 6);
  });

  it('segmentation is lossless through the byte serialiser', () => {
    const text = 'ABC123 mixed ۴۵۶ text https://x.example/p?q=1';
    const segs = autoSegments(text);
    expect(segs.length).toBeGreaterThan(1); // the DP splits at the script boundary
    const bytes = segmentsToBytes(segs);
    expect(bytes.length).toBeGreaterThan(0);
    const sym = encode({ segments: segs });
    const res = decode({ dataBits: sym.dataBits, format: fmt(sym) });
    expect(res.ok, res.error).toBe(true);
    expect(payloadToText(res.payload!)).toBe(text);
  });
});

describe('DEFLATE (RFC 1951)', () => {
  const payloads: [string, Uint8Array][] = [
    ['empty', new Uint8Array(0)],
    ['one byte', Uint8Array.from([65])],
    ['ascii', Uint8Array.from(Buffer.from('the quick brown fox jumps over the lazy dog'))],
    ['repetitive', Uint8Array.from(Buffer.from('A'.repeat(3000)))],
    [
      'persian prose',
      Uint8Array.from(Buffer.from('سیمرغ کد یک نمادنگاری دوبعدی تازه است. '.repeat(6))),
    ],
    ['random binary', randomBytes(2048, 7)],
    ['structured binary', Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + (i >> 5)) & 0xff)],
  ];

  it('round trips every payload at every level', () => {
    for (const [label, data] of payloads) {
      for (const level of [0, 1, 6, 9] as const) {
        const c = deflateRaw(data, { level });
        const back = inflateRaw(c);
        expect(back.length, `${label} level ${level}`).toBe(data.length);
        expect(Array.from(back), `${label} level ${level}`).toEqual(Array.from(data));
      }
    }
  });

  it('produces streams that node:zlib can inflate', () => {
    for (const [label, data] of payloads) {
      const c = deflateRaw(data, { level: 9 });
      const back = inflateRawSync(c);
      expect(Array.from(back), label).toEqual(Array.from(data));
    }
  });

  it('inflates streams that node:zlib produced, at every zlib level', () => {
    for (const [label, data] of payloads) {
      for (const level of [0, 1, 6, 9]) {
        const c = deflateRawSync(data, { level });
        const back = inflateRaw(c);
        expect(Array.from(back), `${label} zlib level ${level}`).toEqual(Array.from(data));
      }
    }
  });

  it('beats the stored-block fallback on compressible data', () => {
    const data = Uint8Array.from(Buffer.from('A'.repeat(3000)));
    expect(deflateRaw(data, { level: 9 }).length).toBeLessThan(100);
    // level 0 must be pure stored blocks: 5 header bytes per 65535-byte block
    expect(deflateRaw(data, { level: 0 }).length).toBe(3000 + 5);
  });

  it('never expands incompressible data by more than the block overhead', () => {
    const data = randomBytes(8192, 11);
    const c = deflateRaw(data, { level: 9 });
    expect(c.length).toBeLessThan(data.length * 1.01);
  });

  it('deflateIfSmaller returns null when compression would not pay', () => {
    expect(deflateIfSmaller(randomBytes(64, 3))).toBeNull();
    expect(deflateIfSmaller(Uint8Array.from(Buffer.from('A'.repeat(400))))).not.toBeNull();
  });

  it('rejects a truncated stream instead of returning partial data', () => {
    const c = deflateRaw(Uint8Array.from(Buffer.from('hello hello hello hello')));
    expect(() => inflateRaw(c.subarray(0, c.length - 2))).toThrow();
  });

  it('rejects malformed streams instead of fabricating output', () => {
    // BFINAL=1, BTYPE=11: reserved
    expect(() => inflateRaw(Uint8Array.from([0x07]))).toThrow(/reserved block type/);
    // stored block whose LEN is not the one's complement of NLEN
    expect(() => inflateRaw(Uint8Array.from([0x01, 0x05, 0x00, 0x05, 0x00]))).toThrow(/complement/);
    // a well-formed empty stored block is legal and yields nothing
    expect(inflateRaw(Uint8Array.from([0x01, 0x00, 0x00, 0xff, 0xff])).length).toBe(0);
  });

  it('enforces the output size cap', () => {
    const c = deflateRaw(Uint8Array.from(Buffer.from('B'.repeat(4096))));
    expect(() => inflateRaw(c, { maxOutput: 1000 })).toThrow(/limit/);
  });
});

describe('compression in the symbology', () => {
  const prose = 'SiMurgh is a radial two-dimensional matrix symbology. '.repeat(40);

  it('is on by default and shrinks the symbol dramatically', () => {
    const on = encode({ text: prose });
    const off = encode({ text: prose, compression: false });
    expect(on.compression).toBe(1);
    expect(off.compression).toBe(0);
    expect(on.version).toBeLessThan(off.version);
    // 2160 characters of prose: DEFLATE finds the repetition, so the disc goes
    // from a version-20-ish size to something an order of magnitude smaller.
    expect(getLattice(on.version).N).toBeLessThan(getLattice(off.version).N / 4);
    expect(payloadToText(decode({ dataBits: on.dataBits, format: fmt(on) }).payload!)).toBe(prose);
    expect(payloadToText(decode({ dataBits: off.dataBits, format: fmt(off) }).payload!)).toBe(prose);
  });

  it('is skipped when it would not shrink the payload', () => {
    const sym = encode({ data: randomBytes(64, 5) });
    expect(sym.compression).toBe(0);
  });

  it('is skipped below the 24-byte floor', () => {
    const sym = encode({ text: 'short' });
    expect(sym.compression).toBe(0);
  });

  it('accepts a caller-supplied compressor', () => {
    const sym = encode({
      text: prose,
      compress: (raw) => deflateIfSmaller(raw),
    });
    expect(sym.compression).toBe(1);
    const res = decode({ dataBits: sym.dataBits, format: fmt(sym) });
    expect(res.ok, res.error).toBe(true);
    expect(payloadToText(res.payload!)).toBe(prose);
  });

  it('a compressed symbol still reports its true data length', () => {
    const sym = encode({ text: prose });
    // planBlocks' payloadBytes is already the user capacity: total data
    // codewords minus the four that carry the CRC-32.
    expect(sym.payloadBytes.length).toBe(sym.plan.payloadBytes);
    expect(sym.plan.payloadBytes + 4 + sym.plan.parityCodewords).toBe(sym.plan.codewords);
  });
});

describe('masks', () => {
  it('all eight masks encode, decode and stay near 50% ink', () => {
    for (let mask = 0; mask < 8; mask++) {
      const sym = encode({ text: 'mask survey 0123456789 abcdefghij', mask });
      expect(sym.mask).toBe(mask);
      expect(sym.inkCoverage).toBeGreaterThan(0.42);
      expect(sym.inkCoverage).toBeLessThan(0.58);
      const res = decode({ dataBits: sym.dataBits, format: fmt(sym) });
      expect(res.ok, `mask ${mask}: ${res.error}`).toBe(true);
      expect(res.mask).toBe(mask);
    }
  });

  it('the automatic mask choice is the cheapest by penalty', () => {
    const sym = encode({ text: 'the automatic mask survey payload 9876543210' });
    const best = sym.maskScores
      .map((score, mask) => ({ score, mask }))
      .sort((a, b) => a.score - b.score)[0]!;
    expect(sym.mask).toBe(best.mask);
  });
});

describe('error correction levels', () => {
  it('every level round trips and parity grows L < M < Q < H', () => {
    const parity: number[] = [];
    for (const ecc of ECC_LEVELS) {
      const sym = encode({ text: 'error correction survey 2026', ecc });
      expect(sym.ecc).toBe(ecc);
      parity.push(sym.plan.codewords - sym.plan.payloadBytes);
      const res = decode({ dataBits: sym.dataBits, format: fmt(sym) });
      expect(res.ok, `${ecc}: ${res.error}`).toBe(true);
      expect(res.ecc).toBe(ecc);
    }
    for (let i = 1; i < parity.length; i++) expect(parity[i]!).toBeGreaterThan(parity[i - 1]!);
  });

  it('higher ECC means less payload at the same version', () => {
    const levels: EccLevel[] = ['L', 'M', 'Q', 'H'];
    const payloads = levels.map((ecc) => planBlocks(10, ecc).payloadBytes);
    for (let i = 1; i < payloads.length; i++) expect(payloads[i]!).toBeLessThan(payloads[i - 1]!);
  });

  it('corrects t random bit errors in the printed values', () => {
    const sym = encode({ text: 'https://simurgh.example/resilience', ecc: 'M' });
    // parityCodewords, not codewords - payloadBytes: plan.payloadBytes is the
    // user capacity, so the difference also contains the four CRC codewords.
    const t = Math.floor(sym.plan.parityCodewords / (2 * sym.plan.blocks));
    expect(t).toBe(10);
    const rng = makeRng(42);
    for (let flips = 0; flips <= t; flips++) {
      const bits = Uint8Array.from(sym.dataBits);
      const hit = new Set<number>();
      while (hit.size < flips) hit.add(Math.floor(rng() * bits.length));
      for (const i of hit) bits[i] = (bits[i]! ^ 1) as 0 | 1;
      const res = decode({ dataBits: bits, format: fmt(sym) });
      expect(res.ok, `${flips} flips: ${res.error}`).toBe(true);
      expect(payloadToText(res.payload!)).toBe('https://simurgh.example/resilience');
    }
  });

  it('refuses to invent a payload when the damage is beyond the code', () => {
    const sym = encode({ text: 'https://simurgh.example/resilience', ecc: 'L' });
    const rng = makeRng(99);
    const bits = Uint8Array.from(sym.dataBits);
    for (let i = 0; i < 90; i++) bits[Math.floor(rng() * bits.length)] = (bits[
      Math.floor(rng() * bits.length)
    ]! ^ 1) as 0 | 1;
    const res = decode({ dataBits: bits, format: fmt(sym) });
    // Either it declines, or it decodes something whose CRC-32 happens to match
    // (probability 2^-32). Declining is the designed outcome.
    if (res.ok) expect(res.stats!.crcOk).toBe(true);
    else expect(res.ok).toBe(false);
  });

  it('erasures are twice as cheap as errors', () => {
    const sym = encode({ text: 'https://simurgh.example/resilience', ecc: 'M' });
    const parityPerBlock = sym.plan.parityCodewords / sym.plan.blocks;
    // floor(parity/2) errors vs floor(parity) erasures: both must decode.
    const rng = makeRng(7);
    const bits = Uint8Array.from(sym.dataBits);
    const erasures: number[] = [];
    for (let i = 0; i < Math.floor(parityPerBlock); i++) {
      let k = Math.floor(rng() * bits.length);
      while (erasures.includes(k)) k = (k + 1) % bits.length;
      erasures.push(k);
      bits[k] = (bits[k]! ^ 1) as 0 | 1;
    }
    const res = decode({ dataBits: bits, erasures, format: fmt(sym) });
    expect(res.ok, res.error).toBe(true);
    expect(payloadToText(res.payload!)).toBe('https://simurgh.example/resilience');
  });
});

describe('version selection and capacity', () => {
  it('picks the smallest version that fits', () => {
    let prev = 0;
    for (const n of [1, 10, 50, 200, 800, 3000]) {
      const sym = encode({ text: 'x'.repeat(n), compression: false });
      expect(sym.version).toBeGreaterThanOrEqual(prev);
      expect(planBlocks(sym.version, 'M').payloadBytes * 8).toBeGreaterThanOrEqual(
        segmentsToBytes(sym.segments).length * 8,
      );
      if (sym.version > 1) {
        expect(planBlocks(sym.version - 1, 'M').payloadBytes).toBeLessThan(
          segmentsToBytes(sym.segments).length,
        );
      }
      prev = sym.version;
    }
  });

  it('honours a pinned version and pads the payload', () => {
    const sym = encode({ text: 'tiny', version: 12, ecc: 'H' });
    expect(sym.version).toBe(12);
    expect(sym.payloadBytes.length).toBe(sym.plan.payloadBytes);
    const res = decode({ dataBits: sym.dataBits, format: fmt(sym) });
    expect(res.ok, res.error).toBe(true);
    expect(res.version).toBe(12);
    expect(payloadToText(res.payload!)).toBe('tiny');
  });

  it('throws a CapacityError that names the pinned version', () => {
    expect(() => encode({ text: 'x'.repeat(5000), version: 1, compression: false })).toThrow(CapacityError);
    try {
      encode({ text: 'x'.repeat(5000), version: 1, compression: false });
    } catch (e) {
      expect((e as CapacityError).message).toMatch(/version 1 \(the requested version\)/);
      expect((e as CapacityError).neededBits).toBeGreaterThan((e as CapacityError).availableBits);
    }
  });

  it('compresses instead of overflowing: the same text fits the pinned version', () => {
    // Big enough that DEFLATE earns a much smaller disc, small enough that the
    // uncompressed payload still fits in the symbology (so the comparison in
    // the last assertion is meaningful rather than a CapacityError).
    const text = 'SiMurgh radial matrix. '.repeat(60);
    const auto = encode({ text });
    expect(auto.compression).toBe(1);
    // The version DEFLATE earned is too small for the uncompressed payload...
    expect(() => encode({ text, version: auto.version, compression: false })).toThrow(CapacityError);
    // ...and it still holds the text when compression does the work.
    expect(textOf({ text, version: auto.version })).toBe(text);
    expect(auto.version).toBeLessThan(encode({ text, compression: false }).version);
  });

  it('the capacity table is consistent with the block planner', () => {
    const table = capacityTable();
    expect(table.length).toBe(40);
    for (const row of table) {
      expect(row.cells).toBe(3 * (2 * row.version + 12) * (2 * row.version + 13) - 18);
      for (const ecc of ECC_LEVELS) {
        const plan = planBlocks(row.version, ecc);
        expect(row.perEcc[ecc].payloadBytes).toBe(plan.payloadBytes);
        expect(row.perEcc[ecc].blocks).toBe(plan.blocks);
        expect(row.perEcc[ecc].payloadBytes + 4 + plan.parityCodewords).toBe(plan.codewords);
        // parityPerBlock is the rounded average: interleaved blocks are allowed
        // to differ by one codeword, so only the average is exact.
        expect(row.perEcc[ecc].parityPerBlock).toBe(Math.round(plan.parityCodewords / plan.blocks));
        expect(plan.parityCodewords).toBe(plan.codewords - plan.payloadBytes - 4);
      }
      const K = 2 * row.version + 12;
      expect(row.diameter).toBe(2 * K + 10); // printed diameter in modules, quiet zone excluded
      expect(row.modules).toBe(2 * K + 10);
      expect(row.cells).toBe(getLattice(row.version).N);
    }
  });

  it('version 40 at level L holds the advertised payload', () => {
    const row = capacityTable().find((r) => r.version === 40)!;
    expect(row.perEcc.L.payloadBytes).toBe(2689);
    expect(row.perEcc.H.payloadBytes).toBe(1439);
    expect(row.cells).toBe(25650);
  });
});

describe('format crown plumbing', () => {
  it('the encoder format word unpacks to what the encoder chose', () => {
    const sym = encode({ text: 'format word', ecc: 'Q', mask: 4 });
    const f = unpackFormat(sym.formatBits);
    expect(f).toEqual({
      versionIndex: sym.version - 1,
      ecc: ECC_LEVELS.indexOf('Q'),
      mask: 4,
      compression: sym.compression,
    });
    expect(Array.from(sym.beads)).toHaveLength(24);
    expect(Array.from(sym.teeth)).toHaveLength(63);
  });

  it('the format is recoverable from the beads alone', () => {
    const sym = encode({ text: 'https://simurgh.example/beads', ecc: 'H' });
    const res = decode({ dataBits: sym.dataBits, beads: sym.beads });
    expect(res.ok, res.error).toBe(true);
    expect(res.version).toBe(sym.version);
    expect(res.ecc).toBe('H');
    expect(payloadToText(res.payload!)).toBe('https://simurgh.example/beads');
  });

  it('decoding without a format searches ecc x mask x compression, not versions', () => {
    const sym = encode({ text: 'brute force me 12345' });
    const res = decode({ dataBits: sym.dataBits, beads: sym.beads });
    expect(res.ok, res.error).toBe(true);
    expect(res.stats!.candidatesTried).toBeLessThanOrEqual(4 * 8 * 2);
    expect(res.version).toBe(sym.version);
  });

  it('the core rosette is present in the model and is not an orientation anchor', () => {
    const cells = coreCells();
    expect(cells.length).toBe(19);
    // d <= 2 rings, and the pattern is rotationally symmetric (coreIsDark(d))
    const byDist = new Map<number, boolean[]>();
    for (const c of cells) {
      const d = hexDistance(c.cell.q, c.cell.r);
      expect(d).toBeLessThanOrEqual(2);
      const list = byDist.get(d) ?? [];
      list.push(c.dark);
      byDist.set(d, list);
    }
    expect(byDist.get(0)).toEqual([true]);
    expect(byDist.get(1)).toEqual(new Array(6).fill(false));
    expect(byDist.get(2)).toEqual(new Array(12).fill(true));
  });
});

describe('multi-frame streams', () => {
  it('splits, reassembles and reports missing frames', () => {
    const data = randomBytes(1200, 21);
    const frames = encodeFrames(data, 120, { ecc: 'M' });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.length).toBeLessThanOrEqual(4096);

    const parts = frames.map((f) => {
      const res = decode({ dataBits: f.dataBits, format: fmt(f) });
      expect(res.ok, res.error).toBe(true);
      const head = res.payload!.segments.find((s) => s.kind === 'frame') as {
        streamId: number;
        index: number;
        count: number;
      };
      const body = res.payload!.segments.find((s) => s.kind === 'byte') as { value: Uint8Array };
      return { ...head, data: body.value };
    });

    const all = reassembleFrames(parts);
    expect(all.missing).toEqual([]);
    expect(Array.from(all.data)).toEqual(Array.from(data));
    expect(all.count).toBe(frames.length);

    // Deliver them out of order and drop one: the reader must say which.
    const dropped = parts.slice().reverse().slice(1);
    const partial = reassembleFrames(dropped);
    expect(partial.missing.length).toBe(1);
    const present = dropped.reduce((a, p) => a + p.data.length, 0);
    expect(partial.data.length).toBe(present);
    const droppedIndices = new Set(dropped.map((p) => p.index));
    expect(droppedIndices.has(partial.missing[0]!)).toBe(false);
    expect(all.streamId).toBe(crc32(data) >>> 0);
  });

  it('every frame of a stream carries the same stream id and count', () => {
    const frames = encodeFrames(Uint8Array.from(Buffer.from('frame payload data '.repeat(20))), 64);
    const head = (f: (typeof frames)[number]) => f.segments.find((s) => s.kind === 'frame') as {
      streamId: number;
      index: number;
      count: number;
    };
    const ids = new Set(frames.map((f) => head(f).streamId));
    const counts = new Set(frames.map((f) => head(f).count));
    const indices = frames.map((f) => head(f).index).sort((a, b) => a - b);
    expect(indices).toEqual(indices.map((_, i) => i));
    expect(ids.size).toBe(1);
    expect(counts.size).toBe(1);
    expect([...counts][0]).toBe(frames.length);
  });
});

describe('symbology metadata', () => {
  it('publishes stable identifiers', () => {
    expect(SYMBOLOGY_NAME).toBe('SiMurgh Code');
    expect(AIM_PREFIX).toBe(']S1');
    expect(SPEC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the printed cell count matches the closed form for the chosen version', () => {
    const sym = encode({ text: 'closed form check' });
    const lat = getLattice(sym.version);
    expect(lat.K).toBe(2 * sym.version + 12);
    expect(lat.N).toBe(3 * lat.K * (lat.K + 1) - 18);
    expect(sym.dataBits.length).toBe(lat.N);
    expect(sym.rawBits.length).toBe(lat.N);
    expect(sym.maskBits.length).toBe(lat.N);
  });

  it('the printed value is always raw XOR mask, and only whole bytes carry data', () => {
    for (const version of [1, 4, 7, 13]) {
      const sym = encode({ text: 'mask algebra check', version });
      const lat = getLattice(version);
      for (let i = 0; i < lat.N; i++) {
        expect(sym.dataBits[i]).toBe(((sym.rawBits[i] as number) ^ (sym.maskBits[i] as number)) as 0 | 1);
      }
      // C = floor(N/8): the cells past 8C exist in the printed pattern but are
      // not part of any codeword, so a reader must not treat them as data.
      expect(lat.N - sym.plan.codewords * 8).toBe(lat.N % 8);
      expect(sym.plan.codewords).toBe(Math.floor(lat.N / 8));
    }
  });
});
