package code.qrart

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

enum class ArtMode {
    /** The painting *is* the code: photo colour and tone flow through every module. */
    FUSION,

    /** Poster: the photo fills the canvas, the code sits on a light plate inside it. */
    POSTER,

    /** Classic styled code tinted with the photo's palette; optionally a logo centre. */
    CLASSIC,
}

data class ArtRequest(
    val mode: ArtMode = ArtMode.FUSION,
    val scale: Int = 16,
    val quiet: Int = 4,
    val painting: Painting? = null,
    val emblem: Painting? = null,
    val emblemFraction: Double = 0.12,
    val dark: Rgb? = null,
    val light: Rgb? = null,
)

class Rendered(val width: Int, val height: Int, val pixels: IntArray)

/**
 * Luminance bands per guarantee level, in the decoder's own luma scale.
 *
 * The design follows three facts from the QR literature:
 *  1. scanners binarize *luminance* (locally: ZXing's 8x8 HybridBinarizer block
 *     means) and then sample **each module's centre pixel only**;
 *  2. a module decodes correctly as long as its sampled core carries the right
 *     value with margin over its own neighbourhood (Chu et al.: a correct central
 *     third of a module is sufficient);
 *  3. everything else in the cell is free for art.
 *
 * So each level defines a wide *body* corridor (the painting's tone, kept on the
 * correct side of a mid-threshold: dark <= 0.46 / light >= 0.54) and a tight *core*
 * that is always an extremum of its own module (>=0.10 clear of the body range),
 * which is what an adaptive binarizer cannot flip. Level 0 shows the most
 * painting; each further level narrows the corridor, and level 3 is nearly flat.
 */
data class Bands(
    val darkBody: DoubleArray,
    val darkCore: DoubleArray,
    val lightBody: DoubleArray,
    val lightCore: DoubleArray,
) {
    companion object {
        val LEVELS =
            listOf(
                Bands(doubleArrayOf(0.20, 0.46), doubleArrayOf(0.02, 0.10), doubleArrayOf(0.54, 0.80), doubleArrayOf(0.90, 0.98)),
                Bands(doubleArrayOf(0.16, 0.40), doubleArrayOf(0.02, 0.09), doubleArrayOf(0.60, 0.84), doubleArrayOf(0.91, 0.98)),
                Bands(doubleArrayOf(0.12, 0.34), doubleArrayOf(0.02, 0.08), doubleArrayOf(0.66, 0.88), doubleArrayOf(0.92, 0.98)),
                Bands(doubleArrayOf(0.08, 0.26), doubleArrayOf(0.02, 0.07), doubleArrayOf(0.74, 0.92), doubleArrayOf(0.93, 0.98)),
            )
    }
}

object ArtRenderer {

    // Fraction of the requested emblem area kept at each guarantee level.
    private val EMBLEM_KEPT = doubleArrayOf(1.0, 0.75, 0.5, 0.0)

    private const val FN_DARK = 0.06
    private const val FN_LIGHT = 0.95

    fun render(grid: QrGrid, req: ArtRequest, level: Int): Rendered =
        when (req.mode) {
            ArtMode.FUSION -> if (req.painting != null) renderFusion(grid, req, level) else renderClassic(grid, req, level)
            ArtMode.POSTER -> if (req.painting != null) renderPoster(grid, req, level) else renderClassic(grid, req, level)
            ArtMode.CLASSIC -> renderClassic(grid, req, level)
        }

    /* ------------------------------------------------------------ FUSION */

