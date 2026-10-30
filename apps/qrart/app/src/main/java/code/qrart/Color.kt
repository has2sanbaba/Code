package code.qrart

import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * An sRGB colour. Scanners only ever see *luminance*, so every artistic choice in
 * this app is expressed as "keep my hue, move my luminance into a safe band" --
 * [toLuminance] is the single primitive that makes that exact and hue-preserving.
 */
class Rgb(val r: Int, val g: Int, val b: Int) {

    fun argb(): Int = (0xff shl 24) or ((r and 0xff) shl 16) or ((g and 0xff) shl 8) or (b and 0xff)

    /**
     * ZXing's own luma coefficients (RGBLuminanceSource: (306R + 601G + 117B) >> 10),
     * normalised to 0..1. Using the *decoder's* definition of brightness is what lets
     * the renderer aim its luminance bands exactly at what the binarizer will see.
     */
    fun luma(): Double = (306.0 * r + 601.0 * g + 117.0 * b) / (1024.0 * 255.0)

    /**
     * Hue-preserving luminance retarget, exact in one step:
     *  - darker  -> scale toward black (linear map, no channel clipping, hue kept);
     *  - lighter -> mix toward white   (monotone map, hue kept, saturation falls).
     * Both maps are linear in luminance, so the requested value is hit exactly.
     */
    fun toLuminance(target: Double): Rgb {
        val y0 = luma()
        val y1 = target.coerceIn(0.0, 1.0)
        if (y0 <= 0.0) {
            val v = (y1 * 255.0).roundToInt().coerceIn(0, 255)
            return Rgb(v, v, v)
        }
        return if (y1 < y0) {
            val k = y1 / y0
            Rgb((r * k).roundToInt().coerceIn(0, 255), (g * k).roundToInt().coerceIn(0, 255), (b * k).roundToInt().coerceIn(0, 255))
        } else {
            val t = if (y0 >= 1.0) 1.0 else (y1 - y0) / (1.0 - y0)
            Rgb(
                (r + (255 - r) * t).roundToInt().coerceIn(0, 255),
                (g + (255 - g) * t).roundToInt().coerceIn(0, 255),
                (b + (255 - b) * t).roundToInt().coerceIn(0, 255),
            )
        }
    }

    fun mix(other: Rgb, t: Double): Rgb {
        val k = t.coerceIn(0.0, 1.0)
        return Rgb(
            (r + (other.r - r) * k).roundToInt(),
            (g + (other.g - g) * k).roundToInt(),
            (b + (other.b - b) * k).roundToInt(),
        )
    }

    /** WCAG relative luminance (for reporting contrast to the user). */
    fun wcagLuminance(): Double {
        fun ch(c: Int): Double {
            val s = c / 255.0
            return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
    }

    fun contrastRatio(other: Rgb): Double {
        val a = wcagLuminance()
        val b = other.wcagLuminance()
        val hi = max(a, b)
        val lo = min(a, b)
        return (hi + 0.05) / (lo + 0.05)
    }

    override fun toString(): String = "#%02x%02x%02x".format(r, g, b)

    companion object {
        val BLACK = Rgb(0, 0, 0)
        val WHITE = Rgb(255, 255, 255)

        fun of(argb: Int): Rgb = Rgb((argb shr 16) and 0xff, (argb shr 8) and 0xff, argb and 0xff)

        fun hex(s: String): Rgb {
            val v = s.removePrefix("#").toLong(16)
            return Rgb(((v shr 16) and 0xff).toInt(), ((v shr 8) and 0xff).toInt(), (v and 0xff).toInt())
        }
    }
}
