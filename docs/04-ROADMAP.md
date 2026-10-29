# SiMurgh Code — Status and Roadmap

**Snapshot at specification 1.1.0, 2026-10-29.**

> **چکیدهٔ فارسی** — آنچه تا امروز ساخته و اندازه‌گیری شده، مرزهای شناخته‌شدهٔ صادقانه،
> و مسیر پیش رو. در نسخهٔ ۱٫۱ افزوده شد: پاکت رمزنگاری `SECURE` (ChaCha20-Poly1305)،
> پالت‌های رنگی با کف کنتراست، خواندن نمادهای وارون (روشن‌روی‌تیره)، اپ موبایل
> (PWA + بستهٔ Capacitor) و مستند مدل امنیتی (`docs/05`).

---

## 1. What is built

A complete, dependency-free reference implementation of the symbology in both
directions, plus tooling and two applications:

```
packages/core    encoder, decoder, geometry, codes, DEFLATE, ChaCha20-Poly1305,
                 palettes, renderers (grayscale/colour/SVG/ASCII), imaging
packages/cli     simurgh encode | decode | capacity | bench | spec  (+ PNG codec)
apps/web         playground: live encoding, robustness lab, file decoding, themes, seal
apps/mobile      installable PWA: create + camera scan + unlock, offline, worker-based
apps/android     native Kotlin app: QuickJS engine host, CameraX scan, CI-built APK
docs/            specification, mathematics, capacity, security model, this roadmap
tools/           derive-angle-track.mjs -- regenerates and verifies the m-sequence
```

**161 automated tests** across four suites, all passing:

| Suite | Tests | Covers |
|---|---|---|
| `math.test.ts` | 33 | GF(256), Reed–Solomon capacity, Golay(24,12), the m-sequence's four properties, ring algebra, `N = 3K(K+1) − 18` for all 40 versions, block planning for all 40 × 4, lattice neighbours, serpentine bijectivity and adjacency, defect run-length |
| `pipeline.test.ts` | 53 | payload round trips in every mode, automatic segmentation and its cost model, RFC 1951 both directions *and against node:zlib*, compression's effect on version choice, all 8 masks, all 4 ECC levels, bit-flip and erasure correction at capacity, version selection, `CapacityError`, Format Crown plumbing, multi-frame streams |
| `imaging.test.ts` | 30 | rasteriser geometry and ink, SVG/ASCII output, locator accuracy, image decode under rotation, perspective, blur, noise, occlusion, fading, resampling, all three module shapes, RGBA input, rotation recovery, rejection of non-symbols, the ECC damage ladder, the mask-prior detector |
| `secure.test.ts` + `visual.test.ts` | 29 + 16 | RFC 8439 vectors (cipher, Poly1305, AEAD tag), differential equality with `node:crypto` and WebCrypto PBKDF2, tamper/AAD/nonce rejection, keyring and context binding, envelope wire cost, sealed round trips through images; palette contrast arithmetic, colour rendering, polarity normalisation and its retry |

The Android app adds **eight JVM tests** (`apps/android/app/src/test`) that run in CI:
they execute the *shipped* `assets/engine.js` inside a real QuickJS runtime and
compare it bit for bit against vectors generated from the TypeScript core — encode
exactness, sealed-envelope reproduction, full image decode, and the JNI string
bridge with Persian text, quotes, newlines and U+2028.

Measured capabilities (reference implementation, single thread):

| Property | Result |
|---|---|
| Clean decode | 100 % of surveyed payloads, confidence 0.97–1.00 |
| Arbitrary rotation | recovered to well under one tooth (5.71°) |
| Perspective | 25°/15° tilt: homography rms 0.179 px, centre error 0.18 px |
| Resolution floor | 4 px/module natively; 2.33 px/module via resampling |
| Damage at level M | 12 % central hole; 14 % at Q; 18 % at H |
| Inverted symbols | light-on-dark decodes; histogram heuristic + one bounded retry |
| Themed symbols | all 8 palettes decode through camera-style luma reduction |
| Sealed symbols | decode structurally without a key; open with one; refuse tampering |
| Decode time | 330–700 ms per image including the full pose solve |
| Negative-frame cost | the scanner profile bounds it 2.3–2.6× below full search |
| Compression | within a few percent of node:zlib level 9, both directions |
| False acceptance | bounded by CRC-32 at 2⁻³² |

## 2. Known limits, stated plainly

These are documented, measured and deliberately not papered over.

