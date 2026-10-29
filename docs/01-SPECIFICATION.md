# SiMurgh Code (SMC) — Symbology Specification

**Version 1.0.0 — 2026-10-28 — normative**

> **چکیدهٔ فارسی** — «سیمرغ کد» یک نمادنگاری دوبعدیِ *شعاعی* است: داده به‌جای شبکهٔ مربعی،
> روی یک شبکهٔ مثلثیِ شش‌گوش در حلقه‌های هم‌مرکز نوشته می‌شود و مرزِ نماد («تاج») از پنج نوار
> هم‌مرکز ساخته شده است: هاله، ۲۴ دانهٔ قالب (کد گولی ۲۴٬۱۲)، ۶۳ دندانِ زاویه‌یاب
> (دنبالهٔ m از مرتبهٔ ۶)، منقار (مرجع فاز) و لیمبوس (حلقهٔ اندازه‌گیری).
> بارِ نماد با رید–سالامون درهم‌بسته محافظت می‌شود، با DEFLATE فشرده می‌شود و با CRC-32 مهر تأیید می‌خورد.
> متن، پیوند، دادهٔ دودویی، مختصات جغرافیایی و جریانهای چندقابته را حمل می‌کند.
> این سند مرجعِ هنجاری (normative) است؛ اعداد آن با پیاده‌سازی در `packages/core/src` یکی است.

The authoritative form of this specification is executable: every constant, table
and algorithm below is implemented in `packages/core/src` and asserted by the test
suite in `packages/core/test`. Where prose and code disagree, the code wins and the
prose is a bug.

---

## 1. Scope

SiMurgh Code is a two-dimensional matrix symbology for automatic identification.
It stores arbitrary digital data — text in any script, URLs, raw binary, geographic
fixes, and multi-frame streams — in a rotationally symmetric printed pattern that is
read from any orientation without a search.

It is **not** a variant of QR Code, Data Matrix, Aztec, PDF417 or any linear
symbology. It shares no finder pattern, no grid, no alignment pattern and no bit
placement rule with them. Its distinguishing structures are:

| Structure | Purpose | Uniqueness |
|---|---|---|
| Triangular (hexagonal) lattice | Data cells | ~15 % more cells per printed diameter than a square grid |
| Serpentine ring path | Bit order | Consecutive modules are always lattice neighbours |
| Angle Track: 63-tooth m-sequence | Absolute rotation | Cyclic autocorrelation −1 ⇒ one correlation, no search |
| Format Crown: 24 beads, Golay(24,12) | Version/ECC/mask/compression | Minimum distance 8 in a 24-bit ring of discs |
| Halo + Limbus at a fixed 3.80-module separation | Scale and pose | Two concentric circles ⇒ a rotation-invariant perspective solve |
| Core rosette (19 cells) | Visual anchor, print check | Rotationally symmetric by design: carries no orientation |

## 2. Notation and coordinate system

* The lattice is the **triangular lattice of pitch 1**. A cell is addressed by axial
  coordinates `(q, r)` and drawn at

  ```
  x = q + r/2
  y = (√3/2) · r
  ```

  with angle 0 along `+x` and angles increasing counter-clockwise.
* The hexagonal ring index ("distance") of a cell is
  `d(q, r) = (|q| + |r| + |q + r|) / 2`. Ring `d` contains `6d` cells; ring 0 is the
  single centre cell. **Note that `hexDistance` takes the difference of two cells'
  coordinates, not two cells.**
* The inverse map is `r = 2y/√3`, `q = x − r/2`, followed by axial rounding.
* A module's circumradius is `1/√3 ≈ 0.5774`; the printed dot radius is `0.46`.
* Images have `y` increasing downward, so a model point at angle θ maps to image
  angle −θ. All rotations in this document are stated in **model** space
  (counter-clockwise positive).
* Ink is `0` and substrate is `255` in the reference rasteriser.

## 3. Versions and the data field

Version `V ∈ [1, 40]` has outermost data ring

```
K = 2V + 12          (K ∈ [14, 92])
```

and data cells

```
N = 3K(K+1) − 18
```

(the −18 removes the two innermost rings, which belong to the Core rosette).
`N` is therefore the number of printed data modules; `V1 → N = 612`,
`V40 → N = 25650`.

