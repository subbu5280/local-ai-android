/**
 * M8 storage management, database integrity and recovery: measured vs estimated usage, each cleanup action and what
 * it must not touch, proposal retention, orphan detection without automatic repair, failed and unsupported migrations,
 * repeated startup recovery, and static security checks on the backup code and Android configuration.
 */
jest.mock('@dr.pogodin/react-native-fs', () => require('../testUtils/fakeBackupEnv').fakeFs());
jest.mock('llama.rn', () => ({ releaseAllLlama: jest.fn(), initLlama: jest.fn() }));

import * as RNFS from '@dr.pogodin/react-native-fs';
import * as chat from '../src/chatStore';
import * as local from '../src/localModel';
import * as docStore from '../src/knowledge/docStore';
import * as storage from '../src/storage';
import { activeTemp, tempDir } from '../src/backup/backup';
import { recoverInterruptedProposals } from '../src/code/apply';
import { recoverInterruptedRestores } from '../src/backup/restore';
import { freshDb, seed } from '../testUtils/backupFixture';
import { sqliteDb } from '../testUtils/sqliteDb';

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
const count = async (t: string) => Number((await chat.db().query(`SELECT COUNT(*) AS n FROM ${t}`))[0].n);
const models = () => `${RNFS.DocumentDirectoryPath}/models`;
beforeEach(async () => { await freshDb(); await seed(); activeTemp.clear(); await RNFS.unlink(tempDir()); await RNFS.unlink(models()); });

test('the report measures the database, files and record counts, and labels text sizes as estimates', async () => {
  await RNFS.mkdir(models());
  await RNFS.writeFile(`${models()}/qwen.gguf`, 'x'.repeat(1000));
  await RNFS.writeFile(`${models()}/e5.gguf.part`, 'x'.repeat(10));
  await RNFS.mkdir(tempDir());
  await RNFS.writeFile(`${tempDir()}/b-1.part`, 'x'.repeat(7));
  const r = await storage.storageReport();
  const pages = Number(Object.values((await chat.db().query('PRAGMA page_count'))[0])[0]);
  expect(r.databaseBytes).toBe(pages * Number(Object.values((await chat.db().query('PRAGMA page_size'))[0])[0]));
  expect(r.items.find(i => i.id === 'chats')).toMatchObject({ records: 2 });
  expect(r.items.find(i => i.id === 'documents')).toMatchObject({ records: 1, chars: 48 });
  expect(r.items.find(i => i.id === 'proposals')!.note).toMatch(/secrets/);
  expect(r.models).toEqual(expect.arrayContaining([{ name: 'qwen.gguf', bytes: 1000, kind: 'model' }, { name: 'e5.gguf.part', bytes: 10, kind: 'incomplete' }]));
  expect(r.temp).toEqual({ files: 1, bytes: 7 });
});

test('vectors can be removed and the keyword index rebuilt without losing documents', async () => {
  const chunk = (await chat.db().query('SELECT id FROM chunks'))[0].id;
  await chat.db().execute("INSERT INTO chunk_vectors (chunk_id, model, text_hash, vector, created_at) VALUES (?, 'm', 'h', 'AAAA', 1)", [chunk]);
  expect(await storage.removeVectors()).toBe(1);
  await chat.db().execute('DELETE FROM chunks_fts');
  expect(await storage.rebuildKeywordIndex()).toBe(true);
  const c = await docStore.counts();
  expect(c).toEqual({ documents: 1, chunks: 1, indexRows: 1 });
});

test('incomplete downloads are removed only when no download is running; verified models stay', async () => {
  await RNFS.mkdir(models());
  await RNFS.writeFile(`${models()}/qwen.gguf`, 'model');
  await RNFS.writeFile(`${models()}/qwen.gguf.part`, 'partial');
  const spy = jest.spyOn(local, 'getState').mockReturnValue({ state: 'downloading', detail: '40%' });
  await expect(storage.removeIncompleteDownloads()).rejects.toThrow(/download is running/);
  spy.mockReturnValue({ state: 'installed', detail: '' });
  expect(await storage.removeIncompleteDownloads()).toBe(1);
  expect((await RNFS.readDir(models())).map(f => f.name)).toEqual(['qwen.gguf']);
  spy.mockRestore();
});

