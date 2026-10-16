/**
 * Registered project workspaces (schema v8): a folder the user picked (scanned into a listing of names and document
 * URIs) or a set of picked files. Only metadata is stored; file contents are read on demand, bounded, and never kept
 * in the database except inside change proposals (src/code/proposals.ts).
 *
 * Removing a workspace deletes its listing, coding tasks and proposals from the app and gives up the storage grant;
 * the project files themselves are never touched. Chats, documents, models, agents, skills and workflows are separate
 * tables and are not affected.
 */
import { db, newId, open } from '../chatStore';
import { isIgnoredDir, isSecretFile, languageOf, LIMITS, looksBinary, redactSecrets } from './files';
import * as native from './native';
import { WorkspaceError, type DocInfo, type Picked } from './native';
import { baseName, samePath } from './paths';

export type WorkspaceKind = 'folder' | 'files';
export type Workspace = {
  id: string; name: string; kind: WorkspaceKind; treeUri: string; rootUri: string; canWrite: boolean;
  scannedAt: number | null; entryCount: number; truncated: boolean; createdAt: number;
};
/** One listed file or folder; path '' is the workspace root folder. */
export type Entry = { path: string; uri: string; treeUri: string; dir: boolean; size: number; modified: number; canWrite: boolean; canCreate: boolean };
export type SourceFile = { path: string; text: string; sha256: string; bytes: number; language: string; redactions: number; lossy: boolean };

const row2ws = (r: any): Workspace => ({
  id: r.id, name: r.name, kind: r.kind, treeUri: r.tree_uri, rootUri: r.root_uri, canWrite: Number(r.can_write) === 1,
  scannedAt: r.scanned_at == null ? null : Number(r.scanned_at), entryCount: Number(r.entry_count ?? 0), truncated: Number(r.truncated) === 1,
  createdAt: Number(r.created_at),
});
const row2entry = (r: any): Entry => ({
  path: r.path, uri: r.uri, treeUri: r.tree_uri, dir: Number(r.dir) === 1, size: Number(r.size ?? -1), modified: Number(r.modified ?? 0),
  canWrite: Number(r.can_write) === 1, canCreate: Number(r.can_create) === 1,
});

// ---------------------------------------------------------------- one operation per workspace

const running = new Map<string, string>();
/**
 * Run `work` as the only scan/question/proposal/apply on this workspace; a second one is refused (not queued), so two
 * operations can never interleave writes to the listing or to a proposal.
 * @throws WorkspaceError('busy') naming the operation already running
 */
export async function exclusive<T>(workspaceId: string, what: string, work: () => Promise<T>): Promise<T> {
  const other = running.get(workspaceId);
  if (other) throw new WorkspaceError('busy', `Wait until "${other}" finishes in this workspace.`);
  running.set(workspaceId, what);
  try { return await work(); } finally { running.delete(workspaceId); }
}
export const busyWith = (workspaceId: string) => running.get(workspaceId) ?? null;

/** A plain-language explanation of a storage error, with what the user can do about it. */
export function explain(e: unknown): string {
  const code = e instanceof WorkspaceError ? e.code : null;
  const msg = String((e as any)?.message ?? e);
  switch (code) {
    case 'revoked': return 'Access to this workspace was removed (for example in Android settings). Remove the workspace and add the folder again.';
    case 'not_found': return 'This file or folder can no longer be opened: it may have been moved or deleted, or its storage is unavailable. Refresh the workspace.';
    case 'unsupported': return `${msg}. The app does not work around storage-provider limits with wider storage access.`;
    case 'too_large': return `This file is larger than ${LIMITS.maxFileBytes / 1000} KB; the assistant does not read it.`;
    case 'unavailable': return 'Project workspaces are not available in this build.';
    default: return msg;
  }
}

// ---------------------------------------------------------------- registration

function checkName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n) throw new WorkspaceError('read_failed', 'Give the workspace a name.');
  if (n.length > 60) throw new WorkspaceError('read_failed', 'The name must be at most 60 characters.');
  return n;
}

/** Register a picked folder (nothing is read yet; call scan()). Rejects a folder that is already registered. */
export async function registerFolder(name: string, picked: Picked, now = Date.now()): Promise<Workspace> {
  await open();
  const n = checkName(name);
  const dup = (await db().query('SELECT name FROM code_workspaces WHERE tree_uri = ?', [picked.treeUri]))[0];
  if (dup) throw new WorkspaceError('exists', `This folder is already registered as "${dup.name}".`);
  const id = newId();
  await db().execute(`INSERT INTO code_workspaces (id, name, kind, tree_uri, root_uri, can_write, created_at, updated_at)
    VALUES (?, ?, 'folder', ?, ?, ?, ?, ?)`, [id, n, picked.treeUri, picked.uri, picked.granted_write ? 1 : 0, now, now]);
  return (await getWorkspace(id))!;
}