The cell index space is `0 … N−1` in ring order: ring `d` starts at
`ringOffset[d] = 1 + 6·d·(d−1)/2 − 18` and runs counter-clockwise from its
canonical start cell.

**Remainder cells.** `C = ⌊N/8⌋` codewords are carried; the `N − 8C` cells at the
end of the path (at most 7, always in the outermost rings) are printed with the
mask pattern only. A reader must not treat them as data.

## 4. The Crown (border design)

All radii are in module pitches and are given as offsets from `K`, so the whole
Crown grows with the version and every gap between features is at least half a
pitch — which is what makes them separable in a radial profile at the resolution
floor.

| Band | Radial extent | Content |
|---|---|---|
| **Halo** | `[K+0.90, K+1.20]` | Solid thin ring, 0.30 wide. Inner guard and the inner half of the scale reference. |
| **Beads** | centre `K+2.20`, disc radius `0.38` | 24 discs at `15°` offsets, first at `7.5°`. The Format Crown codeword, one bit per bead. |
| **Teeth** | `[K+3.10, K+4.10]` | 63 equal sectors of `360/63 = 5.714286°`. Inked sector = 1. The Angle Track. |
| **Beak** | tooth 0 extended to `K+4.70` | Breaks the rotational symmetry of the Teeth band; the phase reference. |
| **Limbus** | `[K+4.70, K+5.00]` | Solid outer ring. Outer guard, print-boundary, and the trace used for the perspective solve. |
| **Quiet zone** | `2.5` modules beyond `K+5.00` | Substrate only. |

Derived constants, all normative:

```
outerRadius  = K + 5.00
canvasRadius = K + 7.50
printed diameter = 2K + 10 modules
beadAngle(i) = i · 15 + 7.5 degrees,  i = 0 … 23
haloRadius   = K + 1.05
limbusRadius = K + 4.85
limbusRadius − haloRadius = 3.80     (exact)
```

The 3.80-module separation is not decorative. Under an arbitrary projective
transform, every Crown band lies at a *known ratio* of the traced Limbus radius:
a ray that finds the Limbus at `r_outer(α)` knows the Halo is at
`r_outer(α) · (1.05/4.85)`, the Beads at `· (2.20/4.85)`, the Teeth at
`· (3.10/4.85)` and `· (4.10/4.85)`. The local pitch on that ray is
`r_outer(α) / 4.85`. No assumption about the symbol being circular, centred or
fronto-parallel is needed anywhere in the pipeline.

### 4.1 Core rosette

The 19 cells with `d ≤ 2` are printed with a fixed pattern:

```
d = 0 : dark        (the pupil)
d = 1 : light       (6 cells)
d = 2 : dark        (12 cells)
```

i.e. `coreIsDark(d) = (d ≠ 1)`. It is rotationally symmetric, so it deliberately
carries **no** orientation information; it exists as a visual anchor, as a focus
target for cameras, and as a cheap sanity check for the sampler (a reader that
misreads the rosette has a bad transform).

## 5. Angle Track

The 63 teeth carry one period of the **order-6 maximum-length sequence** generated
by `p(x) = x⁶ + x + 1` over GF(2), read MSB-first from tooth 0:

```
111111010101100110111011010010011100010111100101000110000100000
hex: 0xFD59BB49C5E51840     (63 bits, zero-padded to 64)
```

Properties, all verified by the test suite:

* length `L = 2⁶ − 1 = 63`, weight 32;
* **every cyclic window of 6 consecutive teeth decodes to a unique absolute tooth
  index** — a de Bruijn property of m-sequences;
* cyclic autocorrelation is `−1` for every non-zero shift, i.e. the sequence is
  uncorrelated with every rotation of itself;
* run-length distribution is Golomb: `{1:16, 2:8, 3:4, 4:2, 5:1, 6:1}`;
* the reversed sequence is **not** a cyclic shift of it, so a mirror image is
  detectable;
* phase is recovered by cyclic correlation over all 63 teeth, and remains correct
  with up to 40 % of the band occluded.

Rotation is therefore a single correlation, not a search, and the residual error is
a small fraction of one tooth (5.71°).

## 6. Format Crown

The 24 beads carry one codeword of the **extended binary Golay code G₂₄**
(generator polynomial `0xC75`, minimum distance 8). Twelve information bits:

