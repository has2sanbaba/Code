package code.simurgh.scanner

import android.content.ClipData
import android.content.ClipboardManager
import android.view.HapticFeedbackConstants
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import android.util.Size
import com.google.android.material.button.MaterialButton
import com.google.android.material.card.MaterialCardView
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The scan panel: CameraX preview + frame analysis.
 *
 * Frames are reduced to an upright grayscale image (Y plane only), base64'd
 * and handed to the engine's full imaging pipeline -- halo search, Angle
 * Track phase lock, Crown reading, geometric resampling, erasure-aware
 * Reed-Solomon -- the same code that passes the repository's imaging suites.
 * The first pass is the bounded `fast` profile so negative frames stay cheap;
 * unlocking a sealed symbol re-runs the full decoder with the key.
 */
class ScanController(
    private val activity: MainActivity,
    private val scope: CoroutineScope,
    root: View,
) {
    private val previewView = root.findViewById<PreviewView>(R.id.preview)
    private val permissionBox = root.findViewById<LinearLayout>(R.id.permission_box)
    private val permissionButton = root.findViewById<MaterialButton>(R.id.permission_button)
    private val torchButton = root.findViewById<MaterialButton>(R.id.torch_button)
    private val resumeButton = root.findViewById<MaterialButton>(R.id.resume_button)
    private val hint = root.findViewById<TextView>(R.id.scan_hint)
    private val resultCard = root.findViewById<MaterialCardView>(R.id.scan_result_card)
    private val resultText = root.findViewById<TextView>(R.id.scan_text)
    private val metaText = root.findViewById<TextView>(R.id.scan_meta)
    private val unlockGroup = root.findViewById<LinearLayout>(R.id.unlock_group)
    private val unlockPass = root.findViewById<EditText>(R.id.unlock_pass)
    private val unlockButton = root.findViewById<MaterialButton>(R.id.unlock_button)
    private val copyButton = root.findViewById<MaterialButton>(R.id.copy_button)
    private val closeButton = root.findViewById<MaterialButton>(R.id.close_result)

    private val analyzerExecutor = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)

    @Volatile
    private var paused = true
    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var torchOn = false
    private var lastGray: Yuv.Gray? = null

    init {
        permissionButton.setOnClickListener { activity.requestCameraPermission() }
        torchButton.setOnClickListener {
            val c = camera ?: return@setOnClickListener
            torchOn = !torchOn
            c.cameraControl.enableTorch(torchOn)
            torchButton.setText(if (torchOn) R.string.torch_off else R.string.torch_on)
        }
        resumeButton.setOnClickListener { resume() }
        closeButton.setOnClickListener { resume() }
        copyButton.setOnClickListener {
            val cm = ContextCompat.getSystemService(activity, ClipboardManager::class.java)
            cm?.setPrimaryClip(ClipData.newPlainText("SiMurgh", resultText.text))
            Snackbar.make(previewView, R.string.copied, Snackbar.LENGTH_SHORT).show()
        }
        unlockButton.setOnClickListener { onUnlock() }
    }

    fun onShow() {
        paused = false
        if (!activity.hasCameraPermission()) {
            permissionBox.isVisible = true
            previewView.isVisible = false
            return
        }
        permissionBox.isVisible = false
        previewView.isVisible = true
        bindCamera()
    }

    fun onHide() {
        paused = true
        release()
    }

    fun release() {
        provider?.unbindAll()
        provider = null
        camera = null
        torchOn = false
        torchButton.setText(R.string.torch_on)
    }

    private fun bindCamera() {
        if (provider != null) return
        val future = ProcessCameraProvider.getInstance(activity)
        future.addListener(
            {
                try {
                    val p = future.get()
                    provider = p
                    val preview =
                        Preview.Builder().build().also {
                            it.setSurfaceProvider(previewView.surfaceProvider)
                        }
                    val analysis =
                        ImageAnalysis.Builder()
                            .setResolutionSelector(
                                ResolutionSelector.Builder()
                                    .setResolutionStrategy(
                                        ResolutionStrategy(
                                            Size(960, 960),
                                            ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                                        ),
                                    ).build(),
                            )
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build()
                    analysis.setAnalyzer(analyzerExecutor) { proxy -> analyze(proxy) }
                    p.unbindAll()
                    camera = p.bindToLifecycle(activity, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                } catch (e: Exception) {
                    hint.text = e.message ?: e.javaClass.simpleName
                }
            },
            ContextCompat.getMainExecutor(activity),
        )
    }

    private fun analyze(proxy: ImageProxy) {
        if (paused || !busy.compareAndSet(false, true)) {
            proxy.close()
            return
        }
        val gray =
            try {
                Yuv.toGray(proxy, 960)
            } catch (_: Exception) {
                busy.set(false)
                return
            } finally {
                proxy.close()
            }
        scope.launch {
            try {
                val req = JSONObject()
                req.put("op", "decode")
                req.put("grayB64", gray.toBase64())
                req.put("width", gray.width)
                req.put("height", gray.height)
                req.put("fast", true)
                val resp = withContext(Dispatchers.Default) { Engine.call(activity, req) }
                if (resp.optBoolean("ok")) present(resp, gray)
            } catch (_: Exception) {
                // Keep scanning through transient engine errors.
            } finally {
                busy.set(false)
            }
        }
    }

    private fun present(resp: JSONObject, gray: Yuv.Gray) {
        paused = true
        lastGray = gray
        previewView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        val locked = resp.optBoolean("encrypted") && !resp.optBoolean("unlocked")
        resultText.text = if (locked) activity.getString(R.string.scan_locked) else resp.optString("text")
        metaText.text = buildMeta(resp, locked)
        unlockGroup.isVisible = locked
        resultCard.isVisible = true
        hint.isVisible = false
        resumeButton.isVisible = true
    }

    private fun buildMeta(resp: JSONObject, locked: Boolean): String {
        val diag = resp.optJSONObject("diag") ?: return ""
        val sb = StringBuilder()
        sb.append(
            activity.getString(
                R.string.meta_scan,
                diag.optInt("version"),
                diag.optString("ecc"),
                diag.optString("teeth"),
                diag.optDouble("confidence").toString(),
                resp.optInt("ms"),
            ),
        )
        sb.append('\n')
        val inverted = activity.getString(if (diag.optBoolean("inverted")) R.string.yes else R.string.no)
        sb.append(
            activity.getString(
                R.string.meta_extra,
                inverted,
                diag.optInt("errorsFixed"),
                diag.optInt("erasures"),
                if (diag.optBoolean("crc")) "OK" else "-",
            ),
        )
        val secureInfo = resp.optJSONObject("secureInfo")
        if (locked && secureInfo != null) {
            sb.append('\n')
            sb.append(
                activity.getString(
                    R.string.meta_sealed,
                    secureInfo.optString("keyId"),
                    secureInfo.optInt("iterations"),
                    secureInfo.optInt("plaintextBytes"),
                ),
            )
        }
        return sb.toString()
    }

    private fun onUnlock() {
        val gray = lastGray ?: return
        val pass = unlockPass.text.toString()
        if (pass.isEmpty()) return
        unlockButton.isEnabled = false
        scope.launch {
            try {
                val req = JSONObject()
                req.put("op", "decode")
                req.put("grayB64", gray.toBase64())
                req.put("width", gray.width)
                req.put("height", gray.height)
                req.put("pass", pass)
                val resp = withContext(Dispatchers.Default) { Engine.call(activity, req) }
                when {
                    resp.optBoolean("ok") && resp.optBoolean("unlocked") -> {
                        resultText.text = resp.optString("text")
                        metaText.text = buildMeta(resp, locked = false)
                        unlockGroup.isVisible = false
                        Snackbar.make(previewView, R.string.unlocked, Snackbar.LENGTH_LONG).show()
                    }
                    resp.optBoolean("ok") ->
                        Snackbar.make(previewView, R.string.unlock_wrong, Snackbar.LENGTH_LONG).show()
                    else ->
                        Snackbar.make(previewView, R.string.unlock_failed, Snackbar.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                Snackbar
                    .make(previewView, e.message ?: e.javaClass.simpleName, Snackbar.LENGTH_LONG)
                    .show()
            } finally {
                unlockButton.isEnabled = true
            }
        }
    }

    private fun resume() {
        resultCard.isVisible = false
        hint.isVisible = true
        resumeButton.isVisible = false
        unlockPass.setText("")
        lastGray = null
        busy.set(false)
        paused = false
    }
}
