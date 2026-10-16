# Documents

Import files, search them, and ask questions answered from their passages, entirely on the phone.

## Supported formats

| Format | How text is read | Limit |
|---|---|---|
| TXT | UTF-8 (UTF-16 with a byte-order mark); invalid bytes shown as � with a warning | 10 MB |
| Markdown | as text, with link/image/emphasis syntax removed | 10 MB |
| CSV | one line per row, each value labelled with its column ("Row 3: name: Asha; city: Pune") | 10 MB |
| PDF | Android's own PDF renderer, page by page (Android 15+, or Android 12–14 with recent system updates) | 50 MB |
| Word (.docx) | text paragraphs, read natively with ZIP-bomb limits; XML entities are never resolved | 30 MB |
| Excel (.xlsx) | each sheet becomes a page ("Sheet: name"), rows labelled like CSV | 30 MB |
| Scanned PDF | text recognition (OCR) on each page image, at most 50 pages | 50 MB |
| Photo (JPG, PNG, WebP) | text recognition (OCR) | 30 MB |

At most 2,000,000 characters and 4,000 passages per document. Password-protected and damaged PDFs fail with their
own message. A partly scanned PDF without an OCR language is indexed with a warning naming how many pages had no text.

## Import and search

**Docs → Import** opens Android's file picker (several files at once). The app has no storage permission: the
picker grants access to each chosen file only. Each file shows its result: indexed, unchanged, duplicate (same bytes
already imported), or failed with the reason. Picking the same file again re-indexes it only if it changed.

The search box shows ranked passages with the file name, page and a highlighted excerpt; tapping one opens that
passage with Previous / Next. Search never uses the model and accepts any text: "quoted phrases" and prefix* words
work, and characters like `( ) : - AND OR` are ignored.

**Ranking.** Text is split into word tokens (Latin and Indian scripts; Indian-language words also match their other
forms through a prefix) and stored in SQLite's full-text index: FTS5 if available, otherwise FTS4 (the Galaxy M35
has FTS4 only). Candidates are ranked by BM25 times the share of query words a passage contains, so results are the
same on FTS5 and FTS4. The screen shows which engine is used.

## Meaning search (optional)

**Get (132 MB)** downloads multilingual-e5-small (MIT) after confirmation, checked by SHA-256. Vectors are built in
the background in small batches. Search then combines keyword and meaning results (reciprocal rank fusion), which
finds paraphrases and **questions in a different language from the document**. Measured on the laptop
([eval/README.md](../eval/README.md)): relevant document in the top 3 for 100 % of answerable test queries (keyword
only: 71 %), cross-language 100 % (keyword only: 0 %). Remove deletes the model and its vectors; documents stay.
A re-ranking step was measured and not adopted (hit@1 fell from 0.893 to 0.821).

## Text recognition (OCR)

Tesseract 5 (Tesseract4Android 4.9.0, Apache-2.0) reads scanned PDFs and photos on the phone.

- **Languages:** under *Text recognition*, tap English, Telugu, Hindi, Tamil, Kannada or Malayalam. The app shows the
  size (1–5 MB) and downloads only after you confirm; each file is checked against its pinned SHA-256
  (`src/knowledge/ocr.ts`). ✕ removes a language.
- Without an installed language, a scan or photo fails with a message saying where to get one.
- Recognized text is labelled as possibly containing mistakes. Measured on clean printed text: 100 % of the
  characters read back for five languages and 88 % for Malayalam (emulator); real photos will do worse.

## Asking questions (Docs mode)

Turn on **Docs** next to the message box (or "Ask questions about all documents"). The bar above the input shows the
scope; **Change** picks documents, or a saved **collection**. Docs mode and its scope are remembered after the app
closes.

- The app retrieves the best passages (at most 4, about 900 tokens) and the model answers only from them, citing them
  like [1]. The sources under the answer come from retrieval, not from the model; only citation numbers that really
  exist are listed.
- **Nothing relevant found:** the app itself answers that it couldn't find anything; the model is not asked.
- **Different documents give different amounts** ("30 days" vs "14 days"): the app flags the conflict under the answer.
- **Spreadsheet questions** with total, sum, average, count, highest or lowest ("What is the total amount for
  North?") are **calculated exactly by the app** from the CSV or Excel rows, not by the model. On the Galaxy M35 the
  model answered 1200 where the right total was 1500. Other questions about a table still go to the model.
- Agents can run the same exact analysis with filters and grouping (`table.analyze`).

## Documents are data, never instructions

Document text never goes into the system message; the sources block's markers are removed from document text; the
model is told to ignore instructions inside sources; and Docs mode gives the model no tools. A small model can still
be swayed by text in a source, so answers always show their sources.

## Storage and deletion

Extracted text, passages and the index live only in the app's private database. Remove (on a document) asks first,
then deletes the document, its passages and index entries in one transaction and gives up the app's access to the
file. **The original file is never changed or deleted.** An import interrupted by the app closing is marked failed
at the next start and can be retried.
