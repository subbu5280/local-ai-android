/**
 * M8 restore: full round trip into a fresh database, selective restore, merge conflicts (keep / copy), duplicates and
 * idempotent re-runs, confirmed replace, wrong passwords and tampering (header, chunks, order, truncation, extra data)
 * without any change, malformed and unsupported payloads, older payloads, re-validation of definitions, invalid
 * external references, partial failure, the journal and interrupted-restore recovery, and unrelated data preserved.
 */
jest.mock('@dr.pogodin/react-native-fs', () => require('../testUtils/fakeBackupEnv').fakeFs());
jest.mock('llama.rn', () => ({ releaseAllLlama: jest.fn(), initLlama: jest.fn() }));

import { NativeModules } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import * as chat from '../src/chatStore';
import * as docStore from '../src/knowledge/docStore';
import * as agentStore from '../src/agents/agentStore';
import * as skills from '../src/skills/skillStore';
import { createBackup, tempDir, activeTemp, PAYLOAD_VERSION } from '../src/backup/backup';
import { ContainerWriter, LIMITS } from '../src/backup/format';
import { applyRestore, closePlan, inspect, listRestores, pickBackup, recoverInterruptedRestores, type Choice, type Plan } from '../src/backup/restore';
import { ALL, FAST, freshDb, PW, SECRET_TEXT, seed } from '../testUtils/backupFixture';
import { pickerState } from '../testUtils/fakeBackupEnv';

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
const fs = node('fs');
const count = async (t: string) => Number((await chat.db().query(`SELECT COUNT(*) AS n FROM ${t}`))[0].n);
const snapshot = async () => {
  const out: Record<string, number> = {};
  for (const t of ['conversations', 'messages', 'memories', 'documents', 'chunks', 'agents', 'skills', 'workflows', 'agent_runs', 'code_workspaces', 'code_tasks', 'code_proposals', 'restore_journal']) out[t] = await count(t);
  return out;
};
const merge = (...ids: string[]): Choice[] => ids.map(id => ({ id, mode: 'merge', onConflict: 'keep' }) as Choice);
let backupFile = '';

/** Make a backup of the seeded database, then start a fresh, empty one (as on a new phone). */
async function backupThenFresh(ids = ALL, extra?: () => Promise<void>) {
  await freshDb();
  await seed();
  await extra?.();
  const b = await createBackup(ids as any, PW, PW, { iterations: FAST });
  backupFile = `${b.path}.copy`;
  fs.copyFileSync(b.path, backupFile);
  await freshDb();
}
async function plan(file = backupFile, password = PW): Promise<Plan> {
  pickerState.openFrom = file;
  const path = (await pickBackup())!;
  return inspect(path, password);
}
beforeEach(() => { activeTemp.clear(); });

test('full round trip into an empty app restores every category, with document text searchable', async () => {
  await backupThenFresh();
  const p = await plan();
  expect(p.categories.filter(c => c.inBackup).map(c => c.id)).toEqual(ALL);
  expect(p.categories.find(c => c.id === 'chats')!.stats).toMatchObject({ new: 1, duplicate: 0, conflict: 0 });
  const s = await applyRestore(p, merge(...ALL));
  await closePlan(p);
  expect(s.status).toBe('done');
  expect(s.integrity).toBe('ok');
  expect((await chat.recentMessages((await chat.listConversations())[0].id)).map(m => m.content)).toEqual([SECRET_TEXT, 'Noted.']);
  expect((await chat.listMemories()).map(m => m.value)).toEqual(['vim']);
  expect(await docStore.getDocument('d1')).toMatchObject({ status: 'ready', chunk_count: 1 });
  const c = await docStore.counts();
  expect(c.indexRows).toBe(c.chunks); // keyword index rebuilt for the restored text
  expect((await agentStore.listAgents()).map(a => a.name)).toContain('My helper');
  expect((await skills.listSkills()).map(x => x.id)).toContain('my-skill');
  expect(await count('agent_steps')).toBe(1);
  expect((await chat.db().query("SELECT scanned_at, entry_count FROM code_workspaces WHERE id = 'w1'"))[0]).toEqual({ scanned_at: null, entry_count: 0 });
  expect(await count('code_entries')).toBe(0); // listings are never in backups
  expect((await chat.db().query("SELECT status FROM code_proposals WHERE id = 'p1'"))[0].status).toBe('stale'); // review only
  expect((await chat.db().query("SELECT value FROM meta WHERE key = 'proposal_retention_days'"))[0].value).toBe('30');
  expect(s.notes.join(' ')).toMatch(/pick(ed)? .*again/);
  expect(await RNFS.exists(p.path)).toBe(false);
  expect((await listRestores())[0]).toMatchObject({ status: 'done' });
});