test('temporary files in use are kept when cleaning up', async () => {
  await RNFS.mkdir(tempDir());
  await RNFS.writeFile(`${tempDir()}/old.part`, 'x');
  await RNFS.writeFile(`${tempDir()}/busy.part`, 'x');
  activeTemp.add(`${tempDir()}/busy.part`);
  expect(await storage.removeTempFiles()).toMatchObject({ files: 1 });
  expect((await RNFS.readDir(tempDir())).map(f => f.name)).toEqual(['busy.part']);
});

test('proposal cleanup and retention delete only finished proposals; histories are separate', async () => {
  await chat.db().execute("INSERT INTO code_proposals (id, workspace_id, title, body_json, status, created_at, updated_at) VALUES ('p2', 'w1', 'Old', '{}', 'applied', 1, 1)");
  await chat.db().execute("INSERT INTO code_proposal_files (proposal_id, idx, op, path, purpose, proposed_text, status) VALUES ('p2', 1, 'create', 'b.ts', 'p', 'x', 'applied')");
  expect(await storage.getProposalRetention()).toBe('30'); // from the seed
  expect(await storage.applyProposalRetention(Date.now())).toBe(1);
  expect((await chat.db().query('SELECT id FROM code_proposals')).map((r: any) => r.id)).toEqual(['p1']); // 'ready' p1 kept
  expect(await count('code_proposal_files')).toBe(1);
  await storage.setProposalRetention('off');
  expect(await storage.applyProposalRetention()).toBe(0);
  expect(await storage.deleteAllCodingHistory()).toBe(1);
  expect(await count('code_turns')).toBe(0);
  expect(await count('code_proposals')).toBe(1);
  expect(await count('messages')).toBe(2);
  expect(await count('code_workspaces')).toBe(1);
});

test('the database check reports orphans and SQLite problems but repairs nothing by itself', async () => {
  expect(await storage.checkDatabase()).toEqual({ sqlite: 'ok', orphans: [] });
  const raw = (chat.db() as any).raw;
  raw.exec('PRAGMA foreign_keys = OFF');
  raw.exec("INSERT INTO messages (id, conversation_id, role, content, created_at, seq) VALUES ('ghost', 'nope', 'user', 'x', 1, 1)");
  raw.exec('PRAGMA foreign_keys = ON');
  const r = await storage.checkDatabase();
  expect(r.orphans).toEqual([{ label: 'messages without a conversation', count: 1 }]);
  expect(await count('messages')).toBe(3); // still there until the user removes them
  expect(await storage.removeOrphans()).toBe(1);
  expect(await count('messages')).toBe(2);
});

test('a database from a newer app is refused without changes; a failed migration keeps the old version and data', async () => {
  const fs = node('fs'), os = node('os'), path = node('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'chat.db');
  const raw = sqliteDb(f);
  raw.raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  raw.raw.exec(`INSERT INTO meta VALUES ('schema_version', '${chat.SCHEMA_VERSION + 1}')`);
  chat.setDb(sqliteDb(f));
  await expect(chat.open()).rejects.toBeInstanceOf(chat.NewerDatabaseError);
  expect(raw.raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value).toBe(String(chat.SCHEMA_VERSION + 1));

  const g = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mig-')), 'chat.db');
  const old = sqliteDb(g);
  for (const sql of ['CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)', ...chat.MIGRATIONS.slice(0, 8).flat()]) old.raw.exec(sql);
  old.raw.exec("INSERT INTO meta VALUES ('schema_version', '8')");
  old.raw.exec("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c', 'Keep', 1, 1)");
  const last = chat.MIGRATIONS[8];
  chat.MIGRATIONS[8] = [...last, 'CREATE TABLE broken ('];
  try {
    chat.setDb(sqliteDb(g));
    await expect(chat.open()).rejects.toThrow();
    expect(old.raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value).toBe('8');
    expect(old.raw.prepare("SELECT name FROM sqlite_master WHERE name = 'restore_journal'").get()).toBeUndefined(); // rolled back
  } finally { chat.MIGRATIONS[8] = last; }
  chat.setDb(sqliteDb(g));
  expect(await chat.schemaVersion()).toBe(chat.SCHEMA_VERSION); // the retry succeeds
  expect((await chat.listConversations()).map(c => c.title)).toEqual(['Keep']);
});

test('deleted rows are overwritten (SQLite secure_delete is on for the app connection)', async () => {
  expect(Number(Object.values((await chat.db().query('PRAGMA secure_delete'))[0])[0])).toBe(1);
});

test('startup recovery is idempotent', async () => {
  await chat.db().execute("UPDATE code_proposals SET status = 'applying' WHERE id = 'p1'");
  await recoverInterruptedProposals();
  await recoverInterruptedProposals();
  expect((await chat.db().query("SELECT status FROM code_proposals WHERE id = 'p1'"))[0].status).toBe('interrupted');
  expect(await recoverInterruptedRestores()).toBe(0);
  await chat.db().execute("UPDATE documents SET status = 'indexing'");
  expect(await docStore.recoverInterrupted()).toBe(1);
  expect(await docStore.recoverInterrupted()).toBe(0);
});

// ---------------------------------------------------------------- static security checks

function sources(dir: string): { file: string; text: string }[] {
  const fs = node('fs'), path = node('path');
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d: any) => {
    const f = path.join(dir, d.name);
    return d.isDirectory() ? sources(f) : /\.(tsx?|kt|xml|gradle)$/.test(d.name) ? [{ file: f.replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }] : [];
  });
}

