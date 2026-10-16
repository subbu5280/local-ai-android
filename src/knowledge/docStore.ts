/**
 * Document library storage: the documents and chunks tables (schema v4, src/chatStore.ts) and the full-text index.
 *
 * Full-text engine: SQLite FTS5 if this phone's SQLite has it, otherwise FTS4 (part of Android's SQLite on every
 * version). Which one is used is decided once, by trying to create the index, and stored in the meta table; the app
 * shows it. The index stores search tokens (src/knowledge/tokens.ts) under the chunk's id (rowid = chunks.id).
 * If neither engine exists, the engine is 'none' and search says it is unavailable (no hidden substitute).
 *
 * All writes that must stay consistent (a document's chunks, its index rows and its status) happen in one transaction.
 */
import { db, open, type Db } from '../chatStore';
import type { Chunk } from './chunker';
import type { DocFormat } from './text';
import { tokenize, TOKENIZER_VERSION } from './tokens';

export type FtsEngine = 'fts5' | 'fts4' | 'none';
export type DocStatus = 'indexing' | 'ready' | 'failed';
export type Doc = {
  id: string; name: string; format: DocFormat; uri: string; mime: string | null; size: number | null;
  sha256: string | null; status: DocStatus; error_code: string | null; error: string | null; warning: string | null;
  page_count: number | null; char_count: number; chunk_count: number;
  created_at: number; updated_at: number; indexed_at: number | null;
};
export type StoredChunk = { id: number; document_id: string; ordinal: number; page: number | null; text: string };

const CREATE: Record<Exclude<FtsEngine, 'none'>, string> = {
  // 'ascii' / 'simple': split only on ASCII separators; our tokens are already lowercase words joined by spaces, and
  // non-ASCII characters (Indian scripts) stay inside tokens.
  fts5: "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(tokens, tokenize = 'ascii')",
  fts4: 'CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts4(tokens, tokenize=simple)',
};

let engineFor: { db: Db; engine: Promise<FtsEngine> } | null = null;

/**
 * The full-text engine in use, creating the index on first use. Cached per database connection.
 * @param candidates engines to try, best first (tests pass ['fts4'] to exercise the FTS4 path)
 */
export function ensureIndex(candidates: Exclude<FtsEngine, 'none'>[] = ['fts5', 'fts4']): Promise<FtsEngine> {
  const current = db();
  if (engineFor?.db !== current) {
    const engine = (async () => {
      await open();
      const saved = (await current.query("SELECT value FROM meta WHERE key = 'fts_engine'"))[0]?.value as FtsEngine | undefined;
      const order = saved && saved !== 'none' ? [saved as Exclude<FtsEngine, 'none'>] : candidates;
      for (const e of order) {
        try {
          const existed = (await current.query("SELECT 1 FROM sqlite_master WHERE name = 'chunks_fts'")).length > 0;
          await current.execute(CREATE[e]);
          await current.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('fts_engine', ?)", [e]);
          const version = (await current.query("SELECT value FROM meta WHERE key = 'tokenizer_version'"))[0]?.value;
          // A lost index table, or tokens made by an older tokenizer (e.g. before M5's normalization): rebuild from
          // the stored passages, so documents imported earlier are searched with today's rules.
          if (!existed || Number(version ?? 1) !== TOKENIZER_VERSION) await rebuildIndex(existed);
          await current.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('tokenizer_version', ?)", [String(TOKENIZER_VERSION)]);
          return e;
        } catch {} // "no such module: fts5": try the next engine
      }
      return 'none' as const;
    })();
    engineFor = { db: current, engine };
    engine.catch(() => { if (engineFor?.engine === engine) engineFor = null; }); // a failed open can be retried
  }
  return engineFor.engine;
}

export const REBUILD_BATCH = 200;

/**
 * Re-create index rows (and word counts) from the stored passages, in bounded batches read page by page (never the
 * whole library in memory). Each batch is one transaction; if the app closes midway, the version stays old and the
 * rebuild simply runs again at the next launch.
 */
