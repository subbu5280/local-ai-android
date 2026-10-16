/**
 * Importing documents: pick -> check -> extract (Android) -> normalize -> chunk -> index, one document at a time.
 *
 * - One import runs at a time (a queue), so two imports can't interleave writes; the same file requested twice while
 *   it is being imported is reported, not imported twice.
 * - The same file picked again (same URI) is re-indexed only if its bytes changed; the same bytes from another place
 *   (same SHA-256) are reported as a duplicate.
 * - A library entry exists from the start of indexing (status 'indexing'); every failure ends as status 'failed'
 *   with a code and a readable message, and retryable failures can be retried later.
 * - Nothing here logs document names or text (metrics carry format, sizes and timings only).
 */
import * as RNFS from '@dr.pogodin/react-native-fs';
import { newId } from '../chatStore';
import { metric } from '../metrics';
import { chunkDocument, type Segment } from './chunker';
import * as store from './docStore';
import * as native from './native';
import * as ocr from './ocr';
import { detectFormat, MAX_BYTES, MAX_CHARS, normalizeText, rowsToText, textFor, type DocFormat } from './text';

export type ImportOutcome = {
  name: string;
  status: 'indexed' | 'unchanged' | 'duplicate' | 'failed' | 'unsupported' | 'busy';
  documentId?: string;
  message: string;
};

/** Failures where trying again can't help (the file itself is the problem). */
const FINAL = new Set(['unsupported', 'too_large', 'empty', 'no_text', 'pdf_encrypted', 'pdf_malformed', 'pdf_unsupported']);
export const canRetry = (d: Pick<store.Doc, 'status' | 'error_code'>) => d.status === 'failed' && !FINAL.has(d.error_code ?? '');

const MB = 1e6;
/** Free space needed before importing: the text, its passages and index can take a few times the file size. */
export const storageNeeded = (bytes: number) => Math.max(bytes, 0) * 4 + 100 * MB;

let queue: Promise<unknown> = Promise.resolve();
const inFlight = new Set<string>();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

const NO_OCR_LANGUAGE = 'This file has no selectable text, so it is probably a scan or a photo. Download a text ' +
  'recognition language in Documents → Text recognition, then import it again.';

/** Native OCR rejections keep their code (e.g. "cancelled", "too_large"). */
async function ocrCall<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (e: any) { throw new Failure(typeof e?.code === 'string' ? e.code : 'ocr_failed', String(e?.message ?? e)); }
}

class Failure extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Extracted, normalized text of a file as page segments, plus a warning when part of it could not be read. */
async function extract(file: native.PickedFile, format: DocFormat): Promise<{ segments: Segment[]; sha256: string;
  bytes: number; pageCount: number | null; warning: string | null }> {
  if (format === 'pdf') {
    const pdf = await native.readPdf(file.uri, MAX_BYTES.pdf);
    const pages = pdf.pages.map(normalizeText);
    const empty = pages.filter(p => !p).length;
    if (pages.length === 0 || empty === pages.length) {
      // A scan: recognize the page images when a text recognition language is installed (M13).
      const langs = await ocr.languageList();
      if (!langs) throw new Failure('no_text', NO_OCR_LANGUAGE);
      const r = await ocrCall(() => ocr.recognizePdf(file.uri, langs));
      const texts = r.pages.map(p => normalizeText(p.text));
      if (!texts.some(Boolean)) throw new Failure('no_text', 'No text was recognized in this scanned PDF.');
      return {
        segments: texts.map((text, i) => ({ text, page: i + 1 })).filter(seg => seg.text),
        sha256: pdf.sha256, bytes: pdf.bytes, pageCount: r.pageCount,
        warning: `Text was recognized from scanned pages (OCR) and may contain mistakes.` +
          (r.pageCount > texts.length ? ` Only the first ${texts.length} of ${r.pageCount} pages were read.` : ''),
      };
    }
    return {
      segments: pages.map((text, i) => ({ text, page: i + 1 })).filter(s => s.text),
      sha256: pdf.sha256, bytes: pdf.bytes, pageCount: pages.length,
      warning: empty ? `${empty} of ${pages.length} pages had no selectable text (scanned pages are skipped).` : null,
    };
  }
  if (format === 'image') {
    const langs = await ocr.languageList();
    if (!langs) throw new Failure('no_text', NO_OCR_LANGUAGE);
    const r = await ocrCall(() => ocr.recognizeImage(file.uri, langs));
    const text = normalizeText(r.text);
    if (!text) throw new Failure('no_text', 'No text was recognized in this image.');
    return { segments: [{ text, page: null }], sha256: r.sha256, bytes: r.bytes, pageCount: null,
      warning: 'Text was recognized from an image (OCR) and may contain mistakes.' };
  }
  if (format === 'docx' || format === 'xlsx') {
    const o = await native.readOffice(file.uri, format, MAX_BYTES[format]);
    // An Excel sheet is one "page" (its number in the workbook), so a source says which sheet it came from.
    const segments = format === 'docx' ? [{ text: normalizeText(o.text ?? ''), page: null }]
      : (o.sheets ?? []).map((sh, i) => ({ text: normalizeText(`Sheet: ${sh.name}\n${rowsToText(sh.rows)}`), page: i + 1 }));
    if (!segments.some(s => s.text.replace(/^Sheet: .*$/m, '').trim())) throw new Failure('empty', 'The file has no text.');
    return { segments: segments.filter(s => s.text), sha256: o.sha256, bytes: o.bytes, pageCount: format === 'xlsx' ? segments.length : null, warning: null };
  }
  const file2 = await native.readText(file.uri, MAX_BYTES[format]);
  const text = textFor(format as 'txt' | 'md' | 'csv', file2.text);
  if (!text) throw new Failure('empty', 'The file has no text.');
  return {
    segments: [{ text, page: null }], sha256: file2.sha256, bytes: file2.bytes, pageCount: null,
    warning: file2.lossy ? 'Some characters could not be read (the file is not UTF-8 text); they show as �.' : null,
  };
}

