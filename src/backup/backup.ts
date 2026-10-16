/**
 * Creating an encrypted backup: the selected categories are read page by page, written as JSON lines into encrypted
 * chunks of a private temporary file (never the whole backup in memory), the finished file is read back and every
 * chunk authenticated, and only then copied to the place the user picks (where AiDocsModule verifies the copy by
 * SHA-256). A cancelled or failed backup leaves no file presented as a backup: its temporary file is deleted, and a
 * failed or mismatching destination copy is removed.
 */
import { NativeModules } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { newId, open, SCHEMA_VERSION } from '../chatStore';
import { CATEGORIES, category, EXCLUDED, forEachRow, measure, type CategoryId } from './categories';
import { BackupError, ContainerWriter, DEFAULT_ITERATIONS, headerText, LIMITS, readChunks, readHeader, type Signal } from './format';
import * as crypto from './crypto';

export const PAYLOAD_VERSION = 1;
export const MIN_PASSWORD = 10;
export const tempDir = () => `${RNFS.CachesDirectoryPath}/backup`;
/** Temporary files in use right now (cleanup never touches them). */
export const activeTemp = new Set<string>();

export type Manifest = {
  type: 'manifest'; payloadVersion: number; appSchema: number; createdAt: number;
  categories: { id: CategoryId; records: number }[]; excluded: string[];
};

/** Problems with a new backup password (empty = acceptable). */
export function checkPassword(password: string, confirm: string): string[] {
  const out: string[] = [];
  if (password.length < MIN_PASSWORD) out.push(`Use at least ${MIN_PASSWORD} characters.`);
  if (password !== confirm) out.push('The two passwords are different.');
  return out;
}

/** Selected categories plus anything they require (document text needs the document list). */
export function withRequirements(ids: CategoryId[]): CategoryId[] {
  const set = new Set(ids);
  for (const id of ids) { const r = category(id)?.requires; if (r) set.add(r); }
  return CATEGORIES.map(c => c.id).filter(id => set.has(id));
}

/** Records and an estimated size (bytes, labelled as an estimate) for a selection. */
export async function estimate(ids: CategoryId[]): Promise<{ categories: { id: CategoryId; records: number }[]; bytes: number }> {
  await open();
  const cats = [];
  let chars = 0;
  for (const id of withRequirements(ids)) {
    const m = await measure(id);
    cats.push({ id, records: m.records });
    chars += m.chars;
  }
  return { categories: cats, bytes: Math.round(chars * 1.4 + 4096) }; // base64 + tags + header
}

/**
 * Write and verify a backup of `ids` in the private cache.
 * @returns the temporary file (pass it to saveBackup, then it is deleted) and what it contains
 * @throws BackupError: password, low_storage, storage, cancelled, unavailable / unsupported (no encryption: no backup)
 */
export async function createBackup(ids: CategoryId[], password: string, confirm: string, opts: {
  signal?: Signal; onProgress?: (note: string) => void; iterations?: number; now?: number;
} = {}): Promise<{ path: string; bytes: number; manifest: Manifest }> {
  const problems = checkPassword(password, confirm);
  if (problems.length) throw new BackupError('password', problems.join(' '));
  const chosen = withRequirements(ids);
  if (!chosen.length) throw new BackupError('invalid', 'Choose at least one category.');
  const est = await estimate(chosen);
  const free = (await RNFS.getFSInfo()).freeSpace;
  if (free < est.bytes * 1.5 + 50e6) {
    throw new BackupError('low_storage', `Not enough free storage for this backup (about ${Math.ceil(est.bytes / 1e6)} MB plus a safety margin). Free some space or choose fewer categories.`);
  }
  await RNFS.mkdir(tempDir());
  const path = `${tempDir()}/b-${newId()}.part`;
  activeTemp.add(path);
  let writer: ContainerWriter | null = null;
  try {
    opts.onProgress?.('Deriving the encryption key…');
    writer = await ContainerWriter.create(path, password, opts.iterations ?? DEFAULT_ITERATIONS);
    const manifest: Manifest = { type: 'manifest', payloadVersion: PAYLOAD_VERSION, appSchema: SCHEMA_VERSION, createdAt: opts.now ?? Date.now(),
      categories: est.categories, excluded: EXCLUDED.map(e => e.what) };
    let chunk = `${JSON.stringify(manifest)}\n`;
    const push = async (line: string) => {
      if (opts.signal?.cancelled) throw new BackupError('cancelled', 'Backup cancelled; nothing was saved.');
      if (chunk.length + line.length + 1 > LIMITS.maxChunkChars) { await writer!.add(chunk); chunk = ''; }
      if (line.length + 1 > LIMITS.maxChunkChars) throw new BackupError('too_large', 'A record is too large for a backup.');
      chunk += `${line}\n`;
    };
    let total = 0;
    for (const id of chosen) {
      opts.onProgress?.(`Backing up ${category(id)!.label.toLowerCase()}…`);
      for (const table of category(id)!.tables) {
        await forEachRow(table, async rows => {
          for (const row of rows) { await push(JSON.stringify({ type: 'row', cat: id, table, row })); total++; }
        });
      }
    }
    await push(JSON.stringify({ type: 'end', records: total }));
    await writer.add(chunk);
    await writer.finish();
    opts.onProgress?.('Checking the finished backup…');
    await verifyBackup(path, writer, total, opts.signal);
    writer.close();
    writer = null;
    return { path, bytes: Number((await RNFS.stat(path)).size), manifest };
  } catch (e) {
    writer?.close();
    activeTemp.delete(path);
    await RNFS.unlink(path).catch(() => undefined);
    if (e instanceof crypto.CryptoError && (e.code === 'unavailable' || e.code === 'unsupported')) throw new BackupError(e.code, e.message);
    throw e;
  }
}

