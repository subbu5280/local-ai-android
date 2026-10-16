package com.subbu.localai

import java.io.ByteArrayInputStream
import java.util.zip.ZipInputStream

/**
 * Text from Office Open XML files (M11): .docx paragraphs and .xlsx sheets as tab-separated rows. Pure Kotlin (no
 * Android types) so it is unit-tested on the JVM.
 *
 * These files are ZIP archives of XML. Untrusted input, so:
 * - ZIP limits: entry count, per-entry and total uncompressed size (zip bombs are refused, not truncated silently);
 * - only the few parts needed are read; nothing is ever written to disk (no path traversal possible);
 * - the XML is scanned with simple tag patterns, not a validating parser: no DTDs, no external or custom entities are
 *   ever resolved (only the five XML entities and numeric character references are decoded).
 * Formatting, images, formulas (only their cached values) and embedded objects are not extracted.
 */
object OfficeText {
  class OfficeException(val code: String, message: String) : Exception(message)

  const val MAX_ENTRIES = 5000
  const val MAX_ENTRY_BYTES = 60L * 1024 * 1024
  const val MAX_TOTAL_BYTES = 150L * 1024 * 1024
  const val MAX_CHARS = 2_000_000
  const val MAX_SHEET_ROWS = 20_000

  /** The XML parts of the archive we need (others are skipped without inflating them fully). */
  private fun parts(bytes: ByteArray, wanted: (String) -> Boolean): Map<String, String> {
    val out = HashMap<String, String>()
    var entries = 0
    var total = 0L
    try {
      ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
        while (true) {
          val e = zip.nextEntry ?: break
          if (++entries > MAX_ENTRIES) throw OfficeException("malformed", "The file has too many parts")
          if (e.isDirectory || !wanted(e.name)) continue
          val buf = java.io.ByteArrayOutputStream()
          val chunk = ByteArray(64 * 1024)
          var size = 0L
          while (true) {
            val n = zip.read(chunk)
            if (n < 0) break
            size += n
            total += n
            if (size > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw OfficeException("too_large", "The file expands to more data than the app reads")
            buf.write(chunk, 0, n)
          }
          out[e.name] = String(buf.toByteArray(), Charsets.UTF_8)
        }
      }
    } catch (e: OfficeException) {
      throw e
    } catch (e: Exception) {
      throw OfficeException("malformed", "This file is damaged or not a Word/Excel document")
    }
    return out
  }

  private val ENTITY = Regex("&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);")
  /** Decode the five XML entities and numeric references; anything else stays as written (never resolved). */
  fun unescape(s: String): String = ENTITY.replace(s) { m ->
    val v = m.groupValues[1]
    when {
      v == "amp" -> "&"; v == "lt" -> "<"; v == "gt" -> ">"; v == "quot" -> "\""; v == "apos" -> "'"
      v.startsWith("#x") -> v.substring(2).toIntOrNull(16)?.takeIf { Character.isValidCodePoint(it) }?.let { String(Character.toChars(it)) } ?: ""
      else -> v.substring(1).toIntOrNull()?.takeIf { Character.isValidCodePoint(it) }?.let { String(Character.toChars(it)) } ?: ""
    }
  }

  // ---------------------------------------------------------------- .docx

  private val DOCX_TOKEN = Regex("<w:t(?:\\s[^>]*)?>([^<]*)</w:t>|<w:tab/>|<w:br/>|<w:cr/>|</w:p>|<w:p[\\s>/]")

  /** Paragraph text of a .docx: main body, then footnotes/endnotes. */
  fun docx(bytes: ByteArray): String {
    val p = parts(bytes) { it == "word/document.xml" || it == "word/footnotes.xml" || it == "word/endnotes.xml" }
    val body = p["word/document.xml"] ?: throw OfficeException("malformed", "This is not a Word document (no document.xml)")
    val sb = StringBuilder()
    for (xml in listOfNotNull(body, p["word/footnotes.xml"], p["word/endnotes.xml"])) {
      for (m in DOCX_TOKEN.findAll(xml)) {
        val t = m.value
        when {
          t.startsWith("<w:t") && !t.startsWith("<w:tab") -> sb.append(unescape(m.groupValues[1]))
          t == "<w:tab/>" -> sb.append('\t')
          t == "<w:br/>" || t == "<w:cr/>" -> sb.append('\n')
          t == "</w:p>" -> sb.append('\n')
        }
        if (sb.length > MAX_CHARS) return sb.substring(0, MAX_CHARS)
      }
      sb.append('\n')
    }
    return sb.toString().trim()
  }

