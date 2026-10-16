package com.subbu.localai

import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.Executors

/**
 * React Native bridge for encrypted backups (M8): exposes BackupCrypto (the actual cryptography, also exercised by the
 * JVM and on-device tests) to src/backup/crypto.ts. Every call runs on one background thread, in order; results and
 * errors go back through the Promise as { code, message } (codes: unsupported, invalid, auth_failed, failed). Messages
 * never contain the password, keys or plaintext.
 *
 * Requires Android 8.0 (API 26) for PBKDF2WithHmacSHA256 and java.util.Base64; older versions are refused rather than
 * given weaker cryptography.
 */
class AiCryptoModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  private val worker = Executors.newSingleThreadExecutor()
  private val crypto = BackupCrypto()

  override fun getName() = "AiCrypto"

  private fun run(promise: Promise, work: () -> Any) {
    if (Build.VERSION.SDK_INT < 26) return promise.reject("unsupported", "Encrypted backups need Android 8.0 or newer")
    worker.execute {
      try {
        promise.resolve(work())
      } catch (e: BackupCrypto.CryptoException) {
        promise.reject(e.code, e.message)
      } catch (e: Throwable) {
        promise.reject("failed", e.javaClass.simpleName) // never the message: it could echo input
      }
    }
  }

  /** n cryptographically random bytes as hex (salts, nonce prefixes). */
  @ReactMethod
  fun randomHex(n: Int, promise: Promise) = run(promise) { crypto.randomHex(n) }

  /** Derive a 256-bit key with PBKDF2-HMAC-SHA256; resolves an opaque key handle. */
  @ReactMethod
  fun deriveKey(password: String, saltHex: String, iterations: Int, promise: Promise) = run(promise) { crypto.deriveKey(password, saltHex, iterations) }

  /** AES-256-GCM encrypt UTF-8 `plaintext`; resolves base64(ciphertext + 128-bit tag). */
  @ReactMethod
  fun seal(handle: String, nonceHex: String, aad: String, plaintext: String, promise: Promise) = run(promise) { crypto.seal(handle, nonceHex, aad, plaintext) }

  /** Decrypt and authenticate; rejects auth_failed when the key, nonce, data or ciphertext don't match. */
  @ReactMethod
  fun open(handle: String, nonceHex: String, aad: String, sealed: String, promise: Promise) = run(promise) { crypto.open(handle, nonceHex, aad, sealed) }

  /** Wipe and drop a key (queued behind pending work that may still use it). */
  @ReactMethod
  fun forget(handle: String) { worker.execute { crypto.forget(handle) } }

  /** Live keys (diagnostics/tests only: shows that keys are released). */
  fun keyCount() = crypto.keyCount()

  override fun invalidate() {
    worker.execute { crypto.forgetAll() }
    worker.shutdown()
    super.invalidate()
  }
}
