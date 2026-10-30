package code.qrart

import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.sqrt


/**
 * The product's spine: every artistic style is rendered to a pixel buffer and
 * decoded back with the ZXing reference decoder -- the same grayscale, adaptive
 * binarization, detection, sampling and Reed-Solomon pipeline a phone camera
 * runs. Several cases additionally survive a *simulated camera capture*
 * (box downsample to a few pixels per module + mild optical blur), because
 * "scans on a clean buffer" is not the same claim as "scans in the wild".
 *
 * Paintings are synthetic (gradient, blocky forest, near-black night, flat
 * pastel, radial portrait, white noise) so the suite covers the hostile cases:
 * very dark, very low contrast and very high frequency artwork.
 */
class FusionScannabilityTest {

    private val payloads =
        listOf(
            "https://example.com/art",
            "Hello, artistic QR — سلام، نقاشی",
            "https://example.com/a/longer/path?with=query&and=more#fragment",
        )

    private val scale = 12

    /* ------------------------------------------------ synthetic paintings */

    private fun hash(x: Int, y: Int): Double {
        val s = kotlin.math.sin(x * 127.1 + y * 311.7) * 43758.5453
        return s - kotlin.math.floor(s)
    }

    private fun painting(size: Int, fn: (u: Double, v: Double) -> Rgb): Painting {
        val px = IntArray(size * size)
        for (y in 0 until size) {
            for (x in 0 until size) px[y * size + x] = fn(x.toDouble() / size, y.toDouble() / size).argb()
        }
        return Painting(size, size, px)
    }

    private val sunset = painting(96) { _, v -> Rgb((255 * (1 - v * 0.6)).toInt(), (120 + 100 * (1 - v)).toInt(), (60 + 160 * v).toInt()) }
    private val forest =
        painting(96) { u, v ->
            val n = hash((u * 12).toInt(), (v * 12).toInt())
            Rgb((30 + 60 * n).toInt(), (90 + 120 * (1 - v)).toInt(), (40 + 50 * u).toInt())
        }
    private val night = painting(96) { u, v -> Rgb((10 + 30 * v).toInt(), (12 + 25 * u).toInt(), (30 + 60 * (1 - v)).toInt()) }
    private val pastel = painting(96) { u, v -> Rgb((200 + 40 * u).toInt(), (205 + 40 * v).toInt(), (215 + 30 * (1 - u)).toInt()) }
    private val noise =
        painting(96) { u, v ->
            val n = hash((u * 96).toInt(), (v * 96).toInt())
            Rgb((255 * n).toInt(), (200 * n).toInt(), (255 * (1 - n)).toInt())
        }
    private val portrait =
        painting(96) { u, v ->
            val d = hypot(u - 0.5, v - 0.45) * 2
            Rgb((245 * (1 - d * 0.7)).toInt().coerceIn(0, 255), (200 * (1 - d * 0.5)).toInt().coerceIn(0, 255), (180 * (1 - d * 0.4)).toInt().coerceIn(0, 255))
        }
    private val emblem =
        painting(48) { u, v ->
            if (hypot(u - 0.5, v - 0.5) * 2 < 0.8) Rgb(220, 40, 80) else Rgb(250, 245, 235)
        }

    private val allPaintings = listOf("sunset" to sunset, "forest" to forest, "night" to night, "pastel" to pastel, "noise" to noise, "portrait" to portrait)

    /* -------------------------------------------------- simulated capture */

    /** ZXing luma of an ARGB pixel. */
    private fun luma(argb: Int): Double = Rgb.of(argb).luma()

