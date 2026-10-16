package com.subbu.localai

import android.app.Activity
import android.content.Intent
import android.graphics.pdf.PdfRenderer
import android.graphics.pdf.PdfRendererPreV
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.ext.SdkExtensions
import android.provider.OpenableColumns
import androidx.annotation.RequiresApi
import androidx.annotation.RequiresExtension
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Documents for the local knowledge library: the system file picker (no storage permission) and text extraction.
 *
 * Only reads: the original files are never changed or deleted. Nothing here logs file names or contents. Parsing,
 * chunking and indexing happen in JavaScript (src/knowledge/); this module returns raw text (or per-page PDF text),
 * the byte count and a SHA-256 of the bytes (to recognize a file that is already imported).
 *
 * PDF text comes from Android's own PDF renderer: PdfRenderer on Android 15+, PdfRendererPreV on Android 12-14 when the
 * phone's system updates provide it (SDK extension level 13). Pages without a text layer (scans) come back empty.
 */
class AiDocsModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private val worker = Executors.newSingleThreadExecutor() // one extraction at a time, off the UI thread
  private var pending: Promise? = null
  private var pendingCreate: Pair<Promise, String>? = null // (promise, text to write) while the save picker is open

  override fun getName() = "AiDocs"

  init {
    ctx.addActivityEventListener(object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == CREATE_REQUEST) { onCreated(resultCode, data); return }
        if (requestCode == SAVE_COPY_REQUEST) { onSaveCopy(resultCode, data); return }
        if (requestCode == OPEN_COPY_REQUEST) { onOpenCopy(resultCode, data); return }
        if (requestCode != PICK_REQUEST) return
        val p = pending ?: return
        pending = null
        if (resultCode != Activity.RESULT_OK || data == null) { p.resolve(Arguments.createArray()); return }
        val uris = mutableListOf<Uri>()
        data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
        if (uris.isEmpty()) data.data?.let { uris.add(it) }
        val out = Arguments.createArray()
        for (uri in uris) {
          // Keep read access so a failed document can be retried later; not all providers allow it.
          runCatching { ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
          out.pushMap(describe(uri))
        }
        p.resolve(out)
      }
    })
  }

  private fun describe(uri: Uri) = Arguments.createMap().apply {
    putString("uri", uri.toString())
    putString("mime", ctx.contentResolver.getType(uri))
    var name: String? = null
    var size = -1.0
    runCatching {
      ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
        if (c.moveToFirst()) {
          if (!c.isNull(0)) name = c.getString(0)
          if (!c.isNull(1)) size = c.getLong(1).toDouble()
        }
      }
    }
    putString("name", name ?: uri.lastPathSegment ?: "document")
    putDouble("size", size)
  }

  /** Open the system picker; resolves with [{uri, name, mime, size}] (empty when cancelled). */
  @ReactMethod
  fun pick(promise: Promise) {
    val activity = ctx.currentActivity ?: return promise.reject("no_activity", "The app is not in front")
    if (busy()) return promise.reject("busy", "A file picker is already open")
    pending = promise
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "*/*" // .md and .csv are often labelled application/octet-stream; the app checks the format itself
      putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }
    try {
      activity.startActivityForResult(intent, PICK_REQUEST)
    } catch (e: Exception) {
      pending = null
      promise.reject("picker_unavailable", "No file picker on this phone")
    }
  }

  /**
   * Save `text` as a NEW file the user names and places in Android's save picker (ACTION_CREATE_DOCUMENT). The app only
   * writes to the document the picker just created; an existing file is never opened for writing. Resolves {uri, name},
   * or null when the user cancels.
   */
  @ReactMethod
  fun createTextFile(name: String, mime: String, text: String, promise: Promise) {
    val activity = ctx.currentActivity ?: return promise.reject("no_activity", "The app is not in front")
    if (busy()) return promise.reject("busy", "A file picker is already open")
    pendingCreate = promise to text
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = mime
      putExtra(Intent.EXTRA_TITLE, name)
    }
    try {
      activity.startActivityForResult(intent, CREATE_REQUEST)
    } catch (e: Exception) {
      pendingCreate = null
      promise.reject("picker_unavailable", "No file picker on this phone")
    }
  }

  private fun onCreated(resultCode: Int, data: Intent?) {
    val (p, text) = pendingCreate ?: return
    pendingCreate = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) { p.resolve(null); return }
    worker.execute {
      try {
        // "w" on the document the picker just created for us (empty); never "wt"/"wa" on a pre-existing one.
        ctx.contentResolver.openOutputStream(uri, "w")?.use { it.write(text.toByteArray(Charsets.UTF_8)) }
          ?: throw java.io.IOException("no output stream")
        p.resolve(describe(uri))
      } catch (e: Exception) {
        p.reject("write_failed", "The file could not be written (${e.javaClass.simpleName})")
      }
    }
  }

  // ---------------------------------------------------------------- backup files (M8)
  // The backup is built in the app's private cache (src/backup/); these two methods only move bytes between that cache
  // and a place the user picks. Paths are confined to <cache>/backup so JavaScript can't read or write elsewhere.

  private var pendingSave: Pair<Promise, java.io.File>? = null
  private var pendingOpen: Triple<Promise, java.io.File, Long>? = null

  private fun backupFile(path: String): java.io.File? {
    val dir = java.io.File(ctx.cacheDir, "backup").canonicalFile
    val f = java.io.File(path).canonicalFile
    return if (f.parentFile == dir) f else null
  }

  private fun busy() = pending != null || pendingCreate != null || pendingSave != null || pendingOpen != null

  /**
   * Copy a finished backup from the private cache to a NEW document the user names in Android's save picker, then read
   * the document back and compare SHA-256 with the source. Resolves {uri, name, size}, or null when cancelled.
   * Rejects verify_failed (the new document is removed: it was created just now and is not trustworthy), write_failed.
   */
  @ReactMethod
  fun saveCopy(path: String, name: String, promise: Promise) {
    val activity = ctx.currentActivity ?: return promise.reject("no_activity", "The app is not in front")
    val src = backupFile(path) ?: return promise.reject("invalid", "not a backup file")
    if (busy()) return promise.reject("busy", "A file picker is already open")
    pendingSave = promise to src
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "application/octet-stream"
      putExtra(Intent.EXTRA_TITLE, name)
    }
    try { activity.startActivityForResult(intent, SAVE_COPY_REQUEST) } catch (e: Exception) {
      pendingSave = null
      promise.reject("picker_unavailable", "No file picker on this phone")
    }
  }

  private fun onSaveCopy(resultCode: Int, data: Intent?) {
    val (p, src) = pendingSave ?: return
    pendingSave = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) { p.resolve(null); return }
    worker.execute {
      try {
        val want = sha256(src.inputStream())
        ctx.contentResolver.openOutputStream(uri, "w")?.use { out -> src.inputStream().use { it.copyTo(out, 64 * 1024) } }
          ?: throw java.io.IOException("no output stream")
        val got = ctx.contentResolver.openInputStream(uri)?.let { sha256(it) }
        if (got != want) {
          runCatching { android.provider.DocumentsContract.deleteDocument(ctx.contentResolver, uri) }
          return@execute p.reject("verify_failed", "The saved copy did not match the backup; it was removed")
        }
        p.resolve(describe(uri))
      } catch (e: Exception) {
        runCatching { android.provider.DocumentsContract.deleteDocument(ctx.contentResolver, uri) }
        p.reject("write_failed", "The backup could not be written there (${e.javaClass.simpleName})")
      }
    }
  }

  /** Let the user pick a backup file and copy it into the private cache (at most maxBytes). Resolves {name, size} or null. */
  @ReactMethod
  fun openCopy(path: String, maxBytes: Double, promise: Promise) {
    val activity = ctx.currentActivity ?: return promise.reject("no_activity", "The app is not in front")
    val dest = backupFile(path) ?: return promise.reject("invalid", "not a backup file")
    if (busy()) return promise.reject("busy", "A file picker is already open")
    pendingOpen = Triple(promise, dest, maxBytes.toLong())
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); type = "*/*" }
    try { activity.startActivityForResult(intent, OPEN_COPY_REQUEST) } catch (e: Exception) {
      pendingOpen = null
      promise.reject("picker_unavailable", "No file picker on this phone")
    }
  }

  private fun onOpenCopy(resultCode: Int, data: Intent?) {
    val (p, dest, max) = pendingOpen ?: return
    pendingOpen = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) { p.resolve(null); return }
    worker.execute {
      try {
        dest.parentFile?.mkdirs()
        var total = 0L
        val input = ctx.contentResolver.openInputStream(uri) ?: throw java.io.FileNotFoundException()
        input.use { s ->
          dest.outputStream().use { out ->
            val buf = ByteArray(64 * 1024)
            while (true) {
              val n = s.read(buf)
              if (n < 0) break
              total += n
              if (total > max) throw ExtractError("too_large", "The file is larger than a backup can be")
              out.write(buf, 0, n)
            }
          }
        }
        p.resolve(describe(uri).apply { putDouble("size", total.toDouble()) })
      } catch (e: ExtractError) {
        dest.delete()
        p.reject(e.code, e.message)
      } catch (e: Exception) {
        dest.delete()
        p.reject("read_failed", "The file could not be read (${e.javaClass.simpleName})")
      }
    }
  }

  private fun sha256(input: java.io.InputStream): String = input.use { s ->
    val d = MessageDigest.getInstance("SHA-256")
    val buf = ByteArray(64 * 1024)
    while (true) { val n = s.read(buf); if (n < 0) break; d.update(buf, 0, n) }
    d.digest().joinToString("") { "%02x".format(it) }
  }

  /** {uri, name, mime, size} of a document the app still has access to (rejects with not_found otherwise). */
  @ReactMethod
  fun info(uri: String, promise: Promise) {
    worker.execute {
      try {
        ctx.contentResolver.openFileDescriptor(Uri.parse(uri), "r")?.close() ?: throw FileNotFoundException()
        promise.resolve(describe(Uri.parse(uri)))
      } catch (e: Exception) {
        promise.reject("not_found", "The file can no longer be opened")
      }
    }
  }

  /** Give up the kept read access to a removed document (the file itself is not touched). */
  @ReactMethod
  fun release(uri: String) {
    runCatching { ctx.contentResolver.releasePersistableUriPermission(Uri.parse(uri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
  }

  /**
   * Text of a TXT / Markdown / CSV file: {text, bytes, sha256, lossy}. Decoded as UTF-8 (or UTF-16 with a byte-order
   * mark); invalid UTF-8 is decoded with replacement characters and `lossy` is set, so the app can warn.
   * Rejects: too_large, not_found, read_failed.
   */
  @ReactMethod
  fun readText(uri: String, maxBytes: Double, promise: Promise) {
    worker.execute {
      try {
        val (bytes, sha) = readBytes(Uri.parse(uri), maxBytes.toLong())
        var lossy = false
        val text = when {
          bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xFE.toByte() -> String(bytes, 2, bytes.size - 2, Charsets.UTF_16LE)
          bytes.size >= 2 && bytes[0] == 0xFE.toByte() && bytes[1] == 0xFF.toByte() -> String(bytes, 2, bytes.size - 2, Charsets.UTF_16BE)
          else -> try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
              .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
          } catch (e: CharacterCodingException) {
            lossy = true
            String(bytes, Charsets.UTF_8)
          }
        }
        promise.resolve(Arguments.createMap().apply {
          putString("text", text); putDouble("bytes", bytes.size.toDouble()); putString("sha256", sha); putBoolean("lossy", lossy)
        })
      } catch (e: ExtractError) {
        promise.reject(e.code, e.message)
      } catch (e: Exception) {
        promise.reject("read_failed", e.javaClass.simpleName)
      }
    }
  }

  /**
   * Text of each PDF page: {pages: [text...], bytes, sha256}. A page without a text layer (a scan) is "".
   * Rejects: too_large, not_found, pdf_encrypted, pdf_malformed, pdf_unsupported (Android too old), read_failed.
   */
  @ReactMethod
  fun readPdf(uri: String, maxBytes: Double, promise: Promise) {
    worker.execute {
      try {
        val parsed = Uri.parse(uri)
        val (bytes, sha) = readBytes(parsed, maxBytes.toLong()) // size limit + hash; the renderer reads the file itself
        val pfd = ctx.contentResolver.openFileDescriptor(parsed, "r") ?: throw ExtractError("not_found", "The file can no longer be opened")
        val pages = pfd.use { pdfPages(it) }
        promise.resolve(Arguments.createMap().apply {
          putArray("pages", Arguments.createArray().apply { pages.forEach { pushString(it) } })
          putDouble("bytes", bytes.size.toDouble()); putString("sha256", sha)
        })
      } catch (e: ExtractError) {
        promise.reject(e.code, e.message)
      } catch (e: SecurityException) {
        promise.reject("pdf_encrypted", "This PDF is password-protected")
      } catch (e: java.io.IOException) {
        promise.reject("pdf_malformed", "This PDF could not be read (damaged or not a PDF)")
      } catch (e: Exception) {
        promise.reject("read_failed", e.javaClass.simpleName)
      }
    }
  }

  /**
   * Text of a .docx (kind "docx": {text}) or the sheets of a .xlsx (kind "xlsx": {sheets: [{name, rows}]}), plus
   * {bytes, sha256}. Rejects: too_large, not_found, malformed, read_failed. See OfficeText for the safety limits.
   */
  @ReactMethod
  fun readOffice(uri: String, kind: String, maxBytes: Double, promise: Promise) {
    worker.execute {
      try {
        val (bytes, sha) = readBytes(Uri.parse(uri), maxBytes.toLong())
        val out = Arguments.createMap().apply { putDouble("bytes", bytes.size.toDouble()); putString("sha256", sha) }
        if (kind == "docx") out.putString("text", OfficeText.docx(bytes))
        else out.putArray("sheets", Arguments.createArray().apply {
          OfficeText.xlsxSheets(bytes).forEach { (name, rows) ->
            pushMap(Arguments.createMap().apply {
              putString("name", name)
              putArray("rows", Arguments.createArray().apply { rows.forEach { r -> pushArray(Arguments.createArray().apply { r.forEach { pushString(it) } }) } })
            })
          }
        })
        promise.resolve(out)
      } catch (e: ExtractError) {
        promise.reject(e.code, e.message)
      } catch (e: OfficeText.OfficeException) {
        promise.reject(e.code, e.message)
      } catch (e: Exception) {
        promise.reject("read_failed", e.javaClass.simpleName)
      }
    }
  }

  private fun pdfPages(pfd: ParcelFileDescriptor): List<String> = when {
    Build.VERSION.SDK_INT >= 35 -> pagesV(pfd)
    Build.VERSION.SDK_INT >= 31 && SdkExtensions.getExtensionVersion(Build.VERSION_CODES.S) >= 13 -> pagesPreV(pfd)
    else -> throw ExtractError("pdf_unsupported", "Reading PDF text needs Android 15, or Android 12-14 with recent system updates")
  }

  @RequiresApi(35)
  private fun pagesV(pfd: ParcelFileDescriptor): List<String> = PdfRenderer(pfd).use { r ->
    (0 until r.pageCount).map { i -> r.openPage(i).use { p -> p.textContents.joinToString("\n") { it.text } } }
  }

  @RequiresExtension(extension = Build.VERSION_CODES.S, version = 13)
  private fun pagesPreV(pfd: ParcelFileDescriptor): List<String> = PdfRendererPreV(pfd).use { r ->
    (0 until r.pageCount).map { i -> r.openPage(i).use { p -> p.textContents.joinToString("\n") { it.text } } }
  }

  /** All bytes of the file (refusing more than maxBytes) and their SHA-256 in hex. */
  private fun readBytes(uri: Uri, maxBytes: Long): Pair<ByteArray, String> {
    val input = try { ctx.contentResolver.openInputStream(uri) } catch (e: Exception) { null }
      ?: throw ExtractError("not_found", "The file can no longer be opened")
    val digest = MessageDigest.getInstance("SHA-256")
    val out = ByteArrayOutputStream()
    input.use { s ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = s.read(buf)
        if (n < 0) break
        if (out.size() + n > maxBytes) throw ExtractError("too_large", "The file is larger than the ${maxBytes / 1_000_000} MB limit")
        digest.update(buf, 0, n)
        out.write(buf, 0, n)
      }
    }
    return out.toByteArray() to digest.digest().joinToString("") { "%02x".format(it) }
  }

  private class ExtractError(val code: String, message: String) : Exception(message)

  override fun invalidate() {
    worker.shutdown()
    super.invalidate()
  }

  companion object {
    private const val PICK_REQUEST = 4207
    private const val CREATE_REQUEST = 4208
    private const val SAVE_COPY_REQUEST = 4209
    private const val OPEN_COPY_REQUEST = 4210
  }
}
