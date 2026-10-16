/**
 * Restoring from an encrypted backup, in stages that never touch live data until the user confirms:
 *
 * 1. pickBackup(): the chosen file is copied into private storage (bounded size) — the original is only read.
 * 2. inspect(): header checked, key derived, EVERY chunk decrypted and authenticated, every record validated, and each
 *    category compared with the current data (new / duplicate / conflict / invalid). Read-only: a wrong password,
 *    tampering or a malformed file stops here with no change to the database.
 * 3. applyRestore(): the backup is authenticated again while it is read, and each chosen category is applied in ONE
 *    SQLite transaction (merge or, if confirmed, replace). Categories are independent transactions: the restore as a
 *    whole is not atomic, so a journal row records each category's outcome, and a restore cut off by the app closing is
 *    shown as interrupted at the next launch (completed categories stay; merging the rest again is safe, because
 *    merge skips what is already there). Document text is added one document per transaction afterwards.
 * Nothing in a backup is ever executed or used as a file path. The password and decrypted data are never journaled.
 */
import { NativeModules } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { db, newId, open } from '../chatStore';
import * as docStore from '../knowledge/docStore';
import { activeTemp, tempDir, type Manifest } from './backup';
import { CATEGORIES, category, type CategoryId } from './categories';
import * as crypto from './crypto';
import { BackupError, LIMITS, openContainer, type Opened, type Signal } from './format';
import { decide, type Mode, type OnConflict, type Stats } from './merge';
import { readPayload, TOO_LARGE } from './payload';

export type CategoryPlan = {
  id: CategoryId; label: string; inBackup: boolean; records: number; stats: Stats | null; errors: string[]; notes: string[];
  restorable: boolean; canReplace: boolean; sensitive?: string;
};
export type Plan = { path: string; opened: Opened; manifest: Manifest; categories: CategoryPlan[]; docsWithText: string[] };
export type Choice = { id: CategoryId; mode: Mode; onConflict: OnConflict };
export type CategoryResult = { id: CategoryId; mode: Mode; status: 'done' | 'failed' | 'cancelled'; stats: Stats | null; notes: string[]; error: string | null };
export type Summary = { journalId: string; status: 'done' | 'partial' | 'failed'; categories: CategoryResult[]; integrity: string; notes: string[] };

let restoring = false;

/** Let the user pick a backup file; it is copied into private storage. Resolves the private path, or null if cancelled. */
export async function pickBackup(): Promise<string | null> {
  const m = NativeModules.AiDocs;
  if (!m?.openCopy) throw new BackupError('unavailable', 'Restoring backups is not available in this build.');
  await RNFS.mkdir(tempDir());
  const path = `${tempDir()}/r-${newId()}.bak`;
  activeTemp.add(path);
  try {
    const got = await m.openCopy(path, LIMITS.maxFileBytes);
    if (!got) { activeTemp.delete(path); return null; }
    return path;
  } catch (e: any) {
    activeTemp.delete(path);
    await RNFS.unlink(path).catch(() => undefined);
    throw new BackupError(e?.code === 'too_large' ? 'too_large' : 'storage', String(e?.message ?? e));
  }
}

/**
 * Authenticate and validate the whole backup and compare it with the current data. Changes nothing.
 * The returned plan holds the derived key: pass it to applyRestore, then closePlan.
 */
export async function inspect(path: string, password: string, opts: { signal?: Signal; onProgress?: (note: string) => void } = {}): Promise<Plan> {
  await open();
  opts.onProgress?.('Checking the password…');
  const opened = await openContainer(path, password);
  const cats = new Map<CategoryId, CategoryPlan>();
  const docsWithText = new Set<string>();
  try {
    opts.onProgress?.('Decrypting and checking every part of the backup…');
    const manifest = await readPayload(path, opened, {
      signal: opts.signal,
      onCategory: async c => {
        const def = category(c.id)!;
        const p: CategoryPlan = { id: c.id, label: def.label, inBackup: true, records: c.records, stats: null, errors: [...new Set(c.errors)].slice(0, 10),
          notes: [], restorable: true, canReplace: def.replace, sensitive: def.sensitive };
        if (c.errors.includes(TOO_LARGE) || c.errors.some(e => /appears twice/.test(e))) p.restorable = false;
        else if (c.id !== 'documentText') {
          const d = await decide(c.id, c.rows, 'merge', 'keep');
          p.stats = { ...d.stats, invalid: d.stats.invalid + c.errors.length };
          p.notes = d.notes;
        }
        cats.set(c.id, p);
      },
      onDocumentText: async (id, chunks, errors) => { if (!errors.length && chunks.length) docsWithText.add(id); },
    });
    const categories = CATEGORIES.map(def => cats.get(def.id) ?? {
      id: def.id, label: def.label, inBackup: manifest.categories.some(c => c.id === def.id), records: 0, stats: null, errors: [], notes: [],
      restorable: manifest.categories.some(c => c.id === def.id), canReplace: def.replace, sensitive: def.sensitive,
    });
    return { path, opened, manifest, categories, docsWithText: [...docsWithText] };
  } catch (e) {
    crypto.forget(opened.key);
    throw e;
  }
}

