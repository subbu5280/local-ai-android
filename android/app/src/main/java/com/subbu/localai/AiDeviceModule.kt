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

  @ReactMethod
  fun keepScreenOn(on: Boolean) {
    val activity = reactApplicationContext.currentActivity ?: return
    activity.runOnUiThread {
      if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
  }
}
