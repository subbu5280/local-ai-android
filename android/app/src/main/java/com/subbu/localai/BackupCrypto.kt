package com.subbu.localai

import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * The cryptography behind encrypted backups (M8/M9): PBKDF2-HMAC-SHA256 key derivation, AES-256-GCM with a 96-bit nonce
 * and 128-bit tag, and SecureRandom, all from the platform's javax.crypto (Conscrypt/BoringSSL on Android). No Android
 * or React Native types, so the exact production code runs in JVM unit tests (src/test) and on devices (src/androidTest);
 * AiCryptoModule only adapts it to the React Native bridge. The container format (header, nonces, chunk order) is
 * defined in src/backup/format.ts.
 *
 * Derived keys stay here behind random opaque handles; forget() overwrites them. Passwords are used once and the char
 * copies made here are overwritten; Java/JS strings themselves can't be wiped.
 */
class BackupCrypto(private val random: SecureRandom = SecureRandom()) {
  class CryptoException(val code: String, message: String) : Exception(message)

  private val keys = ConcurrentHashMap<String, ByteArray>()

  /** n random bytes as lowercase hex (1..64). */
  fun randomHex(n: Int): String {
    if (n < 1 || n > 64) throw CryptoException("invalid", "bad length")
    return ByteArray(n).also { random.nextBytes(it) }.toHex()
  }

  /** PBKDF2-HMAC-SHA256 → a 256-bit AES key held under a new opaque handle. Parameters are checked before any work. */
  fun deriveKey(password: String, saltHex: String, iterations: Int): String {
    if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS || !isHex(saltHex) || saltHex.length < 32 || saltHex.length > 128) {
      throw CryptoException("invalid", "unsafe key-derivation parameters")
    }
    val key = pbkdf2(password, saltHex.fromHex(), iterations)
    val handle = randomHex(16)
    keys[handle] = key
    return handle
  }

  /** AES-256-GCM: base64(ciphertext ‖ 16-byte tag) of the UTF-8 plaintext. */
  fun seal(handle: String, nonceHex: String, aad: String, plaintext: String): String {
    val c = cipher(Cipher.ENCRYPT_MODE, handle, nonceHex, aad)
    return Base64.getEncoder().encodeToString(c.doFinal(plaintext.toByteArray(Charsets.UTF_8)))
  }

  /** Decrypt and authenticate; CryptoException("auth_failed") for any wrong key, nonce, data, tag or encoding. */
  fun open(handle: String, nonceHex: String, aad: String, sealed: String): String {
    val c = cipher(Cipher.DECRYPT_MODE, handle, nonceHex, aad)
    val bytes = try { Base64.getDecoder().decode(sealed) } catch (e: IllegalArgumentException) { throw CryptoException("auth_failed", "malformed data") }
    if (bytes.size < TAG_BYTES) throw CryptoException("auth_failed", "malformed data")
    val plain = try { c.doFinal(bytes) } catch (e: AEADBadTagException) { throw CryptoException("auth_failed", "authentication failed") }
    // Only authenticated bytes reach here; invalid UTF-8 can't come from seal(), so it is treated as tampering too.
    return try {
      Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(plain)).toString()
    } catch (e: java.nio.charset.CharacterCodingException) {
      throw CryptoException("auth_failed", "malformed data")
    } finally { plain.fill(0) }
  }

  /** Overwrite and drop a key. */
  fun forget(handle: String) { keys.remove(handle)?.fill(0) }

  /** Overwrite and drop all keys (module shutdown). */
  fun forgetAll() { keys.values.forEach { it.fill(0) }; keys.clear() }

  /** Number of live keys (tests: keys are released). */
  fun keyCount() = keys.size

  private fun cipher(mode: Int, handle: String, nonceHex: String, aad: String): Cipher {
    val key = keys[handle] ?: throw CryptoException("failed", "no key")
    if (!isHex(nonceHex) || nonceHex.length != NONCE_BYTES * 2) throw CryptoException("invalid", "bad nonce")
    return Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BYTES * 8, nonceHex.fromHex()))
      updateAAD(aad.toByteArray(Charsets.UTF_8))
    }
  }

  companion object {
    const val MIN_ITERATIONS = 100_000 // the container accepts 200,000–2,000,000 (src/backup/format.ts); this is a backstop
    const val MAX_ITERATIONS = 10_000_000
    const val KEY_BYTES = 32
    const val NONCE_BYTES = 12
    const val TAG_BYTES = 16

    /** PBKDF2-HMAC-SHA256 with the platform's SecretKeyFactory (the password is encoded as UTF-8 by the provider). */
    fun pbkdf2(password: String, salt: ByteArray, iterations: Int): ByteArray {
      val chars = password.toCharArray()
      val spec = PBEKeySpec(chars, salt, iterations, KEY_BYTES * 8)
      try {
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
      } finally {
        spec.clearPassword()
        chars.fill('\u0000')
      }
    }

    fun ByteArray.toHex() = joinToString("") { "%02x".format(it) }
    fun String.fromHex(): ByteArray = ByteArray(length / 2) { substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    fun isHex(s: String) = s.length % 2 == 0 && s.all { it in '0'..'9' || it in 'a'..'f' }
  }
}