test('selective restore changes only the chosen categories', async () => {
  await backupThenFresh();
  const p = await plan();
  await applyRestore(p, merge('skills'));
  expect(await count('conversations')).toBe(0);
  expect(await count('documents')).toBe(0);
  expect((await skills.listSkills()).map(x => x.id)).toContain('my-skill');
  await expect(applyRestore(p, merge('documentText'))).rejects.toThrow(/together with the document list/);
});

test('a wrong password, tampering, reordering, truncation and extra data change nothing', async () => {
  await backupThenFresh(ALL, async () => {
    const conv = await chat.createConversation('Long');
    for (let i = 0; i < 80; i++) await chat.addMessage(conv.id, 'user', `${i} ${'x'.repeat(9000)}`); // several chunks
  });
  const before = await snapshot();
  const lines = fs.readFileSync(backupFile, 'utf8').trimEnd().split('\n');
  expect(lines.length).toBeGreaterThan(4);
  const variant = (name: string, ls: string[]) => { const f = `${backupFile}.${name}`; fs.writeFileSync(f, `${ls.join('\n')}\n`); return f; };
  const flip = (s: string) => s.slice(0, 20) + (s[20] === 'A' ? 'B' : 'A') + s.slice(21);
  const header = JSON.parse(lines[1]);
  const cases: [string, string, string][] = [
    ['wrong password', backupFile, 'auth_failed'],
    ['changed chunk', variant('flip', [lines[0], lines[1], flip(lines[2]), ...lines.slice(3)]), 'auth_failed'],
    ['changed header', variant('hdr', [lines[0], JSON.stringify({ ...header, kdf: { ...header.kdf, iterations: FAST + 1 } }), ...lines.slice(2)]), 'auth_failed'],
    ['swapped chunks', variant('swap', [lines[0], lines[1], lines[3], lines[2], ...lines.slice(4)]), 'auth_failed'],
    ['cut short', variant('cut', lines.slice(0, -1)), 'truncated'],
    ['extra chunk', variant('extra', [...lines, lines[lines.length - 1]]), 'auth_failed'],
    ['weak KDF', variant('kdf', [lines[0], JSON.stringify({ ...header, kdf: { ...header.kdf, iterations: 1000 } }), ...lines.slice(2)]), 'bad_header'],
    ['extra header field', variant('field', [lines[0], JSON.stringify({ ...header, compress: 'zip' }), ...lines.slice(2)]), 'bad_header'],
    ['newer format', variant('v2', ['LOCALAI-BACKUP/2', ...lines.slice(1)]), 'unsupported_version'],
    ['not a backup', variant('txt', ['hello', 'world']), 'not_backup'],
  ];
  for (const [what, file, code] of cases) {
    const err = await plan(file, what === 'wrong password' ? 'not the password' : PW).catch(e => e);
    expect([what, err?.code]).toEqual([what, code]);
  }
  expect(await snapshot()).toEqual(before);
  const saved = LIMITS.maxFileBytes;
  LIMITS.maxFileBytes = 100;
  try { expect((await plan().catch(e => e)).code).toBe('too_large'); } finally { LIMITS.maxFileBytes = saved; }
  expect((await RNFS.readDir(tempDir())).filter(f => /^r-/.test(f.name) && activeTemp.has(f.path))).toHaveLength(cases.length); // kept for another try until closed; the oversized file was never kept
});

/** A correctly encrypted backup with hand-made (possibly hostile) contents. */
async function craft(lines: unknown[]): Promise<string> {
  await RNFS.mkdir(tempDir());
  const path = `${tempDir()}/crafted-${Math.random()}.bak`;
  const w = await ContainerWriter.create(path, PW, FAST);
  await w.add(lines.map(l => `${JSON.stringify(l)}\n`).join(''));
  await w.finish();
  w.close();
  return path;
}
const manifest = (cats: string[], extra = {}) => ({ type: 'manifest', payloadVersion: PAYLOAD_VERSION, appSchema: chat.SCHEMA_VERSION, createdAt: 1,
  categories: cats.map(id => ({ id, records: 1 })), excluded: [], ...extra });
