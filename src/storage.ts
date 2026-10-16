/**
 * Storage usage and safe cleanup (M8). Reporting only reads; each cleanup action is separate, explicit, and limited
 * to data the app can rebuild or that the user chose to remove. Nothing here deletes a project file, an imported
 * original, a verified active model, or anything automatically because storage is low.
 *
 * Measurements: the database size (SQLite page count × page size), file sizes (model files, temporary files) and
 * record counts are exact. Per-category sizes inside the database are estimates from the stored text length
 * (characters, not bytes; indexes and page overhead are not included) and are labelled as such.
 */
import * as RNFS from '@dr.pogodin/react-native-fs';
import { db, open } from './chatStore';
import * as local from './localModel';
import * as docStore from './knowledge/docStore';
import { cleanupTemp, tempDir } from './backup/backup';
import { deleteTask } from './code/assistant';
import { deleteProposal } from './code/proposals';

export type UsageItem = { id: string; label: string; records: number; chars: number; note: string };
export type FileItem = { name: string; bytes: number; kind: 'model' | 'incomplete' | 'other' };
export type Report = {
  device: { free: number; total: number };
  databaseBytes: number; // measured
  items: UsageItem[]; // records measured, chars estimated
  models: FileItem[]; // measured
  temp: { files: number; bytes: number }; // measured
  downloading: boolean;
};

const ITEMS: { id: string; label: string; sql: string; note: string }[] = [
  { id: 'chats', label: 'Chats', sql: 'SELECT COUNT(*) AS n, COALESCE(SUM(length(content) + COALESCE(length(meta_json), 0)), 0) AS c FROM messages', note: 'Messages in saved conversations.' },
  { id: 'memories', label: 'Memories', sql: 'SELECT (SELECT COUNT(*) FROM memories) + (SELECT COUNT(*) FROM learned) AS n, (SELECT COALESCE(SUM(length(value)), 0) FROM memories) + (SELECT COALESCE(SUM(length(value)), 0) FROM learned) AS c', note: '' },
  { id: 'documents', label: 'Document text', sql: 'SELECT COUNT(*) AS n, COALESCE(SUM(length(text)), 0) AS c FROM chunks', note: 'Extracted passages of imported documents (the original files are elsewhere and not counted).' },
  { id: 'vectors', label: 'Meaning-search vectors', sql: 'SELECT COUNT(*) AS n, COALESCE(SUM(length(vector)), 0) AS c FROM chunk_vectors', note: 'Rebuildable.' },
  { id: 'runs', label: 'Agent, skill and workflow history', sql: 'SELECT (SELECT COUNT(*) FROM agent_runs) AS n, (SELECT COALESCE(SUM(length(task) + COALESCE(length(final_text), 0)), 0) FROM agent_runs) + (SELECT COALESCE(SUM(COALESCE(length(output_json), 0) + length(input_json)), 0) FROM agent_steps) AS c', note: '' },
  { id: 'definitions', label: 'Agents, skills and workflows', sql: 'SELECT (SELECT COUNT(*) FROM agents) + (SELECT COUNT(*) FROM skills) + (SELECT COUNT(*) FROM workflows) AS n, (SELECT COALESCE(SUM(length(def_json)), 0) FROM skills) + (SELECT COALESCE(SUM(length(def_json)), 0) FROM workflows) AS c', note: '' },
  { id: 'workspaces', label: 'Code workspaces (listings)', sql: 'SELECT COUNT(*) AS n, COALESCE(SUM(length(path) + length(uri)), 0) AS c FROM code_entries', note: 'File lists only; project files are not stored in the app.' },
  { id: 'codingHistory', label: 'Coding tasks', sql: 'SELECT COUNT(*) AS n, COALESCE(SUM(length(question) + COALESCE(length(answer_json), 0) + COALESCE(length(inspected_json), 0)), 0) AS c FROM code_turns', note: '' },
  { id: 'proposals', label: 'Code proposals (with saved file texts)', sql: 'SELECT COUNT(DISTINCT proposal_id) AS n, COALESCE(SUM(COALESCE(length(original_text), 0) + length(proposed_text)), 0) AS c FROM code_proposal_files', note: 'May contain source code and secrets it holds.' },
];

