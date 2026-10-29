# SiMurgh Code — Mathematical Foundations

**Companion to the Specification 1.0.0. Derivations, proofs and measured constants.**

> **چکیدهٔ فارسی** — این سند ریاضیاتِ پشتِ سیمرغ کد را می‌آورد: چرا شبکهٔ مثلثی
> (چگالی بسته‌بندی `π/(2√3) ≈ 0.907` در برابر `π/4 ≈ 0.785`)، چرا دنبالهٔ m با
> `p(x)=x⁶+x+1` برای دندهٔ زاویه (خودهمبستگی چرخه‌ای `−1`)، چرا کد گولی گستردهٔ
> `(24,12)` برای تاجِ قالب (فاصلهٔ حداقل ۸، شعاع پوشش ۴)، چرا رید–سالامونِ درهم‌بسته
> با بودجهٔ محوِ به ازای هر بلوک، و چرا دو دایرهٔ هم‌مرکز کافی است تا ژستِ پرسپکتیو
> بدون حدس اولیه حل شود. هر عددِ اندازه‌گیری‌شده در این سند، با آزمونِ مربوطه در
> `packages/core/test` تأیید شده است.

---

## 1. The lattice

### 1.1 Why triangular

The data cells sit on the triangular lattice of pitch 1. Its Voronoi cell is a
regular hexagon of area `√3/2`, so the density of a disc packing is

```
π (1/√3)² / (√3/2) = π / (2√3) ≈ 0.9069
```

against `π/4 ≈ 0.7854` for the square lattice: **+15.5 % cells per unit area**, or
+7.9 % per unit diameter. Every other structure in the symbology — ring
combinatorics, the serpentine path, the mask families — is a consequence of this
choice.

Each interior cell has exactly **6** lattice neighbours (kissing number of the
hexagonal packing), which is what makes the 19-cell neighbourhood of § 7 a natural
statistical unit.

### 1.2 Coordinates

Axial coordinates `(q, r)` with

```
x = q + r/2 ,    y = (√3/2) r
r = 2y/√3   ,    q = x − r/2      (then axial-round)
```

The hexagonal distance

```
d(q, r) = (|q| + |r| + |q + r|) / 2
```

is the ring index. It is a norm on the lattice, and `d` takes the *difference* of
two cells: `d(b−a)`, never `d(a, b)` with four coordinates.

### 1.3 Ring enumeration

Ring `d ≥ 1` has `6d` cells, split into six sides of `d` cells. Summing:

```
1 + Σ_{d=1..K} 6d = 1 + 3K(K+1)
```

and subtracting the two innermost rings reserved for the Core rosette
(`1 + 6 + 12 = 19`):

```
N(V) = 3K(K+1) − 18 ,   K = 2V + 12
```

`N` is a quadratic in `V` with leading coefficient 12: `N = 12V² + 156V + 486`.
Checked exhaustively for all 40 versions in the test suite.

The side index of a ring cell is

```
side = ⌊j/d⌋ ,  k = j − side·d
side 0: (d−k, k)    side 1: (−k, d)     side 2: (−d, d−k)
side 3: (−d+k, −k)  side 4: (k, −d)     side 5: (d, −d+k)
```

and `ringIndexOf(ringCell(d, j)) = j` for all `d ≥ 1` (tested to `d = 24`).

## 2. The Angle Track: maximum-length sequences

### 2.1 Construction

Take the primitive polynomial `p(x) = x⁶ + x + 1` over GF(2) and the linear feedback
shift register with tap mask `0b1000011` (bits 0 and 1 — the constant term and `x`;
using `0b1000001` instead gives `x⁶ + 1`, which is not irreducible and produces a
degenerate sequence: this was a real bug found by the derivation tool
`tools/derive-angle-track.mjs`).

The output is a **maximum-length sequence** of period

```
L = 2⁶ − 1 = 63
```

with weight `(L+1)/2 = 32`. The frozen track, tooth 0 first:

```
111111010101100110111011010010011100010111100101000110000100000
```

### 2.2 Properties used, and proved

**(a) Window uniqueness (de Bruijn property).** Every cyclic window of `n = 6`
consecutive symbols occurs exactly once per period. Hence any 6 consecutive readable
teeth determine the absolute tooth index. Tested for all 63 windows.

**(b) Ideal autocorrelation.** For the periodic autocorrelation