    private fun renderFusion(grid: QrGrid, req: ArtRequest, level: Int): Rendered {
        val painting = req.painting!!
        val bands = Bands.LEVELS[level.coerceIn(0, Bands.LEVELS.size - 1)]
        val n = grid.size
        val scale = max(4, req.scale)
        val quiet = max(4, req.quiet)
        val total = n + 2 * quiet
        val px = total * scale
        val out = IntArray(px * px)
        val half = scale / 2.0
        val quietArgb = painting.average.toLuminance(0.97).argb()

        for (my in 0 until n) {
            for (mx in 0 until n) {
                val dark = grid.isDark(mx, my)
                val fn = grid.isFunction(mx, my)
                val ox = (quiet + mx) * scale
                val oy = (quiet + my) * scale
                val hue = painting.sample((mx + 0.5) / n, (my + 0.5) / n)
                val fnArgb =
                    if (dark) hue.toLuminance(FN_DARK).argb() else hue.toLuminance(FN_LIGHT).argb()

                for (ly in 0 until scale) {
                    val row = (oy + ly) * px + ox
                    for (lx in 0 until scale) {
                        if (fn) {
                            out[row + lx] = fnArgb
                            continue
                        }
                        // Centre weight: 1 inside the sampled core (middle third of
                        // the cell), easing to 0 at the cell edge.
                        val d = max(abs(lx + 0.5 - half), abs(ly + 0.5 - half)) / half
                        val w = smooth(((0.62 - d) / 0.62).coerceIn(0.0, 1.0))
                        val c = painting.sample((mx + (lx + 0.5) / scale) / n, (my + (ly + 0.5) / scale) / n)
                        val t = painting.stretch(c.luma())
                        val core = if (dark) bands.darkCore else bands.lightCore
                        val body = if (dark) bands.darkBody else bands.lightBody
                        val yCore = core[0] + (core[1] - core[0]) * t
                        val yBody = body[0] + (body[1] - body[0]) * t
                        val target = yBody + (yCore - yBody) * w
                        out[row + lx] = c.toLuminance(target).argb()
                    }
                }
            }
        }
        for (y in 0 until px) {
            for (x in 0 until px) {
                val mx = x / scale - quiet
                val my = y / scale - quiet
                if (mx < 0 || my < 0 || mx >= n || my >= n) out[y * px + x] = quietArgb
            }
        }
        drawEmblem(grid, req, level, quiet, scale, px, out, quietArgb)
        return Rendered(px, px, out)
    }

    /* ------------------------------------------------------------ POSTER */

    private fun renderPoster(grid: QrGrid, req: ArtRequest, level: Int): Rendered {
        val painting = req.painting!!
        val n = grid.size
        val scale = max(4, req.scale)
        val quiet = max(4, req.quiet)
        val frame = 2 // modules of photo visible around the plate
        val total = n + 2 * (quiet + frame)
        val px = total * scale
        val out = IntArray(px * px)

        // Full-bleed photo background.
        for (y in 0 until px) {
            for (x in 0 until px) {
                out[y * px + x] = painting.sample(x.toDouble() / px, y.toDouble() / px).argb()
            }
        }
        // Light plate with rounded corners; the quiet zone lives inside it.
        val plateArgb = painting.average.toLuminance(0.97).argb()
        val plate0 = frame * scale
        val plate1 = total * scale - frame * scale
        val radius = 2.0 * scale
        for (y in plate0 until plate1) {
            for (x in plate0 until plate1) {
                if (insideRounded((x - plate0).toDouble(), (y - plate0).toDouble(), (plate1 - plate0).toDouble(), radius)) {
                    out[y * px + x] = plateArgb
                }
            }
        }

        val code0 = (frame + quiet) * scale
        val band = Bands.LEVELS[level.coerceIn(0, Bands.LEVELS.size - 1)]
        for (my in 0 until n) {
            for (mx in 0 until n) {
                val dark = grid.isDark(mx, my)
                val fn = grid.isFunction(mx, my)
                val ox = code0 + mx * scale
                val oy = code0 + my * scale
                val hue = painting.sample((mx + 0.5) / n, (my + 0.5) / n)
                val t = painting.stretch(hue.luma())
                // Data modules are tinted by the photo under them, clamped deep into
                // the dark band; light modules simply stay the plate colour.
                val colour =
                    when {
                        !dark -> painting.average.toLuminance(0.97)
                        fn -> hue.toLuminance(FN_DARK)
                        else -> hue.toLuminance(band.darkBody[0] + (band.darkBody[1] - band.darkBody[0]) * t * 0.5)
                    }
                val argb = colour.argb()
                for (ly in 0 until scale) {
                    val row = (oy + ly) * px + ox
                    for (lx in 0 until scale) out[row + lx] = argb
                }
            }
        }
        drawEmblem(grid, req, level, frame + quiet, scale, px, out, plateArgb)
        return Rendered(px, px, out)
    }

    /* ----------------------------------------------------------- CLASSIC */

