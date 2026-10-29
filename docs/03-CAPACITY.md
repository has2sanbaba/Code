# SiMurgh Code — Capacity and Sizing

**Companion to the Specification 1.1.0.**

> **چکیدهٔ فارسی** — جدول ظرفیت هر ۴۰ نسخه در چهار سطح تصحیح خطا، به بایتِ *مفید*
> (چهار کدواژهٔ CRC-32 کسر شده‌اند)، همراه با قطر چاپ بر حسب ماژول. سپس اندازهٔ
> واقعیِ نمونه‌بارهای رایج (پیوند، متن فارسی، متن لاتین، رقم، دادهٔ دودویی، موقعیت
> جغرافیایی) و اثر فشرده‌سازی DEFLATE — که برای متن فارسی تا ۴٫۹ برابر دیسک کوچک‌تر
> می‌دهد. در پایان، مقایسهٔ چگالی با کد QR با تفکیک «مساحت جوهر» از «جعبهٔ محدودکننده».

---

## 1. Reading the table

```
ver     version number, 1..40
K       outermost data ring, K = 2·ver + 12
modules printed diameter in module pitches, 2K + 10 (quiet zone of 2.5 excluded)
cells   data cells, N = 3K(K+1) − 18
L/M/Q/H usable payload bytes at that error-correction level
```

The byte figures are **user payload**: the four codewords carrying the CRC-32 are
already excluded. Add 2.5 modules on every side for the quiet zone when laying out
artwork. Regenerate this table at any time with:

```sh
npm run cli -- capacity            # all 40 versions, all four levels
npm run cli -- capacity --ecc H    # one level
npm run cli -- capacity --version 10
```

## 2. Full capacity table

```
      ver        K  modules    cells  L bytes  M bytes  Q bytes  H bytes
------------------------------------------------------------------------
        1       14       38      612       60       51       42       30
        2       16       42      798       79       67       55       41
        3       18       46     1008      102       87       72       53
        4       20       50     1242      126      108       89       66
        5       22       54     1500      153      131      108       80
        6       24       58     1782      182      156      129       96
        7       26       62     2088      215      184      153      113
        8       28       66     2418      250      213      177      132
        9       30       70     2772      287      245      204      152
       10       32       74     3150      326      279      232      173
       11       34       78     3552      369      316      262      196
       12       36       82     3978      413      354      294      220
       13       38       86     4428      461      394      328      245
       14       40       90     4902      510      437      363      271
       15       42       94     5400      563      482      401      300
       16       44       98     5922      618      529      440      329
       17       46      102     6468      675      578      481      360
       18       48      106     7038      734      629      523      392
       19       50      110     7632      797      683      568      425
       20       52      114     8250      862      738      615      460
       21       54      118     8892      929      796      663      496
       22       56      122     9558      999      856      712      533
       23       58      126    10248     1072      918      765      572
       24       60      130    10962     1147      982      818      612
       25       62      134    11700     1224     1049      873      654
       26       64      138    12462     1304     1117      930      697
       27       66      142    13248     1387     1188      990      741
       28       68      146    14058     1472     1261     1050      787
       29       70      150    14892     1559     1336     1113      833
       30       72      154    15750     1649     1413     1177      882
       31       74      158    16632     1742     1493     1243      932
       32       76      162    17538     1837     1574     1311      982
       33       78      166    18468     1935     1658     1381     1035
       34       80      170    19422     2035     1743     1452     1088
       35       82      174    20400     2138     1832     1526     1143
       36       84      178    21402     2243     1922     1601     1200
       37       86      182    22428     2351     2014     1678     1257
       38       88      186    23478     2461     2108     1756     1316
       39       90      190    24552     2574     2206     1837     1377
       40       92      194    25650     2689     2304     1920     1439

Bytes are user payload (the four CRC-32 codewords are already excluded).
modules = printed diameter in module pitches = 2K + 10; quiet zone of 2.5 modules is extra.
```

## 3. What real payloads cost