```
C(τ) = Σ_{i=0}^{L-1} (−1)^{s_i ⊕ s_{i+τ}}
```

an m-sequence satisfies `C(0) = L` and `C(τ) = −1` for all `τ ≠ 0`. Tested for all
62 non-zero shifts. Consequence: a correlation peak is *sharp* — the expected
sidelobe level is `−1/63 = −1.6 %` of the peak, so the phase estimate is robust to
noise and to missing teeth.

**(c) Run distribution (Golomb).** Runs of length `k` occur `2^{n−k}/2` times for
`k < n` and once for `k = n`: measured `{1:16, 2:8, 3:4, 4:2, 5:1, 6:1}` ✓.

**(d) Non-palindromic.** The reversed sequence is not a cyclic shift of the
forward one, so a mirror image (a symbol seen through glass, or a reversed print)
is detectable rather than silently misread.

### 2.3 Why 63 and not a rounder number

The natural alternative is a de Bruijn sequence of order `k` on a ring of length
`L`: for `L = 60` teeth the largest window with all-distinct cyclic words is
`k = 5` (32 windows, `60·5 = 300 > 2⁵·...`), and an exhaustive search
(`tools/derive-angle-track.mjs`, and a separate brute-force over binary necklaces)
found **no** order-6 window assignment for a 60-tooth ring: 60 does not divide
`2⁶ − 1 = 63`. The m-sequence length is dictated by the field, so the tooth count
follows it: 63 teeth at `5.714286°` each. The band is a *clock*, and a clock does
not get to choose its own number of hours.

### 2.4 Rotation recovery

Sample the 63 teeth, correlate cyclically against the reference, and take the argmax
over 63 shifts. With fraction `p` of teeth unreadable (treated as erasures, i.e.
excluded from the sum and renormalised), the expected peak-to-sidelobe margin stays
positive up to `p ≈ 0.40`, tested explicitly. Residual error after sub-tooth
refinement is a few hundredths of a tooth; measured end-to-end rotation error at 25°
tilt: **1.9°** before refinement and well under one tooth after.

## 3. The Format Crown: extended Golay G₂₄

### 3.1 The code

The binary Golay code `G₂₃` is the perfect `[23, 12, 7]` code. Extending it with an
overall parity check gives `G₂₄ = [24, 12, 8]`, generated by `g(x) = 0xC75`
(`x¹¹ + x¹⁰ + x⁶ + x⁵ + x⁴ + x² + 1`).

* Minimum distance 8 ⇒ corrects 3 errors, detects 4 (and, being an even-weight code,
  detects all odd-weight patterns of any size).
* Self-dual: `G₂₄ = G₂₄^⊥`, so every codeword has even weight and the code is
  invariant under its own parity-check matrix.
* Automorphism group `M₂₄`, order `244 823 040` — the reason the 24 beads can be
  placed at equal angular spacing with no privileged position.

Verified by exhaustive test: minimum distance 8, linearity, even weight, all
patterns of ≤ 3 errors corrected, all patterns of 4 errors detected.

### 3.2 It is not perfect, and that is the point

`G₂₃` is perfect: radius-3 balls tile the space exactly. Extending to 24 bits breaks
the tiling:

```
|ball(3)| = 1 + 24 + C(24,2) + C(24,3) = 1 + 24 + 276 + 2024 = 2325
2¹² · 2325 = 9 523 200  <  2²⁴ = 16 777 216
```

so **43 % of all 24-bit patterns are at distance exactly 4** from the nearest
codeword, and the covering radius is 4. For such a pattern the maximum-likelihood
decoder returns *a* nearest codeword, which may be the wrong one. The test suite
asserts this by sampling 200 000 random words and requiring the distance histogram
to place between 35 % and 50 % of them at radius 4, and by exhibiting a word at
radius 4.

The engineering consequence: **the Format Crown must never be the sole authority.**
The decoder treats a decoded format as a hypothesis, ranks the hypotheses, and
accepts one only when the payload CRC-32 (§ 6) agrees.

### 3.3 Why 24 beads and not fewer

Twelve information bits need at least 12 beads; 24 gives the extended Golay code
and puts the beads at exactly 15° apart, which is a divisor-friendly angle for both
the rasteriser and the sampler. At a bead radius of `K + 2.20` the arc between
neighbouring beads is `2.20 · 15° · π/180 ≈ 0.576` modules at V1 — more than half a
pitch, so beads are individually resolvable at the print floor while still sitting
clear of the Halo and the Teeth.