1. **Beyond-capacity damage fails.** At V1/M, three separated blobs covering ~8 %
   each exceed the erasure budget even for an *oracle* erasure list (74 wrong bits =
   12.1 % of cells against a budget of 17 symbols). Level Q corrects it. This is the
   code working as designed, not a decoder defect.
2. **`rebuildLoc` still uses the circular ring trace.** The perspective-aware
   `traceOuterRing` path is used everywhere else; the version-mismatch rebuild path
   falls back to a circular trace whose coverage drops to 0.17–0.35 under tilt. It
   works because the Format Crown, not the geometry, decides the version — but it
   should be unified.
3. **The pose solve is the speed floor.** Measured in 1.1: the scanner profile
   (`retries: 2`, `noPolarityRetry`, `versionWindow: 0`, `maxCandidates: 24`) does
   **not** speed up a clean read (~1.0×: the locate→orient→rectify→sample ladder
   dominates at 330–400 ms), and that is now documented rather than promised. What
   it does is bound the cost of *negative* frames — no symbol 1001→428 ms, a symbol
   cut in half 686→261 ms — which is what a live camera loop mostly sees. A real
   positive-path speed-up has to come from the vision side (skip the homography when
   the second harmonic of the Limbus trace is small; SIMD/WASM the matched filter),
   and remains open.
4. **Portable PBKDF2 is slow by design.** The pure-TypeScript path costs ~3 s at
   210 000 iterations; WebCrypto does it in ~30 ms. The CLI derives with `node:crypto`
   and the apps with WebCrypto, so the slow path only runs where neither exists. A
   reader that passes a raw passphrase to the core on a constrained device should
   expect the portable cost.
5. **No interlacing/Adam7 PNG support** in the CLI reader, and no JPEG, WebP or
   TIFF. A scanner workflow that produces JPEG needs a conversion step (the apps
   decode camera frames directly, so this affects the CLI only).
6. **Masks 6 and 7 depend on a specific 32-bit mixer.** It is fully specified
   (Specification § 10) and deterministic, but an independent implementation must
   reproduce `mix32` bit for bit — a portability tax that the periodic masks do not
   carry.
7. **MAC and SIGNATURE modes are specified and parse, but nothing signs.** The
   segment types, the SHA-256 MAC helper and constant-time comparison exist; there is
   no key management, no signature scheme selection, and no policy for what a reader
   should do with a failed MAC. The `SECURE` envelope is a *different* layer
   (confidentiality + authenticity of the whole payload) and does not replace them.
8. **The APK is built in CI; no phone has held it yet.** `apps/android` is a native
   Kotlin project (no WebView) and `.github/workflows/android.yml` compiles it, runs
   the engine's JVM tests inside a real QuickJS runtime, verifies the one universal
   APK carries all four phone CPU ABIs (`armeabi-v7a`, `arm64-v8a`, `x86`,
   `x86_64`), and publishes it to **GitHub Releases** (`v<version>-android` plus a
   rolling `latest`) on every build of `main`. It targets **Android 6.0 (API 23)
   through the newest release** — 23 is the floor quickjs-kt's AAR allows, so
   pre-Marshmallow devices are out of reach with this engine. The sandbox that wrote
   the code has no Android SDK, Maven access or attached device, so on-device
   behaviour — camera framing, touch, PBKDF2 wall time inside QuickJS, install on a
   real 32-bit handset — is reasoned about and differentially tested, but has not
   been observed on hardware by the author.

## 3. Near term (1.2)

Ordered by value per unit of work.

* **Reader fast path, vision side.** Skip the 8-parameter radial homography when the
  Limbus trace's second harmonic is below a measured threshold, and move the matched
  filter to a coarse-to-fine pitch search. Target: <150 ms per clean frame at 640 px.
* **Conformance test vectors.** Publish, for versions 1/8/20/40 × all four ECC levels
  × a fixed payload set, the exact `dataBits`, Crown words and reference PNGs, plus
  the damaged variants used by the robustness suite, and sealed envelopes with fixed
  salt/nonce for the SECURE mode. A third-party implementation cannot be validated
  against prose alone.
* **CLI batch mode.** `simurgh encode --tsv in.tsv --outdir out/` and
  `simurgh decode 'scans/*.png' --jsonl out.jsonl`, with a per-symbol exit code so a
  production line can gate on it.
* **WASM build.** The core has no dependencies and no DOM access; compiling it to
  WASM (or shipping the ES module as-is, which already works) plus a thin C ABI would
  cover label printers, embedded readers and browser extensions — and would also fix
  limit 3's speed floor on the web.
