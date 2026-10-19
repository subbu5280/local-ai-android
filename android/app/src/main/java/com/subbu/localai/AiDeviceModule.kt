package com.subbu.localai

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Device state and screen control for the model download, with Android's own APIs (no extra library).
 */
class AiDeviceModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "AiDevice"

  /**
   * "online": the active network has internet and Android has validated it (it reached the internet);
   * "no_internet": connected (e.g. Wi-Fi) but not validated (captive portal, no uplink);
   * "offline": no network at all. A validated network can still fail a download, so callers handle that too.
   */
  @ReactMethod
  fun connectivity(promise: Promise) {
    try {
      val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
      val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
      promise.resolve(when {
        caps == null -> "offline"
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) -> "online"
        else -> "no_internet"
      })
    } catch (e: Exception) {
      promise.reject("connectivity", e.javaClass.simpleName)
    }
  }

  /**
   * Keep the screen on (only while this app is in front). Used during the model download: on the Galaxy M35 with
   * battery saver on, the screen turning off cut the app's network and aborted the download.
   */
  /** Copy text to the clipboard (the Copy action on a message; only ever called from a user tap). */
  @ReactMethod
  fun copyText(text: String) {
    val cm = reactApplicationContext.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
    cm.setPrimaryClip(android.content.ClipData.newPlainText("Local AI", text))
  }

  /** Full-screen games: hide the status and navigation bars (a swipe from the edge shows them briefly). */
  @ReactMethod
  fun setImmersive(on: Boolean) {
    val activity = reactApplicationContext.currentActivity ?: return
    activity.runOnUiThread {
      val window = activity.window
      val controller = androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
      if (on) {
        controller.systemBarsBehavior = androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
      } else {
        controller.show(androidx.core.view.WindowInsetsCompat.Type.systemBars())
      }
    }
  }

  /**
   * Model downloads through Android's DownloadManager: it shows a notification with live progress and keeps going
   * with the screen off, in battery saver, or after the app is closed (seen on the M35: screen-off cut the app's own
   * download). The file goes to this app's external files folder (no permission needed; private to the app on
   * Android 11+); the caller checks its SHA-256 and copies it into internal storage. Resolves the download id.
   */
  @ReactMethod
  fun startDownload(url: String, fileName: String, title: String, promise: Promise) {
    try {
      if (!url.startsWith("https://") || fileName.contains('/') || fileName.contains("..")) throw IllegalArgumentException("bad download")
      java.io.File(ctx.getExternalFilesDir("downloads"), fileName).delete() // a stale partial must not be resumed into
      val req = android.app.DownloadManager.Request(android.net.Uri.parse(url))
        .setTitle(title)
        .setDescription("Local AI model download")
        .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalFilesDir(ctx, "downloads", fileName)
      promise.resolve(dm().enqueue(req).toDouble())
    } catch (e: Throwable) { promise.reject("download_failed", e.message ?: e.javaClass.simpleName) }
  }

  /** {status: pending|running|paused|done|failed, bytes, total, path, reason} for a download id. */
  @ReactMethod
  fun downloadStatus(id: Double, promise: Promise) {
    val q = android.app.DownloadManager.Query().setFilterById(id.toLong())
    dm().query(q).use { c ->
      if (!c.moveToFirst()) { promise.resolve(com.facebook.react.bridge.Arguments.createMap().apply { putString("status", "failed"); putInt("reason", -1) }); return }
      val s = c.getInt(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_STATUS))
      val status = when (s) {
        android.app.DownloadManager.STATUS_SUCCESSFUL -> "done"
        android.app.DownloadManager.STATUS_FAILED -> "failed"
        android.app.DownloadManager.STATUS_PAUSED -> "paused"
        android.app.DownloadManager.STATUS_RUNNING -> "running"
        else -> "pending"
      }
      val uri = c.getString(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_LOCAL_URI))
      promise.resolve(com.facebook.react.bridge.Arguments.createMap().apply {
        putString("status", status)
        putDouble("bytes", c.getLong(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)).toDouble())
        putDouble("total", c.getLong(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).toDouble())
        putString("path", uri?.let { android.net.Uri.parse(it).path })
        putInt("reason", c.getInt(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_REASON)))
      })
    }
  }

  /** Cancel a download and delete its partial file. */
  @ReactMethod
  fun cancelDownload(id: Double) { dm().remove(id.toLong()) }

  private fun dm() = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as android.app.DownloadManager

  @ReactMethod
  fun keepScreenOn(on: Boolean) {
    val activity = reactApplicationContext.currentActivity ?: return
    activity.runOnUiThread {
      if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }
}