async function rebuildIndex(clearFirst: boolean): Promise<void> {
  if (clearFirst) await db().execute('DELETE FROM chunks_fts');
  for (let after = -1; ;) {
    const rows = await db().query(`SELECT id, text FROM chunks WHERE id > ? ORDER BY id LIMIT ${REBUILD_BATCH}`, [after]);
    if (!rows.length) break;
    await db().batch(rows.flatMap(r => {
      const tokens = tokenize(r.text);
      return [
        { sql: 'INSERT OR REPLACE INTO chunks_fts (rowid, tokens) VALUES (?, ?)', params: [Number(r.id), tokens.join(' ')] },
        { sql: 'UPDATE chunks SET word_count = ? WHERE id = ?', params: [tokens.length, Number(r.id)] },
      ];
    }));
    after = Number(rows[rows.length - 1].id);
  }
}

/** Rebuild the keyword index from the stored passages (Storage screen, M8). Documents and passages are unchanged. */
export async function rebuildSearchIndex(): Promise<boolean> {
  if ((await ensureIndex()) === 'none') return false;
  await rebuildIndex(true);
  return true;
}

const row2doc = (r: any): Doc => ({
  ...r, size: r.size == null ? null : Number(r.size), page_count: r.page_count == null ? null : Number(r.page_count),
  char_count: Number(r.char_count), chunk_count: Number(r.chunk_count), created_at: Number(r.created_at),
  updated_at: Number(r.updated_at), indexed_at: r.indexed_at == null ? null : Number(r.indexed_at),
});

/** All documents, most recently changed first. */
export async function listDocuments(): Promise<Doc[]> {
  await open();
  return (await db().query('SELECT * FROM documents ORDER BY updated_at DESC, id')).map(row2doc);
}

export async function getDocument(id: string): Promise<Doc | null> {
  await open();
  const r = (await db().query('SELECT * FROM documents WHERE id = ?', [id]))[0];
  return r ? row2doc(r) : null;
}

export async function findByUri(uri: string): Promise<Doc | null> {
  await open();
  const r = (await db().query('SELECT * FROM documents WHERE uri = ?', [uri]))[0];
  return r ? row2doc(r) : null;
}

/** A document with exactly these bytes, other than `exceptId` (the same file picked from another place). */
export async function findBySha(sha256: string, exceptId: string | null): Promise<Doc | null> {
  await open();
  const r = (await db().query('SELECT * FROM documents WHERE sha256 = ? AND id != ?', [sha256, exceptId ?? '']))[0];
  return r ? row2doc(r) : null;
}

/** A new library entry in status 'indexing' (so an interrupted import is visible and can be retried). */
export async function createDocument(d: { id: string; name: string; format: DocFormat; uri: string; mime: string | null;
  size: number | null; now: number }): Promise<void> {
  await open();
  await db().execute(`INSERT INTO documents (id, name, format, uri, mime, size, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'indexing', ?, ?)`, [d.id, d.name, d.format, d.uri, d.mime, d.size, d.now, d.now]);
}

export async function markIndexing(id: string, now: number): Promise<void> {
  await db().execute("UPDATE documents SET status = 'indexing', error_code = NULL, error = NULL, updated_at = ? WHERE id = ?", [now, id]);
}

/** Back to 'ready' without re-indexing (the file was picked again but its bytes are unchanged). */
export async function restoreReady(id: string, updatedAt: number): Promise<void> {
  await db().execute("UPDATE documents SET status = 'ready', error_code = NULL, error = NULL, updated_at = ? WHERE id = ?", [updatedAt, id]);
}

/** Record a failure. Passages from an earlier successful run stay stored, but search skips documents not 'ready'. */
export async function markFailed(id: string, code: string, message: string, now: number): Promise<void> {
  await db().execute('UPDATE documents SET status = ?, error_code = ?, error = ?, updated_at = ? WHERE id = ?',
    ['failed', code, message, now, id]);
}

