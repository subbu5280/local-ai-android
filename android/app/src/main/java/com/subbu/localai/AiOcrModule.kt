package com.subbu.localai

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.googlecode.tesseract.android.TessBaseAPI
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Text recognition (OCR) for scanned PDFs and images (M13), with Tesseract 5 (Tesseract4Android, Apache-2.0) entirely
 * on the phone. Language data (`<lang>.traineddata`, tessdata_fast) lives in the app's private files/tessdata and is
 * downloaded and sha256-checked by src/knowledge/ocr.ts only after the user agrees; this module never downloads.
 *
 * PDF pages are rendered with Android's PdfRenderer (API 21+) at OCR resolution (about 200 dpi, at most MAX_SIDE px
 * per side) one page at a time, so memory stays bounded. Recognition runs on one background thread; cancel() stops
 * a running recognition between pages and inside Tesseract. Nothing here logs recognized text.
 */
class AiOcrModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private val worker = Executors.newSingleThreadExecutor()
  private val cancelled = AtomicBoolean(false)
  @Volatile private var running: TessBaseAPI? = null

  override fun getName() = "AiOcr"

  private fun dataDir() = File(ctx.filesDir, "ocr") // contains tessdata/<lang>.traineddata

  /** Languages with data files present: ["eng","tel",...] (presence only; sizes/hashes are checked in JS). */
  @ReactMethod
  fun languages(promise: Promise) {
    val dir = File(dataDir(), "tessdata")
    promise.resolve(Arguments.createArray().apply {
      dir.listFiles()?.filter { it.name.endsWith(".traineddata") }?.forEach { pushString(it.name.removeSuffix(".traineddata")) }
    })
  }

  /** The folder the JS downloader must write `<lang>.traineddata` into. */
  @ReactMethod
  fun dataPath(promise: Promise) {
    val d = File(dataDir(), "tessdata").apply { mkdirs() }
    promise.resolve(d.absolutePath)
  }

  @ReactMethod
  fun cancel() {
    cancelled.set(true)
    running?.stop()
  }

  /** OCR of an image (content:// or file:// URI, or base64 when `isBase64`). Resolves {text, confidence, bytes, sha256}. */
  @ReactMethod
  fun recognizeImage(source: String, isBase64: Boolean, langs: String, promise: Promise) {
    worker.execute {
      cancelled.set(false)
      try {
        val bytes = if (isBase64) Base64.decode(source, Base64.DEFAULT)
          else ctx.contentResolver.openInputStream(Uri.parse(source))?.use { it.readBytes() } ?: throw OcrError("not_found", "The file can no longer be opened")
        if (bytes.size > MAX_IMAGE_BYTES) throw OcrError("too_large", "The image is larger than 30 MB")
        val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: throw OcrError("not_image", "The image could not be read")
        val (text, conf) = withTess(langs) { tess -> recognize(tess, scaled(bmp)) }
        val sha = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        promise.resolve(Arguments.createMap().apply {
          putString("text", text); putInt("confidence", conf); putDouble("bytes", bytes.size.toDouble()); putString("sha256", sha)
        })
      } catch (e: OcrError) { promise.reject(e.code, e.message) } catch (e: Throwable) { promise.reject("ocr_failed", e.javaClass.simpleName) }
    }
  }

  /**
   * OCR of a PDF's pages (at most maxPages). Resolves {pages: [{text, confidence}], pageCount}. Pages are rendered and
   * recognized one at a time; a cancelled run rejects "cancelled".
   */
  @ReactMethod
  fun recognizePdf(uri: String, langs: String, maxPages: Int, promise: Promise) {
    worker.execute {
      cancelled.set(false)
      try {
        val pfd = ctx.contentResolver.openFileDescriptor(Uri.parse(uri), "r") ?: throw OcrError("not_found", "The file can no longer be opened")
        val out = Arguments.createArray()
        var count = 0
        pfd.use { fd ->
          PdfRenderer(fd).use { r ->
            count = r.pageCount
            withTess(langs) { tess ->
              for (i in 0 until minOf(r.pageCount, maxPages)) {
                if (cancelled.get()) throw OcrError("cancelled", "Cancelled")
                val bmp = r.openPage(i).use { p ->
                  val scale = minOf(200f / 72f, MAX_SIDE.toFloat() / maxOf(p.width, p.height))
                  Bitmap.createBitmap((p.width * scale).toInt().coerceAtLeast(1), (p.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888).also { b ->
                    b.eraseColor(Color.WHITE) // transparent PDF backgrounds would OCR as black
                    p.render(b, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                  }
                }
                val (text, conf) = recognize(tess, bmp)
                bmp.recycle()
                out.pushMap(Arguments.createMap().apply { putString("text", text); putInt("confidence", conf) })
              }
            }
          }
        }
        promise.resolve(Arguments.createMap().apply { putArray("pages", out); putInt("pageCount", count) })
      } catch (e: OcrError) { promise.reject(e.code, e.message) } catch (e: SecurityException) {
        promise.reject("pdf_encrypted", "This PDF is password-protected")
      } catch (e: java.io.IOException) { promise.reject("pdf_malformed", "This PDF could not be read") } catch (e: Throwable) {
        promise.reject("ocr_failed", e.javaClass.simpleName)
      }
    }
  }

  private fun <T> withTess(langs: String, block: (TessBaseAPI) -> T): T {
    if (!Regex("^[a-z]{3}(\\+[a-z]{3}){0,5}$").matches(langs)) throw OcrError("invalid", "bad language list")
    for (l in langs.split('+')) if (!File(dataDir(), "tessdata/$l.traineddata").isFile) throw OcrError("no_language", "Text recognition data for $l is not downloaded")
    val tess = TessBaseAPI()
    try {
      if (!tess.init(dataDir().absolutePath, langs, TessBaseAPI.OEM_LSTM_ONLY)) throw OcrError("init_failed", "The text recognition data could not be loaded")
      tess.pageSegMode = TessBaseAPI.PageSegMode.PSM_AUTO
      running = tess
      return block(tess)
    } finally {
      running = null
      tess.recycle()
    }
  }

  private fun recognize(tess: TessBaseAPI, bmp: Bitmap): Pair<String, Int> {
    tess.setImage(bmp)
    val text = tess.utF8Text ?: ""
    if (cancelled.get()) throw OcrError("cancelled", "Cancelled")
    return text.trim() to tess.meanConfidence()
  }

  /** Very large photos are scaled down (Tesseract needs about 300 dpi text, not 50 megapixels). */
  private fun scaled(b: Bitmap): Bitmap {
    val side = maxOf(b.width, b.height)
    return if (side <= MAX_SIDE) b else Bitmap.createScaledBitmap(b, b.width * MAX_SIDE / side, b.height * MAX_SIDE / side, true)
  }

  private class OcrError(val code: String, message: String) : Exception(message)

  override fun invalidate() {
    cancel()
    worker.shutdown()
    super.invalidate()
  }

  companion object { const val MAX_SIDE = 2400; const val MAX_IMAGE_BYTES = 30_000_000 }
}
