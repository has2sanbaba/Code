package code.qrstudio

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * The only place Android graphics types appear. The artistic renderer and the QR
 * codec are pure Kotlin over [IntArray] buffers (so CI can verify scannability on
 * a plain JVM); this object just ferries pixels between those buffers and
 * [Bitmap], and handles gallery in/out.
 */
object BitmapBridge {

    fun toBitmap(r: Rendered): Bitmap {
        val bmp = Bitmap.createBitmap(r.width, r.height, Bitmap.Config.ARGB_8888)
        bmp.setPixels(r.pixels, 0, r.width, 0, 0, r.width, r.height)
        return bmp
    }

    /**
     * Load a gallery image as an artistic source, subsampled so the longest side
     * is at most [maxDim] (the renderer only samples one colour per module, so a
     * huge photo is wasted work). Transparent pixels read as white.
     */
    fun loadImg(context: Context, uri: Uri, maxDim: Int = 256): Img? {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxDim) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val src = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
        val long = maxOf(src.width, src.height)
        val scaled =
            if (long > maxDim) {
                val w = (src.width.toLong() * maxDim / long).toInt().coerceAtLeast(1)
                val h = (src.height.toLong() * maxDim / long).toInt().coerceAtLeast(1)
                Bitmap.createScaledBitmap(src, w, h, true)
            } else {
                src
            }
        val w = scaled.width
        val h = scaled.height
        val px = IntArray(w * h)
        scaled.getPixels(px, 0, w, 0, 0, w, h)
        for (i in px.indices) {
            if ((px[i] shr 24) and 0xff < 128) px[i] = 0xffffffff.toInt()
        }
        if (scaled !== src) src.recycle()
        scaled.recycle()
        return Img(w, h, px)
    }

    fun toPng(bmp: Bitmap): ByteArray {
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        return out.toByteArray()
    }

    @Suppress("DEPRECATION")
    fun saveToGallery(context: Context, bmp: Bitmap): Uri? {
        val name = "artqr-${System.currentTimeMillis()}.png"
        val png = toPng(bmp)
        val resolver = context.contentResolver
        val values = ContentValues()
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name)
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/ArtQR")
            values.put(MediaStore.Images.Media.IS_PENDING, 1)
        } else {
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "ArtQR")
            dir.mkdirs()
            values.put(MediaStore.Images.Media.DATA, File(dir, name).absolutePath)
        }
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
        resolver.openOutputStream(uri)?.use { it.write(png) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        }
        return uri
    }

    fun share(context: Context, bmp: Bitmap) {
        val dir = File(context.cacheDir, "share")
        dir.mkdirs()
        val file = File(dir, "artqr-${System.currentTimeMillis()}.png")
        file.writeBytes(toPng(bmp))
        val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
        val send = Intent(Intent.ACTION_SEND)
        send.type = "image/png"
        send.putExtra(Intent.EXTRA_STREAM, uri)
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(send, context.getString(R.string.share_title)))
    }
}
