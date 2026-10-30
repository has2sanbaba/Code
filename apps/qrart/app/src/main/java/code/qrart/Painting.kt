package code.qrart

import kotlin.math.max
import kotlin.math.min

/**
 * The user's photo / painting, as a plain ARGB buffer with bilinear sampling and
 * luminance statistics. Pure Kotlin (no Android types) so the renderer -- and the
 * CI scannability suite -- can run on a bare JVM.
 */
class Painting(val width: Int, val height: Int, val pixels: IntArray) {

    val average: Rgb
    val lumaMin: Double
    val lumaMax: Double

    init {
        var sr = 0L
        var sg = 0L
        var sb = 0L
        var lo = 1.0
        var hi = 0.0
        for (p in pixels) {
            val c = Rgb.of(p)
            sr += c.r
            sg += c.g
            sb += c.b
            val y = c.luma()
            if (y < lo) lo = y
            if (y > hi) hi = y
        }
        val n = pixels.size.coerceAtLeast(1)
        average = Rgb((sr / n).toInt(), (sg / n).toInt(), (sb / n).toInt())
        lumaMin = lo
        lumaMax = hi
    }

    /** Bilinear sample at normalised coordinates (u, v in [0,1]). */
    fun sample(u: Double, v: Double): Rgb {
        val fx = (u.coerceIn(0.0, 1.0) * (width - 1)).coerceIn(0.0, (width - 1).toDouble())
        val fy = (v.coerceIn(0.0, 1.0) * (height - 1)).coerceIn(0.0, (height - 1).toDouble())
        val x0 = fx.toInt()
        val y0 = fy.toInt()
        val x1 = min(width - 1, x0 + 1)
        val y1 = min(height - 1, y0 + 1)
        val tx = fx - x0
        val ty = fy - y0
        val a = Rgb.of(pixels[y0 * width + x0])
        val b = Rgb.of(pixels[y0 * width + x1])
        val c = Rgb.of(pixels[y1 * width + x0])
        val d = Rgb.of(pixels[y1 * width + x1])
        return Rgb(
            lerp(lerp(a.r, b.r, tx), lerp(c.r, d.r, tx), ty),
            lerp(lerp(a.g, b.g, tx), lerp(c.g, d.g, tx), ty),
            lerp(lerp(a.b, b.b, tx), lerp(c.b, d.b, tx), ty),
        )
    }

    /**
     * Contrast-stretch a sampled luminance into [0,1] using the photo's own range,
     * so even a flat, low-contrast painting keeps its tonal structure in the code.
     */
    fun stretch(y: Double): Double {
        val span = lumaMax - lumaMin
        if (span < 1e-3) return 0.5
        return ((y - lumaMin) / span).coerceIn(0.0, 1.0)
    }

    private fun lerp(a: Int, b: Int, t: Double): Int = (a + (b - a) * t).toInt()

    companion object {
        fun solid(size: Int, colour: Rgb): Painting =
            Painting(size, size, IntArray(size * size) { colour.argb() })

        /** Horizontal+vertical gradient helper, used by tests as a synthetic painting. */
        fun gradient(size: Int, from: Rgb, to: Rgb): Painting {
            val px = IntArray(size * size)
            for (y in 0 until size) {
                for (x in 0 until size) {
                    val t = (x.toDouble() / size + y.toDouble() / size) / 2.0
                    px[y * size + x] = from.mix(to, t).argb()
                }
            }
            return Painting(size, size, px)
        }
    }
}
