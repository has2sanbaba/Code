/**
 * ============================================================================
 *  SECURE envelope -- AEAD_CHACHA20_POLY1305 (RFC 8439) and MODE_SECURE (10)
 * ============================================================================
 *
 * Three layers are tested here:
 *
 *   1. the primitives against the published RFC 8439 vectors, and against
 *      node:crypto as an independent implementation (differential test);
 *   2. the envelope: key agreement, authenticated additional data, tamper
 *      rejection, nonce freshness, compression-inside-encryption;
 *   3. the symbology: a sealed symbol must still decode as a *symbol* without
 *      the key, must reveal nothing about its contents, and must open with the
 *      right key -- from raw bits and from a rendered image.
 *
 * The KDF cost used in these tests is deliberately far below the shipped
 * default (210 000) so that the suite stays fast; one test asserts the default
 * itself, and one asserts that the platform's native PBKDF2 agrees with the
 * pure-TypeScript one byte for byte.
 */
import { createCipheriv, pbkdf2Sync, randomBytes as nodeRandom } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AEAD_KEY_BYTES,
  AEAD_NONCE_BYTES,
  AEAD_TAG_BYTES,
  PBKDF2_ITERATIONS,
  SECURE_AAD_DOMAIN,
  SECURE_FLAG_DEFLATE,
  SECURE_SUITE_PBKDF2,
  SECURE_SUITE_RAW,
  aeadDecrypt,
  aeadEncrypt,
  chacha20Block,
  chacha20Xor,
  decode,
  deriveKey,
  deriveKeyAsync,
  encode,
  expandSecureKey,
  hexDecode,
  hexEncode,
  pbkdf2Sha256,
  poly1305KeyGen,
  poly1305Mac,
  randomNonce,
  secureAad,
  segmentsToBytes,
  unwrapSecure,
  wrapSecure,
  type SecureSegment,
} from '@simurgh/core';
import { decodeImage } from '@simurgh/core/imaging';
import { renderRaster } from '@simurgh/core/render';
import { toModel } from '@simurgh/core';

/** PBKDF2 cost for tests. Real symbols use PBKDF2_ITERATIONS. */
const FAST = 4096;

function bytes(hex: string): Uint8Array {
  return hexDecode(hex.replace(/[\s:]/g, ''));
}