const modelsDir = () => `${RNFS.DocumentDirectoryPath}/models`;

/** What the app stores, measured where possible (see the module comment for which numbers are estimates). */
export async function storageReport(): Promise<Report> {
  await open();
  const fs = await RNFS.getFSInfo();
  const page = (await db().query('PRAGMA page_count'))[0];
  const size = (await db().query('PRAGMA page_size'))[0];
  const databaseBytes = Number(Object.values(page ?? { n: 0 })[0]) * Number(Object.values(size ?? { n: 0 })[0]);
  const items: UsageItem[] = [];
  for (const it of ITEMS) {
    const r = (await db().query(it.sql))[0];
    items.push({ id: it.id, label: it.label, records: Number(r?.n ?? 0), chars: Number(r?.c ?? 0), note: it.note });
  }
  const models: FileItem[] = (await RNFS.exists(modelsDir())) ? (await RNFS.readDir(modelsDir())).filter(f => f.isFile()).map(f => ({
    name: f.name, bytes: Number(f.size), kind: f.name.endsWith('.part') ? 'incomplete' : f.name.endsWith('.gguf') ? 'model' : 'other',
  })) : [];
  let temp = { files: 0, bytes: 0 };
  if (await RNFS.exists(tempDir())) {
    const files = (await RNFS.readDir(tempDir())).filter(f => f.isFile());
    temp = { files: files.length, bytes: files.reduce((n, f) => n + Number(f.size), 0) };
  }
  const st = local.getState().state;
  return { device: { free: fs.freeSpace, total: fs.totalSpace }, databaseBytes, items, models, temp, downloading: st === 'downloading' || st === 'verifying' };
}

// ---------------------------------------------------------------- cleanup actions (each explicit)

/** Remove meaning-search vectors (rebuilt in the background if meaning search is on). @returns rows removed */
export async function removeVectors(): Promise<number> {
  await open();
  const n = Number((await db().query('SELECT COUNT(*) AS n FROM chunk_vectors'))[0].n);
  await db().execute('DELETE FROM chunk_vectors');
  return n;
}

/** Rebuild the keyword index from the stored passages (nothing is lost). */
export const rebuildKeywordIndex = () => docStore.rebuildSearchIndex();

/** Remove abandoned backup/restore temporary files (files in use are kept). */
export const removeTempFiles = () => cleanupTemp(0);

/**
 * Remove incomplete model downloads (*.part). Refused while a download is running; verified models are never touched.
 * @returns files removed
 */
export async function removeIncompleteDownloads(): Promise<number> {
  const st = local.getState().state;
  if (st === 'downloading' || st === 'verifying') throw new Error('A model download is running; its partial file is in use.');
  if (!(await RNFS.exists(modelsDir()))) return 0;
  let n = 0;
  for (const f of await RNFS.readDir(modelsDir())) {
    if (f.isFile() && f.name.endsWith('.part')) { await RNFS.unlink(f.path); n++; }
  }
  return n;
}

const FINISHED = "status NOT IN ('ready', 'applying')";

/**
 * Delete finished code proposals (applied, partial, failed, stale, rejected, interrupted) and their saved file texts,
 * optionally only those older than `days`. Proposals waiting for review or being applied are kept.
 * Deletion is logical: SQLite marks the space free and reuses it; it is not a secure erase of the storage chip.
 */
export async function deleteFinishedProposals(days: number | null = null, now = Date.now()): Promise<number> {
  await open();
  const rows = await db().query(`SELECT id FROM code_proposals WHERE ${FINISHED}${days === null ? '' : ' AND updated_at < ?'}`, days === null ? [] : [now - days * 86_400_000]);
  for (const r of rows) await deleteProposal(r.id);
  return rows.length;
}