/**
 * Read the finished file back: its header must be exactly the one the key was derived for, every chunk must
 * authenticate, and the record count must match. Uses the writer's key, so PBKDF2 runs once per backup, not twice
 * (password → key derivation itself is covered by the native and cross-implementation tests).
 */
async function verifyBackup(path: string, writer: ContainerWriter, records: number, signal?: Signal) {
  const opened = writer.opened();
  if (headerText(await readHeader(path)) !== headerText(opened.header)) throw new BackupError('storage', 'The backup could not be verified after writing; nothing was saved.');
  let rows = -1;
  await readChunks(path, opened, async text => {
    for (const line of text.split('\n')) if (line) { const r = JSON.parse(line); if (r.type === 'end') rows = r.records; }
  }, signal);
  if (rows !== records) throw new BackupError('storage', 'The backup could not be verified after writing; nothing was saved.');
}

/**
 * Copy a finished backup to a NEW file the user places (Android's save picker), verified by SHA-256 natively; then
 * delete the temporary file. Resolves null when the user cancels (the temporary file is deleted too).
 */
export async function saveBackup(path: string, name = `local-ai-backup-${new Date().toISOString().slice(0, 10)}.laibackup`): Promise<{ name: string; size: number } | null> {
  try {
    const m = NativeModules.AiDocs;
    if (!m?.saveCopy) throw new BackupError('unavailable', 'Saving backups is not available in this build.');
    try {
      return await m.saveCopy(path, name);
    } catch (e: any) {
      throw new BackupError('destination', e?.code === 'verify_failed' ? 'The saved copy did not match the backup, so it was removed. Try another location.'
        : `The backup could not be saved there: ${String(e?.message ?? e)}`);
    }
  } finally {
    activeTemp.delete(path);
    await RNFS.unlink(path).catch(() => undefined);
  }
}

/** Throw away a finished backup that the user decided not to save. */
export async function discardBackup(path: string): Promise<void> {
  activeTemp.delete(path);
  await RNFS.unlink(path).catch(() => undefined);
}

/**
 * Delete abandoned backup/restore temporary files (older than `olderThanMs`, not in use).
 * @returns how many files and bytes were removed
 */
export async function cleanupTemp(olderThanMs = 60 * 60 * 1000, now = Date.now()): Promise<{ files: number; bytes: number }> {
  if (!(await RNFS.exists(tempDir()))) return { files: 0, bytes: 0 };
  let files = 0, bytes = 0;
  for (const f of await RNFS.readDir(tempDir())) {
    if (activeTemp.has(f.path) || !f.isFile()) continue;
    const age = now - (f.mtime ? new Date(f.mtime).getTime() : 0);
    if (olderThanMs > 0 && age < olderThanMs) continue;
    await RNFS.unlink(f.path).catch(() => undefined);
    files++;
    bytes += Number(f.size);
  }
  return { files, bytes };
}
