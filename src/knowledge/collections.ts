/**
 * Named document collections (M11): a saved set of documents ("Insurance", "Course notes") that Docs mode and agent
 * tasks can be limited to. Membership only: deleting a collection never deletes a document, and deleting a document
 * removes it from every collection (foreign keys, plus an explicit delete in docStore.deleteDocument).
 */
import { db, newId, open } from '../chatStore';

export type Collection = { id: string; name: string; documentIds: string[] };

export class CollectionError extends Error {}

export async function listCollections(): Promise<Collection[]> {
  await open();
  const rows = await db().query('SELECT c.id, c.name, d.document_id FROM collections c LEFT JOIN collection_docs d ON d.collection_id = c.id ORDER BY c.name COLLATE NOCASE');
  const out = new Map<string, Collection>();
  for (const r of rows) {
    const c: Collection = out.get(r.id) ?? { id: r.id, name: r.name, documentIds: [] };
    if (r.document_id) c.documentIds.push(String(r.document_id));
    out.set(r.id, c);
  }
  return [...out.values()];
}

/**
 * Create or replace a collection by name (case-insensitive) with exactly these documents.
 * @throws CollectionError for an empty/too long name or no documents
 */
export async function saveCollection(name: string, documentIds: string[], now = Date.now()): Promise<Collection> {
  await open();
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n || n.length > 40) throw new CollectionError('Give the collection a name of at most 40 characters.');
  const ids = [...new Set(documentIds)];
  if (!ids.length) throw new CollectionError('Select at least one document.');
  const existing = (await db().query('SELECT id FROM collections WHERE name = ? COLLATE NOCASE', [n]))[0];
  const id = existing?.id ?? newId();
  await db().batch([
    existing ? { sql: 'UPDATE collections SET name = ?, updated_at = ? WHERE id = ?', params: [n, now, id] }
      : { sql: 'INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', params: [id, n, now, now] },
    { sql: 'DELETE FROM collection_docs WHERE collection_id = ?', params: [id] },
    // Only documents that exist (a stale id is dropped, not an error).
    ...ids.map(d => ({ sql: 'INSERT INTO collection_docs (collection_id, document_id) SELECT ?, id FROM documents WHERE id = ?', params: [id, d] })),
  ]);
  return (await listCollections()).find(c => c.id === id)!;
}

/** Delete a collection (its documents stay in the library). */
export async function deleteCollection(id: string): Promise<void> {
  await open();
  await db().batch([{ sql: 'DELETE FROM collection_docs WHERE collection_id = ?', params: [id] }, { sql: 'DELETE FROM collections WHERE id = ?', params: [id] }]);
}