### 3.4 Decoding

Exhaustive ML over 4096 codewords: 4096 × 24 bit operations ≈ 10⁵ operations,
about 40 µs. Asymptotically silly, practically optimal — and it returns the exact
nearest codeword with its distance, which a syndrome decoder would have to work to
produce.

## 4. Reed–Solomon over GF(256)

### 4.1 Field

`GF(2⁸) = GF(2)[x]/(x⁸ + x⁴ + x³ + x² + 1)`, primitive element `α = 2`
(the polynomial is primitive: `α` has order 255, tested exhaustively). Log/antilog
tables; multiplication by `α` is a shift plus a conditional XOR.

### 4.2 Code and capacity

Systematic RS with evaluation points `X_p = α^{n−1−p}`. Because `α` has order 255,
these collide when `n > 255`, so **the block length is capped at 255** — a hard
structural constraint, not a design preference, and the reason large versions are
split into interleaved blocks.

For a block of `n` symbols with `nK` parity symbols:

```
errors only           : ν ≤ ⌊nK/2⌋
erasures only         : ν ≤ nK
mixed                 : 2e + ν ≤ nK
```

Tested for `(n, nK) ∈ {(10,4), (16,8), (32,16), (64,22), (128,40), (195,60),
(247,8)}` at the full capacity of each mode.

Decoding is Berlekamp–Massey on the modified syndrome polynomial, Chien search for
the error locator roots, Forney for the magnitudes, and — critically — a **residual
syndrome check** after correction. A block whose residual syndrome is non-zero is
reported as failed. This is what makes the CRC-32 the *only* remaining line of
defence, and it is why "RS said OK but the CRC failed" is a genuine miscorrection
rather than a bug.

### 4.3 Erasure decoding with errors present

When `ν` erasure positions are known, the erasure-locator polynomial is
`X(z) = Π (1 − X_{p_i} z)`. The Berlekamp–Massey step must be run on the *reduced*
syndrome sequence `T_i = S_i · X(X_i^{-1})` for **`i = ν … nK−1` only**; including
the first `ν` terms double-counts the known errors and produces a locator of the
wrong degree. (This was an implementation bug found by the test suite.)

### 4.4 Interleaving and bursts

Codewords are interleaved round-robin across `B` blocks. A burst of `b` consecutive
modules therefore contributes about `b/B` symbols to each block. With erasures
declared, the burst costs `b/B` of each block's `nK_b` parity symbols, so the total
survivable burst is

```
b ≤ B · nK_b ≈ ρ · C     (the whole parity budget)
```

which is the "contiguous + erasures ⇒ `f ≤ ρ`" line of the specification. Without
interleaving, the same burst would land in one block and be survivable only up to
`nK_b` symbols — a factor `B` worse.

## 5. The serpentine path

### 5.1 Construction and the adjacency theorem

Rings `d = 3 … K` are traversed in order. Odd rings run counter-clockwise, even
rings clockwise, and each ring starts at the cell nearest the previous ring's end.

**Claim.** Every consecutive pair of modules in the resulting path is a lattice
neighbour (hex distance 1).

*Proof sketch.* Within a ring, consecutive cells in ring order differ by a unit
step along a side, hence are neighbours. At a ring transition, the path ends at a
cell of ring `d` and restarts at the nearest cell of ring `d+1`; because the
traversal direction alternates, the end of ring `d` and the start of ring `d+1` lie
on the same radial spoke, where the two cells are adjacent. Reversing the even rings
is exactly what makes the transition cost zero. ∎

Tested for V ∈ {1, 3, 8, 17} over all `N−1` consecutive pairs, and the path is
verified to be a bijection for V ∈ {1, 2, 5, 11, 23, 40}.

### 5.2 Runs under a compact defect

Let a defect be a disc of radius `R` (in modules) centred at distance `c` from the
origin. The path crosses the disc in arcs; each crossing is a **run**. A disc
intersects at most `2R` rings (plus a constant for off-centre placement), and each
ring contributes `O(1)` runs, so

```
number of runs = O(R)      while the number of damaged cells = O(R²)
```

Measured: a 10 %-area disc at V8 (`R ≈ 8.8` modules, centred 14.5 from the origin)
produces **18 runs** over 175 damaged cells — a run-to-cell ratio above 9, against
the `O(R²)` runs a scattered placement would produce. The test asserts
`runs < 2R + 6` and `runs < damaged/4`; an earlier bound of `runs < 12` was simply
geometrically wrong for this configuration and was corrected, not the code.

