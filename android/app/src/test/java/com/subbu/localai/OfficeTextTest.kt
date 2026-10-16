package com.subbu.localai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** OfficeText on the JVM: real ZIP archives built here (no binary fixtures), including hostile ones. */
class OfficeTextTest {
  private fun zip(vararg parts: Pair<String, String>): ByteArray = ByteArrayOutputStream().also { b ->
    ZipOutputStream(b).use { z -> parts.forEach { (n, t) -> z.putNextEntry(ZipEntry(n)); z.write(t.toByteArray()); z.closeEntry() } }
  }.toByteArray()

  private fun code(block: () -> Unit): String = try { block(); fail("expected failure"); "" } catch (e: OfficeText.OfficeException) { e.code }

  @Test fun docxParagraphsTabsEntitiesAndScripts() {
    val doc = """<w:document><w:body><w:p><w:r><w:t>Refund &amp; returns</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">30 days</w:t><w:tab/><w:t>&#x0C24;&#x0C46;&#x0C32;&#x0C41;&#x0C17;&#x0C41;</w:t></w:r></w:p>
      <w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>"""
    val text = OfficeText.docx(zip("word/document.xml" to doc))
    assertEquals("Refund & returns\n30 days\tతెలుగు\n&xxe;", text) // unknown entities are never resolved
  }

  @Test fun xlsxSharedInlineNumbersBooleansAndGaps() {
    val wb = """<workbook><sheets><sheet name="Sales &amp; Q1" sheetId="1" r:id="rId1"/></sheets></workbook>"""
    val rels = """<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>"""
    val ss = """<sst><si><t>Region</t></si><si><t>Amount</t></si><si><r><t>So</t></r><r><t>uth</t></r></si></sst>"""
    val sheet = """<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12.5</v></c><c r="D2" t="b"><v>1</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>North</t></is></c><c r="B3"><f>SUM(B1:B2)</f><v>7</v></c></row>
      </sheetData></worksheet>"""
    val s = OfficeText.xlsxSheets(zip("xl/workbook.xml" to wb, "xl/_rels/workbook.xml.rels" to rels, "xl/sharedStrings.xml" to ss, "xl/worksheets/sheet1.xml" to sheet))
    assertEquals("Sales & Q1", s[0].first)
    assertEquals(listOf(listOf("Region", "Amount"), listOf("South", "", "12.5", "TRUE"), listOf("North", "7")), s[0].second)
  }

  @Test fun hostileOrWrongFilesAreRefused() {
    assertEquals("malformed", code { OfficeText.docx("not a zip at all".toByteArray()) })
    assertEquals("malformed", code { OfficeText.docx(zip("other.xml" to "<x/>")) })
    assertEquals("malformed", code { OfficeText.xlsxSheets(zip("word/document.xml" to "<w:document/>")) })
    // A zip bomb: one highly compressible entry larger than the per-entry limit.
    val bomb = ByteArrayOutputStream().also { b ->
      ZipOutputStream(b).use { z -> z.putNextEntry(ZipEntry("word/document.xml")); val zeros = ByteArray(1 shl 20); repeat(70) { z.write(zeros) }; z.closeEntry() }
    }.toByteArray()
    assertTrue("bomb archive is small", bomb.size < 1_000_000)
    assertEquals("too_large", code { OfficeText.docx(bomb) })
    // A traversal-looking entry name is just a name: nothing is written to disk, and it is not a part we read.
    assertEquals("malformed", code { OfficeText.docx(zip("../../evil/word/document.xml" to "<w:p/>")) })
  }
}
