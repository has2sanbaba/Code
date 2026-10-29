# SiMurgh Code — Status and Roadmap

**Snapshot at specification 1.0.0, 2026-10-28.**

> **چکیدهٔ فارسی** — آنچه تا امروز ساخته و اندازه‌گیری شده، مرزهای شناخته‌شدهٔ صادقانه،
> و مسیر پیش رو در سه افق: کوتاه‌مدت (کارایی رمزگشا، بردارهای انطباق، بستهٔ WASM)،
> میان‌مدت (حالت‌های امنیتی فعال، کانال رنگی، SDK موبایل) و بلندمدت (مسیر ثبت در AIM/ISO
> و انتشار آزاد مشخصات).

---

## 1. What is built

A complete, dependency-free reference implementation of the symbology in both
directions, plus tooling:

```
packages/core    encoder, decoder, geometry, codes, DEFLATE, renderers, imaging
packages/cli     simurgh encode | decode | capacity | bench | spec  (+ PNG codec)
apps/web         playground: live encoding, robustness lab, file decoding
docs/            specification, mathematics, capacity, this roadmap
tools/           derive-angle-track.mjs -- regenerates and verifies the m-sequence
```

**116 automated tests** across three suites, all passing:

| Suite | Tests | Covers |
|---|---|---|
| `math.test.ts` | 33 | GF(256), Reed–Solomon capacity, Golay(24,12), the m-sequence's four properties, ring algebra, `N = 3K(K+1) − 18` for all 40 versions, block planning for all 40 × 4, lattice neighbours, serpentine bijectivity and adjacency, defect run-length |
| `pipeline.test.ts` | 53 | payload round trips in every mode, automatic segmentation and its cost model, RFC 1951 both directions *and against node:zlib*, compression's effect on version choice, all 8 masks, all 4 ECC levels, bit-flip and erasure correction at capacity, version selection, `CapacityError`, Format Crown plumbing, multi-frame streams |
| `imaging.test.ts` | 30 | rasteriser geometry and ink, SVG/ASCII output, locator accuracy, image decode under rotation, perspective, blur, noise, occlusion, fading, resampling, all three module shapes, RGBA input, rotation recovery, rejection of non-symbols, the ECC damage ladder, the mask-prior detector |

Measured capabilities (reference implementation, single thread, 430-px images):

| Property | Result |
|---|---|
| Clean decode | 100 % of surveyed payloads, confidence 0.97–1.00 |
| Arbitrary rotation | recovered to well under one tooth (5.71°) |
| Perspective | 25°/15° tilt: homography rms 0.179 px, centre error 0.18 px |
| Resolution floor | 4 px/module natively; 2.33 px/module via resampling |
| Damage at level M | 12 % central hole; 14 % at Q; 18 % at H |
| Combined degradation | rotation + perspective + blur + noise + hole: decodes |
| Decode time | 400–700 ms per image including the full pose solve |
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
3. **`orient.sampleTeeth` (the exported, non-pipeline variant) has a pixel-vs-model
   unit bug** carried over from an earlier design; the pipeline uses
   `sampleTeethInto`, which is correct. The dead export should be removed or fixed.
4. **No interlacing/Adam7 PNG support** in the CLI reader, and no JPEG, WebP or
   TIFF. A scanner workflow that produces JPEG needs a conversion step.
5. **Single-threaded reference speed.** ~0.5 s per decode is fine for a printer
   driver's self-check and useless for a 60 fps camera feed. The pose solve is the
   expensive part and it is embarrassingly parallel over rays.
6. **Masks 6 and 7 depend on a specific 32-bit mixer.** It is fully specified
   (Specification § 10) and deterministic, but an independent implementation must
   reproduce `mix32` bit for bit — a portability tax that the periodic masks do not
   carry.
7. **MAC and SIGNATURE modes are specified and parse, but nothing signs.** The
   segment types, the SHA-256 MAC helper and constant-time comparison exist; there is
   no key management, no signature scheme selection, and no policy for what a reader
   should do with a failed MAC.

## 3. Near term (1.1)

Ordered by value per unit of work.

