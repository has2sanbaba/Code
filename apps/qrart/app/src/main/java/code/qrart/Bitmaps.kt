package code.qrart

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.min

/**
 * The only file that touches Android graphics types. Loading honours EXIF
 * orientation and centre-crops to a square, because a painting fused into a
 * square symbol should keep its subject, not its letterboxing.
 */
object Bitmaps {

    fun toBitmap(r: Rendered): Bitmap {
        val bmp = Bitmap.createBitmap(r.width, r.height, Bitmap.Config.ARGB_8888)
        bmp.setPixels(r.pixels, 0, r.width, 0, 0, r.width, r.height)
        return bmp
    }

    fun loadPainting(context: Context, uri: Uri, maxDim: Int = 512): Painting? {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: return null
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxDim * 2) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        var src = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
        src = applyExif(context, uri, src)
        val square = centerCropSquare(src)
        val scaled =
            if (square.width != maxDim) Bitmap.createScaledBitmap(square, maxDim, maxDim, true) else square
        val w = scaled.width
        val h = scaled.height
        val px = IntArray(w * h)
        scaled.getPixels(px, 0, w, 0, 0, w, h)
        if (scaled !== src) src.recycle()
        scaled.recycle()
        return Painting(w, h, px)
    }

    private fun applyExif(context: Context, uri: Uri, bmp: Bitmap): Bitmap {
        val orientation =
            try {
                context.contentResolver.openInputStream(uri)?.use {
                    ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
                } ?: ExifInterface.ORIENTATION_NORMAL
            } catch (e: Exception) {
                ExifInterface.ORIENTATION_NORMAL
            }
        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            else -> return bmp
        }
        val out = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, matrix, true)
        if (out !== bmp) bmp.recycle()
        return out
    }

    private fun centerCropSquare(bmp: Bitmap): Bitmap {
        val side = min(bmp.width, bmp.height)
        if (side == bmp.width && side == bmp.height) return bmp
        val x = (bmp.width - side) / 2
        val y = (bmp.height - side) / 2
        val out = Bitmap.createBitmap(bmp, x, y, side, side)
        if (out !== bmp) bmp.recycle()
        return out
    }

    fun toPng(bmp: Bitmap): ByteArray {
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
        return out.toByteArray()
    }

    @Suppress("DEPRECATION")
    fun saveToGallery(context: Context, bmp: Bitmap): Uri? {
        val name = "qrart-${System.currentTimeMillis()}.png"
        val png = toPng(bmp)
        val resolver = context.contentResolver
        val values = ContentValues()
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name)
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/QRArt")
            values.put(MediaStore.Images.Media.IS_PENDING, 1)
        } else {
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "QRArt")
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
        val file = File(dir, "qrart-${System.currentTimeMillis()}.png")
        file.writeBytes(toPng(bmp))
        val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
        val send = Intent(Intent.ACTION_SEND)
        send.type = "image/png"
        send.putExtra(Intent.EXTRA_STREAM, uri)
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(send, context.getString(R.string.share_title)))
    }
}
