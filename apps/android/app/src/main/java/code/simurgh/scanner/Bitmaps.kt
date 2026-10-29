package code.simurgh.scanner

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer

/** Engine rasters to Android bitmaps, gallery and share sheet. */
object Bitmaps {

    /**
     * The engine raster is RGBA byte order, which is exactly ARGB_8888's
     * in-memory layout, so the buffer copies straight in.
     */
    fun rgbaToBitmap(bytes: ByteArray, width: Int, height: Int): Bitmap {
        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        bmp.copyPixelsFromBuffer(ByteBuffer.wrap(bytes))
        return bmp
    }

    fun toPng(bmp: Bitmap): ByteArray {
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        return out.toByteArray()
    }

    /** Insert into MediaStore (Pictures/SiMurgh). Returns the row URI. */
    @Suppress("DEPRECATION")
    fun saveToGallery(context: Context, bmp: Bitmap): Uri? {
        val name = "simurgh-${System.currentTimeMillis()}.png"
        val png = toPng(bmp)
        val resolver = context.contentResolver
        val values = ContentValues()
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name)
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/SiMurgh")
            values.put(MediaStore.Images.Media.IS_PENDING, 1)
        } else {
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "SiMurgh")
            dir.mkdirs()
            values.put(MediaStore.Images.Media.DATA, File(dir, name).absolutePath)
        }
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return null
        val stream = resolver.openOutputStream(uri) ?: return null
        stream.use { it.write(png) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.clear()
            values.put(MediaStore.Images.Media.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
        }
        return uri
    }

    /** PNG into the cache dir, shared through the FileProvider. */
    fun share(context: Context, bmp: Bitmap) {
        val dir = File(context.cacheDir, "share")
        dir.mkdirs()
        val file = File(dir, "simurgh-${System.currentTimeMillis()}.png")
        file.writeBytes(toPng(bmp))
        val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
        val send = Intent(Intent.ACTION_SEND)
        send.type = "image/png"
        send.putExtra(Intent.EXTRA_STREAM, uri)
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(send, context.getString(R.string.share_title)))
    }
}