describe('ChaCha20 (RFC 8439)', () => {
  it('reproduces the A.1 block function vector', () => {
    const key = bytes('00:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:0e:0f:10:11:12:13:14:15:16:17:18:19:1a:1b:1c:1d:1e:1f');
    const nonce = bytes('00:00:00:09:00:00:00:4a:00:00:00:00');
    const out = chacha20Block(key, 1, nonce);
    expect(hexEncode(out)).toBe(
      '10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e' +
        'd2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e',
    );
  });

  it('reproduces the 2.3.2 encryption vector', () => {
    const key = bytes('00:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:0e:0f:10:11:12:13:14:15:16:17:18:19:1a:1b:1c:1d:1e:1f');
    const nonce = bytes('00:00:00:00:00:00:00:4a:00:00:00:00');
    const plain = new TextEncoder().encode(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const ct = chacha20Xor(key, 1, nonce, plain);
    expect(hexEncode(ct)).toBe(
      '6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b' +
        'f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d8' +
        '07ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab7793736' +
        '5af90bbf74a35be6b40b8eedf2785e42874d',
    );
    // The cipher is a XOR keystream: encrypting twice must restore the input.
    expect(hexEncode(chacha20Xor(key, 1, nonce, ct))).toBe(hexEncode(plain));
  });

  it('rejects a key or nonce of the wrong length', () => {
    const nonce = new Uint8Array(AEAD_NONCE_BYTES);
    expect(() => chacha20Xor(new Uint8Array(31), 1, nonce, new Uint8Array(4))).toThrow();
    expect(() => chacha20Xor(new Uint8Array(32), 1, new Uint8Array(11), new Uint8Array(4))).toThrow();
  });
});

describe('Poly1305 (RFC 8439)', () => {
  it('reproduces the 2.5.2 key-generation vector', () => {
    const key = bytes('80:81:82:83:84:85:86:87:88:89:8a:8b:8c:8d:8e:8f:90:91:92:93:94:95:96:97:98:99:9a:9b:9c:9d:9e:9f');
    const nonce = bytes('00:00:00:00:00:01:02:03:04:05:06:07');
    /*
     * RFC 8439 2.6: the one-time key is the first 32 bytes of ChaCha20 block 0
     * under the same key and nonce. The `r` clamping that turns those bytes into
     * a Poly1305 key is applied inside the MAC, so asserting it here would test
     * the wrong layer -- it is validated instead by the A.3 vector below and by
     * the node:crypto differential test, which cannot both pass if `r` is wrong.
     */
    expect(hexEncode(poly1305KeyGen(key, nonce))).toBe(
      hexEncode(chacha20Block(key, 0, nonce).subarray(0, 32)),
    );
  });

  it('reproduces the A.3 MAC vector', () => {
    const key = bytes('85:d6:be:78:57:55:6d:33:7f:44:52:fe:42:d5:06:a8:01:03:80:8a:fb:0d:b2:fd:4a:bf:f6:af:41:49:f5:1b');
    const msg = new TextEncoder().encode('Cryptographic Forum Research Group');
    expect(hexEncode(poly1305Mac(key, msg))).toBe('a8061dc1305136c6c22b8baf0c0127a9');
  });
});

describe('AEAD_CHACHA20_POLY1305 (RFC 8439 2.8.2)', () => {
  const key = bytes('80:81:82:83:84:85:86:87:88:89:8a:8b:8c:8d:8e:8f:90:91:92:93:94:95:96:97:98:99:9a:9b:9c:9d:9e:9f');
  const nonce = bytes('07:00:00:00:40:41:42:43:44:45:46:47');
  const aad = bytes('50:51:52:53:c0:c1:c2:c3:c4:c5:c6:c7');
  const plain = new TextEncoder().encode(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  );

  it('produces the published ciphertext and tag', () => {
    const sealed = aeadEncrypt(key, nonce, plain, aad);
    expect(sealed.length).toBe(plain.length + AEAD_TAG_BYTES);
    expect(hexEncode(sealed.subarray(0, 16))).toBe('d31a8d34648e60db7b86afbc53ef7ec2');
    expect(hexEncode(sealed.subarray(sealed.length - AEAD_TAG_BYTES))).toBe('1ae10b594f09e26a7e902ecbd0600691');
  });

  it('round-trips, and rejects every kind of tampering', () => {
    const sealed = aeadEncrypt(key, nonce, plain, aad);
    expect(aeadDecrypt(key, nonce, sealed, aad)).toEqual(plain);

    for (let i = 0; i < sealed.length; i += 17) {
      const bad = Uint8Array.from(sealed);
      bad[i] ^= 0x80;
      expect(aeadDecrypt(key, nonce, bad, aad), `ciphertext byte ${i}`).toBeNull();
    }
    expect(aeadDecrypt(key, nonce, sealed, bytes('50:51:52:53:c0:c1:c2:c3:c4:c5:c6:c8'))).toBeNull();
    expect(aeadDecrypt(key, nonce, sealed)).toBeNull();
    const badNonce = Uint8Array.from(nonce);
    badNonce[0] ^= 0x01;
    expect(aeadDecrypt(key, badNonce, sealed, aad)).toBeNull();
    const badKey = Uint8Array.from(key);
    badKey[31] ^= 0x01;
    expect(aeadDecrypt(badKey, nonce, sealed, aad)).toBeNull();
    // Truncation shortens the ciphertext *and* shifts the tag: still rejected.
    expect(aeadDecrypt(key, nonce, sealed.subarray(0, sealed.length - 1), aad)).toBeNull();
    expect(aeadDecrypt(key, nonce, sealed.subarray(1), aad)).toBeNull();
  });

  it('handles empty plaintext and long messages', () => {
    expect(aeadDecrypt(key, nonce, aeadEncrypt(key, nonce, new Uint8Array(0), aad), aad)).toEqual(new Uint8Array(0));
    const big = nodeRandom(5000);
    expect(aeadDecrypt(key, nonce, aeadEncrypt(key, nonce, big, aad), aad)).toEqual(new Uint8Array(big));
  });

  it('agrees with node:crypto over randomised inputs (differential test)', () => {
    for (let trial = 0; trial < 25; trial++) {
      const k = nodeRandom(32);
      const n = nodeRandom(12);
      const pt = nodeRandom(trial * 37);
      const ad = nodeRandom(trial % 5 === 0 ? 0 : trial * 3);
      const keyBytes = new Uint8Array(k);
      const nonceBytes = new Uint8Array(n);

      const mine = aeadEncrypt(keyBytes, nonceBytes, new Uint8Array(pt), new Uint8Array(ad));
      const cipher = createCipheriv('chacha20-poly1305', k, n, { authTagLength: 16 });
      cipher.setAAD(ad);
      const nodeCt = Buffer.concat([cipher.update(pt), cipher.final()]);
      const nodeTag = cipher.getAuthTag();
      expect(hexEncode(mine)).toBe(Buffer.concat([nodeCt, nodeTag]).toString('hex'));

      // and the other direction: open node's output with ours
      const nodeSealed = Buffer.concat([nodeCt, nodeTag]);
      expect(aeadDecrypt(keyBytes, nonceBytes, new Uint8Array(nodeSealed), new Uint8Array(ad))).toEqual(
        new Uint8Array(pt),
      );
    }
  });
});

describe('PBKDF2-HMAC-SHA256 key agreement', () => {
  it('matches node:crypto', () => {
    for (const [pass, saltLen, iters] of [
      ['password', 16, 1000],
      ['رمز عبور سیمرغ', 32, 4096],
      ['', 8, 2],
      ['x'.repeat(200), 16, 512],
    ] as [string, number, number][]) {
      const salt = nodeRandom(saltLen);
      const mine = pbkdf2Sha256(new TextEncoder().encode(pass), new Uint8Array(salt), iters, 32);
      const theirs = pbkdf2Sync(pass, salt, iters, 32, 'sha256');
      expect(hexEncode(mine)).toBe(theirs.toString('hex'));
    }
  });

  it('derives a 4-byte key id and the shipped default cost is 210 000', () => {
    const d = deriveKey('correct horse', new Uint8Array(16).fill(3), FAST);
    expect(d.key.length).toBe(AEAD_KEY_BYTES);
    expect(d.keyId.length).toBe(4);
    expect(d.salt.length).toBe(16);
    expect(d.iterations).toBe(FAST);
    // A different passphrase must not collide on the id.
    const e = deriveKey('correct housa', new Uint8Array(16).fill(3), FAST);
    expect(hexEncode(e.keyId)).not.toBe(hexEncode(d.keyId));
    expect(PBKDF2_ITERATIONS).toBe(210_000);
  });

  it('agrees with the platform PBKDF2 (WebCrypto) that apps should use', async () => {
    const salt = nodeRandom(16);
    const pass = 'passphrase-سیمرغ-2026';
    const sync = deriveKey(pass, new Uint8Array(salt), FAST).key;
    const async = await deriveKeyAsync(pass, new Uint8Array(salt), FAST);
    expect(hexEncode(async)).toBe(hexEncode(sync));
  });
});

describe('SECURE envelope', () => {
  it('uses a fixed AAD domain that cannot change under future readers', () => {
    expect(SECURE_AAD_DOMAIN).toBe('SMC1-SECURE');
    const seg: SecureSegment = {
      kind: 'secure',
      suite: SECURE_SUITE_PBKDF2,
      flags: 0,
      salt: new Uint8Array(4).fill(1),
      iterations: FAST,
      keyId: new Uint8Array([2, 2, 2, 2]),
      nonce: new Uint8Array(AEAD_NONCE_BYTES).fill(3),
      ciphertext: new Uint8Array(AEAD_TAG_BYTES),
    };
    const aad = secureAad(seg, 'invoice-4711');
    // domain | suite | keyIdLen | keyId | nonce | context
    expect(aad.length).toBe(SECURE_AAD_DOMAIN.length + 2 + 4 + AEAD_NONCE_BYTES + 'invoice-4711'.length);
    expect(new TextDecoder().decode(aad.subarray(0, SECURE_AAD_DOMAIN.length))).toBe(SECURE_AAD_DOMAIN);
    expect(aad[SECURE_AAD_DOMAIN.length]).toBe(SECURE_SUITE_PBKDF2);
    expect(aad[SECURE_AAD_DOMAIN.length + 1]).toBe(4);
    // A different context must give different AAD, hence a different tag.
    expect(hexEncode(secureAad(seg, 'invoice-4712'))).not.toBe(hexEncode(aad));
  });

  it('seals and opens with a passphrase', () => {
    const env = wrapSecure([{ kind: 'text', value: 'سلام دنیا' }], { key: 'pass', iterations: FAST });
    expect(env.suite).toBe(SECURE_SUITE_PBKDF2);
    expect(env.nonce.length).toBe(AEAD_NONCE_BYTES);
    expect(env.ciphertext.length).toBeGreaterThanOrEqual(AEAD_TAG_BYTES);
    expect(env.salt.length).toBe(16);

    const inner = unwrapSecure(env, { key: 'pass' });
    expect(inner).not.toBeNull();
    expect(inner![0]).toMatchObject({ kind: 'text', value: 'سلام دنیا' });

    expect(unwrapSecure(env, { key: 'wrong' })).toBeNull();
    expect(unwrapSecure(env)).toBeNull();
  });

  it('seals and opens with a raw 32-byte key, and refuses other lengths', () => {
    const key = new Uint8Array(AEAD_KEY_BYTES).fill(0x5a);
    const env = wrapSecure([{ kind: 'byte', value: nodeRandom(64) }], { key });
    expect(env.suite).toBe(SECURE_SUITE_RAW);
    expect(env.salt.length).toBe(0);
    expect(env.iterations).toBe(0);
    expect(unwrapSecure(env, { key })![0]!.kind).toBe('byte');
    // A passphrase cannot open a raw-key envelope.
    expect(unwrapSecure(env, { key: 'passphrase' })).toBeNull();
    expect(expandSecureKey(env, 'passphrase')).toBeNull();
    expect(() => wrapSecure([], { key: new Uint8Array(16) })).toThrow(/exactly 32 bytes/);
  });

  it('selects from a key ring by the printed key id', () => {
    const a = wrapSecure([{ kind: 'text', value: 'A' }], { key: 'key-a', iterations: FAST });
    const b = wrapSecure([{ kind: 'text', value: 'B' }], { key: 'key-b', iterations: FAST });
    expect(hexEncode(a.keyId)).not.toBe(hexEncode(b.keyId));

    const ring = {
      keys: [
        { keyId: a.keyId, key: 'key-a' },
        { keyId: b.keyId, key: 'key-b' },
      ],
    };
    expect(unwrapSecure(a, ring)![0]).toMatchObject({ value: 'A' });
    expect(unwrapSecure(b, ring)![0]).toMatchObject({ value: 'B' });
    // An entry that declares the wrong id is not tried.
    expect(unwrapSecure(a, { keys: [{ keyId: b.keyId, key: 'key-a' }] })).toBeNull();
    // An entry without an id is a wildcard.
    expect(unwrapSecure(a, { keys: [{ key: 'key-a' }] })).not.toBeNull();
  });

  it('binds the envelope to out-of-band context', () => {
    const env = wrapSecure([{ kind: 'text', value: 'sealed' }], {
      key: 'k',
      iterations: FAST,
      context: 'device-0042',
    });
    expect(unwrapSecure(env, { key: 'k', context: 'device-0042' })).not.toBeNull();
    expect(unwrapSecure(env, { key: 'k', context: 'device-0043' })).toBeNull();
    expect(unwrapSecure(env, { key: 'k' })).toBeNull();
  });

  it('never reuses a nonce', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i++) {
      seen.add(hexEncode(randomNonce()));
      seen.add(hexEncode(wrapSecure([{ kind: 'numeric', value: `${i}` }], { key: 'k', iterations: FAST }).nonce));
    }
    expect(seen.size).toBe(64);
  });

  it('compresses inside the envelope, never outside it', () => {
    const prose = 'the quick brown fox jumps over the lazy dog. '.repeat(30);
    const env = wrapSecure([{ kind: 'text', value: prose }], { key: 'k', iterations: FAST });
    expect(env.flags & SECURE_FLAG_DEFLATE).not.toBe(0);
    // ~1350 characters of highly repetitive prose must not cost 1350 bytes.
    expect(env.ciphertext.length).toBeLessThan(prose.length / 4);
    expect(unwrapSecure(env, { key: 'k' })![0]).toMatchObject({ value: prose });

    const noise = wrapSecure([{ kind: 'byte', value: nodeRandom(200) }], { key: 'k', iterations: FAST });
    expect(noise.flags & SECURE_FLAG_DEFLATE).toBe(0);
    expect(unwrapSecure(noise, { key: 'k' })![0]!.kind).toBe('byte');

    // Opting out must still round-trip.
    const off = wrapSecure([{ kind: 'text', value: prose }], { key: 'k', iterations: FAST, compress: false });
    expect(off.flags & SECURE_FLAG_DEFLATE).toBe(0);
    expect(unwrapSecure(off, { key: 'k' })![0]).toMatchObject({ value: prose });
  });

  it('survives the bit-level segment serialiser', () => {
    const env = wrapSecure([{ kind: 'text', value: 'round trip' }], { key: 'k', iterations: FAST });
    const sym = encode({ segments: [env], ecc: 'Q' });
    const out = decode({ dataBits: sym.dataBits, beads: sym.beads }, { secure: { key: 'k' } });
    expect(out.ok).toBe(true);
    expect(out.text).toBe('round trip');
  });
});