Measured with the reference encoder (compression on, which is the default). "Raw"
is the version the same payload needs with compression disabled.

| Payload | ECC | Version | Cells | Diameter | Without DEFLATE |
|---|---|---|---|---|---|
| URL, 47 characters | M | **V1** | 612 | 38 | V1 — no change |
| URL, 47 characters | H | V2 | 798 | 42 | V2 |
| URL, 90 characters with query | M | V2 | 798 | 42 | V2 |
| URL, 90 characters with query | H | V4 | 1242 | 50 | V4 |
| 40 digits | M | **V1** | 612 | 38 | V1 |
| 40 digits | H | V1 | 612 | 38 | V1 |
| Latin prose, 200 characters | M | V6 | 1782 | 58 | V6 |
| Latin prose, 200 characters | H | V9 | 2772 | 70 | V9 |
| **Persian prose, 200 characters** | M | **V3** | 1008 | 46 | **V14** (4902 cells) |
| **Persian prose, 200 characters** | H | V5 | 1500 | 54 | **V20** (8250 cells) |
| Binary, 100 bytes | M | V4 | 1242 | 50 | V4 |
| Binary, 100 bytes | H | V7 | 2088 | 62 | V7 |
| Binary, 1 KiB (structured) | M | **V11** | 3552 | 78 | **V25** (11700 cells) |
| Binary, 1 KiB (structured) | H | V15 | 5400 | 94 | V33 (18468 cells) |
| Latin prose, 2000 characters | M | **V7** | 2088 | 62 | **V32** (17538 cells) |
| Geographic fix (lat/lon/alt) | M | **V1** | 612 | 38 | V1 |

Two things stand out.

**Non-Latin scripts gain the most.** Persian text costs 2 UTF-8 bytes per character,
which the segment modes cannot avoid — but DEFLATE sees a 200-character sample drawn
from a few hundred distinct bigrams and collapses it by 4.9×, taking the symbol from
V14 (a 90-module disc) to V3 (a 46-module disc). For an Arabic-script, Cyrillic,
Devanagari or CJK deployment this is the single largest lever available, and it is
on by default.

**A geo fix is free.** 92 bits of latitude, longitude, altitude and flags fit in V1
at level M with room to spare, alongside a URL or an identifier — which is what makes
the GEO mode worth reserving rather than serialising as text.

## 4. Choosing a version: the sizing rule

Given a payload of `B` bytes and a level with parity fraction `ρ`:

```
C = ⌊N/8⌋  codewords            N = 3K(K+1) − 18 ,  K = 2V + 12
P = round(ρC) , clamped to [2, C−5]
usable = C − P − 4               (the −4 is the CRC)
```

so the smallest `V` with `usable ≥ B` is the answer, and the encoder finds it by
scanning upward. Practical guidance:

* Start at **M** (28 % parity). It survives a 12 % hole and reads at 2.8 px/module.
* Go to **H** (55 %) for anything that will be handled, abraded, or partially
  covered — labels on tools, tickets, industrial parts. It costs about 45 % of the
  payload.
* Use **L** (16 %) only where the substrate and the print process are both
  controlled, e.g. a laser-marked plate read by a fixed camera.
* **Q** is the compromise when a hole is expected but the payload is tight.
* Leave compression on unless you are encoding incompressible data *and* need the
  decoder to skip the inflate step.

## 5. Density, honestly

The fair question is not "does it beat QR" but "what does the design spend". Two
different denominators give two different answers, and both matter.

### 5.1 Per inked area

At V40 the inked disc has radius `K + 5 = 97` modules, area `π·97² = 29 559` module².
It stores `C = ⌊25650/8⌋ = 3206` codewords = **25 648 bits**, i.e.

```
0.868 bits per module² of ink
```

A QR Code version 40 is 177 × 177 modules and stores 3706 codewords = 29 648 bits
over 31 329 module², i.e. **0.946 bits per module²**. Restricting both to *payload*
bits at their lowest ECC level (QR V40-L: 2956 data codewords; SiMurgh V40-L: 2693):