/** Import or re-index one picked file. Never throws: every problem becomes an outcome (and a 'failed' entry if stored). */
async function importOne(file: native.PickedFile, now: () => number): Promise<ImportOutcome> {
  const format = detectFormat(file.name, file.mime);
  if (!format) {
    return { name: file.name, status: 'unsupported', message: 'Not a supported format (TXT, Markdown, PDF, CSV, Word .docx, Excel .xlsx or a JPG/PNG/WebP image).' };
  }
  if (file.size > MAX_BYTES[format]) {
    return { name: file.name, status: 'failed', message: `Too large: the limit for ${format.toUpperCase()} is ${MAX_BYTES[format] / MB} MB.` };
  }
  const free = await RNFS.getFSInfo().then(i => i.freeSpace).catch(() => null);
  if (free != null && free < storageNeeded(file.size)) {
    return { name: file.name, status: 'failed', message: 'Not enough free storage on the phone to index this file.' };
  }
  const existing = await store.findByUri(file.uri);
  const id = existing?.id ?? newId();
  const t0 = Date.now();
  if (existing) await store.markIndexing(id, now());
  else await store.createDocument({ id, name: file.name, format, uri: file.uri, mime: file.mime, size: file.size >= 0 ? file.size : null, now: now() });
  try {
    const x = await extract(file, format);
    const dup = await store.findBySha(x.sha256, id);
    if (dup) {
      if (existing) await store.markFailed(id, 'duplicate', `Same content as "${dup.name}", which is already in the library.`, now());
      else await store.deleteDocument(id);
      return { name: file.name, status: 'duplicate', documentId: dup.id, message: `Already in the library as "${dup.name}".` };
    }
    if (existing && existing.status === 'ready' && existing.sha256 === x.sha256) {
      await store.restoreReady(id, existing.updated_at); // same bytes: the existing index is still right
      return { name: file.name, status: 'unchanged', documentId: id, message: 'Unchanged since the last import.' };
    }
    const charCount = x.segments.reduce((n, s) => n + s.text.length, 0);
    if (charCount > MAX_CHARS) throw new Failure('too_large', `Too much text (over ${MAX_CHARS.toLocaleString('en')} characters).`);
    let chunks;
    try {
      chunks = chunkDocument(x.segments);
    } catch (e: any) {
      throw new Failure('too_large', `The document is too long to index (${e?.message ?? e}).`);
    }
    await store.replaceChunks(id, chunks, { sha256: x.sha256, size: x.bytes, pageCount: x.pageCount, charCount,
      warning: x.warning, now: now() });
    metric('doc_indexed', { format, bytes: x.bytes, chars: charCount, chunks: chunks.length, pages: x.pageCount,
      ms: Date.now() - t0, reimport: !!existing });
    return { name: file.name, status: 'indexed', documentId: id,
      message: `${chunks.length} passage${chunks.length === 1 ? '' : 's'} indexed${x.warning ? `. ${x.warning}` : '.'}` };
  } catch (e: any) {
    const code = e instanceof Failure || e instanceof native.ExtractFailure ? e.code : 'index_failed';
    const message = e instanceof Failure || e instanceof native.ExtractFailure ? e.message
      : `Indexing failed (${String(e?.message ?? e).slice(0, 120)}). Tap Retry.`;
    await store.markFailed(id, code, message, now()).catch(() => undefined); // the recovery at launch covers this too
    metric('doc_failed', { format, code });
    return { name: file.name, status: 'failed', documentId: id, message };
  }
}

/**
 * Import picked files one after another.
 * @param onProgress called before each file: (index, total, name)
 * @returns one outcome per file, in order
 */
export async function importFiles(files: native.PickedFile[], onProgress: (i: number, total: number, name: string) => void = () => undefined,
  now: () => number = Date.now): Promise<ImportOutcome[]> {
  const out: ImportOutcome[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (inFlight.has(f.uri)) {
      out.push({ name: f.name, status: 'busy', message: 'This file is already being imported.' });
      continue;
    }
    inFlight.add(f.uri);
    try {
      out.push(await exclusive(() => { onProgress(i, files.length, f.name); return importOne(f, now); }));
    } finally {
      inFlight.delete(f.uri);
    }
  }
  return out;
}

/** Index a failed document again from its original file (if the app can still open it). */
export async function retry(id: string, now: () => number = Date.now): Promise<ImportOutcome> {
  const doc = await store.getDocument(id);
  if (!doc) return { name: '?', status: 'failed', message: 'This document is no longer in the library.' };
  let info: native.PickedFile;
  try {
    info = await native.fileInfo(doc.uri);
  } catch {
    await store.markFailed(id, 'not_found', "The original file can't be opened anymore. Import it again.", now());
    return { name: doc.name, status: 'failed', documentId: id, message: "The original file can't be opened anymore. Import it again." };
  }
  // A failed entry is re-indexed even if its bytes are unchanged.
  return (await importFiles([{ ...info, name: doc.name }], undefined, now))[0];
}

/** Remove a document from the library and search, and give up access to its file (the file stays on the phone). */
export async function removeDocument(id: string): Promise<boolean> {
  const doc = await store.getDocument(id);
  const removed = await exclusive(() => store.deleteDocument(id));
  if (removed && doc) native.releaseFile(doc.uri);
  return removed;
}
