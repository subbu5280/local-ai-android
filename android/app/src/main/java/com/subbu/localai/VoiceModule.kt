package com.subbu.localai

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Phase 14: Android's built-in speech recognition and text-to-speech, plus device memory for the model manager.
 *
 * Privacy: the recognizer runs only between startListening() and its result/error (no continuous listening); this
 * module never stores or logs audio or transcripts. Which recognizer runs (Google/Samsung, online or on-device) is
 * the system's choice; recognitionSupport() reports what it really supports per language.
 */
class VoiceModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private val main = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var pending: Promise? = null
  // TTS state, touched on the main thread only. Calls made while the engine initializes wait in ttsWaiting.
  private var tts: TextToSpeech? = null
  private var ttsReady = false
  private class TtsCall(val promise: Promise, val isSpeak: Boolean, val run: (TextToSpeech) -> Unit)
  private val ttsWaiting = mutableListOf<TtsCall>()

  override fun getName() = "AiVoice"

  private fun emit(type: String, text: String? = null) {
    val m = Arguments.createMap()
    m.putString("type", type)
    if (text != null) m.putString("text", text)
    ctx.emitDeviceEvent("AiVoiceEvent", m)
  }

  private fun intent(lang: String, preferOffline: Boolean) = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    if (preferOffline) putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
  }

  /** {available, onDeviceAvailable, sdk, languages: {tag: {online, onDeviceInstalled, onDeviceSupported}}} */
  @ReactMethod
  fun recognitionSupport(langs: ReadableArray, promise: Promise) {
    main.post {
      val out = Arguments.createMap()
      out.putBoolean("available", SpeechRecognizer.isRecognitionAvailable(ctx))
      out.putBoolean("onDeviceAvailable",
        Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx))
      out.putInt("sdk", Build.VERSION.SDK_INT)
      if (Build.VERSION.SDK_INT < 33 || !SpeechRecognizer.isRecognitionAvailable(ctx)) {
        out.putMap("languages", Arguments.createMap())
        promise.resolve(out)
        return@post
      }
      // One Android 13+ support query: RecognitionSupport already lists ALL online / installed / supported languages.
      // (Earlier version queried per language in parallel; a late callback wrote into an already-sent map and
      // crashed the app with ObjectAlreadyConsumedException on the Galaxy M35.)
      val tags = (0 until langs.size()).map { langs.getString(it) ?: "" }.filter { it.isNotEmpty() }
      val r = SpeechRecognizer.createSpeechRecognizer(ctx)
      var finished = false // resolve exactly once (main thread only)
      fun finish(s: RecognitionSupport?, error: String?) {
        main.post {
          if (finished) return@post
          finished = true
          runCatching { r.destroy() }
          val all = Arguments.createMap()
          fun has(list: List<String>?, tag: String) =
            list?.any { it.equals(tag, true) || it.equals(tag.substringBefore('-'), true) || it.startsWith("${tag.substringBefore('-')}-", true) }
          for (tag in tags) {
            val m = Arguments.createMap()
            if (s == null) m.putString("error", error ?: "no answer") else {
              m.putBoolean("online", has(s.onlineLanguages, tag) == true)
              m.putBoolean("onDeviceInstalled", has(s.installedOnDeviceLanguages, tag) == true)
              m.putBoolean("onDeviceSupported", has(s.supportedOnDeviceLanguages, tag) == true)
            }
            all.putMap(tag, m)
          }
          out.putMap("languages", all)
          promise.resolve(out)
        }
      }
      try {
        r.checkRecognitionSupport(intent(tags.firstOrNull() ?: "en-IN", false), Executors.newSingleThreadExecutor(),
          object : RecognitionSupportCallback {
            override fun onSupportResult(s: RecognitionSupport) = finish(s, null)
            override fun onError(error: Int) = finish(null, "code $error")
          })
        main.postDelayed({ finish(null, "timeout") }, 4000) // never leave the JS side waiting
      } catch (e: Exception) {
        finish(null, e.javaClass.simpleName)
      }
    }
  }

  /** Listen once in `lang` (BCP-47, e.g. "te-IN"); resolves with the final transcript, rejects with an error code. */
  @ReactMethod
  fun startListening(lang: String, preferOffline: Boolean, promise: Promise) {
    main.post {
      if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
        promise.reject("unavailable", "Speech recognition is not available on this device"); return@post
      }
      cleanupRecognizer()
      pending = promise
      val r = SpeechRecognizer.createSpeechRecognizer(ctx)
      recognizer = r
      r.setRecognitionListener(object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = emit("ready")
        override fun onBeginningOfSpeech() = emit("speech")
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {} // audio is never kept
        override fun onEndOfSpeech() = emit("processing")
        override fun onPartialResults(b: Bundle?) {
          b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { emit("partial", it) }
        }
        override fun onEvent(eventType: Int, params: Bundle?) {}
        override fun onResults(b: Bundle?) {
          val text = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
          val p = pending; pending = null
          cleanupRecognizer()
          if (text.isBlank()) p?.reject("no_match", "No speech was recognized") else p?.resolve(text)
        }
        override fun onError(error: Int) {
          val p = pending; pending = null
          cleanupRecognizer()
          p?.reject(errorName(error), "Speech recognition error ${errorName(error)} ($error)")
        }
      })
      r.startListening(intent(lang, preferOffline))
    }
  }

  /** Stop capturing and let the recognizer return what it heard. */
  @ReactMethod
  fun stopListening() { main.post { recognizer?.stopListening() } }

  /** Abort without a result. */
  @ReactMethod
  fun cancelListening() {
    main.post {
      val p = pending; pending = null
      cleanupRecognizer()
      p?.reject("cancelled", "Listening cancelled")
    }
  }

  private fun cleanupRecognizer() {
    recognizer?.let { it.cancel(); it.destroy() }
    recognizer = null
  }

  private fun errorName(e: Int) = when (e) {
    SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_NETWORK -> "network"
    SpeechRecognizer.ERROR_AUDIO -> "audio"
    SpeechRecognizer.ERROR_SERVER -> "server"
    SpeechRecognizer.ERROR_CLIENT -> "client"
    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no_speech"
    SpeechRecognizer.ERROR_NO_MATCH -> "no_match"
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission"
    10 -> "too_many_requests"
    11 -> "server_disconnected"
    12 -> "language_not_supported"
    13 -> "language_unavailable"
    else -> "error_$e"
  }

  // ---------------------------------------------------------------- text-to-speech

  /**
   * Run `call` on the main thread once the engine is ready. Everything goes through the main thread, so a Stop and
   * a following Speak keep their order. While the engine initializes, only the newest Speak is kept (an older
   * queued one resolves false), so one tap never turns into two utterances.
   */
  private fun withTts(call: TtsCall) {
    main.post {
      val t = tts
      if (t != null && ttsReady) { call.run(t); return@post }
      if (call.isSpeak) dropQueuedSpeak()
      ttsWaiting.add(call)
      if (t != null) return@post // initialization already under way
      tts = TextToSpeech(ctx) { status -> main.post { onTtsInit(status) } }.also {
        it.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
          override fun onStart(id: String?) = emit("tts_start", id)
          override fun onDone(id: String?) = emit("tts_done", id)
          @Deprecated("Deprecated in Java") override fun onError(id: String?) = emit("tts_error", id)
          override fun onStop(id: String?, interrupted: Boolean) = emit("tts_stop", id)
        })
      }
    }
  }

  /** Forget a Speak still waiting for the engine (replaced or stopped); it resolves false = "not spoken". */
  private fun dropQueuedSpeak() {
    val queued = ttsWaiting.filter { it.isSpeak }
    ttsWaiting.removeAll(queued)
    queued.forEach { it.promise.resolve(false) }
  }

  private fun onTtsInit(status: Int) {
    val waiting = ttsWaiting.toList()
    ttsWaiting.clear()
    val t = tts
    if (status == TextToSpeech.SUCCESS && t != null) {
      ttsReady = true
      waiting.forEach { it.run(t) }
    } else {
      // Reset so the next request tries again; every waiting call gets an honest error (the app resets its button).
      runCatching { t?.shutdown() }
      tts = null
      ttsReady = false
      waiting.forEach { it.promise.reject("tts_unavailable", "Text-to-speech engine failed to start") }
    }
  }

  /** {tag: "available" | "missing_data" | "not_supported", engine} for each BCP-47 tag. */
  @ReactMethod
  fun ttsLanguages(langs: ReadableArray, promise: Promise) {
    withTts(TtsCall(promise, isSpeak = false) { t ->
      val out = Arguments.createMap()
      for (i in 0 until langs.size()) {
        val tag = langs.getString(i) ?: continue
        out.putString(tag, when (t.isLanguageAvailable(Locale.forLanguageTag(tag))) {
          TextToSpeech.LANG_MISSING_DATA -> "missing_data"
          TextToSpeech.LANG_NOT_SUPPORTED -> "not_supported"
          else -> "available"
        })
      }
      out.putString("engine", t.defaultEngine ?: "")
      promise.resolve(out)
    })
  }

  /**
   * Speak `text` in `lang`, replacing anything currently being spoken. Resolves true once Android accepted the
   * utterance (false if a newer Speak or a Stop replaced it while the engine was starting); rejects if it can't.
   */
  @ReactMethod
  fun speak(text: String, lang: String, id: String, promise: Promise) {
    withTts(TtsCall(promise, isSpeak = true) { t ->
      val res = t.setLanguage(Locale.forLanguageTag(lang))
      if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
        promise.reject("voice_unavailable", "No $lang voice is installed on this phone")
      } else if (t.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) == TextToSpeech.ERROR) {
        promise.reject("tts_failed", "Android text-to-speech refused the request")
      } else {
        promise.resolve(true)
      }
    })
  }

  /** Stop now; a Speak still waiting for the engine to start is dropped too, so it can't start after Stop. */
  @ReactMethod
  fun stopSpeaking() { main.post { dropQueuedSpeak(); tts?.stop() } }

  // ---------------------------------------------------------------- device memory (model manager)

  /** {totalBytes, availBytes, lowMemory, thresholdBytes} from ActivityManager.MemoryInfo. */
  @ReactMethod
  fun memoryInfo(promise: Promise) {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mi = ActivityManager.MemoryInfo()
    am.getMemoryInfo(mi)
    val m = Arguments.createMap()
    m.putDouble("totalBytes", mi.totalMem.toDouble())
    m.putDouble("availBytes", mi.availMem.toDouble())
    m.putBoolean("lowMemory", mi.lowMemory)
    m.putDouble("thresholdBytes", mi.threshold.toDouble())
    promise.resolve(m)
  }

  // Required for NativeEventEmitter on the JS side.
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Double) {}

  override fun invalidate() {
    main.post {
      cleanupRecognizer()
      ttsWaiting.forEach { it.promise.reject("tts_unavailable", "Text-to-speech was shut down") }
      ttsWaiting.clear()
      tts?.shutdown(); tts = null; ttsReady = false
    }
    super.invalidate()
  }
}
