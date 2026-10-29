# Security model — مدل امنیتی

**Specification 1.1.0 — 2026-10-29.** This document states what SiMurgh Code
*does* and *does not* protect, and how each claim is tested. Claims without a
test reference are explicitly marked as untested.

---

## خلاصهٔ فارسی

سیمرغ‌کد دو لایهٔ مستقل دارد:

1. **لایهٔ قالب** (تاج، دندانه‌ها، Reed-Solomon، CRC-32): تضمین می‌کند نمادِ
   *آسیب‌دیده* درست خوانده شود. این لایه «بازسازی ریاضی» را ممکن می‌کند — و
   دقیقاً همان چیزی است که در QR هم وجود دارد.
2. **لایهٔ مهر و موم** (حالت `SECURE`، شمارهٔ ۱۰): محتوا را با
   `AEAD_CHACHA20_POLY1305` (RFC 8439) و اشتقاق کلید `PBKDF2-HMAC-SHA256`
   رمز می‌کند.

نکتهٔ کلیدی: وقتی نماد قفل است، لایهٔ اول روی **رمزنگاشته** کار می‌کند، نه روی
متن. پس «بازسازی ریاضیِ» یک نماد آسیب‌دیدهٔ قفل‌شده، رمزنگاشتهٔ کامل به شما
می‌دهد — که بدون کلید همان‌قدر بی‌معناست که نصف آن. هیچ مسیر محاسباتی وجود ندارد
که از قالبِ علنی به متنِ روشن برسد؛ تگ ۱۲۸ بیتی Poly1305 هر تغییر یک بیتی را رد
می‌کند.

آنچه قفل‌کردن **نمی‌پوشاند**: اندازهٔ تقریبی راز، شناسهٔ کلید، نمک و هزینهٔ
PBKDF2 (همه علنی چاپ می‌شوند تا گیرنده بتواند کلید بسازد)، و ضعف خودِ گذرواژه.
گذرواژهٔ کوتاه با جست‌وجوی آفلاین شکسته می‌شود؛ برای دادهٔ واقعی، کلید ۲۵۶ بیتی
تصادفی (حالت raw) استفاده کنید.

---

## 1. Two layers, two different promises

### 1.1 The format layer: integrity, not secrecy

| Mechanism | Role | Failure it catches |
| --- | --- | --- |
| Format Crown, 24 beads in Golay(24,12) | version / ECC / mask / compression | up to 3 bead flips, exactly decoded |
| Angle Track, 63-bit order-6 m-sequence | absolute rotation, teeth synchronisation | cyclic autocorrelation −1 ⇒ mis-sync is detected, not mis-decoded |
| Reed-Solomon over GF(2⁸), interleaved | error *and* erasure correction | up to 55 % parity at level H, see docs/03 |
| CRC-32 over the payload | final accept/reject oracle | any residual wrong payload, p ≈ 2⁻³² |

This layer is **public by design**: anyone can repair a damaged symbol, because
there is nothing to hide in an open symbol. That is the feature QR users know as
"reconstruction": the format is a public error-correcting code, and completing a
torn symbol is simply decoding.

### 1.2 The seal layer: secrecy and authenticity

Mode **10 (`SECURE`)** wraps any segment list in an authenticated envelope:

```
mode(4)=10 | suite(4) | flags(4) | saltLen(8) | salt | iterations(32)
           | keyIdLen(4) | keyId | nonce(96) | ctLen(16) | ciphertext‖tag(128)
```

* `suite 0` — passphrase: `key = PBKDF2-HMAC-SHA256(pass, salt, iterations)`,
  default **210 000 iterations** (OWASP 2023 for SHA-256).
* `suite 1` — a raw 256-bit key supplied by a KMS/HSM or an out-of-band channel.
* `flags` bit 0 — the plaintext was compressed with raw DEFLATE *before*
  encryption (compress-then-encrypt; the reverse order is meaningless and
  leaks lengths to an observer of the ciphertext).
* `nonce` — 96 bits, always freshly generated from the platform CSPRNG
  (WebCrypto). **Nonce reuse under one key is catastrophic** for any AEAD; the
  encoder never derives a nonce from the payload for exactly this reason.
* `keyId` — 4 bytes, `HMAC("SiMurgh key id v1", key)[0..4]`, printed so a reader
  with a keyring knows which key to use. It is a *hint*, not a secret.
* AAD — `utf8("SMC1-SECURE") ‖ suite ‖ keyIdLen ‖ keyId  nonce ‖ context`.
  The domain string is frozen: it deliberately contains no version or date, so
  symbols printed today keep opening after a future specification bump.
  `context` lets a deployment bind the ciphertext to data that is *not* printed
  (an invoice number, a device serial); a reader that cannot supply it gets the
  same answer as a wrong key, namely nothing.

Authenticated encryption means the tag (Poly1305, 128 bits) is checked in
constant time **before** any plaintext is returned. There is no "partially
decrypted" state.

### 1.3 Why a damaged sealed symbol cannot be reconstructed into plaintext

The two layers compose in one direction only:

```
plaintext ──DEFLATE──▶ ──ChaCha20-Poly1305──▶ ciphertext ──segments──▶ RS/CRC ──▶ symbol
```

* Damage to the *symbol* is repaired by Reed-Solomon **on ciphertext bytes**.
  The repair is exact (or the CRC refuses the result); it never invents
  plaintext, because plaintext is not present anywhere in the symbol.
* Completing a *missing* region of the symbol by the format layer yields a
  complete ciphertext. Without the key that ciphertext is indistinguishable
  from random to any polynomial-time adversary (ChaCha20-Poly1305 is an AEAD
  under the standard assumptions).
