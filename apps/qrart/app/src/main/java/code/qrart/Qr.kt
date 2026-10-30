package code.qrart

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder

/**
 * A spec-exact QR symbol: the module grid produced by the ZXing reference encoder,
 * plus its version and the function-pattern mask (see [QrLayout]).
 *
 * Encoding through ZXing (instead of hand-rolling the standard) is what guarantees
 * the data layer is byte-for-byte ISO/IEC 18004 compliant for every payload,
 * including UTF-8 Persian text.
 */
class QrGrid(
    val size: Int,
    val version: Int,
    private val modules: BooleanArray,
    val functionMask: BooleanArray,
) {
    fun isDark(x: Int, y: Int): Boolean = modules[y * size + x]

    fun isFunction(x: Int, y: Int): Boolean = functionMask[y * size + x]

    companion object {
        fun encode(content: String, level: ErrorCorrectionLevel = ErrorCorrectionLevel.H): QrGrid {
            val hints =
                mapOf<EncodeHintType, Any>(
                    EncodeHintType.ERROR_CORRECTION to level,
                    EncodeHintType.CHARACTER_SET to "UTF-8",
                    EncodeHintType.MARGIN to 0, // the renderer owns the quiet zone
                )
            val qr = Encoder.encode(content, level, hints)
            val m = qr.matrix
            val size = m.width
            val modules = BooleanArray(size * size)
            for (y in 0 until size) {
                for (x in 0 until size) {
                    modules[y * size + x] = m.get(x, y).toInt() != 0
                }
            }
            return QrGrid(size, qr.version.versionNumber, modules, QrLayout.functionMask(size, qr.version.versionNumber))
        }
    }
}

/**
 * Decode an ARGB pixel buffer with the ZXing reference decoder (grayscale ->
 * adaptive HybridBinarizer -> detect -> sample -> Reed-Solomon), i.e. exactly the
 * pipeline a phone camera runs. Returns the payload, or null when unreadable.
 */
fun decodePixels(pixels: IntArray, width: Int, height: Int): String? =
    try {
        val source = RGBLuminanceSource(width, height, pixels)
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        val hints = mapOf<DecodeHintType, Any>(DecodeHintType.TRY_HARDER to true)
        QRCodeReader().decode(bitmap, hints).text
    } catch (e: Exception) {
        null
    }
