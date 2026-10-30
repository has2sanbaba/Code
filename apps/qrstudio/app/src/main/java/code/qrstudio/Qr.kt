package code.qrstudio

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.EncodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import com.google.zxing.qrcode.encoder.Encoder

/**
 * A bare QR matrix (no quiet zone) produced by the ZXing reference encoder.
 *
 * Encoding with ZXing -- the decoder embedded in countless scanners and the de
 * facto reference implementation of ISO/IEC 18004 -- is what guarantees the
 * *data layer* is spec-exact, so anything we draw on top of it inherits real
 * scannability instead of hoping a hand-rolled encoder got the format bits right.
 */
class QrGrid(val size: Int, private val dark: BooleanArray) {
    fun isDark(x: Int, y: Int): Boolean = dark[y * size + x]

    companion object {
        fun encode(text: String, level: ErrorCorrectionLevel): QrGrid {
            val hints = mapOf<EncodeHintType, Any>(EncodeHintType.CHARACTER_SET to "UTF-8")
            val qr = Encoder.encode(text, level, hints)
            val m = qr.matrix
            val n = m.width
            val bits = BooleanArray(n * n)
            for (y in 0 until n) {
                for (x in 0 until n) {
                    bits[y * n + x] = m.get(x, y).toInt() == 1
                }
            }
            return QrGrid(n, bits)
        }
    }
}

/**
 * Decode an ARGB pixel buffer with ZXing, exactly as a scanner would see the
 * rendered image (grayscale threshold via [HybridBinarizer]). Returns the decoded
 * text, or null when the image does not read. Used for the on-device "will it
 * scan?" self-test and by the CI scannability suite.
 */
fun decodePixels(pixels: IntArray, width: Int, height: Int): String? =
    try {
        val source = RGBLuminanceSource(width, height, pixels)
        val result =
            MultiFormatReader().decode(
                BinaryBitmap(HybridBinarizer(source)),
                mapOf<DecodeHintType, Any>(
                    DecodeHintType.TRY_HARDER to true,
                    DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                ),
            )
        result.text
    } catch (_: Exception) {
        null
    }