* **Reader fast path.** Try fronto-parallel similarity before the 8-parameter radial
  homography, and skip the perspective solve entirely when the Limbus trace's second
  harmonic is below a threshold. Expected 3–5× on clean images, which is where 95 %
  of real reads are.
* **Conformance test vectors.** Publish, for versions 1/8/20/40 × all four ECC levels
  × a fixed payload set, the exact `dataBits`, Crown words and reference PNGs, plus
  the damaged variants used by the robustness suite. A third-party implementation
  cannot be validated against prose alone.
* **CLI batch mode.** `simurgh encode --tsv in.tsv --outdir out/` and
  `simurgh decode 'scans/*.png' --jsonl out.jsonl`, with a per-symbol exit code so a
  production line can gate on it.
* **WASM build.** The core has no dependencies and no DOM access; compiling it with
  `tsc` + a bundler to WASM (or shipping the ES module as-is, which already works)
  plus a thin C ABI would cover label printers, embedded readers and browser
  extensions.
* **Unify the ring tracer** (limit 2) and **delete the dead export** (limit 3).
* **Fuzzing.** A generator that produces valid symbols, degrades them with random
  combinations of the simulator's operators, and asserts either `ok` with the exact
  payload or a clean failure. The pieces all exist; only the harness is missing.
  Differential fuzzing of `deflate.ts` against `node:zlib` should run in the same
  harness.

## 4. Medium term (1.2 – 1.x)

* **Activate the security modes.** Define algorithm ids for MAC (HMAC-SHA-256 is
  already implemented as `macTag`) and SIGNATURE (Ed25519 would need a dependency or
  a WebCrypto shim), and specify reader policy: refuse, warn, or report. The segment
  headers already carry an algorithm nibble and a 12-bit length, so no format change
  is needed — only a policy document.
* **Colour / density channels.** The lattice supports two or three distinguishable
  ink levels per cell without changing geometry. At three levels the payload grows by
  `log₂3 = 1.58×`; the cost is a much tighter print and illumination tolerance. This
  needs a measurement study before a decision, not a decision before a measurement.
* **Structured-append UI.** `FRAME` mode exists and reassembles with missing-frame
  reporting; what is missing is a reader-side session that accumulates frames across
  scans, with a timeout and a progress signal for the operator.
* **Mobile SDK.** Camera pipeline ( autofocus/exposure lock, ROI tracking), the
  fast-path reader, and a haptic/audio confirmation contract. The imaging code is
  already allocation-light and portable; the work is platform glue.
* **Printer-side quality grading.** ISO/IEC 15415-style grading (contrast, module
  uniformity, unused error correction, axial non-uniformity) computed from a captured
  image, reported through the CLI's `--json`. The confidence and erasure statistics
  already produced are most of the input.
* **Vector artwork for print shops.** Dieline output with spot-colour separation,
  minimum-module warnings at a target dpi, and a quiet-zone violation check against a
  supplied artwork bounding box.

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
  ratio. The imaging simulator models these badly; only measurements will tell us
  where the real floor is.
* **Patent and licensing position.** The specification is published under MIT with
  the intent that it be free to implement. The structures used are classical —
  m-sequences, extended Golay, Reed–Solomon, DEFLATE, projective circle fitting — and
  the novelty is in their arrangement. A prior-art review by counsel should precede
  any standardisation submission.

## 6. Explicitly out of scope

* A different lattice. The triangular lattice, the ring algebra and the serpentine
  path are load-bearing; changing them changes the symbology.
* Rectangular or truncated variants. If a substrate is rectangular and large, use a
  frame stream; if it is rectangular and small, use a square symbology.
* Backwards compatibility with any existing symbology. There is none to be
  compatible with, and a translator would only create confusion about which format a
  reader is looking at.

## 7. Contributing

```sh
npm install
npm run typecheck     # tsc -b for core, cli and web
npm test              # vitest, 116 tests, ~40 s
npm run build
npm run dev           # playground on http://localhost:5173
npm run cli -- spec   # print the frozen constants
```

Anything that changes a printed bit, a Crown radius, a mask rule or a code
parameter needs a test in `packages/core/test` that pins the new value, and a note
in `docs/01-SPECIFICATION.md`. The Angle Track and the Crown radii are **frozen**:
they are in the specification, in the tests, and in every symbol already printed.
