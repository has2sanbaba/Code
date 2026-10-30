package code.qrstudio

import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The contract that makes this more than a paint program: every artistic style the
 * app guarantees is rendered to a pixel buffer and decoded back with the ZXing
 * reference decoder -- the same grayscale-threshold path a phone camera uses, and
 * the strictest binarizer of the three decoders we probed (ZXing-Java rejects
 * rounded/dot module geometry that jsQR and ZXing-JS accept, so the *guaranteed*
 * set keeps square modules and gets its artistry from colour, gradient,
 * photo-mosaic and a centre emblem instead).
 *
 * Runs on a plain JVM (the renderer has no Android types), which is why CI can
 * verify scannability with no emulator and no device.
 */
class ArtScannabilityTest {

    private val payloads =
        listOf(
            "https://example.com/art",
            "Hello, artistic QR — سلام",
            "https://example.com/a/longer/path?with=query&and=more#fragment",
        )

    private fun synthImg(w: Int, h: Int, a: String, b: String): Img {
        val px = IntArray(w * h)
        for (y in 0 until h) {
            for (x in 0 until w) {
                val t = (x.toDouble() / w + y.toDouble() / h) / 2.0
                px[y * w + x] = mix(Rgb.hex(a), Rgb.hex(b), t).argb()
            }
        }
        return Img(w, h, px)
    }

    private fun assertScans(
        label: String,
        options: ArtOptions,
        level: ErrorCorrectionLevel = ErrorCorrectionLevel.H,
    ) {
        for (payload in payloads) {
            val grid = QrGrid.encode(payload, level)
            val r = ArtRenderer.render(grid, options)
            val back = decodePixels(r.pixels, r.width, r.height)
            assertNotNull("$label: failed to decode '$payload'", back)
            assertEquals("$label: payload mismatch", payload, back)
        }
    }

    @Test
    fun classicSquareScans() =
        assertScans("classic", ArtOptions(shape = ModuleShape.SQUARE))

    @Test
    fun colouredScans() =
        assertScans(
            "coloured",
            ArtOptions(shape = ModuleShape.SQUARE, dark = Rgb.hex("#1e3a5f"), light = Rgb.hex("#fdf6e3")),
        )

    @Test
    fun gradientWithAccentEyesScans() =
        assertScans(
            "gradient",
            ArtOptions(
                shape = ModuleShape.SQUARE,
                gradient = Pair(Rgb.hex("#7c3aed"), Rgb.hex("#0f766e")),
                accent = Rgb.hex("#1d4ed8"),
            ),
        )

    @Test
    fun photoMosaicScans() =
        assertScans(
            "mosaic",
            ArtOptions(shape = ModuleShape.SQUARE, mosaic = synthImg(64, 64, "#db2777", "#0ea5e9")),
        )

    @Test
    fun photoEmblemScans() =
        assertScans(
            "emblem",
            ArtOptions(shape = ModuleShape.SQUARE, emblem = synthImg(48, 48, "#f59e0b", "#111827")),
        )

    @Test
    fun everyColourFeatureAtOnceScans() =
        assertScans(
            "kitchen-sink",
            ArtOptions(
                shape = ModuleShape.SQUARE,
                gradient = Pair(Rgb.hex("#0f172a"), Rgb.hex("#be123c")),
                accent = Rgb.hex("#1d4ed8"),
                mosaic = synthImg(64, 64, "#16a34a", "#9333ea"),
                emblem = synthImg(48, 48, "#eab308", "#0f172a"),
            ),
        )

    @Test
    fun midToneInputIsRescuedToScannableContrast() {
        // A designer picks a pastel foreground that would never scan on its own;
        // the renderer must push it into the dark band so the contrast holds.
        val bad = Rgb.hex("#9ca3af") // ~1.9:1 on white -- the canonical failure
        val grid = QrGrid.encode(payloads[0], ErrorCorrectionLevel.H)
        val r = ArtRenderer.render(grid, ArtOptions(dark = bad, shape = ModuleShape.SQUARE))
        assertNotNull("pastel foreground must still decode", decodePixels(r.pixels, r.width, r.height))
    }

    @Test
    fun quietZoneIsLightAndSized() {
        val grid = QrGrid.encode(payloads[0], ErrorCorrectionLevel.H)
        val o = ArtOptions(quiet = 4, shape = ModuleShape.SQUARE, light = Rgb.WHITE)
        val r = ArtRenderer.render(grid, o)
        val corner = Rgb.of(r.pixels[0])
        assertTrue("quiet zone must be light", luminance(corner) > 0.6)
        val totalModules = r.width / o.scale
        assertEquals(grid.size + 8, totalModules)
    }

    @Test
    fun contrastMathMatchesKnownPairs() {
        assertEquals(21.0, contrastRatio(Rgb.BLACK, Rgb.WHITE), 0.05)
        assertTrue(contrastRatio(Rgb.hex("#9ca3af"), Rgb.WHITE) < 3.0)
        assertTrue(contrastRatio(Rgb.hex("#1e3a5f"), Rgb.WHITE) > 7.0)
    }
}
