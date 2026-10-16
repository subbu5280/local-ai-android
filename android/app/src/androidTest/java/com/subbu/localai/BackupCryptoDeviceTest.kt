package com.subbu.localai

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.runner.RunWith

/** BackupCryptoChecks on an Android device or emulator (the platform's own javax.crypto provider). */
@RunWith(AndroidJUnit4::class)
class BackupCryptoDeviceTest : BackupCryptoChecks() {
  override fun resource(name: String): String =
    InstrumentationRegistry.getInstrumentation().context.assets.open("backup/$name").use { String(it.readBytes(), Charsets.UTF_8) }
}