const conv = (id: string, title = 'T') => ({ type: 'row', cat: 'chats', table: 'conversations', row: { id, title, created_at: 1, updated_at: 1 } });

test('malformed or unsupported payloads are refused before any change', async () => {
  await freshDb();
  const before = await snapshot();
  const bad: [unknown[], string][] = [
    [[conv('c1'), { type: 'end', records: 1 }], 'malformed'], // no manifest
    [[manifest(['chats']), { type: 'row', cat: 'chats', table: 'sqlite_master', row: {} }, { type: 'end', records: 1 }], 'malformed'],
    [[manifest(['chats']), conv('c1'), { type: 'end', records: 5 }], 'malformed'],
    [[manifest(['chats']), conv('c1')], 'truncated'], // no end marker
    [[manifest(['chats'], { appSchema: chat.SCHEMA_VERSION + 1 }), { type: 'end', records: 0 }], 'unsupported_version'],
    [[manifest(['chats'], { payloadVersion: 99 }), { type: 'end', records: 0 }], 'unsupported_version'],
    [[manifest(['chats']), { type: 'end', records: 0 }, conv('c1')], 'malformed'],
    [[manifest(['chats']), { type: 'exec', cmd: 'rm -rf /' }, { type: 'end', records: 1 }], 'malformed'],
  ];
  for (const [ls, code] of bad) {
    const p = await craft(ls);
    expect((await inspect(p, PW).catch(e => e)).code).toBe(code);
  }
  expect(await snapshot()).toEqual(before);
});

