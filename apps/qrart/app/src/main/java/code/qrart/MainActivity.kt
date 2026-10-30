package code.qrart

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Bundle
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import com.google.android.material.button.MaterialButton
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.slider.Slider
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.textfield.TextInputEditText
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * QRArt studio. The flow is deliberately impossible to get wrong: pick a
 * painting, choose a style, press make -- and whatever comes back has already
 * been decoded by ZXing on this device, so the badge under the preview is a
 * measurement, not a promise.
 */
class MainActivity : AppCompatActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private lateinit var payload: TextInputEditText
    private lateinit var eccGroup: MaterialButtonToggleGroup
    private lateinit var modeGroup: MaterialButtonToggleGroup
    private lateinit var pickButton: MaterialButton
    private lateinit var photoThumb: ImageView
    private lateinit var photoState: TextView
    private lateinit var emblemSwitch: MaterialSwitch
    private lateinit var artSlider: Slider
    private lateinit var generateButton: MaterialButton
    private lateinit var busyBox: LinearLayout
    private lateinit var preview: ImageView
    private lateinit var statusText: TextView
    private lateinit var saveButton: MaterialButton
    private lateinit var shareButton: MaterialButton

    private var painting: Painting? = null
    private var lastBitmap: Bitmap? = null
    private var startLevel = 0

    private val pickPhoto =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri == null) return@registerForActivityResult
            scope.launch {
                val img = withContext(Dispatchers.IO) { Bitmaps.loadPainting(this@MainActivity, uri) }
                painting = img
                if (img == null) {
                    photoState.setText(R.string.photo_none)
                    snack(R.string.err_photo)
                } else {
                    photoState.text = getString(R.string.photo_loaded, img.width, img.height)
                    photoThumb.setImageBitmap(thumbOf(img))
                    if (!payload.text.isNullOrBlank()) onGenerate()
                }
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        payload = findViewById(R.id.input_payload)
        eccGroup = findViewById(R.id.ecc_group)
        modeGroup = findViewById(R.id.mode_group)
        pickButton = findViewById(R.id.pick_button)
        photoThumb = findViewById(R.id.photo_thumb)
        photoState = findViewById(R.id.photo_state)
        emblemSwitch = findViewById(R.id.emblem_switch)
        artSlider = findViewById(R.id.art_slider)
        generateButton = findViewById(R.id.generate_button)
        busyBox = findViewById(R.id.busy_box)
        preview = findViewById(R.id.preview)
        statusText = findViewById(R.id.status_text)
        saveButton = findViewById(R.id.save_button)
        shareButton = findViewById(R.id.share_button)

        eccGroup.check(R.id.ecc_h)
        modeGroup.check(R.id.mode_fusion)

        pickButton.setOnClickListener { pickPhoto.launch("image/*") }
        generateButton.setOnClickListener { onGenerate() }
        saveButton.setOnClickListener { onSave() }
        shareButton.setOnClickListener { lastBitmap?.let { Bitmaps.share(this, it) } }
        artSlider.addOnChangeListener { _, value, _ -> startLevel = value.toInt().coerceIn(0, 3) }
    }

    private fun selectedLevel(): ErrorCorrectionLevel =
        when (eccGroup.checkedButtonId) {
            R.id.ecc_l -> ErrorCorrectionLevel.L
            R.id.ecc_m -> ErrorCorrectionLevel.M
            R.id.ecc_q -> ErrorCorrectionLevel.Q
            else -> ErrorCorrectionLevel.H
        }

    private fun selectedMode(): ArtMode =
        when (modeGroup.checkedButtonId) {
            R.id.mode_poster -> ArtMode.POSTER
            R.id.mode_classic -> ArtMode.CLASSIC
            else -> ArtMode.FUSION
        }

    private fun onGenerate() {
        val text = payload.text?.toString()?.trim().orEmpty()
        if (text.isEmpty()) {
            snack(R.string.err_empty)
            return
        }
        val mode = selectedMode()
        if (mode != ArtMode.CLASSIC && painting == null) {
            snack(R.string.err_photo)
            return
        }
        val req =
            ArtRequest(
                mode = mode,
                scale = 16,
                quiet = 4,
                painting = painting,
                emblem = if (emblemSwitch.isChecked) painting else null,
                emblemFraction = 0.12,
            )
        val level = selectedLevel()

        generateButton.isEnabled = false
        saveButton.isEnabled = false
        shareButton.isEnabled = false
        busyBox.isVisible = true
        statusText.setText(R.string.busy)

        scope.launch {
            val result =
                withContext(Dispatchers.Default) {
                    val grid = QrGrid.encode(text, level)
                    Scannability.renderGuaranteed(grid, text, req, startLevel)
                }
            val bmp = Bitmaps.toBitmap(result.rendered)
            lastBitmap = bmp
            preview.setImageBitmap(bmp)
            preview.isVisible = true
            statusText.text =
                if (result.ok) {
                    getString(R.string.status_ok, result.ms, result.level)
                } else {
                    getString(R.string.status_fail)
                }
            saveButton.isEnabled = result.ok
            shareButton.isEnabled = result.ok
            busyBox.isVisible = false
            generateButton.isEnabled = true
        }
    }

    private fun onSave() {
        val bmp = lastBitmap ?: return
        if (!hasWritePermission()) {
            requestWritePermission()
            return
        }
        scope.launch {
            val uri = withContext(Dispatchers.IO) { Bitmaps.saveToGallery(this@MainActivity, bmp) }
            snack(if (uri != null) R.string.saved else R.string.save_failed)
        }
    }

    private fun thumbOf(img: Painting): Bitmap {
        val side = 96
        val bmp = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888)
        val px = IntArray(side * side)
        for (y in 0 until side) {
            for (x in 0 until side) {
                px[y * side + x] = img.sample(x.toDouble() / side, y.toDouble() / side).argb()
            }
        }
        bmp.setPixels(px, 0, side, 0, 0, side, side)
        return bmp
    }

    /* ------------------------------------------------------------ permissions */

    @Suppress("DEPRECATION")
    private fun hasWritePermission(): Boolean =
        android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
                PackageManager.PERMISSION_GRANTED

    @Suppress("DEPRECATION")
    private fun requestWritePermission() {
        requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_WRITE)
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_WRITE && grantResults.isNotEmpty() &&
            grantResults[0] == PackageManager.PERMISSION_GRANTED
        ) {
            onSave()
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun snack(res: Int) {
        Snackbar.make(generateButton, res, Snackbar.LENGTH_SHORT).show()
    }

    private companion object {
        const val REQ_WRITE = 48
    }
}