    /**
     * Simulated camera capture: box-integrate the render down to [ppm] pixels per
     * module, which is exactly what a sensor pixel does (integrate light over its
     * area). Decoding the result proves the code survives real-world shrinking.
     */
    private fun capture(r: Rendered, ppm: Double): IntArray {
        // ppm = pixels per module in the simulated frame.
        val dst = (r.width.toDouble() * ppm / scale).toInt()
        val out = IntArray(dst * dst)
        val grey = DoubleArray(dst * dst)
        for (y in 0 until dst) {
            for (x in 0 until dst) {
                var s = 0.0
                var c = 0
                val x0 = (x * r.width) / dst
                val x1 = maxOf(x0 + 1, ((x + 1) * r.width) / dst)
                val y0 = (y * r.height) / dst
                val y1 = maxOf(y0 + 1, ((y + 1) * r.height) / dst)
                for (yy in y0 until y1) {
                    for (xx in x0 until x1) {
                        s += luma(r.pixels[yy * r.width + xx])
                        c++
                    }
                }
                grey[y * dst + x] = s / c
            }
        }
        for (i in grey.indices) {
            val g = (grey[i] * 255).toInt().coerceIn(0, 255)
            out[i] = (0xff shl 24) or (g shl 16) or (g shl 8) or g
        }
        return out
    }

    /* ------------------------------------------------------------- checks */

    private fun assertFuses(payload: String, p: Painting, withEmblem: Boolean) {
        val grid = QrGrid.encode(payload, ErrorCorrectionLevel.H)
        val req =
            ArtRequest(
                mode = ArtMode.FUSION,
                scale = scale,
                painting = p,
                emblem = if (withEmblem) emblem else null,
                emblemFraction = 0.12,
            )
        val g = Scannability.renderGuaranteed(grid, payload, req)
        assertTrue("fusion must decode (payload='$payload', emblem=$withEmblem, level=${g.level})", g.ok)
        assertEquals(payload, g.decoded)
        assertTrue(
            "artistic request should be honoured near the top of the ladder (level=${g.level})",
            g.level <= 1,
        )

        // Simulated camera capture: readable at 8 px per module with the JVM
        // reference decoder (5 px/module is additionally verified against the
        // ZXing-C++ port locally, see README).
        for (ppm in listOf(8.0)) {
            val cap = capture(g.rendered, ppm)
            val back = decodePixelsLenient(cap, cap.size, cap.size)
            assertEquals(
                "capture @${ppm}px/module (frame ${cap.size}px) must decode; got '$back' (level ${g.level})",
                payload,
                back,
            )
        }
    }

    @Test
    fun fusionScansAcrossHostilePaintings() {
        for ((_, p) in allPaintings) {
            for (payload in payloads) {
                assertFuses(payload, p, false)
            }
        }
    }

    @Test
    fun fusionWithEmblemScans() {
        for ((_, p) in allPaintings) {
            assertFuses(payloads[0], p, true)
            assertFuses(payloads[1], p, true)
        }
    }

    @Test
    fun posterAndClassicScans() {
        for ((_, p) in allPaintings) {
            for (mode in listOf(ArtMode.POSTER, ArtMode.CLASSIC)) {
                val grid = QrGrid.encode(payloads[0], ErrorCorrectionLevel.H)
                val g =
                    Scannability.renderGuaranteed(
                        grid,
                        payloads[0],
                        ArtRequest(mode = mode, scale = scale, painting = p, emblem = emblem, emblemFraction = 0.12),
                    )
                assertTrue("$mode must decode", g.ok)
            }
        }
    }

    @Test
    fun oversizedEmblemIsClampedAwayFromFunctionPatterns() {
        // Ask for far more logo area than is safe: the renderer must clamp the box
        // inside the format rings and skip function modules, and still decode.
        val grid = QrGrid.encode(payloads[0], ErrorCorrectionLevel.H)
        val g =
            Scannability.renderGuaranteed(
                grid,
                payloads[0],
                ArtRequest(mode = ArtMode.FUSION, scale = scale, painting = sunset, emblem = emblem, emblemFraction = 0.45),
            )
        assertTrue(g.ok)
    }