| Bits | Field | Range |
|---|---|---|
| 11..6 | `versionIndex` | `V − 1`, 0…39 |
| 5..4 | `ecc` | 0=L, 1=M, 2=Q, 3=H |
| 3..1 | `mask` | 0…7 |
| 0 | `compression` | 0=none, 1=raw DEFLATE (RFC 1951) |

Decoding is exhaustive maximum-likelihood over the 4096 codewords: the nearest
codeword is returned with its Hamming distance. The code corrects any 3 bead errors
and detects 4.

**G₂₄ is not a perfect code.** Its covering radius is 4: a radius-3 ball holds
`1 + 24 + 276 + 2024 = 2325` words, so 4096 codewords cover 9 523 200 of the
16 777 216 possible 24-bit patterns and roughly 43 % of all patterns lie exactly 4
bits from the nearest codeword. For those, the decoder returns a *nearest* word that
may be wrong. This is why the Format Crown is never the final authority: if the
payload CRC-32 fails, the reader retries the remaining format candidates (§ 11).

## 7. Data placement — serpentine ring path

Codeword bits are written along a **continuous outward serpentine** over rings
`d = 3 … K`:

* ring `d` is traversed counter-clockwise when `d` is odd, and clockwise when `d`
  is even;
* each ring's traversal starts where the previous ring ended (nearest cell).

Consequence, and the reason this path exists: **every consecutive pair of modules
in the bit stream are lattice neighbours** (verified for V ∈ {1, 3, 8, 17}).

Why that matters quantitatively. A compact physical defect — a hole, a scratch, a
sticker, a thumbprint — covers a disc of radius `R`. With a *scattered* placement
the damaged bits are spread over every block, and the code can only correct them
while their number is below the error budget of each block, i.e. `f ≤ ρ/16`
(1.75 % of cells at level M). With a *contiguous* placement plus block
interleaving (§ 8), the damage lands in `O(R)` short runs, each run hitting every
block in a few consecutive symbols, and the reader can declare them **erasures**:

```
scattered           : f ≤ ρ/16   (M: 1.75 %,  H: 3.4 %)
contiguous, errors  : f ≤ ρ/2    (M: 14 %,    H: 27.5 %)
contiguous, erasures: f ≤ ρ      (M: 28 %,    H: 55 %)
```

A factor of sixteen in survivable damage for a hole of the same size. Measured
behaviour matches: at V1, a centred disc covering 12 % of the symbol decodes at
level M with 46 cells declared erased, and a 10 %-area defect at V8 produces 18
contiguous runs — `O(R)`, not `O(R²)`.

The path is a bijection (`Lattice.serpentine[i]`, inverted by
`spiralIndexOfCell`).

## 8. Error correction

* Field: GF(2⁸) with `p(x) = x⁸ + x⁴ + x³ + x² + 1` (0x11D) and `α = 2`.
* Code: systematic Reed–Solomon, **block length ≤ 255** (a hard constraint: the
  evaluation points `X_p = α^(n−1−p)` collide for `n > 255`).
* Decoding: Berlekamp–Massey, Chien search, Forney, with erasure support and a
  residual-syndrome check. A block whose syndrome is still non-zero after
  correction is reported as failed rather than silently accepted.
* Parity fraction ρ by level:

  | Level | ρ | Corrects (errors) | Corrects (erasures) |
  |---|---|---|---|
  | L | 0.16 | 8 % of codewords | 16 % |
  | M | 0.28 | 14 % | 28 % |
  | Q | 0.40 | 20 % | 40 % |
  | H | 0.55 | 27.5 % | 55 % |

* Block planning, for `C = ⌊N/8⌋` codewords and `P = round(ρC)` parity symbols
  clamped to `[2, C−5]`:

  ```
  B = max(1, ⌈C / 192⌉)
  while B > 1 and ⌊P/B⌋ < 2 : B −−       (every block needs 2 parity symbols)
  while ⌈C/B⌉ > 255         : B ++       (RS length limit)
  ```

  Data and parity are distributed as evenly as possible (`dPer + extra`,
  `pPer + extra`).
* **Interleaving**: codewords are written across blocks in round-robin order, so a
  burst of consecutive modules touches every block equally. The user payload is
  `D − 4` bytes where `D = C − P`; the last four data codewords are the CRC-32.

## 9. Payload

