package com.subbu.localai

import com.subbu.localai.BackupCrypto.Companion.fromHex
import com.subbu.localai.BackupCrypto.Companion.toHex
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Base64
import java.util.Properties

/**
 * Tests of the PRODUCTION backup cryptography (BackupCrypto, the class AiCryptoModule uses). The same checks run on the
 * laptop JVM (src/test: SunJCE provider) and on Android (src/androidTest: the device's provider), so each run proves
 * that environment's javax.crypto produces and accepts exactly what the backup format and the TypeScript side expect.
 *
 * Independent references: RFC 7914 §11 PBKDF2-HMAC-SHA256 vectors, and vectors/container written by the production
 * TypeScript container code on Node/OpenSSL (__tests__/cryptoVectors.test.ts, TEST-ONLY fixed salt and nonce).
 * The container walk below re-states the documented nonce and associated-data rules (docs/backup-and-restore.md) as a
 * test oracle; the cryptography itself is only BackupCrypto.
 */
abstract class BackupCryptoChecks {
  /** The text of a test resource under backup/ (JVM: classpath; Android: test APK assets). */
  abstract fun resource(name: String): String

  private val props by lazy { Properties().apply { load(resource("vectors.properties").reader()) } }
  private fun p(k: String) = props.getProperty(k) ?: error("missing $k")
  private fun b64(k: String) = String(Base64.getDecoder().decode(p(k)), Charsets.UTF_8)
  private val password by lazy { b64("password.b64") }

  private fun expectCode(code: String, block: () -> Unit) {
    try { block(); fail("expected $code") } catch (e: BackupCrypto.CryptoException) { assertEquals(code, e.code) }
  }

  // ---------------------------------------------------------------- key derivation

  @Test fun pbkdf2MatchesRfc7914Vectors() {
    // RFC 7914 §11 gives 64-byte outputs; the first 32 bytes are the first PBKDF2 block, which is what a 256-bit key is.
    assertEquals("55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc", BackupCrypto.pbkdf2("passwd", "salt".toByteArray(), 1).toHex())
    assertEquals("4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56", BackupCrypto.pbkdf2("Password", "NaCl".toByteArray(), 80_000).toHex())
  }

  @Test fun pbkdf2MatchesNodeForUnicodePasswordAtProductionIterations() {
    val salt = p("salt").fromHex()
    assertEquals(p("key.600000"), BackupCrypto.pbkdf2(password, salt, 600_000).toHex())
    assertEquals(p("key.200000"), BackupCrypto.pbkdf2(password, salt, 200_000).toHex())
    assertEquals(32, BackupCrypto.pbkdf2(password, salt, 200_000).size)
  }

  @Test fun unsafeKeyDerivationParametersAreRefusedBeforeAnyWork() {
    val c = BackupCrypto()
    val start = System.nanoTime()
    expectCode("invalid") { c.deriveKey("pw", p("salt"), 99_999) }
    expectCode("invalid") { c.deriveKey("pw", p("salt"), 10_000_001) }
    expectCode("invalid") { c.deriveKey("pw", "00112233", 200_000) } // salt too short
    expectCode("invalid") { c.deriveKey("pw", "ZZ112233445566778899AABBCCDDEEFF", 200_000) } // not lowercase hex
    assertTrue("refusals must not derive a key", (System.nanoTime() - start) / 1_000_000 < 200)
    assertEquals(0, c.keyCount())
  }

  // ---------------------------------------------------------------- AES-256-GCM against Node

  @Test fun sealProducesExactlyNodesCiphertextAndOpensIt() {
    val c = BackupCrypto()
    val k = c.deriveKey(password, p("salt"), 200_000)
    for (i in 0..2) {
      val nonce = p("gcm.$i.nonce")
      val aad = b64("gcm.$i.aad.b64")
      val plain = b64("gcm.$i.plain.b64")
      assertEquals("seal #$i", p("gcm.$i.sealed"), c.seal(k, nonce, aad, plain))
      assertEquals("open #$i", plain, c.open(k, nonce, aad, p("gcm.$i.sealed")))
      assertEquals(plain.toByteArray().size + 16, Base64.getDecoder().decode(p("gcm.$i.sealed")).size) // ciphertext ‖ 16-byte tag
    }
  }

  @Test fun anyChangeFailsAuthentication() {
    val c = BackupCrypto()
    val k = c.deriveKey(password, p("salt"), 200_000)
    val nonce = p("gcm.1.nonce")
    val aad = b64("gcm.1.aad.b64")
    val sealed = Base64.getDecoder().decode(p("gcm.1.sealed"))
    fun flipped(at: Int) = Base64.getEncoder().encodeToString(sealed.copyOf().also { it[at] = (it[at].toInt() xor 1).toByte() })
    expectCode("auth_failed") { c.open(k, nonce, aad, flipped(0)) } // ciphertext
    expectCode("auth_failed") { c.open(k, nonce, aad, flipped(sealed.size - 1)) } // tag
    expectCode("auth_failed") { c.open(k, nonce, aad.replace("200000", "200001"), p("gcm.1.sealed")) } // authenticated header
    expectCode("auth_failed") { c.open(k, p("gcm.0.nonce"), aad, p("gcm.1.sealed")) } // another chunk's nonce (position)
    expectCode("auth_failed") { c.open(k, nonce, aad.dropLast(1) + "1", p("gcm.1.sealed")) } // "last chunk" flag
    val wrong = c.deriveKey("not the password", p("salt"), 200_000)
    expectCode("auth_failed") { c.open(wrong, nonce, aad, p("gcm.1.sealed")) }
  }

