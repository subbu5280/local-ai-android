package com.subbu.localai

import android.annotation.SuppressLint
import android.content.Context
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Location for local questions such as "What's today's weather?" (src/location.ts decides when to ask).
 *
 * - Coarse only: the app declares ACCESS_COARSE_LOCATION, never fine (weather needs a town, not a street).
 * - One fix per request (getCurrentLocation), never continuous updates, never in the background.
 * - Nothing is stored or logged here: the coordinates go back to JavaScript, which keeps them in memory only.
 * - locality() turns coordinates into "Hyderabad, Telangana, India" with Android's own Geocoder.
 */
class AiLocationModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()

  override fun getName() = "AiLocation"

  private fun manager() = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager

  /** Whether the phone's Location setting is on (if off, no app gets a location). */
  @ReactMethod
  fun isLocationEnabled(promise: Promise) {
    promise.resolve(Build.VERSION.SDK_INT < 28 || manager().isLocationEnabled)
  }

  /** One coarse location: {latitude, longitude, accuracy, time}. Rejects with no_permission / location_off / unavailable. */
  @SuppressLint("MissingPermission") // checked by the caller (src/location.ts) and caught as SecurityException
  @ReactMethod
  fun currentLocation(timeoutMs: Double, promise: Promise) {
    val lm = manager()
    if (Build.VERSION.SDK_INT >= 28 && !lm.isLocationEnabled) {
      promise.reject("location_off", "Location is turned off on this phone"); return
    }
    val provider = when {
      Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER) -> LocationManager.FUSED_PROVIDER
      lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
      else -> LocationManager.PASSIVE_PROVIDER
    }
    var done = false
    fun finish(loc: Location?, error: String?) {
      main.post {
        if (done) return@post
        done = true
        if (loc == null) { promise.reject(error ?: "unavailable", "No location available right now"); return@post }
        val m = Arguments.createMap()
        m.putDouble("latitude", loc.latitude)
        m.putDouble("longitude", loc.longitude)
        m.putDouble("accuracy", loc.accuracy.toDouble())
        m.putDouble("time", loc.time.toDouble())
        promise.resolve(m)
      }
    }
    try {
      if (Build.VERSION.SDK_INT >= 30) {
        val cancel = CancellationSignal()
        lm.getCurrentLocation(provider, cancel, worker) { loc ->
          // A fresh fix can fail indoors; a recent last-known fix is still good enough for weather.
          finish(loc ?: lm.getLastKnownLocation(provider), "unavailable")
        }
        main.postDelayed({ if (!done) { cancel.cancel(); finish(lm.getLastKnownLocation(provider), "timeout") } }, timeoutMs.toLong())
      } else {
        finish(lm.getLastKnownLocation(provider), "unavailable")
      }
    } catch (e: SecurityException) {
      finish(null, "no_permission")
    } catch (e: Exception) {
      finish(null, "unavailable")
    }
  }

  /** "Locality, Admin area, Country" for coordinates, or rejects if the phone's geocoder can't tell. */
  @Suppress("DEPRECATION")
  @ReactMethod
  fun locality(latitude: Double, longitude: Double, promise: Promise) {
    if (!Geocoder.isPresent()) { promise.reject("no_geocoder", "No geocoder on this phone"); return }
    worker.execute {
      try {
        val a = Geocoder(ctx, Locale.ENGLISH).getFromLocation(latitude, longitude, 1)?.firstOrNull()
        val parts = listOfNotNull(a?.locality ?: a?.subAdminArea, a?.adminArea, a?.countryName).distinct()
        if (parts.isEmpty()) promise.reject("unknown_place", "No place name for this location") else promise.resolve(parts.joinToString(", "))
      } catch (e: Exception) {
        promise.reject("geocoder_failed", e.javaClass.simpleName)
      }
    }
  }

  override fun invalidate() {
    worker.shutdown()
    super.invalidate()
  }
}
