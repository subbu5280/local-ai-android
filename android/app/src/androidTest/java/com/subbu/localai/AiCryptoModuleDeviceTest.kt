package com.subbu.localai

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.WritableMap
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The React Native module itself on a device: the @ReactMethod entry points src/backup/crypto.ts calls, with the
 * argument types the bridge delivers (String, Int), results and error codes through Promise, on the module's worker
 * thread. The JavaScript side of the bridge is not part of this test (see the app-level checks in docs/release.md).
 */
@RunWith(AndroidJUnit4::class)
class AiCryptoModuleDeviceTest {
  private val module = AiCryptoModule(BridgeReactContext(InstrumentationRegistry.getInstrumentation().targetContext))

  @After fun close() = module.invalidate()

  /** A Promise that records the outcome, like the bridge would deliver it to JavaScript. */
  private class Result : Promise {
    val done = CountDownLatch(1)
    var value: Any? = null
    var code: String? = null
    var message: String? = null
    override fun resolve(value: Any?) { this.value = value; done.countDown() }
    override fun reject(code: String?, message: String?) { this.code = code; this.message = message; done.countDown() }
    override fun reject(code: String?, throwable: Throwable?) = reject(code, throwable?.message)
    override fun reject(code: String?, message: String?, throwable: Throwable?) = reject(code, message)
    override fun reject(throwable: Throwable) = reject("error", throwable.message)
    override fun reject(throwable: Throwable, userInfo: WritableMap) = reject("error", throwable.message)
    override fun reject(code: String?, userInfo: WritableMap) = reject(code, null as String?)
    override fun reject(code: String?, throwable: Throwable?, userInfo: WritableMap) = reject(code, throwable?.message)
    override fun reject(code: String?, message: String?, userInfo: WritableMap) = reject(code, message)
    override fun reject(code: String?, message: String?, throwable: Throwable?, userInfo: WritableMap?) = reject(code, message)
    @Deprecated("RN API") override fun reject(message: String) = reject("error", message)
  }

  private fun call(block: (Promise) -> Unit): Result = Result().also { block(it); assertTrue("timed out", it.done.await(60, TimeUnit.SECONDS)) }

  @Test fun backupRoundTripThroughTheModuleAndErrorCodes() {
    val salt = call { module.randomHex(16, it) }.value as String
    assertEquals(32, salt.length)
    val prefix = call { module.randomHex(8, it) }.value as String
    val key = call { module.deriveKey("correct horse battery staple", salt, 600_000, it) }.value as String
    val header = "LOCALAI-BACKUP/1\n{\"format\":1}"
    val nonce0 = prefix + "00000000"
    val sealed = call { module.seal(key, nonce0, "$header\n0\n1", "తెలుగు chat 🔐", it) }
    assertNull(sealed.code)
    val opened = call { module.open(key, nonce0, "$header\n0\n1", sealed.value as String, it) }
    assertEquals("తెలుగు chat 🔐", opened.value)

    val tampered = call { module.open(key, nonce0, "$header\n0\n0", sealed.value as String, it) }
    assertEquals("auth_failed", tampered.code)
    assertTrue("error text must not echo data", !(tampered.message ?: "").contains("తెలుగు"))
    val wrong = call { module.deriveKey("wrong password", salt, 600_000, it) }.value as String
    assertEquals("auth_failed", call { module.open(wrong, nonce0, "$header\n0\n1", sealed.value as String, it) }.code)
    assertEquals("invalid", call { module.deriveKey("pw", salt, 1000, it) }.code)
    assertEquals("invalid", call { module.randomHex(0, it) }.code)

    assertEquals(2, module.keyCount())
    module.forget(key)
    module.forget(wrong)
    assertEquals("failed", call { module.open(key, nonce0, "$header\n0\n1", sealed.value as String, it) }.code) // runs after the queued forgets
    assertEquals(0, module.keyCount())
  }

  @Test fun encryptionThroughputWithMaximumSizedChunks() {
    val c = BackupCrypto()
    val k = c.deriveKey("throughput test", c.randomHex(16), 200_000)
    val chunk = "0123456789abcdef".repeat(16 * 1024) // 256 KiB: the format's largest plaintext chunk (ASCII)
    val n = 40
    val prefix = c.randomHex(8)
    var t0 = System.nanoTime()
    val sealed = (0 until n).map { c.seal(k, prefix + "%08x".format(it), "header\n$it\n${if (it == n - 1) 1 else 0}", chunk) }
    val sealMs = (System.nanoTime() - t0) / 1_000_000.0
    t0 = System.nanoTime()
    sealed.forEachIndexed { i, s -> assertEquals(chunk.length, c.open(k, prefix + "%08x".format(i), "header\n$i\n${if (i == n - 1) 1 else 0}", s).length) }
    val openMs = (System.nanoTime() - t0) / 1_000_000.0
    val mb = n * chunk.length / 1_048_576.0
    android.util.Log.i("LOCALAI_M9", "AES-256-GCM %.1f MiB in 256 KiB chunks: seal %.0f ms (%.1f MiB/s), open %.0f ms (%.1f MiB/s)".format(mb, sealMs, mb / (sealMs / 1000), openMs, mb / (openMs / 1000)))
    c.forgetAll()
  }

  @Test fun keyDerivationTimeAtProductionIterations() {
    val salt = call { module.randomHex(16, it) }.value as String
    val t0 = System.nanoTime()
    val r = call { module.deriveKey("correct horse battery staple", salt, 600_000, it) }
    val ms = (System.nanoTime() - t0) / 1_000_000
    assertNull(r.code)
    android.util.Log.i("LOCALAI_M9", "PBKDF2-HMAC-SHA256 600000 iterations: $ms ms") // a timing only; never secrets
    module.forget(r.value as String)
  }
}
