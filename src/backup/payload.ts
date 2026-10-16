/**
 * Reading a backup's decrypted payload, after authentication: the manifest, then each category's rows (contiguous in
 * the file), checked against the strict row schemas. Rows are handed over one category at a time, so at most one
 * category is in memory; document text is handed over one document at a time.
 *
 * Payload versions are separate from the database schema: payload version 1 holds rows of the tables in categories.ts.
 * A backup from an older app (lower appSchema) may lack columns added later; their defaults are filled in by checkRow.
 * A backup from a newer app (higher appSchema) is refused before anything is read into the database.
 */
import { SCHEMA_VERSION } from '../chatStore';
import { CATEGORIES, category, checkRow, keyOf, type CategoryId } from './categories';
import { PAYLOAD_VERSION, type Manifest } from './backup';
import { BackupError, readChunks, type Opened, type Signal } from './format';

export const MAX_RECORDS = 500_000;
/** One category is restored in one transaction; above these it is refused (documents' text is handled per document). */
export const MAX_CATEGORY_RECORDS = 60_000;
export const MAX_CATEGORY_CHARS = 48_000_000;

export type Rows = Record<string, Record<string, unknown>[]>;
export type CategoryRead = { id: CategoryId; rows: Rows; errors: string[]; records: number; chars: number };

/** Payload migrations by version (none yet: version 1 is the first). A future version adds a step here. */
const MIGRATE: Record<number, (record: any) => any> = {};

/**
 * Stream the payload: onManifest first, then onCategory for each category (rows validated; errors listed, never
 * thrown for a single bad row), and onDocumentText for each document's passages (document text only).
 */
export async function readPayload(path: string, opened: Opened, handlers: {
  onManifest?: (m: Manifest) => Promise<void> | void;
  onCategory: (c: CategoryRead) => Promise<void>;
  onDocumentText?: (documentId: string, chunks: Record<string, unknown>[], errors: string[]) => Promise<void>;
  signal?: Signal;
}): Promise<Manifest> {
  let manifest: Manifest | null = null;
  let ended = false;
  let total = 0;
  let cur: CategoryRead | null = null;
  const seen = new Map<string, Set<string>>();
  const done = new Set<string>();
  let doc: { id: string; chunks: Record<string, unknown>[]; errors: string[] } | null = null;

  const flushDoc = async () => { if (doc && handlers.onDocumentText) await handlers.onDocumentText(doc.id, doc.chunks, doc.errors); doc = null; };
  const flush = async () => {
    await flushDoc(); // a category's documents are complete before the category itself is reported
    if (cur) { done.add(cur.id); const c = cur; cur = null; await handlers.onCategory(c); }
  };

  const onRecord = async (rec: any) => {
    if (ended) throw new BackupError('malformed', 'The backup has data after its end marker.');
    if (!manifest) {
      if (rec?.type !== 'manifest') throw new BackupError('malformed', 'The backup has no manifest.');
      manifest = checkManifest(rec);
      await handlers.onManifest?.(manifest);
      return;
    }
    if (rec?.type === 'end') {
      if (rec.records !== total) throw new BackupError('malformed', 'The backup\'s record count does not match its contents.');
      ended = true;
      return;
    }
    if (rec?.type !== 'row' || typeof rec.cat !== 'string' || typeof rec.table !== 'string' || Object.keys(rec).length !== 4) {
      throw new BackupError('malformed', 'The backup contains an unexpected record.');
    }
    if (MIGRATE[manifest.payloadVersion]) rec = MIGRATE[manifest.payloadVersion](rec);
    const cat = category(rec.cat);
    if (!cat || !cat.tables.includes(rec.table) || !manifest.categories.some(c => c.id === cat.id)) {
      throw new BackupError('malformed', 'The backup contains data in an unexpected place.');
    }
    if (++total > MAX_RECORDS) throw new BackupError('too_large', 'The backup has too many records.');
    if (cur?.id !== cat.id) {
      await flush();
      if (done.has(cat.id)) throw new BackupError('malformed', 'The backup\'s categories are out of order.');
      cur = { id: cat.id, rows: {}, errors: [], records: 0, chars: 0 };
    }
    const c = cur!;
    c.records++;
    const checked = checkRow(rec.table, rec.row);
    const keys = seen.get(rec.table) ?? new Set<string>();
    seen.set(rec.table, keys);
    if (checked.row) {
      const k = keyOf(rec.table, checked.row);
      if (keys.has(k)) { c.errors.push(`${rec.table}: the same record appears twice`); return; }
      keys.add(k);
    }
    if (cat.id === 'documentText') {
      // One document's passages at a time (they are written in rowid order, so a document's passages are together).
      const id = String((rec.row as any)?.document_id ?? '');
      if (doc && doc.id !== id) await flushDoc();
      doc ??= { id, chunks: [], errors: [] };
      if (checked.row) doc.chunks.push(checked.row); else doc.errors.push(checked.error!);
      return;
    }
    if (!checked.row) { c.errors.push(checked.error!); return; }
    c.chars += JSON.stringify(checked.row).length;
    (c.rows[rec.table] ??= []).push(checked.row);
    if (c.records > MAX_CATEGORY_RECORDS || c.chars > MAX_CATEGORY_CHARS) {
      // Too big for one transaction: keep counting, but stop holding rows.
      c.rows = {};
      if (!c.errors.includes(TOO_LARGE)) c.errors.push(TOO_LARGE);
    }
  };

  await readChunks(path, opened, async text => {
    const lines = text.split('\n');
    if (lines[lines.length - 1] !== '') throw new BackupError('malformed', 'The backup is damaged.');
    for (const line of lines.slice(0, -1)) {
      let rec: unknown;
      try { rec = JSON.parse(line); } catch { throw new BackupError('malformed', 'The backup contains damaged data.'); }
      await onRecord(rec);
    }
  }, handlers.signal);
  if (!ended || !manifest) throw new BackupError('truncated', 'The backup is incomplete.');
  await flush();
  return manifest;
}

export const TOO_LARGE = 'This category is too large to restore in one step.';

function checkManifest(m: any): Manifest {
  const keys = ['type', 'payloadVersion', 'appSchema', 'createdAt', 'categories', 'excluded'];
  if (!m || Object.keys(m).sort().join() !== [...keys].sort().join()) throw new BackupError('malformed', 'The backup\'s manifest is damaged.');
  if (m.payloadVersion !== PAYLOAD_VERSION && !MIGRATE[m.payloadVersion]) {
    throw new BackupError('unsupported_version', `This backup's contents use version ${String(m.payloadVersion)}, which this app can't read.`);
  }
  if (!Number.isInteger(m.appSchema) || m.appSchema < 1) throw new BackupError('malformed', 'The backup\'s manifest is damaged.');
  if (m.appSchema > SCHEMA_VERSION) throw new BackupError('unsupported_version', 'This backup was made by a newer version of the app. Update the app to restore it.');
  if (!Number.isInteger(m.createdAt) || !Array.isArray(m.categories) || m.categories.length > CATEGORIES.length || !Array.isArray(m.excluded)) {
    throw new BackupError('malformed', 'The backup\'s manifest is damaged.');
  }
  for (const c of m.categories) {
    if (!c || !category(c.id) || !Number.isInteger(c.records) || c.records < 0 || Object.keys(c).length !== 2) throw new BackupError('malformed', 'The backup lists an unknown category.');
  }
  return m as Manifest;
}