* **Unify the ring tracer** (limit 2).
* **Fuzzing.** A generator that produces valid symbols, degrades them with random
  combinations of the simulator's operators, and asserts either `ok` with the exact
  payload or a clean failure; plus sealed envelopes that assert *refusal* under
  mutation. Differential fuzzing of `deflate.ts` against `node:zlib` in the same
  harness.
* **Structured-append session.** `FRAME` mode reassembles with missing-frame
  reporting; what is missing is a reader-side session that accumulates frames across
  scans with a timeout and an operator-visible progress signal (the mobile app shows
  per-frame results only).

## 4. Medium term (1.3 – 1.x)

* **Activate MAC/SIGNATURE policy.** Algorithm ids, Ed25519 via WebCrypto, and the
  reader policy document: refuse, warn, or report.
* **Multi-level ink channels.** The lattice supports two or three distinguishable
  ink levels per cell without changing geometry (`log₂3 = 1.58×` payload at three
  levels). The 1.1 palette work deliberately stayed at *one* ink colour per symbol —
  multi-level ink needs a print/illumination measurement study before a decision.
* **Printer-side quality grading.** ISO/IEC 15415-style grading (contrast, module
  uniformity, unused error correction, axial non-uniformity) from a captured image,
  reported through the CLI's `--json`. The confidence and erasure statistics already
  produced are most of the input; `themeContrast` is the contrast term.
* **Vector artwork for print shops.** Dieline output with spot-colour separation,
  minimum-module warnings at a target dpi, and a quiet-zone violation check against
  a supplied artwork bounding box.
* **Camera tuning on Android.** Continuous autofocus/exposure lock and ROI cropping
  through CameraX's Camera2 interop, plus a resolution ladder for large symbols;
  today the analyzer hands whole 960 px frames to the vision ladder, which is
  robust but leaves low-light behaviour and frame rate on the table.

## 5. Long term

* **Standardisation.** The realistic path is AIM's symbology registration process
  (the `]S1` prefix is already reserved in the AIM style), followed by an ISO/IEC
  JTC1 SC31 work item if there is an industrial adopter. Both require: a normative
  specification independent of the reference code (done: `docs/01-SPECIFICATION.md`),
  conformance vectors (near-term item), and at least two independent implementations.
* **Independent second implementation.** Deliberately in another language — Rust or
  Python — written from the specification alone, then differential-tested against
  this one. Every disagreement is either a specification ambiguity or a bug, and both
  are worth finding before anyone prints a million labels.
* **Physical print trials.** Thermal transfer at 203/300 dpi, inkjet on corrugated,
  laser marking on anodised aluminium, and screen rendering at 1×/2×/3× device pixel
  ratio — including the coloured palettes, whose real floor is paper and ink, not
  the luminance model.
* **Patent and licensing position.** The specification is published under MIT with
  the intent that it be free to implement. The structures used are classical —
  m-sequences, extended Golay, Reed–Solomon, DEFLATE, ChaCha20-Poly1305, projective
  circle fitting — and the novelty is in their arrangement. A prior-art review by
  counsel should precede any standardisation submission.

## 6. Explicitly out of scope

* A different lattice. The triangular lattice, the ring algebra and the serpentine
  path are load-bearing; changing them changes the symbology.
* Rectangular or truncated variants. If a substrate is rectangular and large, use a
  frame stream; if it is rectangular and small, use a square symbology.
* Backwards compatibility with any existing symbology. There is none to be
  compatible with, and a translator would only create confusion about which format a
  reader is looking at.
* Secret formats. `SECURE` seals the *payload*; the symbol always announces itself
  as a SiMurgh symbol. A format that hides its own existence cannot be scanned
  reliably by a stranger's camera, which defeats the point of a barcode.

## 7. Contributing

```sh
npm install
npm run typecheck     # tsc -b for core, cli, web and mobile
npm test              # vitest, 161 tests
npm run build         # core + cli
npm run build:all     # + web and mobile bundles
npm run dev           # playground on :5173
npm run mobile        # mobile app on :5174
npm run icons         # regenerate PWA + Android icons from a live symbol
npm run cli -- spec   # print the frozen constants
```

Anything that changes a printed bit, a Crown radius, a mask rule, a palette's
contrast floor or a code parameter needs a test in `packages/core/test` that pins
the new value, and a note in `docs/01-SPECIFICATION.md`. The Angle Track, the Crown
radii and the SECURE AAD domain string are **frozen**: they are in the
specification, in the tests, and in every symbol already printed.