* Flipping, truncating or transplanting any byte changes the tag's input, so the
  envelope opens to *nothing* — not to a corrupted secret. A forged symbol is
  therefore not "a symbol with a wrong message", it is a symbol with no message.
* The QR comparison, stated precisely: QR has layer 1 and no layer 2. SiMurgh
  with `SECURE` has both, and layer 1 operates below the ciphertext. SiMurgh
  without `SECURE` makes exactly QR's promise — integrity, never secrecy — and
  says so.

## 2. What an attacker *can* learn (the honest leakage list)

A reader without the key learns, from a sealed symbol:

| Leaked | Why it must be public |
| --- | --- |
| version, ECC level, mask, cell count | geometry; needed to even sample the symbol |
| that the payload is sealed, and its suite | format honesty; the decoder reports `encrypted` |
| `keyId` (4 B) | keyring routing |
| `salt` (16 B) and `iterations` | the reader must derive the same key |
| ciphertext length ±1 byte | unavoidable; mitigated by in-envelope compression |
| whether a FRAME header is present | stream reassembly requires it in the clear |

It does **not** learn: any plaintext byte, the plaintext's structure beyond its
length, or a way to modify the ciphertext undetected.

Consequences the deployment must accept:

1. **Passphrase quality is the security level.** `salt` and `iterations` are
   printed, so an offline dictionary attack against a passphrase-secured symbol
   costs `iterations` HMAC-SHA256 per guess — expensive at 210 000, but a GPU
   farm still tries billions. For anything real, use suite 1 with a random
   256-bit key, or a passphrase of 6+ random words.
2. **Length leaks.** A sealed payload reveals the compressed plaintext length.
   Pad your plaintext if lengths are sensitive (the API accepts any bytes).
3. **The endpoint is not protected.** A camera, a screen, or a compromised
   reader app sees plaintext the moment it is unlocked. No barcode scheme can
   help there; that is a key-management problem, and the `context` binding
   exists precisely to let a verifier tie a symbol to a channel it trusts.
4. **No revocation, no forward secrecy.** A printed symbol is forever. Treat it
   like printed key material: short secrets, short lifetimes, or a rotating
   `keyId`.

## 3. What is tested, where

| Claim | Test |
| --- | --- |
| ChaCha20 block + cipher match RFC 8439 A.1, §2.3.2 | `packages/core/test/secure.test.ts` |
| Poly1305 MAC matches RFC 8439 A.3 | same |
| AEAD ciphertext **and** tag match RFC 8439 §2.8.2 | same |
| One-time Poly1305 key = ChaCha20 block 0, first 32 bytes (§2.6) | same, derived from the construction |
| Implementation equals `node:crypto` `chacha20-poly1305`, 25 random cases, both directions | same |
| PBKDF2 equals `node:crypto.pbkdf2Sync` (4 parameter sets) and WebCrypto's native PBKDF2 | same |
| Every ciphertext bit flip, tag truncation, AAD change, key change, nonce change ⇒ `null` | same |
| Nonces never repeat across 64 envelopes | same |
| Sealed symbol decodes as a symbol, reports `encrypted`, leaks no plaintext | same |
| Wrong passphrase / wrong context / wrong suite ⇒ still sealed | same |
| Keyring selection by `keyId`; wildcard entries | same |
| FRAME header stays in the clear; sealed body opens beside it | same |
| Envelope wire overhead is exactly 57 B + at most 1 packing byte | same |
| Sealed symbol round-trips through a rendered image, with and without the key | same |
| CLI: `--selftest` on a sealed symbol opens it and compares plaintext | manual + CLI contract |
| Mobile app: worker returns locked/unlocked correctly, incl. raw-key and hint flows | `apps/mobile` worker smoke path (built bundle) |

Untested, by nature: resistance of ChaCha20/Poly1305/PBKDF2 themselves (we rely
on published analysis and on `node:crypto`/WebCrypto agreement), and the quality
of the platform CSPRNG.

## 4. Key management guidance

1. **Humans** → suite 0, ≥6 random words, default iterations, and a `context`
   string that only the intended reader knows.
2. **Machines** → suite 1 with a key from a KMS; rotate `keyId`s; never embed a
   raw key in a client binary — the app in this repository asks the user to type
   or paste it and keeps it in memory only.
3. **Verification** → print the `keyId` next to the symbol in human-readable
   form so a human can confirm which key should open it (the app shows it).
4. **Storage** → a sealed symbol is ciphertext, but store it like a password
   hash: the salt and cost are public *by design*, so treat the symbol itself as
   the challenge, not as a secret.

## 5. Robustness is not security, but it is part of the promise

* **Polarity**: `decodeImage` normalises light-on-dark symbols (histogram
  heuristic + one bounded retry). Tested in `visual.test.ts`, including the case
  where the heuristic guesses wrong.
* **Colour**: palettes are constrained by WCAG luminance contrast; the print
  floor is 7:1 and every shipped theme clears it (`themeContrast`, tested).
  A themed symbol is still scanned in the test suite through the same
  luminance reduction a camera performs.
* **Damage**: the erasure ladder and the mask-prior damage detector are bounded
  by the parity budget on purpose; `brutal` presets are *refused* rather than
  half-decoded (docs/04, limit 1). A refused decode is the correct security
  behaviour: never emit a payload the CRC did not accept.

## 6. Auditability

* No network calls anywhere in the decode path; the mobile app ships a service
  worker that makes the *whole app* offline, and its Android manifest requests
  only CAMERA and VIBRATE.
* Every constant in this document lives in `packages/core/src` and is frozen by
  tests; the CLI's `spec` command prints them.
* The cryptographic core is ~600 lines with no dependencies and no fallbacks:
  if WebCrypto is missing, key derivation uses the in-repo implementation and
  random generation *throws* rather than silently weakening.