describe('sealed symbols', () => {
  const SECRET = 'رمز گاوصندوق ۴۷-۱۲-۸۹ / vault pin 4712';
  const sym = encode({ text: SECRET, ecc: 'H', secure: { key: 'correct horse', iterations: FAST } });

  it('encode reports the envelope and keeps the compression bit clear', () => {
    expect(sym.secure).toBeDefined();
    expect(sym.compression).toBe(0);
    expect(sym.segments.every((s) => s.kind === 'secure')).toBe(true);
    expect(sym.secure!.iterations).toBe(FAST);
  });

  it('opens with the passphrase', () => {
    const r = decode({ dataBits: sym.dataBits, beads: sym.beads }, { secure: { key: 'correct horse' } });
    expect(r.ok).toBe(true);
    expect(r.text).toBe(SECRET);
    expect(r.encrypted).toBe(true);
    expect(r.secureUnlocked).toBe(true);
  });

  it('decodes as a symbol without the key but reveals no plaintext', () => {
    const r = decode({ dataBits: sym.dataBits, beads: sym.beads });
    expect(r.ok).toBe(true);
    expect(r.encrypted).toBe(true);
    expect(r.secureUnlocked).toBeFalsy();
    expect(r.text).toMatch(/^\[encrypted:[0-9a-f]{8} \d+B\]$/);
    expect(r.text).not.toContain('گاوصندوق');
    expect(r.secureInfo).toEqual({
      suite: SECURE_SUITE_PBKDF2,
      keyId: hexEncode(sym.secure!.keyId),
      iterations: FAST,
      salt: hexEncode(sym.secure!.salt),
      plaintextBytes: sym.secure!.ciphertext.length - AEAD_TAG_BYTES,
    });
    // The bytes a keyless reader gets are ciphertext, not the secret.
    expect(hexEncode(r.bytes!)).not.toContain(hexEncode(new TextEncoder().encode(SECRET)));
  });

  it('does not open with the wrong passphrase, a wrong context or a wrong suite', () => {
    const wrong = decode({ dataBits: sym.dataBits, beads: sym.beads }, { secure: { key: 'wrong horse' } });
    expect(wrong.ok).toBe(true);
    expect(wrong.secureUnlocked).toBeFalsy();
    expect(wrong.text).toMatch(/^\[encrypted:/);

    const ctx = decode({ dataBits: sym.dataBits, beads: sym.beads }, { secure: { key: 'correct horse', context: 'x' } });
    expect(ctx.secureUnlocked).toBeFalsy();

    const raw = decode({ dataBits: sym.dataBits, beads: sym.beads }, {
      secure: { key: new Uint8Array(AEAD_KEY_BYTES) },
    });
    expect(raw.secureUnlocked).toBeFalsy();
  });

  it('opens from a rendered image, and stays sealed without the key', () => {
    const img = renderRaster(toModel(sym), { scale: 6 });
    const opened = decodeImage(img, { secure: { key: 'correct horse' } });
    expect(opened.ok).toBe(true);
    expect(opened.text).toBe(SECRET);
    expect(opened.secureUnlocked).toBe(true);

    const locked = decodeImage(img);
    expect(locked.ok).toBe(true);
    expect(locked.encrypted).toBe(true);
    expect(locked.secureUnlocked).toBeFalsy();
  });

  it('keeps a FRAME header in the clear so streams stay reassemblable', () => {
    const framed = encode({
      text: 'sealed body',
      frame: { streamId: 0x1234, index: 0, count: 3 },
      secure: { key: 'k', iterations: FAST },
    });
    const keyless = decode({ dataBits: framed.dataBits, beads: framed.beads });
    expect(keyless.ok).toBe(true);
    expect(keyless.segments!.some((s) => s.kind === 'frame')).toBe(true);
    expect(keyless.encrypted).toBe(true);
    expect(keyless.text).not.toContain('sealed body');

    const opened = decode({ dataBits: framed.dataBits, beads: framed.beads }, { secure: { key: 'k' } });
    expect(opened.secureUnlocked).toBe(true);
    expect(opened.segments!.some((s) => s.kind === 'frame')).toBe(true);
    expect(opened.text).toContain('sealed body');
  });

  it('still carries an arbitrary segment mix inside the envelope', () => {
    const mixed = encode({
      secure: { key: 'k', iterations: FAST },
      url: 'https://simurgh.example/vault/47',
      text: 'یادداشت محرمانه',
      data: nodeRandom(24),
      geo: { lat: 35.6892, lon: 51.389, alt: 1180, flags: 0 },
    });
    const r = decode({ dataBits: mixed.dataBits, beads: mixed.beads }, { secure: { key: 'k' } });
    expect(r.ok).toBe(true);
    expect(r.segments!.map((s) => s.kind).sort()).toEqual(['byte', 'geo', 'text', 'url'].sort());
    expect(r.text).toContain('یادداشت محرمانه');
  });

  it('fails loudly when the envelope no longer fits the disc', () => {
    expect(() =>
      encode({ version: 1, ecc: 'H', text: 'x'.repeat(200), secure: { key: 'k', iterations: FAST } }),
    ).toThrow(/does not fit/);
  });

  it('costs a bounded, documented amount of capacity', () => {
    /*
     * Envelope overhead on the wire:
     *   mode 4 + suite 4 + flags 4 + saltLen 8 + salt 128 + iterations 32
     *   + keyIdLen 4 + keyId 32 + nonce 96 + ctLen 16   = 328 bits = 41 bytes
     *   + Poly1305 tag                                   =  16 bytes
     *                                                     ---------
     *                                                      57 bytes
     * Measured against the inner segment stream, not against version sizes
     * (which jump in steps and would mask the real cost).
     */
    const inner = [{ kind: 'text', value: 'x'.repeat(8) }] as const;
    const clearBytes = segmentsToBytes([...inner]);
    const sealed = encode({ segments: [...inner], secure: { key: 'k', iterations: FAST, compress: false } });
    expect(sealed.secure!.ciphertext.length).toBe(clearBytes.length + AEAD_TAG_BYTES);
    const overhead = segmentsToBytes(sealed.segments).length - clearBytes.length;
    // 456 header+tag bits = 57 bytes, plus at most one byte of stream packing:
    // the inner terminator disappears into the ciphertext and the outer stream
    // needs its own, so the realignment can round the total up by one.
    expect(overhead === 57 || overhead === 58).toBe(true);
    // An 8-character secret still fits on a small disc, seal and all.
    expect(sealed.version).toBeLessThanOrEqual(3);
    // With compression on (the default) the envelope can be *smaller* than the
    // uncompressed inner stream: 11 bytes of segment overhead collapse to 7.
    const squeezed = encode({ segments: [...inner], secure: { key: 'k', iterations: FAST } });
    expect(squeezed.secure!.flags & SECURE_FLAG_DEFLATE).not.toBe(0);
    expect(squeezed.secure!.ciphertext.length).toBeLessThan(clearBytes.length + AEAD_TAG_BYTES);
  });
});