### 5.3 The sixteen-fold argument

Damage fraction `f` of the symbol's cells, parity fraction `ρ`:

| Placement | How damage distributes | Survivable `f` |
|---|---|---|
| scattered (e.g. golden-ratio stride) | ~uniformly over all blocks; each block sees errors, not erasures | `f ≤ ρ/16` |
| contiguous, undetected | concentrated runs, but read as *errors* | `f ≤ ρ/2` |
| contiguous, detected as erasures | concentrated runs, declared | `f ≤ ρ` |

The `ρ/16` figure comes from the per-block error budget: a scattered defect spreads
its `fC` damaged cells over `B` blocks, each block tolerating `nK_b/2 ≈ ρC/(2B)`
errors — and since the damaged cells are *not* known to be damaged, the reader pays
the error price, not the erasure price. At level M that is 1.75 % of cells: a
fingertip. With contiguity plus the mask prior of § 7 the same reader survives 28 %:
a hole punched through the middle.

**A note on a rejected idea.** A golden-ratio scattering stride
(`i ↦ ⌊i·φ⌋ mod N`) is the textbook way to spread bursts, and it is implemented and
exported in `geometry.ts` **for analysis only**. For this symbology it is actively
harmful: it maximises the number of blocks a compact defect touches while making the
damage undetectable as a region, converting a cheap erasure problem into an
expensive error problem. The bijection test passes for it; the robustness test does
not.

## 6. CRC-32 as the decision rule

The decoder's acceptance rule is `CRC-32(payload) == stored`, not "Reed–Solomon
succeeded". Justification:

* The CRC-32 (IEEE 802.3 polynomial, reflected, `crc32("123456789") = 0xCBF43926`)
  is a random-code-like check on `D` bytes: a wrong payload passes with probability
  `2⁻³² ≈ 2.3·10⁻¹⁰`, independent of how it became wrong.
* Reed–Solomon miscorrections are not rare events at the boundary: at `ν = t + 1`
  errors the decoder still returns *a* codeword roughly `1/n!`-ish of the time, and
  the residual-syndrome check catches most but not all of them.
* Therefore the pair (RS, CRC) has a false-accept rate dominated by `2⁻³²`, while a
  longer RS code buying the same guarantee would cost 4 more parity bytes per block
  and reduce capacity.

This is also what makes brute-force format search (§ 11.8 of the specification)
safe: 64 candidates × `2⁻³²` is still `1.5·10⁻⁸`.

## 7. The mask prior: a hypothesis test on 19 cells

Under any of the eight masks the printed value of a cell is `data ⊕ mask`, and the
mask families are balanced, so for a *valid* symbol the number of dark cells in a
19-cell neighbourhood (the cell plus its 6 and 12 neighbours at distance 1 and 2) is

```
D ~ Binomial(19, 1/2)
```

with mean 9.5 and `P(D ≤ k)`:

| Threshold | Predicted `P` per neighbourhood | Measured false seeds per 612-cell symbol |
|---|---|---|
| `D ≤ 1` or `≥ 18` | `1.9·10⁻⁵` | 0.02 |
| `D ≤ 2` or `≥ 17` | `2.0·10⁻⁴` | 0.26 |
| `D ≤ 3` or `≥ 16` | `1.4·10⁻³` | **2.1** |
| `D ≤ 4` or `≥ 15` | `7.0·10⁻³` | 9.1 |
| `D ≤ 5` or `≥ 14` | `2.5·10⁻²` | 31.6 |

Measured over **182 796** full neighbourhoods from 50 symbols; the histogram peaks
at 8–10 as the binomial predicts. The chosen operating point is `D ≤ 3 or ≥ 16`:
2.1 false seeds per symbol, each of which costs one erasure slot, against a hole of
a few hundred cells that would otherwise be read as *confident wrong data*.

Cells with fewer than 19 neighbours (the innermost data rings) are excluded from the
statistic; a second stage dilates each seed to its lattice neighbours with graded
penalties (seed 0.02, near 0.35, far 0.70) because a hole's edge is soft.