### 9.1 Segment modes

| Mode | Name | Header | Data |
|---|---|---|---|
| 0 | TERMINATOR | 4 zero bits | — |
| 1 | NUMERIC | count, 14 bits | 3 digits → 10 bits, 2 → 7, 1 → 4 (3.33 bits/digit) |
| 2 | C64 | count, 14 bits | `a–z A–Z 0–9 space` = codes 0…62; code 63 = ESCAPE followed by the character's raw UTF-8 bytes |
| 3 | TEXT | count, 16 bits | raw UTF-8 |
| 4 | BYTE | count, 16 bits | arbitrary bytes |
| 5 | URL | see below | |
| 6 | GEO | 92 bits | lat, lon as int32 at 1e−7°; altitude int16 biased +1000 m; 8 flag bits |
| 7 | FRAME | streamId 32, index 12, count 12 | multi-symbol streams |
| 8 | MAC | algo 4, length 12 | authentication tag |
| 9 | SIGNATURE | algo 4, length 12 | detached signature |
| 15 | VENDOR | id 16, length 16 | private use |

**URL mode.** `scheme` (3 bits: 0=https, 1=http) · `authorityLength` (8) ·
authority as a base-39 big integer over `a-z0-9-.:` · `bodyLength` (14) · body in
the 6-bit alphabet

```
U64 = "abcdefghijklmnopqrstuvwxyz0123456789-._/?=&%:#+~@,;()!$'*[] "
      code 60 = UPPER_SHIFT (next code 0..25 is A..Z), 63 = ESCAPE (raw UTF-8)
```

Costs per character: digits 3.33 · URL body 6.00 · hostname 5.29 · Latin prose
(C64) 6.00 · any other text (TEXT/UTF-8) 8.00 · a 2-byte UTF-8 character through a
C64 escape 22.00 — which is why the mode selector picks TEXT for Persian and CJK
prose and C64 for Latin.

### 9.2 Automatic mode selection

`autoSegments` runs a dynamic programme over NUMERIC / C64 / TEXT candidates for
every substring, with URL mode preferred when the whole payload is an `http(s)`
URL. The cost model charges exactly what the writer emits — including the full
UTF-8 length of every escaped character — so the chosen segmentation and the
version selected from its size can never disagree.

### 9.3 Block layout

```
segments · TERMINATOR · zero-pad to byte boundary · alternating 0xEC 0x11 pad
        · CRC-32 (4 bytes, big endian) as the final four data codewords
```

The CRC-32 (IEEE polynomial, `crc32("123456789") = 0xCBF43926`) is the arbiter of
every decode: a candidate is accepted only if the CRC matches, which makes a false
acceptance a 2⁻³² event even when Reed–Solomon miscorrects.

### 9.4 Compression

When the `compression` format bit is 1, the byte string of § 9.3 *before padding*
is compressed with **raw DEFLATE (RFC 1951)**, implemented in the core with no
dependencies (LZ77 with hash chains, fixed and dynamic Huffman blocks, stored
blocks; the inflater accepts all three). Streams are interoperable both ways with
`node:zlib`. Compression is applied only when it actually shrinks the payload and
the payload is at least 24 bytes; the version is then chosen from the *compressed*
length. Zero padding after the final DEFLATE block is harmless because a reader
stops at `BFINAL`.

Typical effect on real payloads:

| Payload | Without | With DEFLATE | Symbol |
|---|---|---|---|
| 2 160 chars of prose | V32, 17 538 cells | V7, 2 088 cells | 8.4× smaller disc |
| 6 900 chars of prose | does not fit V4 | fits V4 | — |
| 47-char URL | V1 | V1 | no change (already small) |
| 300 random bytes | V11 | V10 | incompressible |

## 10. Masks

Eight masks balance the printed ink and break up large uniform areas, which both
helps the sampler's two-cluster threshold and reduces the chance that a defect is
mistaken for data. `maskBit(id, q, r, V)`:

| id | rule |
|---|---|
| 0 | `q mod 3 = 0` |
| 1 | `r mod 3 = 0` |
| 2 | `(q + r) mod 3 = 0` |
| 3 | `(q − r) mod 2 = 0` |
| 4 | `d(q, r) mod 2 = 0` (ring parity) |
| 5 | `(q² + 3r) mod 5 < 2` |
| 6 | `mix32(q, r, V, 6) & 1` |
| 7 | `mix32(7q+3, 11r+5, 13V+1, 7) & 1` |

