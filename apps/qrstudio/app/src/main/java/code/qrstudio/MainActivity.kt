package code.qrstudio

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Bundle
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.EditText
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
import com.google.android.material.snackbar.Snackbar
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * ArtQR studio: type a payload, pick a look, get a graphical QR code that is
 * provably scannable. Every render is decoded back with ZXing before it is shown,
 * so the "will it scan?" question is answered on-device, not at print time.
 */
class MainActivity : AppCompatActivity() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private lateinit var payload: EditText
    private lateinit var eccGroup: MaterialButtonToggleGroup
    private lateinit var shapeDropdown: AutoCompleteTextView
    private lateinit var paletteDropdown: AutoCompleteTextView
    private lateinit var mosaicSwitch: MaterialSwitch
    private lateinit var emblemSwitch: MaterialSwitch
    private lateinit var pickButton: MaterialButton
    private lateinit var generateButton: MaterialButton
    private lateinit var busyBox: LinearLayout
    private lateinit var preview: ImageView
    private lateinit var statusText: TextView
    private lateinit var saveButton: MaterialButton
    private lateinit var shareButton: MaterialButton

    private var shapeIndex = 1 // rounded
    private var paletteIndex = 0
    private var pickedImg: Img? = null
    private var lastBitmap: Bitmap? = null

    private val shapes = listOf(ModuleShape.SQUARE, ModuleShape.ROUNDED, ModuleShape.DOT)

    private data class Palette(
        val dark: Rgb,
        val light: Rgb,
        val gradient: Pair<Rgb, Rgb>?,
        val accent: Rgb?,
    )

    private val palettes =
        listOf(
            Palette(Rgb.BLACK, Rgb.WHITE, null, null),
            Palette(Rgb.hex("#1e3a5f"), Rgb.hex("#fdf6e3"), null, null),
            Palette(Rgb.BLACK, Rgb.WHITE, Pair(Rgb.hex("#7c3aed"), Rgb.hex("#0f766e")), Rgb.hex("#1d4ed8")),
            Palette(Rgb.BLACK, Rgb.WHITE, Pair(Rgb.hex("#be123c"), Rgb.hex("#7c2d12")), Rgb.hex("#b45309")),
            Palette(Rgb.hex("#14532d"), Rgb.hex("#f0fdf4"), null, Rgb.hex("#166534")),
        )

    private val pickPhoto =
        registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri == null) return@registerForActivityResult
            scope.launch {
                val img = withContext(Dispatchers.IO) { BitmapBridge.loadImg(this@MainActivity, uri) }
                pickedImg = img
                if (img == null) snack(R.string.err_photo) else snack(R.string.photo_loaded)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        payload = findViewById(R.id.input_payload)
        eccGroup = findViewById(R.id.ecc_group)
        shapeDropdown = findViewById(R.id.shape_dropdown)
        paletteDropdown = findViewById(R.id.palette_dropdown)
        mosaicSwitch = findViewById(R.id.mosaic_switch)
        emblemSwitch = findViewById(R.id.emblem_switch)
        pickButton = findViewById(R.id.pick_button)
        generateButton = findViewById(R.id.generate_button)
        busyBox = findViewById(R.id.busy_box)
        preview = findViewById(R.id.preview)
        statusText = findViewById(R.id.status_text)
        saveButton = findViewById(R.id.save_button)
        shareButton = findViewById(R.id.share_button)

        eccGroup.check(R.id.ecc_h)

        val shapeNames = resources.getStringArray(R.array.shape_names).toList()
        shapeDropdown.setAdapter(ArrayAdapter(this, android.R.layout.simple_list_item_1, shapeNames))
        shapeDropdown.setText(shapeNames[shapeIndex], false)
        shapeDropdown.setOnItemClickListener { _, _, pos, _ -> shapeIndex = pos }

        val paletteNames = resources.getStringArray(R.array.palette_names).toList()
        paletteDropdown.setAdapter(ArrayAdapter(this, android.R.layout.simple_list_item_1, paletteNames))
        paletteDropdown.setText(paletteNames[paletteIndex], false)
        paletteDropdown.setOnItemClickListener { _, _, pos, _ -> paletteIndex = pos }

        pickButton.setOnClickListener { pickPhoto.launch("image/*") }
        generateButton.setOnClickListener { onGenerate() }
        saveButton.setOnClickListener { onSave() }
        shareButton.setOnClickListener {
            lastBitmap?.let { BitmapBridge.share(this, it) }
        }
    }

    private fun selectedLevel(): ErrorCorrectionLevel =
        when (eccGroup.checkedButtonId) {
            R.id.ecc_l -> ErrorCorrectionLevel.L
            R.id.ecc_m -> ErrorCorrectionLevel.M
            R.id.ecc_q -> ErrorCorrectionLevel.Q
            else -> ErrorCorrectionLevel.H
        }

    private fun onGenerate() {
        val text = payload.text.toString().trim()
        if (text.isEmpty()) {
            snack(R.string.err_empty)
            return
        }
        val wantsPhoto = mosaicSwitch.isChecked || emblemSwitch.isChecked
        if (wantsPhoto && pickedImg == null) {
            snack(R.string.err_photo)
            return
        }
        val palette = palettes.getOrElse(paletteIndex) { palettes[0] }
        val options =
            ArtOptions(
                scale = 10,
                quiet = 4,
                shape = shapes.getOrElse(shapeIndex) { ModuleShape.ROUNDED },
                dark = palette.dark,
                light = palette.light,
                accent = palette.accent,
                gradient = palette.gradient,
                mosaic = if (mosaicSwitch.isChecked) pickedImg else null,
                emblem = if (emblemSwitch.isChecked) pickedImg else null,
            )
        val level = selectedLevel()

        generateButton.isEnabled = false
        busyBox.isVisible = true
        scope.launch {
            val result =
                withContext(Dispatchers.Default) {
                    val t0 = System.currentTimeMillis()
                    val grid = QrGrid.encode(text, level)
                    val rendered = ArtRenderer.render(grid, options)
                    val back = decodePixels(rendered.pixels, rendered.width, rendered.height)
                    val ms = System.currentTimeMillis() - t0
                    Triple(rendered, back, ms)
                }
            val (rendered, back, ms) = result
            val bmp = BitmapBridge.toBitmap(rendered)
            lastBitmap = bmp
            preview.setImageBitmap(bmp)
            statusText.text =
                if (back == text) {
                    getString(R.string.scannable_ok, ms)
                } else {
                    getString(R.string.scannable_fail)
                }
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
            val uri = withContext(Dispatchers.IO) { BitmapBridge.saveToGallery(this@MainActivity, bmp) }
            snack(if (uri != null) R.string.saved else R.string.save_failed)
        }
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