**A rejected detector.** "Large uniform connected region" does not work: the largest
same-colour connected component in a *valid* symbol contains 124–302 of 612 cells,
so any threshold that catches a hole also catches the symbol. A second rejected
detector, cluster-agreement on local thresholds, produced 43.6 false seeds per
symbol against 0.045 predicted — it measured sampling noise, not damage.

## 8. Projective geometry of the Crown

### 8.1 The problem

A printed symbol photographed at an angle is a projective image of the model. To
sample a cell we need the transform `H ∈ PGL(3)` mapping model coordinates to image
coordinates: 8 degrees of freedom.

The naive approach — trace feature points, match them to model points, solve the
8-parameter linear system — needs to know *which* tooth or bead each traced point
is, and that needs the rotation, which needs the transform. Under 25° of tilt the
initial guess is off by more than one module and the fixed-point iteration diverges.
(Measured, and the reason the first implementation of this stage was deleted.)

### 8.2 The rotation-invariant formulation

Two concentric circles of known radius ratio survive a projective transform as two
concentric *conics* with a known cross-ratio structure. Sample the outer Limbus over
`M = 180` rays at angles `α_j`, obtaining radii `ρ_j = r_outer(α_j)`. Any Crown
band of model radius `R` lies, on ray `α_j`, at

```
r_band(α_j) = ρ_j · R / 4.85
```

and the local pitch on that ray is `ρ_j / 4.85`. So **one traced circle gives every
other radius**, with no rotation estimate at all.

For the pose itself, write `H = G · T` and impose, for each sampled point `p` of
both known circles,

```
‖G p‖ = ρ
```

which is 2·M **radial** equations in 8 unknowns, linear in the entries of `GᵗG`.
Radial equations are invariant to the rotation of the point set, so the system has
no dependence on the unknown phase and therefore **no basin of attraction**. Solve
by least squares with the gauge `G₈ = 1`, iterate ≤ 40 times, then two Tukey
biweight IRLS passes to reject mis-traced rays.

Acceptance guards: `rms < 4 px`, `det G < 0` is rejected (a reflection cannot come
from a camera), implied scale within `[0.55, 1.8] × pitch`.

### 8.3 The ellipse-centre trap

Driving the *first* radial harmonic to zero is the standard trick for centring a
conic, and it is wrong here: it moves the pole to the **centre of the fitted
ellipse**, which is not the projection of the model centre. At 25° tilt with a
190-px Limbus radius the two differ by ≈15 px ≈ 1.5 modules — enough to sample the
wrong cells. The correct reading is that the first harmonic gives the *centre
offset* of the projected disc:

```
r(α) = c₀ + a₁ cos α + b₁ sin α + a₂ cos 2α + b₂ sin 2α
centre error: dx = a₁ , dy = b₁ ;  tilt from (a₂, b₂)
```

Fitted by least squares over all rays (a naive Fourier sum leaks DC whenever rays
are missing, so the normal equations are solved explicitly). Guards: reject if
`rms > 0.35·c₀` or `hypot(a₁, b₁) > 0.2·c₀`.

### 8.4 The rotation sign

The fitted transform satisfies `H = H_true ∘ Rot(ψ)`, so the model rotation must be
composed as `H ∘ Rot(−ψ)`. Using `+ψ` yields a *valid* Golay word from a wrong
format and a cascade failure — the most expensive kind of bug to find, because
nothing downstream reports an error until the CRC.

### 8.5 Measured accuracy

At V1, scale 10 px/module:

| Case | rms (px) | points | centre error | rotation error |
|---|---|---|---|---|
| clean | 0.116 | 357 | — | — |
| rotate 37° | 0.121 | — | — | 0.18° |
| perspective 25°/15° | 0.179 | 355 | 0.18 px | 1.89° |

Closed-form check for the tilted case: with the simulator's focal scale `f = 2.2`
(`f = 946 px`), a 190-px Limbus radius tilted 25° projects to an ellipse with
`v ∈ [−187.8, +158.4]`, centre offset `−14.7 px` and semi-axes `190 / 173.1` — all
reproduced by the fit.

## 9. Compression

The payload is compressed with raw DEFLATE (RFC 1951): LZ77 with 32 KiB window and
hash chains, then Huffman coding (stored, fixed and dynamic blocks; the inflater
accepts all three, and code lengths are validated against the **Kraft inequality**
before use — a stream whose lengths sum above 1 is rejected rather than decoded).

Reference sizes against `node:zlib` at level 9 (mine / zlib):