test('duplicate records, unknown fields and invalid references are reported, never imported', async () => {
  await freshDb();
  const p = await inspect(await craft([manifest(['chats', 'documents', 'workspaces']), conv('c1'), conv('c1'),
    { type: 'row', cat: 'documents', table: 'documents', row: { id: 'd9', name: 'x', format: 'txt', uri: 'file:///etc/passwd', mime: null, size: 1, sha256: null, status: 'ready',
      error_code: null, error: null, warning: null, page_count: null, char_count: 1, chunk_count: 1, created_at: 1, updated_at: 1, indexed_at: null } },
    { type: 'row', cat: 'workspaces', table: 'code_workspaces', row: { id: 'w9', name: 'x', kind: 'folder', tree_uri: '/sdcard/x', root_uri: '/sdcard/x', can_write: 1,
      scanned_at: null, entry_count: null, truncated: 0, created_at: 1, updated_at: 1, evil: 1 } },
    { type: 'end', records: 4 }]), PW);
  const cat = (id: string) => p.categories.find(c => c.id === id)!;
  expect(cat('chats')).toMatchObject({ restorable: false });
  expect(cat('chats').errors.join()).toMatch(/appears twice/);
  expect(cat('documents').stats).toMatchObject({ invalid: 1, new: 0 });
  expect(cat('workspaces').stats).toMatchObject({ invalid: 1 });
  await expect(applyRestore(p, merge('chats'))).rejects.toThrow(/can't be restored/);
  const s = await applyRestore(p, merge('documents', 'workspaces'));
  expect(s.categories.map(c => c.stats?.new)).toEqual([0, 0]);
  expect(await count('documents')).toBe(0);
});

test('an older backup without newer columns is migrated; restored definitions are validated again', async () => {
  await freshDb();
  const base = (await skills.listSkills())[0].def;
  const badSkill = { ...JSON.parse(JSON.stringify(base)), id: 'bad-skill', tools: ['shell.exec'] };
  const p = await inspect(await craft([manifest(['agents', 'skills', 'runHistory'], { appSchema: 6 }),
    { type: 'row', cat: 'agents', table: 'agents', row: { id: 'a1', name: 'Shell agent', purpose: '', tools_json: '["shell.exec"]', limits_json: '{"maxSteps":2,"maxRetries":0,"stepTimeoutSec":10}', confirm_plan: 0, enabled: 1, version: 1, created_at: 1, updated_at: 1 } },
    { type: 'row', cat: 'skills', table: 'skills', row: { id: 'bad-skill', version: 1, def_json: JSON.stringify(badSkill), enabled: 1, builtin: 0, created_at: 1, updated_at: 1 } },
    { type: 'row', cat: 'runHistory', table: 'agent_runs', row: { id: 'r1', agent_id: 'a1', agent_version: 1, agent_name: 'A', task: 't', scope_json: null, plan_source: 'model', plan_note: null,
      status: 'succeeded', final_text: null, sources_json: null, error: null, warnings_json: null, created_at: 1, started_at: null, ended_at: null } }, // no M6 columns
    { type: 'end', records: 3 }]), PW);
  const s = await applyRestore(p, merge('agents', 'skills', 'runHistory'));
  expect(s.categories.find(c => c.id === 'agents')!.stats).toMatchObject({ invalid: 1, new: 0 });
  expect(s.categories.find(c => c.id === 'skills')!.stats).toMatchObject({ invalid: 1, new: 0 });
  expect(s.notes.join(' ')).toMatch(/Unknown tool "shell.exec"/i);
  expect((await chat.db().query("SELECT kind FROM agent_runs WHERE id = 'r1'"))[0].kind).toBe('agent');
});

test('merge: duplicates are skipped, conflicts keep the current version or add a copy, and re-running is idempotent', async () => {
  await backupThenFresh();
  await seed(); // same ids and content as the backup
  await chat.addMessage((await chat.listConversations())[0].id, 'user', 'a newer message here'); // the chat now differs
  await chat.db().execute("UPDATE agents SET purpose = 'changed here' WHERE name = 'My helper'");
  const before = await snapshot();
  const p = await plan();
  expect(p.categories.find(c => c.id === 'chats')!.stats).toMatchObject({ conflict: 0, duplicate: 1 }); // every backed-up message is here
  expect(p.categories.find(c => c.id === 'agents')!.stats).toMatchObject({ conflict: 1 });
  let s = await applyRestore(p, merge(...ALL));
  expect(s.status).toBe('done');
  const after = await snapshot();
  expect({ ...after, restore_journal: 0 }).toEqual({ ...before, restore_journal: 0 }); // nothing new, nothing replaced
  expect((await agentStore.listAgents()).find(a => a.name === 'My helper')!.purpose).toBe('changed here');
  s = await applyRestore(p, [{ id: 'agents', mode: 'merge', onConflict: 'copy' }, { id: 'skills', mode: 'merge', onConflict: 'copy' }]);
  expect((await agentStore.listAgents()).map(a => a.name)).toEqual(expect.arrayContaining(['My helper', 'My helper (restored)']));
  expect(s.categories[0].stats).toMatchObject({ copied: 1 });
  await chat.db().execute("UPDATE skills SET def_json = replace(def_json, 'My skill', 'My skill v2') WHERE id = 'my-skill'");
  await applyRestore(p, [{ id: 'skills', mode: 'merge', onConflict: 'copy' }]);
  expect((await skills.listSkills()).map(x => x.id)).toContain('my-skill-restored');
});

test('a conflicting conversation can be added as a copy', async () => {
  await backupThenFresh(['chats']);
  await chat.db().execute("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'Other', 1, 1)"); // same id, other content
  const p = await plan();
  expect(p.categories.find(c => c.id === 'chats')!.stats).toMatchObject({ conflict: 1 });
  await applyRestore(p, [{ id: 'chats', mode: 'merge', onConflict: 'copy' }]);
  expect((await chat.listConversations()).map(c => c.title).sort()).toEqual(['Falcon planning (restored)', 'Other']);
});

test('replace needs confirmation and replaces only the chosen category', async () => {
  await backupThenFresh();
  const mine = await chat.createConversation('Only on this phone');
  await chat.addMessage(mine.id, 'user', 'keep?');
  await docStore.createDocument({ id: 'local', name: 'local.txt', format: 'txt', uri: 'content://local', mime: null, size: 1, now: 1 });
  const p = await plan();
  const replace: Choice[] = [{ id: 'chats', mode: 'replace', onConflict: 'keep' }];
  await expect(applyRestore(p, replace)).rejects.toThrow(/confirmation/);
  expect(await chat.getConversation(mine.id)).not.toBeNull();
  await expect(applyRestore(p, [{ id: 'workspaces', mode: 'replace', onConflict: 'keep' }], { confirmReplace: true })).rejects.toThrow(/only be merged/);
  const s = await applyRestore(p, replace, { confirmReplace: true });
  expect(s.status).toBe('done');
  expect(await chat.getConversation(mine.id)).toBeNull();
  expect((await chat.listConversations()).map(c => c.title)).toEqual(['Falcon planning']);
  expect(await docStore.getDocument('local')).not.toBeNull(); // other categories untouched
});

test('a category that fails is reported, others are restored, and the journal says so', async () => {
  await backupThenFresh();
  const p = await plan();
  const db = chat.db();
  const realBatch = db.batch.bind(db);
  const spy = jest.spyOn(db, 'batch').mockImplementation(async (st: any) => {
    if (st.some((x: any) => /INSERT INTO agents/.test(x.sql))) throw new Error('disk I/O error');
    return realBatch(st);
  });
  try {
    const s = await applyRestore(p, merge('chats', 'agents', 'skills'));
    expect(s.status).toBe('partial');
    expect(s.categories.map(c => [c.id, c.status])).toEqual([['chats', 'done'], ['agents', 'failed'], ['skills', 'done']]);
    expect(s.categories[1].error).toMatch(/Not restored: disk I\/O error/);
  } finally { spy.mockRestore(); }
  expect((await agentStore.listAgents()).map(a => a.name)).not.toContain('My helper');
  expect((await listRestores())[0]).toMatchObject({ status: 'partial', progress: { chats: 'done', agents: 'failed', skills: 'done' } });
});

test('an interrupted restore is marked at launch, once; nothing is redone automatically', async () => {
  await freshDb();
  await chat.db().execute("INSERT INTO restore_journal (id, status, plan_json, progress_json, created_at, updated_at) VALUES ('j1', 'applying', '{\"categories\":[]}', '{\"chats\":\"done\"}', 1, 1)");
  expect(await recoverInterruptedRestores()).toBe(1);
  expect(await recoverInterruptedRestores()).toBe(0);
  expect((await listRestores())[0]).toMatchObject({ status: 'interrupted', progress: { chats: 'done' } });
  const row = (await chat.db().query('SELECT plan_json, progress_json FROM restore_journal'))[0];
  expect(JSON.stringify(row)).not.toMatch(/password|Falcon/);
});

test('the key is wiped and the private copy deleted when a restore is closed', async () => {
  await backupThenFresh(['settings']);
  const p = await plan();
  const keys = (NativeModules.AiCrypto as any).keyCount();
  await closePlan(p);
  expect((NativeModules.AiCrypto as any).keyCount()).toBe(keys - 1);
  expect(await RNFS.exists(p.path)).toBe(false);
});

test('categories with no records are reported as done, so a fully successful restore is never called partial (M9 fix)', async () => {
  await freshDb(); // nothing but one agent, like a new app
  await chat.db().execute(`INSERT INTO agents (id, name, purpose, tools_json, limits_json, confirm_plan, enabled, version, created_at, updated_at)
    VALUES ('a1', 'Only agent', '', '["calculator"]', '{"maxSteps":2,"maxRetries":0,"stepTimeoutSec":10}', 0, 1, 1, 1, 1)`);
  const b = await createBackup(['settings', 'chats', 'memories', 'agents'] as any, PW, PW, { iterations: FAST });
  backupFile = `${b.path}.copy`;
  fs.copyFileSync(b.path, backupFile);
  await freshDb();
  const mine = await chat.createConversation('Mine');
  const p = await plan();
  const s = await applyRestore(p, merge('settings', 'chats', 'memories', 'agents'));
  expect(s.status).toBe('done');
  expect(s.categories.map(c => [c.id, c.status])).toEqual([['settings', 'done'], ['chats', 'done'], ['memories', 'done'], ['agents', 'done']]);
  expect(s.categories[1].notes).toEqual(['The backup had no records here.']);
  expect(await chat.getConversation(mine.id)).not.toBeNull(); // merge of an empty category changes nothing
  // Replace with an empty category removes the current data, only with the confirmation.
  const r = await applyRestore(p, [{ id: 'chats', mode: 'replace', onConflict: 'keep' }], { confirmReplace: true });
  expect(r.status).toBe('done');
  expect(await chat.getConversation(mine.id)).toBeNull();
  expect((await listRestores())[0].progress).toEqual({ chats: 'done' });
});