with the deterministic mixer

```
mix32(a, b, c, d):
  h = 0x9E3779B9
  h = (h ^ (a + 0x165667B1)) · 0x85EBCA6B ;  h ^= h >>> 13
  h = (h ^ (b + 0xC2B2AE35)) · 0x27D4EB2F ;  h ^= h >>> 16
  h = (h ^ (c + 0x2545F491)) · 0x85EBCA6B ;  h ^= h >>> 13
  h = (h ^ (d + 0x9E3779B9)) · 0xC2B2AE35 ;  h ^= h >>> 16
  return h >>> 0
```

(all multiplications are 32-bit). Masks 6 and 7 are pseudo-random and depend on the
version, so they break up payloads that align badly with the periodic masks.

The printed value is `data ⊕ mask`. Penalty used for automatic selection:

```
P = 2000 · |inkRatio − 0.5|
  + 1200 · (fraction of neighbour pairs with equal colour)
  +   40 · max(0, longest monochrome arc along any ring − 6)
```

All eight masks land between 42 % and 58 % ink on the data field for typical
payloads; measured 49.7–51.1 % across a twelve-payload survey.

## 11. Decoding (normative sequence)

1. **Threshold.** Take the 2nd and 98th percentile of the image as the ink and
   substrate levels; split with the midpoint of the darkest and lightest 15 %
   (plain Otsu is wrong here — a clean symbol is a two-bin histogram and Otsu
   returns an arbitrary maximiser).
2. **Locate.** Radial profile over 256 rays at 0.5-pixel steps from candidate
   centres; matched filter against the expected Crown band pattern; refine with
   `refineFromRingPairs`. Then trace the Limbus over 180 rays and fit a circle
   (three passes). Score the hypothesis on band agreement. The best hypothesis is
   always returned; the CRC is the arbiter, not a score threshold.
3. **Solve the pose.** Fit **radial harmonics** to the traced Limbus
   `r_outer(α) = c₀ + a₁cos α + b₁sin α + a₂cos 2α + b₂sin 2α`; the first harmonic
   gives the projected centre offset, the second gives the tilt. Then fit an
   8-parameter radial homography by least squares to the two known concentric
   circles (`‖Gp‖ = ρ` for the Halo at 1.05 and the Limbus at 4.85), with two
   Tukey IRLS passes. This system is **rotation invariant** and has no basin of
   attraction, unlike point-correspondence fitting.
   * Guard: reject if `rms > 4 px`, `det ≤ 0`, or the implied scale leaves
     `0.55 < scale/pitch < 1.8`.
   * Note that driving the first harmonic to zero moves the pole to the *ellipse
     centre*, which is **not** the projected model centre (≈15 px ≈ 1.5 modules off
     at 25° tilt). The fit must keep it.
4. **Rotation.** Correlate the 63 sampled teeth with the m-sequence over all shifts,
   in the mapped space; `ψ = −sFine · 360/63`, and the model rotation is composed as
   `H ∘ Rot(−ψ)`. The sign matters: `H = H_true ∘ Rot(ψ)`.
5. **Sample.** For each of the `N` cells, average a 13-point sunflower disc of
   radius `0.40 · pitch` through the transform, with a per-cell local scale.
   Quantise with the two-cluster cut and record a confidence per cell. Sample the
   24 beads, 63 teeth and 19 core cells the same way.
6. **Damage prior.** For each cell, count dark neighbours in its 19-cell
   neighbourhood. Under a balanced mask that count is `Binomial(19, ½)`; a
   uniformly bare or uniformly inked neighbourhood has probability `3.8·10⁻⁵`.
   Cells beyond a strict threshold become **seeds**; their lattice neighbours are
   dilated. Their confidence is cut (0.02 for seeds, 0.35 near, 0.7 far), which
   turns them into erasures. Measured false-seed rate on clean symbols:
   **2.1 per 612-cell symbol**.
7. **Format.** Decode the 24 beads as Golay. If it succeeds, use it; the version is
   re-derived geometrically if it disagrees with the located size.
