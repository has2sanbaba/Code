package code.simurgh.scanner

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.os.LocaleListCompat
import androidx.core.view.isVisible
import com.google.android.material.bottomnavigation.BottomNavigationView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * Single native activity, two panels: create and scan. Deliberately no
 * fragments, no WebView, no web assets -- XML views, Material components,
 * CameraX, and the symbology engine in an embedded QuickJS VM.
 */
class MainActivity : AppCompatActivity() {

    internal val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private lateinit var createController: CreateController
    private lateinit var scanController: ScanController

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        setSupportActionBar(findViewById(R.id.toolbar))

        createController = CreateController(this, scope, findViewById(R.id.view_create))
        scanController = ScanController(this, scope, findViewById(R.id.view_scan))

        val nav = findViewById<BottomNavigationView>(R.id.bottom_nav)
        nav.setOnItemSelectedListener { item ->
            when (item.itemId) {
                R.id.nav_create -> {
                    showTab(create = true)
                    true
                }
                R.id.nav_scan -> {
                    showTab(create = false)
                    true
                }
                else -> false
            }
        }
        // XML starts on the create tab; make the controllers agree.
        showTab(create = true)

        // Pre-load the symbology VM off the main thread so the first generate or
        // scan does not pay the cold-start cost (reading + evaluating ~184 KiB of
        // interpreter bytecode). Engine calls serialize on a mutex, so this can
        // never race a user action.
        scope.launch(Dispatchers.Default) { Engine.warmup(this@MainActivity) }
    }

    private fun showTab(create: Boolean) {
        findViewById<View>(R.id.view_create).isVisible = create
        findViewById<View>(R.id.view_scan).isVisible = !create
        if (create) scanController.onHide() else scanController.onShow()
    }

    /* ------------------------------------------------------- language toggle */

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.toolbar_menu, menu)
        return true
    }

    override fun onPrepareOptionsMenu(menu: Menu): Boolean {
        // Label the control with the language it switches *to*.
        menu.findItem(R.id.action_language)?.title =
            if (isPersian()) getString(R.string.lang_switch_to_en) else getString(R.string.lang_switch_to_fa)
        return super.onPrepareOptionsMenu(menu)
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean =
        when (item.itemId) {
            R.id.action_language -> {
                val target = if (isPersian()) "en" else "fa"
                // Recreates the activity (and, on API 33+, registers the per-app
                // language). The choice persists via AppCompatLocalesService.
                AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(target))
                true
            }
            else -> super.onOptionsItemSelected(item)
        }

    private fun isPersian(): Boolean {
        val locales = AppCompatDelegate.getApplicationLocales()
        val tag = if (locales.isEmpty()) Locale.getDefault().language else locales.toLanguageTags()
        return tag.startsWith("fa")
    }

    override fun onDestroy() {
        scanController.release()
        scope.cancel()
        super.onDestroy()
    }

    /* ------------------------------------------------------------ permissions */

    fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED

    fun requestCameraPermission() {
        ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
    }

    @Suppress("DEPRECATION")
    fun hasWritePermission(): Boolean =
        android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
            PackageManager.PERMISSION_GRANTED

    @Suppress("DEPRECATION")
    fun requestWritePermission() {
        ActivityCompat.requestPermissions(
            this,
            arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE),
            REQ_WRITE,
        )
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        when (requestCode) {
            REQ_CAMERA -> if (granted) scanController.onShow()
            REQ_WRITE -> if (granted) createController.onSave()
        }
    }

    private companion object {
        const val REQ_CAMERA = 47
        const val REQ_WRITE = 48
    }
}