/** Register individually picked files as one workspace (files keep their own grants; no folder, so no new files). */
export async function registerFiles(name: string, picked: Picked[], now = Date.now()): Promise<Workspace> {
  await open();
  const n = checkName(name);
  if (!picked.length) throw new WorkspaceError('read_failed', 'No files were picked.');
  const names = new Set<string>();
  for (const p of picked) {
    if (names.has(p.name.toLowerCase())) throw new WorkspaceError('exists', `Two picked files are both named "${p.name}"; pick them in separate workspaces.`);
    names.add(p.name.toLowerCase());
  }
  const id = newId();
  await db().batch([
    { sql: `INSERT INTO code_workspaces (id, name, kind, tree_uri, root_uri, can_write, scanned_at, entry_count, created_at, updated_at)
      VALUES (?, ?, 'files', '', '', ?, ?, ?, ?, ?)`, params: [id, n, picked.every(p => p.granted_write) ? 1 : 0, now, picked.length, now, now] },
    ...picked.map(p => ({ sql: `INSERT INTO code_entries (workspace_id, path, uri, tree_uri, dir, size, modified, can_write, can_create)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0)`, params: [id, p.name, p.uri, p.treeUri, p.size, p.modified, p.granted_write && p.canWrite ? 1 : 0] })),
  ]);
  return (await getWorkspace(id))!;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  await open();
  return (await db().query('SELECT * FROM code_workspaces ORDER BY name COLLATE NOCASE')).map(row2ws);
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  await open();
  const r = (await db().query('SELECT * FROM code_workspaces WHERE id = ?', [id]))[0];
  return r ? row2ws(r) : null;
}

export async function renameWorkspace(id: string, name: string): Promise<void> {
  await open();
  await db().execute('UPDATE code_workspaces SET name = ?, updated_at = ? WHERE id = ?', [checkName(name), Date.now(), id]);
}

/**
 * Remove a workspace from the app: its listing, coding tasks, proposals (and their saved originals) in one transaction,
 * then give up the storage grant. The project's files are not touched.
 * @returns false if there was no such workspace
 */
export async function removeWorkspace(id: string): Promise<boolean> {
  const ws = await getWorkspace(id);
  if (!ws) return false;
  if (running.has(id)) throw new WorkspaceError('busy', `Wait until "${running.get(id)}" finishes before removing this workspace.`);
  const grants = ws.kind === 'folder' ? [ws.treeUri] : (await entries(id)).map(e => e.treeUri);
  await db().batch([
    { sql: 'DELETE FROM code_turns WHERE task_id IN (SELECT id FROM code_tasks WHERE workspace_id = ?)', params: [id] },
    { sql: 'DELETE FROM code_tasks WHERE workspace_id = ?', params: [id] },
    { sql: 'DELETE FROM code_proposal_files WHERE proposal_id IN (SELECT id FROM code_proposals WHERE workspace_id = ?)', params: [id] },
    { sql: 'DELETE FROM code_proposals WHERE workspace_id = ?', params: [id] },
    { sql: 'DELETE FROM code_entries WHERE workspace_id = ?', params: [id] },
    { sql: 'DELETE FROM code_workspaces WHERE id = ?', params: [id] },
  ]);
  // Another workspace may hold the same grant (the same file picked twice): keep it then.
  const still = new Set((await db().query('SELECT tree_uri FROM code_workspaces UNION SELECT tree_uri FROM code_entries')).map((r: any) => r.tree_uri));
  grants.filter(g => g && !still.has(g)).forEach(native.release);
  return true;
}

/** What the app can still do in this workspace (a user can revoke access in Android settings at any time). */
export async function checkAccess(ws: Workspace): Promise<{ read: boolean; write: boolean }> {
  if (ws.kind === 'folder') return native.access(ws.treeUri);
  const all = await Promise.all((await entries(ws.id)).map(e => native.access(e.treeUri)));
  return { read: all.length > 0 && all.every(a => a.read), write: all.length > 0 && all.every(a => a.write) };
}

// ---------------------------------------------------------------- listing

export type ScanProgress = { listed: number; folder: string };
export type Signal = { cancelled: boolean };

/**
 * List the workspace (breadth-first, through the storage provider), skipping dependency/output folders and stopping at
 * LIMITS.maxEntries / maxScanDepth, then replace the stored listing in one transaction. A cancelled scan stores
 * nothing (the previous listing stays).
 * @returns how many entries were stored and whether the listing was cut off at a limit
 */
