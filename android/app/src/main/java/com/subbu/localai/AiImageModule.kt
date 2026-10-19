package com.subbu.localai

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.util.concurrent.Executors

/**
 * On-device image generation with stable-diffusion.cpp (libsdjni.so from the android/sdjni module, built only when
 * scripts/fetch-sdcpp.ps1 has fetched its source). The model file is downloaded and SHA-256-checked by JS (src/imageGen.ts) after the user agrees;
 * this module only reads it. Images are written to the app's private files/images and never leave the phone.
 * One image at a time, on one background thread; cancel() stops between sampling steps.
 */
class AiImageModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private val worker = Executors.newSingleThreadExecutor()

  override fun getName() = "AiImage"

  /** Whether this build contains the image engine. */
  @ReactMethod
  fun available(promise: Promise) = promise.resolve(loaded)

  /** Generate one image; resolves {path, ms}. Rejects with a plain message on failure or cancel. */
  @ReactMethod
  fun generate(modelPath: String, taesdPath: String, prompt: String, width: Int, height: Int, steps: Int, seed: Double, promise: Promise) {
    if (!loaded) { promise.reject("unavailable", "Image generation is not included in this build"); return }
    val model = File(modelPath)
    val taesd = File(taesdPath)
    val inside = { f: File -> f.isFile && f.canonicalPath.startsWith(ctx.filesDir.canonicalPath) }
    if (!inside(model) || !inside(taesd)) { promise.reject("no_model", "The image model is not downloaded"); return }
    if (width !in 256..768 || height !in 256..768 || steps !in 1..8 || prompt.isBlank() || prompt.length > 500) {
      promise.reject("invalid", "Invalid image request"); return
    }
    worker.execute {
      try {
        val dir = File(ctx.filesDir, "images").apply { mkdirs() }
        val out = File(dir, "img-${System.currentTimeMillis()}.png")
        val threads = Runtime.getRuntime().availableProcessors().coerceIn(2, 6)
        val t0 = System.currentTimeMillis()
        val err = nativeGenerate(model.absolutePath, taesd.absolutePath, prompt, width, height, steps, seed.toLong(), threads, out.absolutePath)
        if (err.isNotEmpty()) { out.delete(); promise.reject("failed", err); return@execute }
        promise.resolve(Arguments.createMap().apply { putString("path", out.absolutePath); putDouble("ms", (System.currentTimeMillis() - t0).toDouble()) })
      } catch (e: Throwable) {
        promise.reject("failed", e.javaClass.simpleName)
      }
    }
  }

  @ReactMethod
  fun cancel() { if (loaded) nativeCancel() }

  /** The sampling step reached so far (for a progress line). */
  @ReactMethod
  fun step(promise: Promise) = promise.resolve(if (loaded) nativeStep() else 0)

  override fun invalidate() {
    cancel()
    worker.shutdown()
    super.invalidate()
  }

  companion object {
    /** False when the build had no stable-diffusion.cpp source (the library isn't in the APK). */
    val loaded: Boolean = runCatching { System.loadLibrary("sdjni") }.isSuccess

    @JvmStatic external fun nativeGenerate(model: String, taesd: String, prompt: String, width: Int, height: Int, steps: Int, seed: Long, threads: Int, out: String): String
    @JvmStatic external fun nativeCancel()
    @JvmStatic external fun nativeStep(): Int
  }
}
