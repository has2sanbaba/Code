package code.qrart

/**
 * The QR spec's *function patterns* -- finder + separator + format rings, timing
 * patterns, alignment patterns, version information and the dark module.
 *
 * These are the only parts of a QR symbol that are NOT protected by Reed-Solomon
 * error correction (format/version carry only BCH), and the finder's 1:1:3:1:1
 * run ratios are how every scanner finds the symbol at all. The renderer therefore
 * treats them as untouchable: pristine geometry, maximum luminance separation,
 * no artwork, no logo, no photo.
 */
object QrLayout {

    /** Version (1..40) from the symbol size: size = 4*version + 17. */
    fun versionOf(size: Int): Int = (size - 17) / 4

    /**
     * Alignment-pattern centre coordinates for a version, using the spec's
     * even-step rule (with the v32 exception). Matches the ISO/IEC 18004 tables:
     * v2 -> [6,18], v7 -> [6,22,38], v40 -> [6,30,58,86,114,142,170].
     */
    fun alignmentCoords(version: Int): IntArray {
        if (version <= 1) return IntArray(0)
        val numAlign = version / 7 + 2
        val size = version * 4 + 17
        val step =
            if (version == 32) 26
            else ((version * 4 + 4).toDouble() / (numAlign * 2 - 2)).let { kotlin.math.ceil(it).toInt() } * 2
        val res = ArrayList<Int>()
        res.add(6)
        var pos = size - 7
        while (res.size < numAlign) {
            res.add(1, pos)
            pos -= step
        }
        return res.toIntArray()
    }

    /**
     * A mask over the module grid: true = function pattern (render pristine),
     * false = data/error-correction module (artwork may flow through it).
     */
    fun functionMask(size: Int, version: Int): BooleanArray {
        val m = BooleanArray(size * size)
        fun set(x: Int, y: Int) {
            if (x in 0 until size && y in 0 until size) m[y * size + x] = true
        }
        // Finder + separator + format information rings (3 corners).
        for (y in 0 until 9) for (x in 0 until 9) set(x, y)
        for (y in 0 until 9) for (x in size - 8 until size) set(x, y)
        for (y in size - 8 until size) for (x in 0 until 9) set(x, y)
        // Timing patterns (row 6 and column 6 between the finders).
        for (i in 8 until size - 8) {
            set(i, 6)
            set(6, i)
        }
        // Version information blocks (version >= 7 only).
        if (version >= 7) {
            for (y in 0 until 6) for (x in size - 11 until size - 8) set(x, y)
            for (y in size - 11 until size - 8) for (x in 0 until 6) set(x, y)
        }
        // Alignment patterns, skipping the three that merge into the finders.
        val coords = alignmentCoords(version)
        if (coords.isNotEmpty()) {
            val last = coords[coords.size - 1]
            for (cy in coords) {
                for (cx in coords) {
                    val overlapsFinder = (cx == 6 && cy == 6) || (cx == 6 && cy == last) || (cx == last && cy == 6)
                    if (overlapsFinder) continue
                    for (dy in -2..2) for (dx in -2..2) set(cx + dx, cy + dy)
                }
            }
        }
        return m
    }

    fun isFunction(mask: BooleanArray, size: Int, x: Int, y: Int): Boolean = mask[y * size + x]
}