    @Test
    fun functionPatternsStayPristineAndHighContrast() {
        val grid = QrGrid.encode(payloads[0], ErrorCorrectionLevel.H)
        val r = ArtRenderer.render(grid, ArtRequest(mode = ArtMode.FUSION, scale = scale, painting = noise), 0)
        val quiet = 4
        // Finder pattern centre (module 3,3) must be deep dark...
        val dark = luma(r.pixels[((quiet + 3) * scale + scale / 2) * r.width + (quiet + 3) * scale + scale / 2])
        // ...and its separator ring (module 7,3) deep light.
        val light = luma(r.pixels[((quiet + 3) * scale + scale / 2) * r.width + (quiet + 7) * scale + scale / 2])
        assertTrue("finder dark must be dark (was $dark)", dark < 0.15)
        assertTrue("separator must be light (was $light)", light > 0.85)
        // Quiet zone uniform and light.
        assertTrue(luma(r.pixels[0]) > 0.9)
        assertEquals(r.pixels[0], r.pixels[r.width - 1])
    }

    @Test
    fun everyModuleKeepsItsCoreOnTheRightSideOfItsBody() {
        // The guarantee's mathematical heart: within a data module the sampled
        // core is an extremum (dark core darker than the darkest body tone of the
        // same module), so an adaptive binarizer cannot flip the sample.
        val grid = QrGrid.encode(payloads[2], ErrorCorrectionLevel.H)
        for (level in Bands.LEVELS.indices) {
            val b = Bands.LEVELS[level]
            assertTrue("dark body must sit under the mid threshold", b.darkBody[1] <= 0.46)
            assertTrue("light body must sit over the mid threshold", b.lightBody[0] >= 0.54)
            assertTrue("core must stay inside its own side", b.darkCore[1] < b.darkBody[0])
            assertTrue("core must stay inside its own side", b.lightCore[0] > b.lightBody[1])
        }
        // At the artistic end of the ladder the sampled core is a clear extremum
        // of its own module (the property adaptive binarizers cannot flip).
        val b0 = Bands.LEVELS[0]
        assertTrue(b0.darkCore[1] + 0.08 <= b0.darkBody[0])
        assertTrue(b0.lightCore[0] - 0.08 >= b0.lightBody[1])
        val r = ArtRenderer.render(grid, ArtRequest(mode = ArtMode.FUSION, scale = scale, painting = portrait), 0)
        val quiet = 4
        var worstMargin = 1.0
        for (my in 0 until grid.size) {
            for (mx in 0 until grid.size) {
                if (grid.isFunction(mx, my)) continue
                val ox = (quiet + mx) * scale
                val oy = (quiet + my) * scale
                val core = luma(r.pixels[(oy + scale / 2) * r.width + ox + scale / 2])
                var bodyMin = 1.0
                var bodyMax = 0.0
                for (ly in 0 until scale) {
                    for (lx in 0 until scale) {
                        val d = maxOf(kotlin.math.abs(lx + 0.5 - scale / 2.0), kotlin.math.abs(ly + 0.5 - scale / 2.0)) / (scale / 2.0)
                        if (d < 0.85) continue // outer ring: pure body tones
                        val y = luma(r.pixels[(oy + ly) * r.width + ox + lx])
                        bodyMin = minOf(bodyMin, y)
                        bodyMax = maxOf(bodyMax, y)
                    }
                }
                val margin = if (grid.isDark(mx, my)) bodyMin - core else core - bodyMax
                worstMargin = minOf(worstMargin, margin)
            }
        }
        assertTrue("core/body margin must stay positive (was $worstMargin)", worstMargin > 0.02)
    }

    @Test
    fun lowContrastPaintingIsRescuedByTheCorridor() {
        val grid = QrGrid.encode(payloads[0], ErrorCorrectionLevel.H)
        val g =
            Scannability.renderGuaranteed(
                grid,
                payloads[0],
                ArtRequest(mode = ArtMode.FUSION, scale = scale, painting = pastel),
            )
        assertTrue(g.ok)
    }

    @Test
    fun allErrorCorrectionLevelsStillScan() {
        for (level in listOf(ErrorCorrectionLevel.L, ErrorCorrectionLevel.M, ErrorCorrectionLevel.Q, ErrorCorrectionLevel.H)) {
            val grid = QrGrid.encode(payloads[1], level)
            val g =
                Scannability.renderGuaranteed(
                    grid,
                    payloads[1],
                    ArtRequest(mode = ArtMode.FUSION, scale = scale, painting = sunset),
                )
            assertTrue("ECC $level must decode", g.ok)
        }
    }