| Payload | bytes | mine | zlib |
|---|---|---|---|
| ASCII sentence | 41 | **16** | 17 |
| Persian prose (repeated) | 420 | 73 | **70** |
| `'A' × 3000` | 3000 | 23 | **21** |
| structured binary | 70 000 | 1587 | **1337** |
| pseudo-random bytes | 900 | **279** | 280 |

Within a few percent of the runtime's own zlib, in both directions
(`inflateRawSync(ours)` and `inflateRaw(zlib's)` are both tested), with zero
dependencies — which matters because the core must run in a browser, on an
embedded target and inside a print driver.

The gain that matters is not the byte ratio but the **version ratio**: symbols are
discrete sizes, and 2 160 characters of prose goes from V32 (17 538 cells) to V7
(2 088 cells) — an 8.4× smaller disc, because DEFLATE removes the repetition that
the segment modes cannot express.

Two encoder bugs found by differential testing against zlib are worth recording,
because both produce *streams that inflate correctly*:

1. starting the hash-chain walk at the just-inserted position ⇒ the match search
   compared a position with itself, found distance 0, and gave up: no match was ever
   emitted and every payload silently degraded to stored blocks (3000 `'A'` → 3002
   bytes);
2. skipping the prefix comparison after the cheap length reject ⇒ matches that
   decoded to plausible garbage.

The lesson is the standard one: a compressor that round-trips is not necessarily a
compressor. Always compare sizes against a reference implementation.

## 10. Information density

Cells per printed module diameter `D = 2K + 10`:

```
cells/D² = (3K(K+1) − 18) / (2K+10)²  →  3/4 as K → ∞
```

so at large versions SiMurgh carries **0.75 data cells per square module of
bounding box**, of which `ρ`-dependent fractions are payload: at level M and V40,
2 304 payload bytes in a 194-module disc = **0.0613 bytes per module²**, and with
DEFLATE on repetitive text an effective 0.2–0.5 bytes per module².

For comparison at the same bounding box and same ECC philosophy, a square-grid
symbology gets `0.785/0.907 = 0.866` of SiMurgh's cell count from the lattice alone,
before the Crown's cost. The Crown spends 63 + 24 + two rings ≈ 90 modules of
annulus — about 3.5 % of V40's area and 12 % of V1's — to buy rotation-free
reading, pose recovery from one traced circle, and a version/ECC field that survives
three bit errors. That is the trade the design makes explicitly.

## 11. Sampling theory: why 3–4 pixels per module

The reference rasteriser draws each module from a signed distance field and
supersamples adaptively (`4×` below 5 px/module, `2×` below 8, `1×` above). The
reader averages a 13-point sunflower disc of radius `0.40 · pitch` per cell.

Two effects set the floor:

1. **Aliasing shifts apparent radii.** At 4 px/module with no supersampling the
   Crown's rings read at a pitch of 3.71 instead of 4.00 — a 7 % scale error, which
   moves the sampler off the cells. Supersampling fixes the *rendering*; the reader
   tolerates it via the per-ray pitch (§ 8.2).
2. **The two-cluster cut needs separation.** Cell averages form two clusters whose
   separation shrinks as the disc kernel mixes neighbouring modules; below ≈2.3
   px/module the clusters overlap enough that per-cell confidence collapses.

Measured floor: native rendering decodes at **4 px/module** (confidence 0.96, teeth
40/63) and fails at 3 (mislocated version); the resampling path decodes at every
target width from 430 down to **100 px**, i.e. **2.33 px/module** (teeth 63/63,
Crown decoded, confidence 0.87). Hence the recommendation: **≥ 3–4 px/module**.

## 12. Cost of the design, honestly

* The Crown's annulus is pure overhead: 12 % of V1's area, 3.5 % of V40's.
* `N mod 8` cells (up to 7) are printed but carry nothing.
* Four codewords per symbol are CRC, i.e. ≈ 5 % of V1's data capacity.
* The perspective solver costs ≈ 400 ms at 430 px in a single-threaded reference
  implementation — a real-time reader would use the fast path (clean,
  fronto-parallel) and escalate only on failure.
* G₂₄'s covering radius of 4 means the format hypothesis can be wrong, and the
  decoder pays for that with a 64-candidate ladder in the worst case.

Every one of these buys something measurable: rotation-free reading, pose from one
circle, a 16× improvement in survivable damage, and a `2⁻³²` false-accept rate.