  // ---------------------------------------------------------------- .xlsx

  private val SI = Regex("<si>(.*?)</si>", RegexOption.DOT_MATCHES_ALL)
  private val T = Regex("<t(?:\\s[^>]*)?>([^<]*)</t>")
  private val SHEET = Regex("<sheet\\s[^>]*?name=\"([^\"]*)\"[^>]*?r:id=\"([^\"]*)\"")
  private val REL = Regex("<Relationship\\s[^>]*?Id=\"([^\"]*)\"[^>]*?Target=\"([^\"]*)\"|<Relationship\\s[^>]*?Target=\"([^\"]*)\"[^>]*?Id=\"([^\"]*)\"")
  private val ROW = Regex("<row\\b[^>]*>(.*?)</row>", RegexOption.DOT_MATCHES_ALL)
  private val CELL = Regex("<c\\b([^>]*?)(?:/>|>(.*?)</c>)", RegexOption.DOT_MATCHES_ALL)
  private val V = Regex("<v>([^<]*)</v>")

  /** Column index of a cell reference like "C12" (A = 0). */
  private fun col(ref: String): Int = ref.takeWhile { it.isLetter() }.fold(0) { n, ch -> n * 26 + (ch.uppercaseChar() - 'A' + 1) } - 1

  /** Sheets of a .xlsx as (name, rows of cells). Formulas give their cached value; empty cells are "". */
  fun xlsxSheets(bytes: ByteArray): List<Pair<String, List<List<String>>>> {
    val p = parts(bytes) { it == "xl/workbook.xml" || it == "xl/sharedStrings.xml" || it == "xl/_rels/workbook.xml.rels" || (it.startsWith("xl/worksheets/sheet") && it.endsWith(".xml")) }
    val workbook = p["xl/workbook.xml"] ?: throw OfficeException("malformed", "This is not an Excel workbook (no workbook.xml)")
    val shared = p["xl/sharedStrings.xml"]?.let { s -> SI.findAll(s).map { si -> T.findAll(si.groupValues[1]).joinToString("") { unescape(it.groupValues[1]) } }.toList() } ?: emptyList()
    val rels = HashMap<String, String>()
    p["xl/_rels/workbook.xml.rels"]?.let { r -> REL.findAll(r).forEach { m -> val id = m.groupValues[1].ifEmpty { m.groupValues[4] }; val t = m.groupValues[2].ifEmpty { m.groupValues[3] }; rels[id] = t } }
    val sheets = SHEET.findAll(workbook).map { unescape(it.groupValues[1]) to it.groupValues[2] }.toList()
    val out = ArrayList<Pair<String, List<List<String>>>>()
    var chars = 0
    for ((i, s) in sheets.withIndex()) {
      val target = rels[s.second]?.removePrefix("/")?.let { if (it.startsWith("xl/")) it else "xl/$it" } ?: "xl/worksheets/sheet${i + 1}.xml"
      val xml = p[target] ?: continue
      val rows = ArrayList<List<String>>()
      for (r in ROW.findAll(xml)) {
        if (rows.size >= MAX_SHEET_ROWS) break
        val cells = ArrayList<String>()
        for (c in CELL.findAll(r.groupValues[1])) {
          val attrs = c.groupValues[1]
          val inner = c.groupValues[2]
          val ref = Regex("\\br=\"([A-Z]+)\\d+\"").find(attrs)?.groupValues?.get(1)
          val type = Regex("\\bt=\"([a-zA-Z]+)\"").find(attrs)?.groupValues?.get(1)
          val raw = V.find(inner)?.groupValues?.get(1)?.let(::unescape)
          val value = when (type) {
            "s" -> raw?.toIntOrNull()?.let { shared.getOrNull(it) } ?: ""
            "inlineStr" -> T.findAll(inner).joinToString("") { unescape(it.groupValues[1]) }
            "b" -> if (raw == "1") "TRUE" else if (raw == "0") "FALSE" else ""
            else -> raw ?: ""
          }
          val at = ref?.let { col(it) } ?: cells.size
          if (at > 16_383) continue
          while (cells.size < at) cells.add("")
          cells.add(value)
          chars += value.length
        }
        rows.add(cells)
        if (chars > MAX_CHARS) break
      }
      out.add(s.first to rows)
      if (chars > MAX_CHARS) break
    }
    if (out.isEmpty()) throw OfficeException("malformed", "The workbook has no readable sheets")
    return out
  }
}
