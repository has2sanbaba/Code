package code.qrstudio

import com.google.zxing.qrcode.ErrorCorrectionLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The contract that makes this more than a paint program: every artistic style the
 * app can produce is rendered to a pixel buffer and then decoded back with the
 * ZXing reference decoder -- the same binarize-threshold path a phone camera uses.
 * A style that looks beautiful but fails to read is a *test failure*, not a
 * surprise at print time.
 *
 * Runs on a plain JVM (no Android types anywhere in the renderer), which is why CI
 * can verify scannability with no emulator and no device.
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

    private fun assertScans(label: String, options: ArtOptions, level: ErrorCorrectionLevel = ErrorCorrectionLevel.H) {
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
    fun roundedColouredScans() =
        assertScans(
            "rounded-coloured",
            ArtOptions(shape = ModuleShape.ROUNDED, dark = Rgb.hex("#1e3a5f"), light = Rgb.hex("#fdf6e3")),
        )

    @Test
    fun dotGradientScans() =
        assertScans(
            "dot-gradient",
            ArtOptions(shape = ModuleShape.DOT, gradient = Pair(Rgb.hex("#7c3aed"), Rgb.hex("#0f766e"))),
        )

    @Test
    fun photoMosaicScans() =
        assertScans(
            "mosaic",
            ArtOptions(shape = ModuleShape.ROUNDED, mosaic = synthImg(64, 64, "#db2777", "#0ea5e9")),
        )

    @Test
    fun photoEmblemScans() =
        assertScans(
            "emblem",
            ArtOptions(shape = ModuleShape.ROUNDED, emblem = synthImg(48, 48, "#f59e0b", "#111827")),
        )

    @Test
    fun everythingAtOnceScans() =
        assertScans(
            "kitchen-sink",
            ArtOptions(
                shape = ModuleShape.DOT,
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
        // 4 modules of quiet on each side of an n-module grid.
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
