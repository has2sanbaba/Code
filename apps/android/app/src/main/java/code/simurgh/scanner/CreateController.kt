package code.simurgh.scanner

import android.graphics.Bitmap
import android.util.Base64
import android.view.View
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.isVisible
import com.google.android.material.button.MaterialButton
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.card.MaterialCardView
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.materialswitch.MaterialSwitch
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * The create panel: payload in, scannable symbol out.
 *
 * Every decision (segments, version, ECC block plan, mask selection, Golay
 * crown, Reed-Solomon interleaving, DEFLATE, the SECURE envelope) happens
 * inside the engine -- the exact TypeScript reference core, bit-identical to
 * the 161 repository test suites. This class only assembles JSON requests,
 * turns the returned raster into a [Bitmap], and self-tests the result by
 * decoding it again before showing it.
 */
class CreateController(
    private val activity: MainActivity,
    private val scope: CoroutineScope,
    root: View,
) {
    private val payload = root.findViewById<EditText>(R.id.input_payload)
    private val eccGroup = root.findViewById<MaterialButtonToggleGroup>(R.id.ecc_group)
    private val themeDropdown = root.findViewById<AutoCompleteTextView>(R.id.theme_dropdown)
    private val shapeDropdown = root.findViewById<AutoCompleteTextView>(R.id.shape_dropdown)
    private val secureSwitch = root.findViewById<MaterialSwitch>(R.id.secure_switch)
    private val secureGroup = root.findViewById<LinearLayout>(R.id.secure_group)
    private val securePass = root.findViewById<EditText>(R.id.secure_pass)
    private val secureIter = root.findViewById<EditText>(R.id.secure_iter)
    private val secureContext = root.findViewById<EditText>(R.id.secure_context)
    private val generateButton = root.findViewById<MaterialButton>(R.id.generate_button)
    private val busyBox = root.findViewById<LinearLayout>(R.id.busy_box)
    private val busyText = root.findViewById<TextView>(R.id.busy_text)
    private val resultCard = root.findViewById<MaterialCardView>(R.id.result_card)
    private val symbolView = root.findViewById<ImageView>(R.id.symbol_view)
    private val infoText = root.findViewById<TextView>(R.id.result_info)
    private val selfTestText = root.findViewById<TextView>(R.id.selftest_text)
    private val saveButton = root.findViewById<MaterialButton>(R.id.save_button)
    private val shareButton = root.findViewById<MaterialButton>(R.id.share_button)
    private val verifyButton = root.findViewById<MaterialButton>(R.id.verify_button)

    private var lastBitmap: Bitmap? = null
    private var lastRgbaB64: String? = null
    private var lastWidth = 0
    private var lastHeight = 0
    private var lastSealed = false
    private var themeIds = listOf("ink", "lapis", "turquoise", "saffron", "rosewater", "pistachio", "pomegranate", "night")
    private val shapeIds = listOf("dot", "hex", "square")

    // Clean, classic, highest-contrast look by default: ink (black on white) +
    // square modules + a 4-module quiet zone. These are the research-backed
    // settings that scan most reliably and read as "simple, like QR"; the ornate
    // palettes (lapis, night, ...) and round/hex modules stay one tap away.
    private var themeIndex = 0 // ink
    private var shapeIndex = 2 // square

    init {
        eccGroup.check(R.id.ecc_m)
        val shapeLabels =
            listOf(
                activity.getString(R.string.shape_dot),
                activity.getString(R.string.shape_hex),
                activity.getString(R.string.shape_square),
            )
        shapeDropdown.setAdapter(ArrayAdapter(activity, android.R.layout.simple_list_item_1, shapeLabels))
        shapeDropdown.setText(shapeLabels[shapeIndex], false)
        shapeDropdown.setOnItemClickListener { _, _, position, _ -> shapeIndex = position }
        loadThemes()
        secureSwitch.setOnCheckedChangeListener { _, checked -> secureGroup.isVisible = checked }
        generateButton.setOnClickListener { onGenerate() }
        saveButton.setOnClickListener { onSave() }
        shareButton.setOnClickListener { onShare() }
        verifyButton.setOnClickListener { onVerify() }
        verifyButton.isEnabled = false
    }

    /** Theme list (with Persian names and measured contrast) comes from the engine. */
    private fun loadThemes() {
        scope.launch {
            var labels = themeIds
            try {
                val resp = withContext(Dispatchers.Default) { Engine.call(activity, JSONObject().put("op", "themes")) }
                val arr = resp.getJSONArray("themes")
                themeIds = (0 until arr.length()).map { arr.getJSONObject(it).getString("id") }
                labels =
                    (0 until arr.length()).map {
                        val t = arr.getJSONObject(it)
                        activity.getString(
                            R.string.theme_item,
                            t.getString("fa"),
                            t.getString("en"),
                            t.getDouble("contrast").toString(),
                        )
                    }
                themeIndex = themeIds.indexOf("ink").coerceAtLeast(0)
            } catch (_: Exception) {
                // Engine warm-up failed; the static list still works.
            }
            themeDropdown.setAdapter(ArrayAdapter(activity, android.R.layout.simple_list_item_1, labels))
            themeDropdown.setText(labels.getOrElse(themeIndex) { labels[0] }, false)
            themeDropdown.setOnItemClickListener { _, _, position, _ -> themeIndex = position }
        }
    }

    private fun selectedEcc(): String =
        when (eccGroup.checkedButtonId) {
            R.id.ecc_l -> "L"
            R.id.ecc_q -> "Q"
            R.id.ecc_h -> "H"
            else -> "M"
        }

    private fun onGenerate() {
        val text = payload.text.toString().trim()
        if (text.isEmpty()) {
            snack(R.string.err_empty_payload)
            return
        }
        val req = JSONObject()
        req.put("op", "encode")
        if (text.startsWith("http://") || text.startsWith("https://")) req.put("url", text) else req.put("text", text)
        req.put("ecc", selectedEcc())
        req.put("theme", themeIds.getOrElse(themeIndex) { "ink" })
        req.put("shape", shapeIds.getOrElse(shapeIndex) { "square" })
        // Scale 8 keeps the on-device raster (and its base64) ~2.25x smaller than
        // the old 12, which is a direct encode-speed win; quiet 4 is the quiet
        // zone scanners want. Both still render crisply on screen and in save.
        req.put("scale", 8)
        req.put("quiet", 4)

        var sealed = false
        if (secureSwitch.isChecked) {
            val pass = securePass.text.toString()
            if (pass.isEmpty()) {
                snack(R.string.err_empty_pass)
                return
            }
            sealed = true
            val iterations = (secureIter.text.toString().toIntOrNull() ?: 210000).coerceIn(1000, 1_000_000)
            val secure = JSONObject()
            secure.put("pass", pass)
            secure.put("iterations", iterations)
            // Fresh salt (16 B) and nonce (12 B) from the platform CSPRNG on
            // every generation -- never reused, never from the VM.
            secure.put("saltHex", Engine.randomHex(16))
            secure.put("nonceHex", Engine.randomHex(12))
            val ctx = secureContext.text.toString().trim()
            if (ctx.isNotEmpty()) secure.put("context", ctx)
            req.put("secure", secure)
        }

        generateButton.isEnabled = false
        resultCard.isVisible = false
        busyBox.isVisible = true
        busyText.setText(R.string.busy_encoding)

        scope.launch {
            try {
                val resp = withContext(Dispatchers.Default) { Engine.call(activity, req) }
                if (!resp.optBoolean("ok")) {
                    snackText(resp.optString("error", "?"))
                    return@launch
                }
                busyText.setText(R.string.busy_selftest)
                val raster = resp.getJSONObject("raster")
                val rgbaB64 = raster.getString("rgbaB64")
                val width = raster.getInt("width")
                val height = raster.getInt("height")

                // Fast self-test: read the codewords straight back (Reed-Solomon,
                // Golay crown, CRC, segments) with no render -> locate -> orient ->
                // sample pass. For a sealed symbol this verifies structure only and
                // skips the second PBKDF2 derivation, so encode stays quick; the
                // "Verify by image" button runs the full imaging read on demand.
                val t0 = System.currentTimeMillis()
                val self =
                    withContext(Dispatchers.Default) {
                        Engine.decodeBits(
                            activity,
                            resp.getString("dataBitsHex"),
                            resp.getString("beadsHex"),
                        )
                    }
                val selfMs = (System.currentTimeMillis() - t0).toInt()

                val bytes = Base64.decode(rgbaB64, Base64.DEFAULT)
                val bmp =
                    withContext(Dispatchers.Default) { Bitmaps.rgbaToBitmap(bytes, width, height) }
                lastBitmap = bmp
                lastRgbaB64 = rgbaB64
                lastWidth = width
                lastHeight = height
                lastSealed = sealed
                symbolView.setImageBitmap(bmp)
                infoText.text = buildInfo(resp)
                selfTestText.text = buildSelfTest(self, text, sealed, selfMs)
                resultCard.isVisible = true
                verifyButton.isEnabled = true
            } catch (e: Exception) {
                snackText(e.message ?: e.javaClass.simpleName)
            } finally {
                busyBox.isVisible = false
                generateButton.isEnabled = true
            }
        }
    }

    private fun buildInfo(resp: JSONObject): String {
        val sb = StringBuilder()
        sb.append(
            activity.getString(
                R.string.info_line1,
                resp.getInt("version"),
                resp.getString("ecc"),
                resp.getInt("mask"),
            ),
        )
        sb.append('\n')
        sb.append(
            activity.getString(
                R.string.info_line2,
                resp.getInt("cells"),
                resp.getInt("payloadBytes"),
                resp.getInt("codewords"),
                resp.getInt("blocks"),
            ),
        )
        sb.append('\n')
        val compressed = activity.getString(if (resp.optBoolean("compressed")) R.string.yes else R.string.no)
        sb.append(
            activity.getString(
                R.string.info_line3,
                Math.round(resp.optDouble("inkCoverage", 0.0) * 100).toInt(),
                compressed,
                themeIds.getOrElse(themeIndex) { "ink" },
            ),
        )
        val secure = resp.optJSONObject("secure")
        if (secure != null) {
            sb.append('\n')
            sb.append(
                activity.getString(
                    R.string.info_sealed,
                    secure.getString("keyId"),
                    secure.getInt("iterations"),
                    secure.getInt("ciphertextBytes"),
                ),
            )
        }
        return sb.toString()
    }

    /**
     * Formats the fast bit-level self-test. `self` is the decodeBits result
     * ({ok, text, crcOk, encrypted, unlocked}). For a sealed symbol the content
     * is intentionally not opened here -- that would re-run the full PBKDF2 --
     * so we confirm the structure + CRC and that the envelope is present.
     */
    private fun buildSelfTest(self: JSONObject, expected: String, sealed: Boolean, ms: Int): String {
        if (!self.optBoolean("ok")) return activity.getString(R.string.selftest_fail)
        if (sealed) {
            val structOk = self.optBoolean("crcOk") && self.optBoolean("encrypted")
            return if (structOk) {
                activity.getString(R.string.selftest_sealed_ok, ms)
            } else {
                activity.getString(R.string.selftest_fail)
            }
        }
        return if (self.optString("text") == expected) {
            activity.getString(R.string.selftest_bits_ok, ms)
        } else {
            activity.getString(R.string.selftest_mismatch)
        }
    }

    /**
     * On-demand full verification: decode the rendered raster through the whole
     * imaging ladder (and unlock it if sealed). This is the slow, thorough check
     * the old flow ran on every encode; making it opt-in is what keeps normal
     * encode fast on the interpreter.
     */
    private fun onVerify() {
        val rgbaB64 = lastRgbaB64 ?: return
        verifyButton.isEnabled = false
        busyBox.isVisible = true
        busyText.setText(R.string.busy_verify)
        scope.launch {
            try {
                val req = JSONObject()
                req.put("op", "decode")
                req.put("rgbaB64", rgbaB64)
                req.put("width", lastWidth)
                req.put("height", lastHeight)
                if (lastSealed) req.put("pass", securePass.text.toString())
                val t0 = System.currentTimeMillis()
                val self = withContext(Dispatchers.Default) { Engine.call(activity, req) }
                val ms = (System.currentTimeMillis() - t0).toInt()
                selfTestText.text = buildVerifyResult(self, ms)
            } catch (e: Exception) {
                snackText(e.message ?: e.javaClass.simpleName)
            } finally {
                busyBox.isVisible = false
                verifyButton.isEnabled = true
            }
        }
    }

    private fun buildVerifyResult(self: JSONObject, ms: Int): String {
        if (!self.optBoolean("ok")) return activity.getString(R.string.selftest_fail)
        if (lastSealed) {
            return if (self.optBoolean("unlocked")) {
                activity.getString(R.string.verify_unlocked, ms)
            } else {
                activity.getString(R.string.verify_locked, ms)
            }
        }
        return activity.getString(R.string.verify_ok, ms)
    }

    fun onSave() {
        val bmp = lastBitmap ?: return
        if (!activity.hasWritePermission()) {
            activity.requestWritePermission()
            return
        }
        saveButton.isEnabled = false
        scope.launch {
            try {
                val uri = withContext(Dispatchers.IO) { Bitmaps.saveToGallery(activity, bmp) }
                snack(if (uri != null) R.string.saved else R.string.save_failed)
            } catch (e: Exception) {
                snackText(e.message ?: e.javaClass.simpleName)
            } finally {
                saveButton.isEnabled = true
            }
        }
    }

    private fun onShare() {
        val bmp = lastBitmap ?: return
        try {
            Bitmaps.share(activity, bmp)
        } catch (e: Exception) {
            snackText(e.message ?: e.javaClass.simpleName)
        }
    }

    private fun snack(res: Int) {
        Snackbar.make(generateButton, res, Snackbar.LENGTH_SHORT).show()
    }

    private fun snackText(text: String) {
        Snackbar.make(generateButton, text, Snackbar.LENGTH_LONG).show()
    }
}