/** Forget the key and delete the private copy of the backup. */
export async function closePlan(plan: Plan | null, path?: string): Promise<void> {
  if (plan) crypto.forget(plan.opened.key);
  const p = plan?.path ?? path;
  if (p) { activeTemp.delete(p); await RNFS.unlink(p).catch(() => undefined); }
}

async function journal(id: string, status: string, progress: Record<string, unknown>, error: string | null = null) {
  await db().execute('UPDATE restore_journal SET status = ?, progress_json = ?, error = ?, updated_at = ? WHERE id = ?',
    [status, JSON.stringify(progress), error, Date.now(), id]);
}

/**
 * Apply the chosen categories. Each category is one transaction; replace needs `confirmReplace`.
 * @returns what happened to each category (never "done" for a category that failed or was cancelled)
 */
export async function applyRestore(plan: Plan, choices: Choice[], opts: { confirmReplace?: boolean; signal?: Signal; onProgress?: (note: string) => void } = {}): Promise<Summary> {
  if (restoring) throw new BackupError('invalid', 'A restore is already running.');
  const chosen = new Map(choices.map(c => [c.id, c]));
  for (const c of choices) {
    const p = plan.categories.find(x => x.id === c.id);
    if (!p?.inBackup || !p.restorable) throw new BackupError('invalid', `"${category(c.id)?.label ?? c.id}" can't be restored from this backup.`);
    if (c.mode === 'replace' && !p.canReplace) throw new BackupError('invalid', `"${p.label}" can only be merged.`);
  }
  if (!choices.length) throw new BackupError('invalid', 'Choose at least one category to restore.');
  if (chosen.has('documentText') && !chosen.has('documents')) throw new BackupError('invalid', 'Document text can only be restored together with the document list.');
  if (choices.some(c => c.mode === 'replace') && !opts.confirmReplace) throw new BackupError('invalid', 'Replacing data needs your confirmation.');
  restoring = true;
  const journalId = newId();
  const results: CategoryResult[] = [];
  const progress: Record<string, unknown> = {};
  const pendingText = new Set<string>();
  const withText = new Set(chosen.has('documentText') ? plan.docsWithText : []);
  try {
    await db().execute('INSERT INTO restore_journal (id, status, plan_json, progress_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [journalId, 'applying', JSON.stringify({ categories: choices, backupCreatedAt: plan.manifest.createdAt }), '{}', Date.now(), Date.now()]);
    await readPayload(plan.path, plan.opened, {
      onCategory: async c => {
        const choice = chosen.get(c.id);
        if (!choice) return;
        if (c.id === 'documentText') { results.push({ id: c.id, mode: choice.mode, status: 'done', stats: null, notes: [], error: null }); return; }
        if (opts.signal?.cancelled) {
          results.push({ id: c.id, mode: choice.mode, status: 'cancelled', stats: null, notes: [], error: 'Cancelled before this category; nothing in it was changed.' });
          return;
        }
        opts.onProgress?.(`Restoring ${category(c.id)!.label.toLowerCase()}…`);
        try {
          const d = await decide(c.id, c.rows, choice.mode, choice.onConflict, withText);
          await db().batch(d.stmts as any); // one transaction: all of this category, or none of it
          const missing = await countMissing(d.inserted);
          if (missing) throw new Error(`${missing} restored record(s) could not be found afterwards`);
          d.textFor.forEach(id => pendingText.add(id));
          results.push({ id: c.id, mode: choice.mode, status: 'done', stats: { ...d.stats, invalid: d.stats.invalid + c.errors.length }, notes: d.notes, error: null });
        } catch (e: any) {
          results.push({ id: c.id, mode: choice.mode, status: 'failed', stats: null, notes: [], error: `Not restored: ${String(e?.message ?? e).slice(0, 300)}` });
        }
        progress[c.id] = results[results.length - 1].status;
        await journal(journalId, 'applying', progress);
      },
      onDocumentText: async (id, chunks) => {
        if (!pendingText.has(id)) return;
        const doc = await docStore.getDocument(id);
        if (!doc) return;
        await docStore.replaceChunks(id, chunks.map(c => ({ ordinal: Number(c.ordinal), page: c.page == null ? null : Number(c.page), text: String(c.text), tokens: Number(c.token_count) })) as any,
          { sha256: doc.sha256 ?? '', size: doc.size ?? 0, pageCount: doc.page_count, charCount: doc.char_count, warning: doc.warning ?? null, now: Date.now() });
        pendingText.delete(id);
      },
    });
    for (const id of pendingText) await docStore.markFailed(id, 'restored_without_text', 'Its text was not in the backup. Pick the file again (Import) to make it searchable.', Date.now());
    // M9 fix (found on the emulator): a chosen category with no records in the backup has no rows in the payload, so it
    // never reached onCategory. It is complete (nothing to restore), not missing; reporting it keeps "partial" honest.
    for (const c of choices) {
      if (results.some(r => r.id === c.id)) continue;
      const empty = { new: 0, duplicate: 0, conflict: 0, copied: 0, invalid: 0, skipped: 0 };
      if (c.mode === 'replace') {
        // Replace with an empty category still means "delete the current data": do it through the same rules.
        try {
          const d = await decide(c.id, {}, 'replace', c.onConflict, withText);
          await db().batch(d.stmts as any);
          results.push({ id: c.id, mode: c.mode, status: 'done', stats: empty, notes: ['The backup had no records here; current data was removed as confirmed.'], error: null });
        } catch (e: any) {
          results.push({ id: c.id, mode: c.mode, status: 'failed', stats: null, notes: [], error: `Not restored: ${String(e?.message ?? e).slice(0, 300)}` });
        }
      } else results.push({ id: c.id, mode: c.mode, status: 'done', stats: empty, notes: ['The backup had no records here.'], error: null });
      progress[c.id] = results[results.length - 1].status;
    }
    results.sort((a, b) => CATEGORIES.findIndex(k => k.id === a.id) - CATEGORIES.findIndex(k => k.id === b.id));
  } catch (e: any) {
    const status = results.some(r => r.status === 'done') ? 'partial' : 'failed';
    await journal(journalId, status, progress, String(e?.message ?? e).slice(0, 300)).catch(() => undefined);
    restoring = false;
    throw e;
  }
  const integrity = await integrityCheck();
  const done = results.filter(r => r.status === 'done').length;
  const status = done === choices.length ? 'done' : done ? 'partial' : 'failed';
  await journal(journalId, status, progress);
  restoring = false;
  const notes = [...new Set(results.flatMap(r => r.notes))];
  if (results.some(r => r.id === 'documents' && r.status === 'done')) notes.push('Meaning-search vectors are not in backups; if meaning search is on, they are rebuilt in the background.');
  return { journalId, status, categories: results, integrity, notes };
}

/** How many of the records a restore inserted are not in the database afterwards (should be 0). */
async function countMissing(inserted: { table: string; id: string }[]): Promise<number> {
  let missing = 0;
  const byTable = new Map<string, string[]>();
  inserted.forEach(i => byTable.set(i.table, [...(byTable.get(i.table) ?? []), i.id]));
  for (const [table, ids] of byTable) {
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400);
      const n = Number((await db().query(`SELECT COUNT(*) AS n FROM ${table} WHERE id IN (${part.map(() => '?').join(', ')})`, part))[0].n);
      missing += part.length - n;
    }
  }
  return missing;
}

