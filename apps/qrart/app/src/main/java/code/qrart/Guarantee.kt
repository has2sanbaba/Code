package code.qrart

/**
 * The contract of the whole app: never hand the user a code that does not scan.
 *
 * [renderGuaranteed] renders the requested look, decodes it back with the ZXing
 * reference decoder (the same grayscale/adaptive-binarize/sample/Reed-Solomon
 * pipeline every phone camera runs), and -- if the artistic request was too bold
 * for the decoder -- escalates through the guarantee ladder: narrower luminance
 * corridors, then a smaller logo, then a nearly flat code, and finally a plain
 * high-contrast classic symbol, which is structurally always readable.
 *
 * The level actually used is reported back so the UI can say *why* ("rendered at
 * safety level 2 so it stays scannable"), instead of silently shipping artwork
 * that only looks scannable.
 */
data class Guaranteed(
    val rendered: Rendered,
    val level: Int,
    val decoded: String?,
    val ok: Boolean,
    val ms: Long,
    val attempts: Int,
)

object Scannability {

    fun renderGuaranteed(
        grid: QrGrid,
        payload: String,
        req: ArtRequest,
        startLevel: Int = 0,
    ): Guaranteed {
        var last: Guaranteed? = null
        for (level in startLevel.coerceIn(0, Bands.LEVELS.size - 1) until Bands.LEVELS.size) {
            val t0 = System.nanoTime()
            val rendered = ArtRenderer.render(grid, req, level)
            val decoded = decodePixels(rendered.pixels, rendered.width, rendered.height)
            val ms = (System.nanoTime() - t0) / 1_000_000
            val g = Guaranteed(rendered, level, decoded, decoded == payload, ms, level + 1)
            if (g.ok) return g
            last = g
        }
        // Structural fallback: a plain dark-on-light symbol. Always decodes.
        val t0 = System.nanoTime()
        val plain =
            ArtRenderer.render(
                grid,
                ArtRequest(mode = ArtMode.CLASSIC, scale = req.scale, quiet = req.quiet, dark = Rgb.BLACK, light = Rgb.WHITE),
                3,
            )
        val decoded = decodePixels(plain.pixels, plain.width, plain.height)
        val ms = (System.nanoTime() - t0) / 1_000_000
        return Guaranteed(plain, Bands.LEVELS.size, decoded, decoded == payload, ms, Bands.LEVELS.size + 1)
            .let { if (it.ok) it else (last ?: it) }
    }
}
