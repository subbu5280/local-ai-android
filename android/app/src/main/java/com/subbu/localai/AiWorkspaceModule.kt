package com.subbu.localai

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Project workspaces for the coding assistant (M7), through the Storage Access Framework only: the user picks a folder
 * (ACTION_OPEN_DOCUMENT_TREE) or files (ACTION_OPEN_DOCUMENT) and the app keeps the grant Android gives for exactly
 * those. No storage permission, no filesystem paths: every document is a content:// URI the provider resolves, and a
 * tree grant only reaches documents inside that tree (the provider enforces it).
 *
 * Writes are deliberately narrow, and only ever called by the approval flow in src/code/apply.ts:
 * - write(): replaces one existing document's text, but only if its current bytes still hash to `expectedSha` (stale
 *   check right before writing), then reads it back; if the read-back differs, the original bytes are written back.
 * - create(): makes a NEW document in a folder; refuses when a file of that name exists, and removes the document it
 *   just created if the provider renamed it (e.g. "a (1).ts"), so nothing unexpected is left behind.
 * There is no delete or rename of the user's files, and nothing here logs names or contents.
 */
class AiWorkspaceModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private val worker = Executors.newSingleThreadExecutor() // one storage operation at a time, off the UI thread
  private var pending: Pair<Promise, Int>? = null

  override fun getName() = "AiWorkspace"

  init {
    ctx.addActivityEventListener(object : BaseActivityEventListener() {
      override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        val (p, code) = pending ?: return
        if (requestCode != code) return
        pending = null
        if (resultCode != Activity.RESULT_OK || data == null) { p.resolve(null); return }
        try {
          if (code == TREE_REQUEST) p.resolve(onTree(data)) else p.resolve(onFiles(data))
        } catch (e: Exception) {
          p.reject("pick_failed", e.javaClass.simpleName)
        }
      }
    })
  }

  private fun keep(uri: Uri, data: Intent): Boolean {
    val rw = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    // Read+write when the provider offers it; read-only otherwise (the app then explains that edits can't be applied).
    if (data.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION != 0 &&
      runCatching { ctx.contentResolver.takePersistableUriPermission(uri, rw) }.isSuccess) return true
    runCatching { ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    return false
  }

  private fun onTree(data: Intent): WritableMap? {
    val tree = data.data ?: return null
    val canWrite = keep(tree, data)
    val root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
    return describe(root).apply { putString("treeUri", tree.toString()); putBoolean("granted_write", canWrite) }
  }

  private fun onFiles(data: Intent) = Arguments.createArray().apply {
    val uris = mutableListOf<Uri>()
    data.clipData?.let { clip -> for (i in 0 until clip.itemCount) uris.add(clip.getItemAt(i).uri) }
    if (uris.isEmpty()) data.data?.let { uris.add(it) }
    for (uri in uris) {
      val canWrite = keep(uri, data)
      pushMap(describe(uri).apply { putString("treeUri", uri.toString()); putBoolean("granted_write", canWrite) })
    }
  }

  /** {uri, name, mime, size, modified, dir, canWrite, canCreate} of one document (provider flags, not a promise). */
  private fun describe(uri: Uri): WritableMap = Arguments.createMap().apply {
    putString("uri", uri.toString())
    ctx.contentResolver.query(uri, COLUMNS, null, null, null)?.use { c ->
      if (c.moveToFirst()) row(c, this)
    } ?: throw java.io.FileNotFoundException()
  }

  private fun row(c: android.database.Cursor, m: WritableMap) {
    val mime = if (c.isNull(2)) null else c.getString(2)
    val flags = if (c.isNull(5)) 0 else c.getInt(5)
    m.putString("name", if (c.isNull(1)) "document" else c.getString(1))
    m.putString("mime", mime)
    m.putDouble("size", if (c.isNull(3)) -1.0 else c.getLong(3).toDouble())
    m.putDouble("modified", if (c.isNull(4)) 0.0 else c.getLong(4).toDouble())
    m.putBoolean("dir", mime == Document.MIME_TYPE_DIR)
    m.putBoolean("canWrite", flags and Document.FLAG_SUPPORTS_WRITE != 0)
    m.putBoolean("canCreate", flags and Document.FLAG_DIR_SUPPORTS_CREATE != 0)
  }

  private fun pick(promise: Promise, code: Int, intent: Intent) {
    val activity = ctx.currentActivity ?: return promise.reject("no_activity", "The app is not in front")
    if (pending != null) return promise.reject("busy", "A picker is already open")
    pending = promise to code
    try {
      activity.startActivityForResult(intent, code)
    } catch (e: Exception) {
      pending = null
      promise.reject("unsupported", "This phone has no folder or file picker for this")
    }
  }

  /** Let the user pick a project folder; resolves the root document (+ treeUri, granted_write) or null if cancelled. */
  @ReactMethod
  fun pickFolder(promise: Promise) = pick(promise, TREE_REQUEST, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
  })

  /** Let the user pick individual files; resolves [document] (empty/null if cancelled). */
  @ReactMethod
  fun pickFiles(promise: Promise) = pick(promise, FILES_REQUEST, Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = "*/*"
    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
  })

  /** {read, write}: what the app still holds for a picked folder/file (the user can revoke it in system settings). */
  @ReactMethod
  fun access(treeUri: String, promise: Promise) {
    val p = ctx.contentResolver.persistedUriPermissions.firstOrNull { it.uri.toString() == treeUri }
    promise.resolve(Arguments.createMap().apply { putBoolean("read", p?.isReadPermission == true); putBoolean("write", p?.isWritePermission == true) })
  }

  /** The children of a folder document: [document]. Rejects not_found (gone / access removed) or unsupported. */
  @ReactMethod
  fun list(dirUri: String, promise: Promise) {
    worker.execute {
      try {
        val dir = Uri.parse(dirUri)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(dir, DocumentsContract.getDocumentId(dir))
        val out = Arguments.createArray()
        ctx.contentResolver.query(children, COLUMNS, null, null, null)?.use { c ->
          while (c.moveToNext()) {
            out.pushMap(Arguments.createMap().apply {
              putString("uri", DocumentsContract.buildDocumentUriUsingTree(dir, c.getString(0)).toString())
              row(c, this)
            })
          }
        } ?: throw java.io.FileNotFoundException()
        promise.resolve(out)
      } catch (e: SecurityException) {
        promise.reject("revoked", "Access to this folder was removed")
      } catch (e: UnsupportedOperationException) {
        promise.reject("unsupported", "This storage provider can't list folders")
      } catch (e: IllegalArgumentException) {
        promise.reject("unsupported", "This location is not a folder the app can list")
      } catch (e: Exception) {
        promise.reject("not_found", "The folder can no longer be opened")
      }
    }
  }

  /**
   * Replace an existing document's text, only if its current bytes hash to expectedSha. Resolves {sha256, bytes}.
   * Rejects: stale (changed since it was checked), not_found, revoked, unsupported (provider can't truncate/write),
   * verify_failed (read-back differed; `restored` says whether the original bytes were written back), write_failed.
   */
  @ReactMethod
  fun write(uri: String, text: String, expectedSha: String, promise: Promise) {
    worker.execute {
      val doc = Uri.parse(uri)
      var original: ByteArray? = null
      try {
        original = readAll(doc)
        if (sha(original) != expectedSha) return@execute promise.reject("stale", "The file changed since it was checked")
        val bytes = text.toByteArray(Charsets.UTF_8)
        // "wt" truncates; plain "w" does not on some providers and could leave old bytes at the end, so it is not used.
        ctx.contentResolver.openOutputStream(doc, "wt")?.use { it.write(bytes) } ?: throw java.io.IOException("no stream")
        val back = readAll(doc)
        if (!back.contentEquals(bytes)) {
          val restored = runCatching { ctx.contentResolver.openOutputStream(doc, "wt")?.use { it.write(original) }; readAll(doc).contentEquals(original) }.getOrDefault(false)
          return@execute promise.reject("verify_failed", if (restored) "restored" else "not_restored")
        }
        promise.resolve(Arguments.createMap().apply { putString("sha256", sha(bytes)); putDouble("bytes", bytes.size.toDouble()) })
      } catch (e: SecurityException) {
        promise.reject("revoked", "Write access to this file was removed")
      } catch (e: IllegalArgumentException) {
        promise.reject("unsupported", "This storage provider can't replace the file's contents")
      } catch (e: UnsupportedOperationException) {
        promise.reject("unsupported", "This storage provider can't replace the file's contents")
      } catch (e: java.io.FileNotFoundException) {
        promise.reject(if (original == null) "not_found" else "unsupported", if (original == null) "The file can no longer be opened" else "This storage provider can't write this file")
      } catch (e: Exception) {
        promise.reject("write_failed", e.javaClass.simpleName)
      }
    }
  }

  /** Create a NEW file `name` in a folder document and write `text`. Resolves the new document. Rejects: exists, name_changed, unsupported, revoked, write_failed. */
  @ReactMethod
  fun create(dirUri: String, name: String, mime: String, text: String, promise: Promise) {
    worker.execute {
      var made: Uri? = null
      try {
        val dir = Uri.parse(dirUri)
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(dir, DocumentsContract.getDocumentId(dir))
        val exists = ctx.contentResolver.query(children, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
          generateSequence { if (c.moveToNext()) c.getString(0) else null }.any { it.equals(name, ignoreCase = true) }
        } ?: throw java.io.FileNotFoundException()
        if (exists) return@execute promise.reject("exists", "A file with this name already exists")
        made = DocumentsContract.createDocument(ctx.contentResolver, dir, mime, name) ?: throw UnsupportedOperationException()
        val info = describe(made)
        if (info.getString("name") != name) {
          // The provider picked another name (or added an extension): remove the empty document we just made.
          runCatching { DocumentsContract.deleteDocument(ctx.contentResolver, made) }
          return@execute promise.reject("name_changed", "The storage provider would not use this exact file name")
        }
        val bytes = text.toByteArray(Charsets.UTF_8)
        ctx.contentResolver.openOutputStream(made, "w")?.use { it.write(bytes) } ?: throw java.io.IOException("no stream")
        if (!readAll(made).contentEquals(bytes)) return@execute promise.reject("verify_failed", "not_restored")
        promise.resolve(describe(made))
      } catch (e: SecurityException) {
        promise.reject("revoked", "Write access to this folder was removed")
      } catch (e: UnsupportedOperationException) {
        promise.reject("unsupported", "This storage provider can't create files here")
      } catch (e: IllegalArgumentException) {
        promise.reject("unsupported", "This storage provider can't create files here")
      } catch (e: Exception) {
        promise.reject(if (made == null) "write_failed" else "verify_failed", if (made == null) e.javaClass.simpleName else "not_restored")
      }
    }
  }

  /** Give up the kept access to a removed workspace (the files themselves are not touched). */
  @ReactMethod
  fun release(treeUri: String) {
    runCatching {
      ctx.contentResolver.releasePersistableUriPermission(Uri.parse(treeUri),
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }
    runCatching { ctx.contentResolver.releasePersistableUriPermission(Uri.parse(treeUri), Intent.FLAG_GRANT_READ_URI_PERMISSION) }
  }

  private fun readAll(uri: Uri): ByteArray {
    val input = ctx.contentResolver.openInputStream(uri) ?: throw java.io.FileNotFoundException()
    val out = ByteArrayOutputStream()
    input.use { s ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = s.read(buf)
        if (n < 0) break
        if (out.size() + n > MAX_BYTES) throw java.io.IOException("too large")
        out.write(buf, 0, n)
      }
    }
    return out.toByteArray()
  }

  private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

  override fun invalidate() {
    worker.shutdown()
    super.invalidate()
  }

  companion object {
    private const val TREE_REQUEST = 4311
    private const val FILES_REQUEST = 4312
    private const val MAX_BYTES = 2_000_000L // the app never edits files larger than this (src/code/files.ts limits are smaller)
    private val COLUMNS = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
      Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS)
  }
}