    private fun renderClassic(grid: QrGrid, req: ArtRequest, level: Int): Rendered {
        val n = grid.size
        val scale = max(4, req.scale)
        val quiet = max(4, req.quiet)
        val total = n + 2 * quiet
        val px = total * scale
        val out = IntArray(px * px)
        val band = Bands.LEVELS[level.coerceIn(0, Bands.LEVELS.size - 1)]

        val src = req.painting?.average
        val darkC = req.dark ?: src?.toLuminance(band.darkBody[0] + 0.04) ?: Rgb.BLACK
        val lightC = req.light ?: src?.toLuminance(0.97) ?: Rgb.WHITE
        val lightArgb = lightC.toLuminance(0.97).argb()
        out.fill(lightArgb)

        for (my in 0 until n) {
            for (mx in 0 until n) {
                if (!grid.isDark(mx, my)) continue
                val fn = grid.isFunction(mx, my)
                val colour =
                    if (fn) {
                        darkC.toLuminance(FN_DARK)
                    } else {
                        val src = req.painting
                        val hue = src?.sample((mx + 0.5) / n, (my + 0.5) / n)
                        val t = if (src != null && hue != null) src.stretch(hue.luma()) else 0.3
                        hue?.toLuminance(band.darkBody[0] + (band.darkBody[1] - band.darkBody[0]) * t * 0.5) ?: darkC
                    }
                val argb = colour.argb()
                val ox = (quiet + mx) * scale
                val oy = (quiet + my) * scale
                for (ly in 0 until scale) {
                    val row = (oy + ly) * px + ox
                    for (lx in 0 until scale) out[row + lx] = argb
                }
            }
        }
        drawEmblem(grid, req, level, quiet, scale, px, out, lightArgb)
        return Rendered(px, px, out)
    }

    /* ------------------------------------------------------------ emblem */

    /**
     * Centred logo/photo on a light pad, sized by *area* fraction and always kept
     * clear of the 9-module finder/separator/format rings, which carry no
     * Reed-Solomon protection. Function patterns inside the box win over the logo.
     * Higher guarantee levels shrink (and finally drop) the emblem.
     */
    private fun drawEmblem(
        grid: QrGrid,
        req: ArtRequest,
        level: Int,
        originModules: Int,
        scale: Int,
        px: Int,
        out: IntArray,
        padArgb: Int,
    ) {
        val img = req.emblem ?: return
        val kept = EMBLEM_KEPT[level.coerceIn(0, EMBLEM_KEPT.size - 1)]
        if (kept <= 0.0) return
        val n = grid.size
        val avail = n - 18 // inside the format rings
        var side = (sqrt(req.emblemFraction * kept) * n).toInt().coerceAtLeast(3)
        if (side + 2 > avail) side = avail - 2
        // Small symbols have a small Reed-Solomon budget: the logo plus its light
        // pad must stay within what the ECC can rebuild, so cap the box by size.
        val cap = (n - 18) / 2
        if (side > cap) side = cap
        if (side < 3) return
        val start = (n - side) / 2
        val pad = 1
        for (my in start - pad until start + side + pad) {
            for (mx in start - pad until start + side + pad) {
                if (mx < 0 || my < 0 || mx >= n || my >= n) continue
                if (grid.isFunction(mx, my)) continue
                val inImg = mx >= start && mx < start + side && my >= start && my < start + side
                val ox = (originModules + mx) * scale
                val oy = (originModules + my) * scale
                for (ly in 0 until scale) {
                    val row = (oy + ly) * px + ox
                    for (lx in 0 until scale) {
                        out[row + lx] =
                            if (inImg) {
                                img.sample(
                                    (mx - start + (lx + 0.5) / scale) / side,
                                    (my - start + (ly + 0.5) / scale) / side,
                                ).argb()
                            } else {
                                padArgb
                            }
                    }
                }
            }
        }
    }

    /* ------------------------------------------------------------ helpers */

    private fun smooth(t: Double): Double = t * t * (3 - 2 * t)

    private fun insideRounded(x: Double, y: Double, side: Double, r: Double): Boolean {
        if (x < 0 || y < 0 || x >= side || y >= side) return false
        val inX = x >= r && x <= side - 1 - r
        val inY = y >= r && y <= side - 1 - r
        if (inX || inY) return true
        val cx = if (x < r) r else side - 1 - r
        val cy = if (y < r) r else side - 1 - r
        val dx = x - cx
        val dy = y - cy
        return dx * dx + dy * dy <= r * r
    }
}