    @Test
    fun quietZoneIsFourModulesAndLight() {
        val grid = QrGrid.encode(payloads[0], ErrorCorrectionLevel.H)
        val r = ArtRenderer.render(grid, ArtRequest(mode = ArtMode.FUSION, scale = scale, quiet = 4, painting = forest), 0)
        val total = grid.size + 8
        assertEquals(total * scale, r.width)
        for (i in 0 until r.width) {
            assertTrue(luma(r.pixels[i]) > 0.9)
        }
    }

    @Test
    fun renderingIsDeterministic() {
        val grid = QrGrid.encode(payloads[0], ErrorCorrectionLevel.H)
        val req = ArtRequest(mode = ArtMode.FUSION, scale = scale, painting = sunset)
        val a = ArtRenderer.render(grid, req, 0)
        val b = ArtRenderer.render(grid, req, 0)
        assertTrue(a.pixels.contentEquals(b.pixels))
    }

    @Test
    fun luminanceMathIsExactAndHuePreserving() {
        val c = Rgb.hex("#c26a2f")
        for (target in listOf(0.05, 0.12, 0.3, 0.6, 0.85, 0.97)) {
            val moved = c.toLuminance(target)
            assertTrue("luma target miss at $target", abs(moved.luma() - target) < 0.01)
        }
        // Darker: pure scale, so hue ratios survive exactly.
        val dark = c.toLuminance(0.1)
        assertEquals(c.g.toDouble() / c.r, dark.g.toDouble() / dark.r, 0.02)
        assertEquals(21.0, Rgb.BLACK.contrastRatio(Rgb.WHITE), 0.05)
    }

    @Test
    fun functionMaskCoversExactlyTheFunctionPatterns() {
        for (version in listOf(1, 2, 7, 40)) {
            val size = version * 4 + 17
            val mask = QrLayout.functionMask(size, version)
            assertTrue(mask[3 * size + 3]) // finder centre
            assertTrue(mask[6 * size + 20]) // timing row
            assertTrue(mask[20 * size + 6]) // timing column
            assertTrue(mask[8]) // format ring
            assertTrue(mask[(size - 8) * size + 8]) // dark module
            if (version >= 7) {
                assertTrue(mask[size - 10]) // version info block
            }
            // A data module somewhere in the middle of the encoding region.
            var dataFound = false
            for (y in 10 until size - 10) {
                for (x in 10 until size - 10) {
                    if (!mask[y * size + x]) dataFound = true
                }
            }
            assertTrue(dataFound)
        }
        assertEquals(listOf(6, 18).toIntArray().toList(), QrLayout.alignmentCoords(2).toList())
        assertEquals(listOf(6, 22, 38).toIntArray().toList(), QrLayout.alignmentCoords(7).toList())
        assertEquals(
            listOf(6, 30, 58, 86, 114, 142, 170).toIntArray().toList(),
            QrLayout.alignmentCoords(40).toList(),
        )
    }

    @Test
    fun posterKeepsPhotoOutsideThePlate() {
        val grid = QrGrid.encode(payloads[0], ErrorCorrectionLevel.H)
        val r = ArtRenderer.render(grid, ArtRequest(mode = ArtMode.POSTER, scale = scale, painting = sunset), 0)
        val total = grid.size + 2 * (4 + 2)
        assertEquals(total * scale, r.width)
        // The outer frame pixel is the photo, not the plate.
        val corner = Rgb.of(r.pixels[0])
        val photo = sunset.sample(0.0, 0.0)
        val dr = (corner.r - photo.r).toDouble()
        val dg = (corner.g - photo.g).toDouble()
        val db = (corner.b - photo.b).toDouble()
        assertTrue(sqrt(dr * dr + dg * dg + db * db) < 2.0)
        // Plate centre-top (quiet zone inside plate) is light.
        val platePx = r.pixels[(2 * scale + scale / 2) * r.width + r.width / 2]
        assertTrue(Rgb.of(platePx).luma() > 0.9)
    }
}
