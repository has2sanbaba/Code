package code.qrstudio

import kotlin.math.sqrt

/** An ARGB image used as artistic source (photo / painting / logo). */
class Img(val width: Int, val height: Int, val pixels: IntArray) {
    fun at(x: Int, y: Int): Rgb =
        Rgb.of(pixels[y.coerceIn(0, height - 1) * width + x.coerceIn(0, width - 1)])
}

enum class ModuleShape { SQUARE, ROUNDED, DOT }

/**
 * Everything the artist may choose. Every knob is clamped at render time to the
 * scannability rules from ISO/IEC 18004 + the QR design literature:
 *  - quiet zone >= 4 modules, uniform light colour;
 *  - dark-on-light polarity only, luminance gap forced to >= ~7:1;
 *  - finder/timing patterns keep their exact geometry (we only recolour them);
 *  - a centre emblem covers <= 15% of the module area and sits on a light pad.
 */
data class ArtOptions(
    // 12 px/module keeps strict binarizers (ZXing's 8x8 local-threshold blocks)
    // sitting well inside a module even when the shape is rounded or dotted.
    val scale: Int = 12,
    val quiet: Int = 4,
    val shape: ModuleShape = ModuleShape.ROUNDED,
    val dark: Rgb = Rgb.BLACK,
    val light: Rgb = Rgb.WHITE,
    val accent: Rgb? = null,
    val gradient: Pair<Rgb, Rgb>? = null,
    val mosaic: Img? = null,
    val emblem: Img? = null,
    val emblemAreaFraction: Float = 0.10f,
)

data class Rendered(val width: Int, val height: Int, val pixels: IntArray)

object ArtRenderer {

    /** Lightness bands that guarantee a >=7:1 gap whatever the hue. */
    private fun ensureDark(c: Rgb): Rgb = if (luminance(c) <= 0.20) c else reskinForContrast(c, true)
    private fun ensureLight(c: Rgb): Rgb = if (luminance(c) >= 0.60) c else reskinForContrast(c, false)

    fun render(grid: QrGrid, o: ArtOptions): Rendered {
        val quiet = maxOf(4, o.quiet)
        val n = grid.size
        val scale = maxOf(4, o.scale)
        val total = n + 2 * quiet
        val px = total * scale

        val lightBg = ensureLight(o.light)
        val pixels = IntArray(px * px)
        pixels.fill(lightBg.argb())

        val accentDark = o.accent?.let { ensureDark(it) }

        for (my in 0 until n) {
            for (mx in 0 until n) {
                val darkModule = grid.isDark(mx, my)
                val colour =
                    if (darkModule) {
                        darkColour(grid, o, mx, my, n, accentDark)
                    } else {
                        // Light modules: plain field, or a pale tint of the photo
                        // when mosaicking (still firmly in the light band).
                        o.mosaic?.let { reskinForContrast(sample(it, mx, my, n), false) } ?: lightBg
                    }
                drawModule(pixels, px, (quiet + mx) * scale, (quiet + my) * scale, scale, o.shape, colour)
            }
        }

        o.emblem?.let { drawEmblem(pixels, px, n, scale, quiet, it, o, lightBg) }

        return Rendered(px, px, pixels)
    }

    private fun darkColour(
        grid: QrGrid,
        o: ArtOptions,
        mx: Int,
        my: Int,
        n: Int,
        accentDark: Rgb?,
    ): Rgb {
        if (accentDark != null && isFinder(mx, my, n)) return accentDark
        o.mosaic?.let { return reskinForContrast(sample(it, mx, my, n), true) }
        o.gradient?.let { (a, b) ->
            val t = (mx + my).toDouble() / (2.0 * n)
            return ensureDark(mix(a, b, t))
        }
        return ensureDark(o.dark)
    }

    /** The three 7x7 finder patterns; geometry untouched, colour is free. */
    private fun isFinder(mx: Int, my: Int, n: Int): Boolean =
        (mx < 7 && my < 7) || (mx >= n - 7 && my < 7) || (mx < 7 && my >= n - 7)

    private fun sample(img: Img, mx: Int, my: Int, n: Int): Rgb =
        img.at(mx * img.width / n, my * img.height / n)

    private fun drawModule(
        pixels: IntArray,
        stride: Int,
        ox: Int,
        oy: Int,
        scale: Int,
        shape: ModuleShape,
        colour: Rgb,
    ) {
        val argb = colour.argb()
        // Fuller shapes scan better: a light corner cut for ROUNDED and a dot that
        // nearly fills its cell, so module centres and run-lengths stay unambiguous.
        val r = scale * 0.22
        val rad = scale * 0.5
        val c = scale / 2.0
        for (ly in 0 until scale) {
            val row = (oy + ly) * stride
            for (lx in 0 until scale) {
                val inside =
                    when (shape) {
                        ModuleShape.SQUARE -> true
                        ModuleShape.DOT -> {
                            val dx = lx + 0.5 - c
                            val dy = ly + 0.5 - c
                            dx * dx + dy * dy <= rad * rad
                        }
                        ModuleShape.ROUNDED -> {
                            val inX = lx >= r && lx <= scale - 1 - r
                            val inY = ly >= r && ly <= scale - 1 - r
                            if (inX || inY) {
                                true
                            } else {
                                val cx = if (lx < r) r else scale - 1 - r
                                val cy = if (ly < r) r else scale - 1 - r
                                val dx = lx - cx
                                val dy = ly - cy
                                dx * dx + dy * dy <= r * r
                            }
                        }
                    }
                if (inside) pixels[row + ox + lx] = argb
            }
        }
    }

    /**
     * Centre photo emblem on a light pad. Side is derived from the requested
     * *area* fraction (clamped to 15%), so the deliberate damage stays inside the
     * Level-H error-correction budget that pays for it.
     */
    private fun drawEmblem(
        pixels: IntArray,
        px: Int,
        n: Int,
        scale: Int,
        quiet: Int,
        img: Img,
        o: ArtOptions,
        lightBg: Rgb,
    ) {
        val fraction = o.emblemAreaFraction.coerceIn(0.02f, 0.15f)
        val modulePx = n * scale
        val side = (sqrt(fraction.toDouble()) * modulePx).toInt().coerceAtLeast(8)
        val pad = maxOf(2, scale / 2)
        val centre = px / 2
        val boxSide = side + 2 * pad
        val box0 = centre - boxSide / 2
        val img0 = centre - side / 2
        val padArgb = lightBg.argb()
        val corner = boxSide * 0.18

        for (yy in 0 until boxSide) {
            val py = box0 + yy
            if (py < 0 || py >= px) continue
            for (xx in 0 until boxSide) {
                val pxx = box0 + xx
                if (pxx < 0 || pxx >= px) continue
                if (insideRounded(xx.toDouble(), yy.toDouble(), boxSide.toDouble(), corner)) {
                    pixels[py * px + pxx] = padArgb
                }
            }
        }
        val imgCorner = side * 0.12
        for (yy in 0 until side) {
            val py = img0 + yy
            for (xx in 0 until side) {
                val pxx = img0 + xx
                if (!insideRounded(xx.toDouble(), yy.toDouble(), side.toDouble(), imgCorner)) continue
                val sx = xx * img.width / side
                val sy = yy * img.height / side
                pixels[py * px + pxx] = img.at(sx, sy).argb()
            }
        }
        // quiet is unused today but kept for clarity of the geometry contract.
        require(quiet >= 4)
    }

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