8. **Payload.** Unmask, de-interleave, and run Reed–Solomon per block with a
   **per-block erasure budget** of `⌊n_b · ρ⌋` symbols (a global budget lets one
   hole spend the redundancy of untouched blocks). If a block fails, retry the
   remaining format candidates — `ecc × mask × compression = 64`, never the
   version, which is recovered geometrically.
9. **Accept** only on a matching CRC-32. Then inflate if the compression bit is set,
   parse the segment stream, and return the payload with statistics.

**Early bail.** If the Crown did not decode, fewer than 40 of 63 teeth matched and
mean confidence is below 0.30, the image does not contain a SiMurgh symbol; the
reader stops instead of running the ladder over a false hypothesis (this bounds the
worst case at ≈200 ms instead of ≈23 s on adversarial inputs).

## 12. Dimensions and print

* Printed diameter: `2K + 10` modules (38 at V1, 194 at V40), plus a 2.5-module
  quiet zone on every side.
* Module shapes: `dot` (radius 0.46), `hex` (tiles the lattice exactly), `square`
  (Chebyshev, gap 0.94). All three decode.
* **Resolution floor.** The reference reader decodes a natively rendered symbol
  down to **4 px/module** and a resampled image down to **2.33 px/module**
  (a 100-px image of a V1 symbol: teeth 63/63, Crown decoded, confidence 0.87).
  The practical recommendation is **≥ 3–4 px/module**, i.e. ≈96 dpi at a 10 mm
  V1 symbol.
* Measured pose accuracy at 25°/15° tilt: homography rms 0.179 px over 355 points,
  centre error 0.18 px, rotation error 1.9°.
* Robustness matrix (V1, 430-px image, URL payload):

  | Damage | L | M | Q | H |
  |---|---|---|---|---|
  | hole, 10 % of radius | — | ✓ | ✓ | ✓ |
  | hole, 12 % | ✗ | ✓ | ✓ | ✓ |
  | hole, 14 % | ✗ | ✓ | ✓ | ✓ |
  | hole, 15.5 % | ✗ | ✗ | ✓ | ✓ |
  | hole, 18 % | ✗ | ✗ | ✗ | ✓ |
  | three separated blobs | ✗ | ✗ | ✓ | ✓ |

* Beyond the code's reach the reader reports a failure and a reason; it never
  invents a payload.

## 13. Identification metadata

```
symbology name : SiMurgh Code
identifier     : SMC
AIM prefix     : ]S1        (] = 2D matrix, S = SiMurgh, 1 = version of the spec)
spec version   : 1.0.0
spec date      : 2026-10-28
```

A conforming reader that returns text should be able to prefix it with `]S1` when
the calling application asks for AIM-style identification.

## 14. Conformance

A **conforming encoder** produces, for any payload it accepts, a symbol whose
printed pattern decodes to that payload with a bit-exact reader, whose Crown
matches its Format Crown, whose ink coverage on the data field is between 40 % and
60 %, and whose geometry follows §§ 3–4 exactly.

A **conforming decoder** must:

1. locate and decode a clean symbol at ≥ 4 px/module in any rotation;
2. recover rotation from the Angle Track without a search;
3. decode under at least 25° of perspective tilt in both axes;
4. verify the CRC-32 and refuse the payload when it fails;
5. report, not guess, when correction is impossible.

Reference measurements for both directions are in `packages/core/test`.

## 15. Reference implementation

```
packages/core/src/
  geometry.ts    lattice, rings, serpentine, Crown constants, Angle Track, masks
  blocks.ts      block planning, interleaving, capacity table
  segments.ts    payload modes, cost model, automatic segmentation
  format.ts      Golay(24,12) Format Crown pack/unpack and candidate enumeration
  encoder.ts     encode(), multi-frame streams, CapacityError
  decoder.ts     bit-level decode, erasure budgets, format ladder
  gf256.ts       field arithmetic, matrix inversion
  reed-solomon.ts Berlekamp-Massey / Chien / Forney, erasures, verification
  golay.ts       exhaustive ML decoder for G24
  crc.ts         CRC-32, CRC-16, FNV-1a, xorshift RNG
  deflate.ts     RFC 1951 deflate and inflate, no dependencies
  sha256.ts      MAC tag and constant-time comparison
  model.ts       SymbolModel: the printable description of one symbol
  render/        raster (SDF), SVG, ASCII
  imaging/       locate, orient, sample, damage, decode, simulate
```