/**
 * Replace a document's passages and index rows and mark it ready, all in one transaction: either the new index is
 * complete, or the previous state is untouched.
 */
export async function replaceChunks(id: string, chunks: Chunk[], info: { sha256: string; size: number;
  pageCount: number | null; charCount: number; warning: string | null; now: number }): Promise<void> {
  const engine = await ensureIndex();
  const statements: { sql: string; params?: any[] }[] = [];
  if (engine !== 'none') {
    statements.push({ sql: 'DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)', params: [id] });
  }
  statements.push({ sql: 'DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)', params: [id] });
  statements.push({ sql: 'DELETE FROM chunks WHERE document_id = ?', params: [id] });
  for (const c of chunks) {
    const tokens = tokenize(c.text);
    statements.push({ sql: `INSERT INTO chunks (document_id, ordinal, page, text, token_count, word_count)
      VALUES (?, ?, ?, ?, ?, ?)`, params: [id, c.ordinal, c.page, c.text, c.tokens, tokens.length] });
    if (engine !== 'none') {
      statements.push({ sql: `INSERT INTO chunks_fts (rowid, tokens)
        VALUES ((SELECT id FROM chunks WHERE document_id = ? AND ordinal = ?), ?)`, params: [id, c.ordinal, tokens.join(' ')] });
    }
  }
  statements.push({ sql: `UPDATE documents SET status = 'ready', error_code = NULL, error = NULL, warning = ?, sha256 = ?,
    size = ?, page_count = ?, char_count = ?, chunk_count = ?, updated_at = ?, indexed_at = ? WHERE id = ?`,
  params: [info.warning, info.sha256, info.size, info.pageCount, info.charCount, chunks.length, info.now, info.now, id] });
  await db().batch(statements);
}

/** Remove a document, its passages and its index rows (one transaction). The original file is not touched. */
export async function deleteDocument(id: string): Promise<boolean> {
  const engine = await ensureIndex();
  if (!(await getDocument(id))) return false;
  await db().batch([
    ...(engine !== 'none' ? [{ sql: 'DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)', params: [id] }] : []),
    { sql: 'DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)', params: [id] },
    { sql: 'DELETE FROM chunks WHERE document_id = ?', params: [id] },
    { sql: 'DELETE FROM collection_docs WHERE document_id = ?', params: [id] },
    { sql: 'DELETE FROM documents WHERE id = ?', params: [id] },
  ]);
  return true;
}

/** At launch: imports cut off by the app closing are marked failed (retryable); their old index, if any, is kept. */
export async function recoverInterrupted(now = Date.now()): Promise<number> {
  await open();
  const stuck = await db().query("SELECT id FROM documents WHERE status = 'indexing'");
  for (const r of stuck) {
    await markFailed(r.id, 'interrupted', 'Indexing was interrupted (the app closed). Tap Retry.', now);
  }
  return stuck.length;
}

/** One passage of a document, or null. */
export async function getChunk(documentId: string, ordinal: number): Promise<StoredChunk | null> {
  await open();
  const r = (await db().query('SELECT id, document_id, ordinal, page, text FROM chunks WHERE document_id = ? AND ordinal = ?',
    [documentId, ordinal]))[0];
  return r ? { ...r, id: Number(r.id), ordinal: Number(r.ordinal), page: r.page == null ? null : Number(r.page) } : null;
}

/** Number of passages and index rows (tests and diagnostics: the two must always match). */
export async function counts(): Promise<{ documents: number; chunks: number; indexRows: number }> {
  const engine = await ensureIndex();
  const n = async (sql: string) => Number((await db().query(sql))[0]?.n ?? 0);
  return {
    documents: await n('SELECT COUNT(*) AS n FROM documents'),
    chunks: await n('SELECT COUNT(*) AS n FROM chunks'),
    indexRows: engine === 'none' ? 0 : await n('SELECT COUNT(*) AS n FROM chunks_fts'),
  };
}