/** SQLite's own quick check: 'ok', or the first problems it reports. Never repairs anything. */
export async function integrityCheck(): Promise<string> {
  try {
    const rows = await db().query('PRAGMA quick_check');
    const msgs = rows.map((r: any) => String(Object.values(r)[0]));
    return msgs.length === 1 && msgs[0] === 'ok' ? 'ok' : msgs.slice(0, 5).join('; ');
  } catch (e: any) {
    return `check not available: ${String(e?.message ?? e).slice(0, 100)}`;
  }
}

export type JournalEntry = { id: string; status: string; categories: Choice[]; progress: Record<string, string>; error: string | null; createdAt: number };

export async function listRestores(limit = 10): Promise<JournalEntry[]> {
  await open();
  return (await db().query(`SELECT * FROM restore_journal ORDER BY created_at DESC LIMIT ${Math.max(1, Math.floor(limit))}`)).map((r: any) => ({
    id: r.id, status: r.status, categories: JSON.parse(r.plan_json).categories, progress: JSON.parse(r.progress_json), error: r.error ?? null, createdAt: Number(r.created_at),
  }));
}

/** At launch: a restore cut off by the app closing is marked interrupted (idempotent; nothing is redone automatically). */
export async function recoverInterruptedRestores(): Promise<number> {
  await open();
  const n = (await db().query("SELECT COUNT(*) AS n FROM restore_journal WHERE status = 'applying'"))[0];
  await db().execute("UPDATE restore_journal SET status = 'interrupted', error = 'The app closed during this restore. Categories marked done were restored; merge the others again.', updated_at = ? WHERE status = 'applying'", [Date.now()]);
  return Number(n?.n ?? 0);
}

/** Remove a finished journal entry from the list (it only describes what happened). */
export async function dismissRestore(id: string): Promise<void> {
  await db().execute("DELETE FROM restore_journal WHERE id = ? AND status != 'applying'", [id]);
}
