package com.subbu.localai

/** BackupCryptoChecks on the laptop JVM (javax.crypto from the JDK). Run: gradlew :app:testDebugUnitTest --offline */
class BackupCryptoJvmTest : BackupCryptoChecks() {
  override fun resource(name: String): String =
    javaClass.classLoader!!.getResourceAsStream("backup/$name")!!.use { String(it.readBytes(), Charsets.UTF_8) }
}
