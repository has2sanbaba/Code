package code.simurgh.scanner

import android.util.Base64
import androidx.camera.core.ImageProxy

/**
 * Camera frames to engine input.
 *
 * The symbology pipeline reduces every image to grayscale before anything
 * else, so only the Y plane of YUV_420_888 is interesting. This takes it out
 * of the ImageProxy (respecting rowStride), rotates it upright using the
 * sensor rotation, and box-downscales to a sane working size -- the decoder's
 * documented resolution floor is 2.33 px/module after resampling, and 960 px
 * on the long side leaves every symbol up to V40 far above it.
 */
object Yuv {

    class Gray(val width: Int, val height: Int, val data: ByteArray) {
        fun toBase64(): String = Base64.encodeToString(data, Base64.NO_WRAP)
    }

    fun toGray(proxy: ImageProxy, maxDim: Int): Gray {
        val plane = proxy.planes[0]
        val w = proxy.width
        val h = proxy.height
        val y = ByteArray(w * h)
        val buffer = plane.buffer
        val rowStride = plane.rowStride
        if (rowStride == w) {
            buffer.get(y, 0, w * h)
        } else {
            for (row in 0 until h) {
                buffer.position(row * rowStride)
                buffer.get(y, row * w, w)
            }
        }
        val upright =
            when (proxy.imageInfo.rotationDegrees) {
                90 -> rotate(y, w, h, 90)
                180 -> rotate(y, w, h, 180)
                270 -> rotate(y, w, h, 270)
                else -> Gray(w, h, y)
            }
        return downscale(upright, maxDim)
    }

    /** Clockwise rotation by 90/180/270 degrees. */
    private fun rotate(src: ByteArray, w: Int, h: Int, deg: Int): Gray {
        val out = ByteArray(w * h)
        when (deg) {
            // (x, y) -> (h-1-y, x) in a w' = h, h' = w grid
            90 ->
                for (yy in 0 until h) {
                    for (xx in 0 until w) {
                        out[(h - 1 - yy) + xx * h] = src[yy * w + xx]
                    }
                }

            180 ->
                for (yy in 0 until h) {
                    for (xx in 0 until w) {
                        out[(h - 1 - yy) * w + (w - 1 - xx)] = src[yy * w + xx]
                    }
                }

            // (x, y) -> (y, w-1-x) in a w' = h, h' = w grid
            else ->
                for (yy in 0 until h) {
                    for (xx in 0 until w) {
                        out[yy + (w - 1 - xx) * h] = src[yy * w + xx]
                    }
                }
        }
        return if (deg == 180) Gray(w, h, out) else Gray(h, w, out)
    }

    /** Integer box-average downscale so the long side is at most maxDim. */
    private fun downscale(g: Gray, maxDim: Int): Gray {
        val long = maxOf(g.width, g.height)
        if (long <= maxDim) return g
        val f = (long + maxDim - 1) / maxDim
        val w2 = g.width / f
        val h2 = g.height / f
        if (w2 < 2 || h2 < 2) return g
        val out = ByteArray(w2 * h2)
        for (yy in 0 until h2) {
            for (xx in 0 until w2) {
                var sum = 0
                for (dy in 0 until f) {
                    val rowBase = (yy * f + dy) * g.width
                    for (dx in 0 until f) {
                        sum += g.data[rowBase + xx * f + dx].toInt() and 0xff
                    }
                }
                out[yy * w2 + xx] = (sum / (f * f)).toByte()
            }
        }
        return Gray(w2, h2, out)
    }
}