| | payload bits | inked area | bits / module² of ink |
|---|---|---|---|
| QR Code V40-L | 23 648 | 31 329 (square) | 0.755 |
| SiMurgh V40-L | 21 544 | 29 559 (disc) | 0.729 |

**Within 3.5 %.** On the ink itself the two symbologies are comparable: the Crown's
annulus costs about as much as QR's three finder patterns, timing patterns,
alignment patterns and version blocks.

### 5.2 Per bounding box

A disc inside its bounding square wastes exactly `π/4 = 0.785`:

| | payload bits | bounding box | bits / module² |
|---|---|---|---|
| QR Code V40-L | 23 648 | 31 329 | 0.755 |
| SiMurgh V40-L | 21 544 | 37 636 | 0.572 |

and `0.572 / 0.729 = 0.785` — the whole difference is the circle. This is the honest
cost of a radial symbology, and it is a *substrate* question, not an encoding one:

* On a **round** substrate — a bottle cap, a coin, a button, a seal, a wafer, a
  round label, a lens barrel — the bounding square is already wasted, and SiMurgh
  fills the usable area as well as a square code would.
* On a **rectangular** label with room to spare, a square code is denser and should
  usually win.
* SiMurgh's answer to a narrow strip is a multi-frame stream (`FRAME` mode) or a
  lower ECC level, not a different lattice.

### 5.3 What the disc buys

The comparison above counts bits and ignores what the reader must do:

| | Square matrix code | SiMurgh |
|---|---|---|
| Orientation | 3 asymmetric finder patterns; a search over rotations if they are damaged | one cyclic correlation over 63 teeth; no search |
| Pose under tilt | needs ≥ 3 correspondence points, which need orientation first | 2 concentric circles ⇒ 8-parameter radial LSQ, rotation invariant |
| Scale reference | module grid fitted from finder geometry | Halo–Limbus separation, exactly 3.80 modules, per ray |
| Compact damage | bursts hit one codeword region | serpentine + interleaving ⇒ erasure-correctable, 16× survivable area |
| Max parity | 30 % (QR H) | 55 % (level H) |
| Substrate | rectangle | disc |

## 6. Print sizes

Diameter in millimetres at a given module pitch, for the most-used versions:

| Version | Diameter (modules) | at 0.25 mm | at 0.33 mm | at 0.50 mm |
|---|---|---|---|---|
| V1 | 38 | 9.5 mm | 12.5 mm | 19.0 mm |
| V3 | 46 | 11.5 mm | 15.2 mm | 23.0 mm |
| V5 | 54 | 13.5 mm | 17.8 mm | 27.0 mm |
| V10 | 74 | 18.5 mm | 24.4 mm | 37.0 mm |
| V20 | 114 | 28.5 mm | 37.6 mm | 57.0 mm |
| V40 | 194 | 48.5 mm | 64.0 mm | 97.0 mm |

Minimum module size follows from the reader's resolution floor of 3–4 px/module:
a 203 dpi (8 dot/mm) thermal printer gives 0.125 mm modules, so aim for at least
**0.25 mm** and prefer 0.33 mm for anything handled. At 0.33 mm a V1 symbol is
12.5 mm across and holds 51 bytes at level M — enough for a URL, a serial number, or
a geo fix.

## 7. The ceiling

Version 40 at level H carries **1 439 bytes**. A payload larger than that — 2 000
characters of prose without compression, for instance — does not fit in one symbol
and the encoder raises `CapacityError` rather than truncating. Three answers, in
order of preference:

1. **Compress** (the default). 2 000 characters of prose is 1 574 bytes raw and
   about 184 compressed: V32 becomes V7.
2. **Split** into a multi-frame stream with `encodeFrames(data, perFrameBytes)`,
   which stamps every symbol with a stream id, an index and a count, so a reader can
   reassemble out of order and report exactly which frames are missing.
3. **Lower the ECC level**, which buys 87 % more payload from H to L but gives up the
   damage tolerance that was the reason for the symbology's placement rules.