export type Retention = 'off' | '7' | '30';
export async function getProposalRetention(): Promise<Retention> {
  await open();
  const v = (await db().query("SELECT value FROM meta WHERE key = 'proposal_retention_days'"))[0]?.value;
  return v === '7' || v === '30' ? v : 'off';
}
export async function setProposalRetention(v: Retention): Promise<void> {
  await open();
  await db().execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('proposal_retention_days', ?)", [v]);
}
/** At launch, if the user chose a retention period: delete finished proposals older than it. @returns how many */
export async function applyProposalRetention(now = Date.now()): Promise<number> {
  const r = await getProposalRetention();
  return r === 'off' ? 0 : deleteFinishedProposals(Number(r), now);
}

/** Delete all coding tasks (questions and answers) of every workspace; proposals and project files stay. */
export async function deleteAllCodingHistory(): Promise<number> {
  await open();
  const rows = await db().query('SELECT id FROM code_tasks');
  for (const r of rows) await deleteTask(r.id);
  return rows.length;
}

// ---------------------------------------------------------------- integrity

const ORPHANS: { label: string; where: string; table: string }[] = [
  { label: 'messages without a conversation', table: 'messages', where: 'conversation_id NOT IN (SELECT id FROM conversations)' },
  { label: 'passages without a document', table: 'chunks', where: 'document_id NOT IN (SELECT id FROM documents)' },
  { label: 'vectors without a passage', table: 'chunk_vectors', where: 'chunk_id NOT IN (SELECT id FROM chunks)' },
  { label: 'run steps without a run', table: 'agent_steps', where: 'run_id NOT IN (SELECT id FROM agent_runs)' },
  { label: 'workspace listings without a workspace', table: 'code_entries', where: 'workspace_id NOT IN (SELECT id FROM code_workspaces)' },
  { label: 'coding turns without a task', table: 'code_turns', where: 'task_id NOT IN (SELECT id FROM code_tasks)' },
  { label: 'proposal files without a proposal', table: 'code_proposal_files', where: 'proposal_id NOT IN (SELECT id FROM code_proposals)' },
];

/**
 * Check the database: SQLite's quick_check plus records that point at something that no longer exists. Read-only:
 * problems are reported, never repaired automatically.
 */
export async function checkDatabase(): Promise<{ sqlite: string; orphans: { label: string; count: number }[] }> {
  await open();
  let sqlite: string;
  try {
    const msgs = (await db().query('PRAGMA quick_check')).map((r: any) => String(Object.values(r)[0]));
    sqlite = msgs.length === 1 && msgs[0] === 'ok' ? 'ok' : msgs.slice(0, 5).join('; ');
  } catch (e: any) { sqlite = `not available (${String(e?.message ?? e).slice(0, 80)})`; }
  const orphans = [];
  for (const o of ORPHANS) orphans.push({ label: o.label, count: Number((await db().query(`SELECT COUNT(*) AS n FROM ${o.table} WHERE ${o.where}`))[0].n) });
  return { sqlite, orphans: orphans.filter(o => o.count > 0) };
}

/** Remove the orphaned records checkDatabase found (explicit action; they are unreachable from the app). @returns removed */
export async function removeOrphans(): Promise<number> {
  await open();
  let n = 0;
  for (const o of ORPHANS) n += Number((await db().query(`SELECT COUNT(*) AS n FROM ${o.table} WHERE ${o.where}`))[0].n);
  const fts = (await db().query("SELECT 1 FROM sqlite_master WHERE name = 'chunks_fts'")).length > 0;
  await db().batch([
    ...(fts ? [{ sql: `DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE ${ORPHANS[1].where})` }] : []),
    ...ORPHANS.map(o => ({ sql: `DELETE FROM ${o.table} WHERE ${o.where}` })),
  ]);
  return n;
}