test('backup code has no network, logging, compression or execution path, and only the backup screen applies restores', () => {
  const src = sources('src');
  for (const s of src.filter(x => /src\/backup\//.test(x.file))) {
    expect([s.file, /fetch\(|XMLHttpRequest|uploadFiles|downloadFile|WebSocket|console\.|zip|inflate|gunzip|eval\(|new Function/i.test(s.text)]).toEqual([s.file, false]);
  }
  const appliers = [...src, { file: 'App.tsx', text: node('fs').readFileSync('App.tsx', 'utf8') }].filter(s => /applyRestore\(/.test(s.text) && !/src\/backup\//.test(s.file)).map(s => s.file);
  expect(appliers).toEqual(['src/BackupScreen.tsx']);
  expect(src.filter(s => /from '(\.\/|[^']*backup\/)crypto'/.test(s.text)).map(s => s.file).sort()).toEqual(['src/backup/backup.ts', 'src/backup/format.ts', 'src/backup/restore.ts']);
});

test('Android configuration: no cloud backup or device transfer of app data, no secrets in the build files', () => {
  const fs = node('fs');
  const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  expect(manifest).toMatch(/android:allowBackup="false"/);
  expect(manifest).toMatch(/android:dataExtractionRules="@xml\/data_extraction_rules"/);
  expect(manifest).not.toMatch(/android:debuggable="true"|MANAGE_EXTERNAL_STORAGE|READ_MEDIA|<uses-permission android:name="android.permission.(READ|WRITE)_EXTERNAL_STORAGE" \/>/);
  expect([...manifest.matchAll(/<uses-permission android:name="([^"]+)" \/>/g)].map(m => m[1])).toEqual(['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.ACCESS_COARSE_LOCATION', 'android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS', 'android.permission.RECEIVE_BOOT_COMPLETED']);
  const rules = fs.readFileSync('android/app/src/main/res/xml/data_extraction_rules.xml', 'utf8');
  for (const part of ['cloud-backup', 'device-transfer']) {
    const section = rules.match(new RegExp(`<${part}>([\\s\\S]*?)</${part}>`))![1];
    for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) expect(section).toContain(`<exclude domain="${domain}" path="." />`);
  }
  const gradle = fs.readFileSync('android/app/build.gradle', 'utf8');
  expect(gradle.match(/storePassword\s+'([^']*)'/g)).toEqual(["storePassword 'android'"]); // only the public debug key
  expect(gradle).toMatch(/findProperty\('LOCALAI_RELEASE_STORE_PASSWORD'\)/);
  const network = fs.readFileSync('android/app/src/main/res/xml/network_security_config.xml', 'utf8');
  expect(network).toMatch(/<base-config cleartextTrafficPermitted="false"/);
});
