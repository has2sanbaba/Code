package code.qrstudio

import kotlin.math.max
import kotlin.math.min

/**
 * Colour science for scannable artistic QR codes.
 *
 * Every scanner reduces the image to grayscale and thresholds it, so the ONLY
 * optical property that matters is the *luminance* gap between dark modules and
 * the light background -- hue is free, brightness is not. The helpers here let the
 * renderer take any artistic hue (brand colour, gradient stop, a pixel sampled
 * from a photo) and clamp its lightness into a band that is guaranteed to
 * binarise cleanly, which is what keeps a "graphical" code readable by every
 * scanner.
 *
 * Contrast uses the WCAG 2.x relative-luminance ratio, the same number the QR
 * design literature quotes (>=4:1 minimum, >=7:1 recommended, black-on-white 21:1).
 */
data class Rgb(val r: Int, val g: Int, val b: Int) {
    fun argb(): Int = (0xff shl 24) or ((r and 0xff) shl 16) or ((g and 0xff) shl 8) or (b and 0xff)

    companion object {
        fun of(argb: Int): Rgb =
            Rgb((argb shr 16) and 0xff, (argb shr 8) and 0xff, argb and 0xff)

        fun hex(hex: String): Rgb {
            val s = hex.removePrefix("#")
            return Rgb(
                s.substring(0, 2).toInt(16),
                s.substring(2, 4).toInt(16),
                s.substring(4, 6).toInt(16),
            )
        }

        val BLACK = Rgb(0, 0, 0)
        val WHITE = Rgb(255, 255, 255)
    }
}

/** WCAG relative luminance in 0..1. */
fun luminance(c: Rgb): Double {
    fun ch(v: Int): Double {
        val s = v / 255.0
        return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b)
}

/** WCAG contrast ratio (1..21) between two colours. */
fun contrastRatio(a: Rgb, b: Rgb): Double {
    val la = luminance(a)
    val lb = luminance(b)
    val hi = max(la, lb)
    val lo = min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
}

/* ------------------------------------------------------------------ HSL ---- */

private fun rgbToHsl(c: Rgb): DoubleArray {
    val r = c.r / 255.0
    val g = c.g / 255.0
    val b = c.b / 255.0
    val mx = max(r, max(g, b))
    val mn = min(r, min(g, b))
    val l = (mx + mn) / 2.0
    if (mx == mn) return doubleArrayOf(0.0, 0.0, l)
    val d = mx - mn
    val s = if (l > 0.5) d / (2.0 - mx - mn) else d / (mx + mn)
    val h =
        when (mx) {
            r -> ((g - b) / d + (if (g < b) 6 else 0))
            g -> ((b - r) / d + 2)
            else -> ((r - g) / d + 4)
        } / 6.0
    return doubleArrayOf(h, s, l)
}

private fun hue2rgb(p: Double, q: Double, t0: Double): Double {
    var t = t0
    if (t < 0) t += 1.0
    if (t > 1) t -= 1.0
    if (t < 1.0 / 6) return p + (q - p) * 6 * t
    if (t < 1.0 / 2) return q
    if (t < 2.0 / 3) return p + (q - p) * (2.0 / 3 - t) * 6
    return p
}

private fun hslToRgb(h: Double, s: Double, l: Double): Rgb {
    if (s <= 0.0) {
        val v = (l * 255).toInt().coerceIn(0, 255)
        return Rgb(v, v, v)
    }
    val q = if (l < 0.5) l * (1 + s) else l + s - l * s
    val p = 2 * l - q
    val r = hue2rgb(p, q, h + 1.0 / 3)
    val g = hue2rgb(p, q, h)
    val b = hue2rgb(p, q, h - 1.0 / 3)
    return Rgb(
        (r * 255).toInt().coerceIn(0, 255),
        (g * 255).toInt().coerceIn(0, 255),
        (b * 255).toInt().coerceIn(0, 255),
    )
}

/**
 * Re-skin [source] to a guaranteed-scannable lightness while keeping its hue and
 * (scaled) saturation. [dark] selects the band: dark modules are pushed to a very
 * low lightness, light modules to a very high one, so the pair always clears the
 * 7:1 contrast target no matter what hue the artist (or the photo) supplied.
 */
fun reskinForContrast(source: Rgb, dark: Boolean): Rgb {
    val hsl = rgbToHsl(source)
    val h = hsl[0]
    return if (dark) {
        // Keep some saturation so the colour reads, but force near-black lightness.
        hslToRgb(h, min(0.85, hsl[1]) , 0.13)
    } else {
        // Desaturate light modules a little so they stay a clean pale field.
        hslToRgb(h, hsl[1] * 0.35, 0.93)
    }
}

/** Linear interpolation between two colours, t in 0..1. */
fun mix(a: Rgb, b: Rgb, t: Double): Rgb {
    val u = t.coerceIn(0.0, 1.0)
    return Rgb(
        (a.r + (b.r - a.r) * u).toInt().coerceIn(0, 255),
        (a.g + (b.g - a.g) * u).toInt().coerceIn(0, 255),
        (a.b + (b.b - a.b) * u).toInt().coerceIn(0, 255),
    )
}