export async function scan(ws: Workspace, opts: { signal?: Signal; onProgress?: (p: ScanProgress) => void } = {}, now = Date.now()): Promise<{ count: number; truncated: boolean }> {
  return exclusive(ws.id, 'Refresh', async () => {
    if (ws.kind === 'files') return refreshFiles(ws, now);
    const out: Entry[] = [{ path: '', uri: ws.rootUri, treeUri: ws.treeUri, dir: true, size: -1, modified: 0, canWrite: false, canCreate: true }];
    const queue: { uri: string; path: string; depth: number }[] = [{ uri: ws.rootUri, path: '', depth: 0 }];
    let truncated = false;
    while (queue.length) {
      if (opts.signal?.cancelled) throw new WorkspaceError('cancelled', 'Refresh cancelled; the previous listing is kept.');
      const dir = queue.shift()!;
      opts.onProgress?.({ listed: out.length, folder: dir.path || '/' });
      let children: DocInfo[];
      try {
        children = await native.list(dir.uri);
      } catch (e) {
        if (!dir.path) throw e; // the root itself
        continue; // a sub-folder the provider can't list: leave it out, keep the rest
      }
      for (const c of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= LIMITS.maxEntries) { truncated = true; break; }
        if (!c.name || c.name.includes('/')) continue; // a provider name that can't be a path segment
        const path = dir.path ? `${dir.path}/${c.name}` : c.name;
        if (c.dir) {
          if (isIgnoredDir(c.name) || (c.name.startsWith('.') && c.name !== '.github')) continue;
          if (dir.depth + 1 > LIMITS.maxScanDepth) { truncated = true; continue; }
          queue.push({ uri: c.uri, path, depth: dir.depth + 1 });
        }
        out.push({ path, uri: c.uri, treeUri: ws.treeUri, dir: c.dir, size: c.size, modified: c.modified, canWrite: c.canWrite, canCreate: c.canCreate });
      }
      if (truncated) break;
    }
    if (opts.signal?.cancelled) throw new WorkspaceError('cancelled', 'Refresh cancelled; the previous listing is kept.');
    await db().batch([
      { sql: 'DELETE FROM code_entries WHERE workspace_id = ?', params: [ws.id] },
      ...out.map(e => ({ sql: `INSERT OR REPLACE INTO code_entries (workspace_id, path, uri, tree_uri, dir, size, modified, can_write, can_create)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, params: [ws.id, e.path, e.uri, e.treeUri, e.dir ? 1 : 0, e.size, e.modified, e.canWrite ? 1 : 0, e.canCreate ? 1 : 0] })),
      { sql: 'UPDATE code_workspaces SET scanned_at = ?, entry_count = ?, truncated = ?, updated_at = ? WHERE id = ?',
        params: [now, out.length - 1, truncated ? 1 : 0, now, ws.id] },
    ]);
    return { count: out.length - 1, truncated };
  });
}

/** A file workspace has no folder to list: check each picked file still opens and record what changed. */
async function refreshFiles(ws: Workspace, now: number) {
  const list = await entries(ws.id);
  let missing = 0;
  for (const e of list) {
    const ok = await native.access(e.treeUri).then(a => a.read, () => false);
    if (!ok) missing++;
  }
  await db().execute('UPDATE code_workspaces SET scanned_at = ?, updated_at = ? WHERE id = ?', [now, now, ws.id]);
  if (missing) throw new WorkspaceError('revoked', `${missing} of the picked files can no longer be opened`);
  return { count: list.length, truncated: false };
}

/** The stored listing (no contents), by path. */
export async function entries(workspaceId: string): Promise<Entry[]> {
  await open();
  return (await db().query('SELECT * FROM code_entries WHERE workspace_id = ? ORDER BY path', [workspaceId])).map(row2entry);
}

/** The listed file or folder at this path (case-insensitive, like many providers), or null. */
export async function entry(workspaceId: string, path: string): Promise<Entry | null> {
  await open();
  const rows = (await db().query('SELECT * FROM code_entries WHERE workspace_id = ? AND lower(path) = lower(?)', [workspaceId, path])).map(row2entry);
  return rows.find(r => r.path === path) ?? rows.find(r => samePath(r.path, path)) ?? null;
}

/** Why the assistant won't read this file, or null if it may. */
export function unreadableReason(e: Pick<Entry, 'path' | 'dir' | 'size'>): string | null {
  if (e.dir) return 'it is a folder';
  if (isSecretFile(e.path)) return 'files like this usually hold secrets, so the assistant does not read them';
  if (!languageOf(baseName(e.path))) return 'not a supported text or source file';
  if (e.size > LIMITS.maxFileBytes) return `larger than ${LIMITS.maxFileBytes / 1000} KB`;
  return null;
}

/**
 * Read one listed file as bounded text, with recognizable secrets redacted (unless `raw`, which only proposal
 * validation and application use, to compare and change the real content).
 * @throws WorkspaceError: not_found (not listed / gone / access removed), unsupported (type, secrets, binary), too_large
 */
export async function readFile(ws: Workspace, path: string, opts: { raw?: boolean } = {}): Promise<SourceFile> {
  const e = await entry(ws.id, path);
  if (!e) throw new WorkspaceError('not_found', `"${path}" is not in this workspace's listing`);
  const why = unreadableReason(e);
  if (why) throw new WorkspaceError(e.size > LIMITS.maxFileBytes ? 'too_large' : 'unsupported', `"${e.path}": ${why}`);
  const r = await native.readText(e.uri, LIMITS.maxFileBytes);
  if (looksBinary(r.text, r.lossy)) throw new WorkspaceError('unsupported', `"${e.path}" looks like a binary file`);
  const language = languageOf(baseName(e.path))!;
  if (opts.raw) return { path: e.path, text: r.text, sha256: r.sha256, bytes: r.bytes, language, redactions: 0, lossy: r.lossy };
  const red = redactSecrets(r.text);
  return { path: e.path, text: red.text, sha256: r.sha256, bytes: r.bytes, language, redactions: red.count, lossy: r.lossy };
}