  @Test fun malformedInputIsRejectedSafely() {
    val c = BackupCrypto()
    val k = c.deriveKey(password, p("salt"), 200_000)
    val nonce = p("gcm.1.nonce")
    expectCode("auth_failed") { c.open(k, nonce, "a", "not base64 !!") }
    expectCode("auth_failed") { c.open(k, nonce, "a", Base64.getEncoder().encodeToString(ByteArray(15))) } // shorter than a tag
    expectCode("invalid") { c.open(k, "00ff", "a", p("gcm.1.sealed")) } // nonce must be 12 bytes
    expectCode("invalid") { c.seal(k, "zz".repeat(12), "a", "x") }
    expectCode("failed") { c.open("no-such-key", nonce, "a", p("gcm.1.sealed")) }
    expectCode("invalid") { c.randomHex(0) }
    expectCode("invalid") { c.randomHex(65) }
  }

  // ---------------------------------------------------------------- the backup container written by TypeScript

  private data class Container(val header: String, val prefix: String, val chunks: List<String>)
  private fun container(text: String): Container {
    val lines = text.trimEnd('\n').split("\n")
    val prefix = Regex("\"nonce\":\"([0-9a-f]{16})\"").find(lines[1])!!.groupValues[1]
    return Container("${lines[0]}\n${lines[1]}", prefix, lines.drop(2))
  }
  /** Decrypt chunks the way src/backup/format.ts reads them: nonce = prefix ‖ i (4 bytes BE), AAD = header ‖ i ‖ last. */
  private fun openAll(c: BackupCrypto, key: String, x: Container): List<String> = x.chunks.mapIndexed { i, s ->
    c.open(key, x.prefix + "%08x".format(i), "${x.header}\n$i\n${if (i == x.chunks.size - 1) 1 else 0}", s)
  }

  @Test fun decryptsTheTypeScriptContainerChunkByChunk() {
    val x = container(resource("container-v1.txt"))
    assertEquals("LOCALAI-BACKUP/1", x.header.lines()[0])
    assertEquals(p("noncePrefix"), x.prefix)
    val c = BackupCrypto()
    val k = c.deriveKey(password, p("salt"), 200_000)
    val expected = (0 until p("chunks.count").toInt()).map { b64("chunks.$it.b64") }
    assertEquals(expected, openAll(c, k, x))
    assertTrue("includes an empty chunk", expected.contains(""))
  }

  @Test fun reorderedRemovedAppendedOrTruncatedChunksFail() {
    val x = container(resource("container-v1.txt"))
    val c = BackupCrypto()
    val k = c.deriveKey(password, p("salt"), 200_000)
    val n = x.chunks.size
    val swapped = x.copy(chunks = x.chunks.toMutableList().also { val t = it[1]; it[1] = it[2]; it[2] = t })
    expectCode("auth_failed") { openAll(c, k, swapped) }
    expectCode("auth_failed") { openAll(c, k, x.copy(chunks = x.chunks.take(n - 1))) } // cut short: new last isn't "last"
    expectCode("auth_failed") { openAll(c, k, x.copy(chunks = x.chunks + x.chunks.last())) } // extra chunk
    expectCode("auth_failed") { openAll(c, k, x.copy(chunks = x.chunks.drop(1))) } // first removed
    val edited = x.copy(header = x.header.replace("\"iterations\":200000", "\"iterations\":200001"))
    expectCode("auth_failed") { openAll(c, k, edited) }
  }

  // ---------------------------------------------------------------- sizes, randomness, key lifetime

  @Test fun emptyAndMaximumSizedChunksRoundTrip() {
    val c = BackupCrypto()
    val k = c.deriveKey("boundary test password", c.randomHex(16), 200_000)
    val nonce = c.randomHex(12)
    for (plain in listOf("", "a".repeat(256 * 1024), "తె".repeat(128 * 1024), "🔐".repeat(64 * 1024))) {
      val sealed = c.seal(k, nonce, "header", plain)
      assertEquals(plain, c.open(k, nonce, "header", sealed))
    }
  }

  @Test fun randomValuesAreFreshAndKeysUnique() {
    val c = BackupCrypto()
    assertEquals(32, c.randomHex(16).length)
    val seen = HashSet<String>()
    repeat(1000) { assertTrue("SecureRandom repeated a value", seen.add(c.randomHex(8))) }
    val a = c.deriveKey(password, c.randomHex(16), 200_000)
    val b = c.deriveKey(password, c.randomHex(16), 200_000)
    assertNotEquals(a, b)
    val nonce = c.randomHex(12)
    assertNotEquals("different salts must give different keys", c.seal(a, nonce, "", "same"), c.seal(b, nonce, "", "same"))
  }

  @Test fun forgottenKeysCanNoLongerBeUsed() {
    val c = BackupCrypto()
    val k = c.deriveKey(password, p("salt"), 200_000)
    val k2 = c.deriveKey(password, p("salt"), 200_000)
    assertEquals(2, c.keyCount())
    c.forget(k)
    assertEquals(1, c.keyCount())
    expectCode("failed") { c.open(k, p("gcm.1.nonce"), b64("gcm.1.aad.b64"), p("gcm.1.sealed")) }
    c.forgetAll()
    assertEquals(0, c.keyCount())
    expectCode("failed") { c.seal(k2, p("gcm.1.nonce"), "", "x") }
  }
}
