package com.subbu.localai

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.googlecode.tesseract.android.TessBaseAPI
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * M13: Tesseract on a real Android runtime. Known text in each supported script is drawn with the system fonts and read
 * back. The language data is not in the repository; push it first (scripts/push-tessdata.ps1 does it with run-as), and
 * a language whose file is missing is skipped, not passed. The similarity per language is logged under "OcrDeviceTest".
 */
@RunWith(AndroidJUnit4::class)
class OcrDeviceTest {
  private val dataDir = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "ocr")

  private fun render(text: String): Bitmap {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK; textSize = 64f }
    val width = paint.measureText(text).toInt() + 80
    return Bitmap.createBitmap(width, 160, Bitmap.Config.ARGB_8888).also {
      it.eraseColor(Color.WHITE)
      Canvas(it).drawText(text, 40f, 100f, paint)
    }
  }

  /** Share of the expected characters (spaces ignored) found in order: a longest-common-subsequence ratio. */
  private fun similarity(expected: String, actual: String): Double {
    val a = expected.filterNot { it.isWhitespace() }
    val b = actual.filterNot { it.isWhitespace() }
    val dp = Array(a.length + 1) { IntArray(b.length + 1) }
    for (i in 1..a.length) for (j in 1..b.length) {
      dp[i][j] = if (a[i - 1] == b[j - 1]) dp[i - 1][j - 1] + 1 else maxOf(dp[i - 1][j], dp[i][j - 1])
    }
    return dp[a.length][b.length].toDouble() / a.length
  }

  private fun check(lang: String, text: String) {
    assumeTrue("$lang.traineddata not pushed", File(dataDir, "tessdata/$lang.traineddata").isFile)
    val tess = TessBaseAPI()
    try {
      assertTrue(tess.init(dataDir.absolutePath, lang, TessBaseAPI.OEM_LSTM_ONLY))
      tess.setImage(render(text))
      val got = tess.utF8Text.trim()
      val score = similarity(text, got)
      Log.i("OcrDeviceTest", "$lang similarity=%.2f confidence=${tess.meanConfidence()}".format(score))
      assertTrue("$lang read back only %.2f of the text".format(score), score >= 0.8)
    } finally {
      tess.recycle()
    }
  }

  @Test fun english() = check("eng", "Refunds are paid within 5 days")
  @Test fun telugu() = check("tel", "తెలుగు భాష చాలా అందమైనది")
  @Test fun hindi() = check("hin", "भारत एक विशाल देश है")
  @Test fun tamil() = check("tam", "தமிழ் ஒரு பழமையான மொழி")
  @Test fun kannada() = check("kan", "ಕನ್ನಡ ಒಂದು ಸುಂದರ ಭಾಷೆ")
  @Test fun malayalam() = check("mal", "മലയാളം ഒരു മനോഹര ഭാഷ")
}
