/**
 * M7 safe application and the security boundary: nothing changes before approval; approved changes are revalidated,
 * stale files are never overwritten, multi-file failures are reported exactly, originals can be restored (never over
 * newer edits), created files are never deleted, provider limits are explained, interrupted applies are recovered;
 * agents, tools, skills and workflows have no path to writes; no execution path exists; migration keeps data.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => true),
  readFile: jest.fn(async () => require('../src/localModel').MODEL.sha256),
  getFSInfo: jest.fn(async () => ({ freeSpace: 50e9, totalSpace: 128e9 })),
}));
jest.mock('llama.rn', () => ({ releaseAllLlama: jest.fn(), initLlama: jest.fn() }));

import * as chat from '../src/chatStore';
import { applyProposal, recoverInterruptedProposals, restoreOriginal } from '../src/code/apply';
import { getProposal, rejectProposal, saveProposal, validateProposal, type Proposal } from '../src/code/proposals';
import * as store from '../src/code/workspaceStore';
import { validatePlan } from '../src/agents/policy';
import { getTool, TOOLS } from '../src/agents/tools';
import { validateSkill } from '../src/skills/format';
import { BUILTIN_SKILLS } from '../src/skills/builtins';
import { setupWorkspace } from '../testUtils/codeFixture';
import { sqliteDb } from '../testUtils/sqliteDb';
import type { FakeProvider } from '../testUtils/fakeWorkspace';

let p: FakeProvider;
let ws: store.Workspace;
beforeEach(async () => { ({ p, ws } = await setupWorkspace()); });

const SAFE = { op: 'modify', path: 'src/user.ts', purpose: 'guard', content: '', edits: [{ find: 'return user.name.trim();', replace: "return user?.name.trim() ?? '';" }] };
const DB = { op: 'modify', path: 'src/db.ts', purpose: 'params', content: '', edits: [{ find: "catch (e) {}", replace: 'catch (e) { return null; }' }] };
const NEW = { op: 'create', path: 'src/strings.ts', purpose: 'helper', content: 'export const empty = "";\n', edits: [] };
async function make(...changes: object[]): Promise<Proposal> {
  const v = await validateProposal(ws, { title: 'T', objective: 'o', reason: 'r', assumptions: [], risks: [], validation: [], changes });
  expect(v.errors).toEqual([]);
  return saveProposal(ws.id, null, v.proposal!);
}
const original = () => p.text('src/user.ts')!;

test('nothing is written before approval; approved changes are applied, verified and recorded once', async () => {
  const before = original();
  const prop = await make(SAFE, NEW);
  expect(p.state.writes).toEqual([]);
  expect(original()).toBe(before);
  const r = await applyProposal(ws, prop.id, [1, 2]);
  expect(r.status).toBe('applied');
  expect(r.files.map(f => f.status)).toEqual(['applied', 'applied']);
  expect(original()).toContain("user?.name.trim() ?? ''");
  expect(p.text('src/strings.ts')).toBe('export const empty = "";\n');
  expect(await store.entry(ws.id, 'src/strings.ts')).not.toBeNull();
  // The approval was used: the same proposal can't be applied again.
  await expect(applyProposal(ws, prop.id, [1])).rejects.toThrow(/can't be applied again/);
  expect(p.state.writes).toEqual(['src/user.ts']);
});

test('only the approved changes are applied; unknown or empty approvals are refused; a rejected proposal is final', async () => {
  const prop = await make(SAFE, NEW);
  await expect(applyProposal(ws, prop.id, [])).rejects.toThrow(/Approve at least one/);
  await expect(applyProposal(ws, prop.id, [3])).rejects.toThrow(/not part of this proposal/);
  const r = await applyProposal(ws, prop.id, [1]);
  expect(r.files.map(f => f.status)).toEqual(['applied', 'rejected']);
  expect(p.text('src/strings.ts')).toBeUndefined();
  const other = await make(NEW);
  await rejectProposal(other.id);
  await expect(applyProposal(ws, other.id, [1])).rejects.toThrow(/rejected/);
  const foreign = await setupWorkspace();
  await expect(applyProposal(foreign.ws, prop.id, [1])).rejects.toThrow(/does not belong/);
});

test('a file changed after the proposal makes the whole proposal stale; nothing is written', async () => {
  const prop = await make(SAFE, NEW);
  p.edit('src/user.ts', `${original()}// edited elsewhere\n`);
  const r = await applyProposal(ws, prop.id, [1, 2]);
  expect(r.status).toBe('stale');
  expect(r.files.map(f => f.status)).toEqual(['stale', 'not_applied']);
  expect(r.summary).toMatch(/Nothing was changed/);
  expect(p.state.writes).toEqual([]);
  expect(p.state.creates).toEqual([]);
  expect(original()).toContain('// edited elsewhere');
});

test('a deleted target or a new file that appeared meanwhile is detected before writing', async () => {
  const prop = await make(SAFE, NEW);
  p.remove('src/user.ts');
  expect((await applyProposal(ws, prop.id, [1, 2])).status).toBe('stale');
  const prop2 = await make(NEW);
  await p.workspace.create('content://fake/tree/root/document/src', 'strings.ts', 'text/plain', 'theirs');
  p.state.creates.length = 0;
  const r = await applyProposal(ws, prop2.id, [1]);
  expect(r.status).toBe('stale');
  expect(p.text('src/strings.ts')).toBe('theirs'); // never replaced
});

test('a failure partway reports applied, failed and not-applied files exactly', async () => {
  const prop = await make(SAFE, DB, NEW);
  p.state.failWrite.add('src/db.ts');
  const r = await applyProposal(ws, prop.id, [1, 2, 3]);
  expect(r.status).toBe('partial');
  expect(r.files.map(f => f.status)).toEqual(['applied', 'failed', 'not_applied']);
  expect(r.summary).toMatch(/Only 1 of 3/);
  expect(r.files[2].error).toMatch(/earlier change failed/);
  expect(p.text('src/strings.ts')).toBeUndefined();
  // Recovery: the applied file can be restored to its saved original.
  expect(await restoreOriginal(ws, prop.id, 1)).toMatch(/restored/);
  expect(original()).toContain('return user.name.trim();');
  expect((await getProposal(prop.id))!.files[0].status).toBe('restored');
});

test('restore never overwrites newer edits, and created files are never deleted', async () => {
  const prop = await make(SAFE, NEW);
  await applyProposal(ws, prop.id, [1, 2]);
  p.edit('src/user.ts', `${original()}// newer edit\n`);
  expect(await restoreOriginal(ws, prop.id, 1)).toMatch(/would overwrite newer edits/);
  expect(original()).toContain('// newer edit');
  expect(await restoreOriginal(ws, prop.id, 2)).toMatch(/never deletes files/);
  expect(p.text('src/strings.ts')).toBeDefined();
});

test('provider limits and revoked access stop the write and are explained', async () => {
  const prop = await make(SAFE);
  p.state.cantWrite.add('src/user.ts');
  let r = await applyProposal(ws, prop.id, [1]);
  expect(r.status).toBe('failed');
  expect(r.files[0].error).toMatch(/does not allow this file to be changed/);
  const prop2 = await make(SAFE);
  p.state.cantWrite.clear();
  p.state.revoked = true;
  r = await applyProposal(ws, prop2.id, [1]);
  expect(r.files[0].error).toMatch(/Access to this workspace was removed/);
  p.state.revoked = false;
  const prop3 = await make(SAFE);
  p.state.corruptWrite.add('src/user.ts');
  r = await applyProposal(ws, prop3.id, [1]);
  expect(r.status).toBe('failed');
  expect(r.files[0].error).toMatch(/original was written back/);
  expect(original()).toContain('return user.name.trim();');
  expect(p.state.writes).toEqual([]);
});

test('an apply cut off by a closed app is recovered as interrupted with unknown files', async () => {
  const prop = await make(SAFE);
  await chat.db().execute("UPDATE code_proposals SET status = 'applying' WHERE id = ?", [prop.id]);
  await recoverInterruptedProposals();
  const after = (await getProposal(prop.id))!;
  expect(after.status).toBe('interrupted');
  expect(after.files[0]).toMatchObject({ status: 'unknown' });
  expect(await restoreOriginal(ws, prop.id, 1)).toMatch(/already holds its original/);
});

// ---------------------------------------------------------------- the boundary: no other path to writes

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
function sources(dir: string): { file: string; text: string }[] {
  const fs = node('fs'), path = node('path');
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d: any) => {
    const f = path.join(dir, d.name);
    return d.isDirectory() ? sources(f) : /\.tsx?$/.test(d.name) ? [{ file: f.replace(/\\/g, '/'), text: fs.readFileSync(f, 'utf8') }] : [];
  });
}

test('only the approval flow can write: no tool, agent, skill or workflow reaches apply or the native writes', () => {
  const all = [...sources('src'), { file: 'App.tsx', text: node('fs').readFileSync('App.tsx', 'utf8') }];
  const importsApply = all.filter(s => /from '\.\.?\/(code\/|src\/code\/)?apply'/.test(s.text)).map(s => s.file);
  expect(importsApply.sort()).toEqual(['App.tsx', 'src/ProposalScreen.tsx']);
  const writers = all.filter(s => /native\.(writeText|createFile)\(|\.write\(uri|AiWorkspace'\)\.(write|create)\(/.test(s.text)).map(s => s.file);
  expect(writers.sort()).toEqual(['src/code/apply.ts', 'src/code/native.ts']);
  for (const s of all.filter(x => /src\/(agents|skills)\//.test(x.file))) expect(s.text).not.toMatch(/from '[^']*code\/(apply|proposals)'|writeText\(|createFile\(/);
  // Workspace tools only read.
  const ws = TOOLS.filter(t => t.permission === 'workspace.read');
  expect(ws.map(t => t.id)).toEqual(['code.search', 'code.read']);
  expect(ws.every(t => t.risk === 'read')).toBe(true);
  expect(TOOLS.filter(t => t.risk === 'write').map(t => t.id)).toEqual(['file.export']);
});

test('no code execution path exists in the app', () => {
  for (const s of sources('src')) {
    expect(s.text).not.toMatch(/(require\(|from )['"]child_process['"]|\beval\(|new Function\(|Runtime\.getRuntime/);
  }
  const kotlin = node('fs').readdirSync('android/app/src/main/java/com/subbu/localai').map((f: string) => node('fs').readFileSync(`android/app/src/main/java/com/subbu/localai/${f}`, 'utf8')).join('\n');
  expect(kotlin).not.toMatch(/ProcessBuilder|Runtime\.getRuntime\(\)\.exec|DexClassLoader/);
  expect(kotlin).not.toMatch(/MANAGE_EXTERNAL_STORAGE/);
});

test('the read tools respect paths, secrets and agent permissions', async () => {
  const read = getTool('code.read')!;
  const ctx = { scope: [], previous: null, isCancelled: () => false, onCancel: () => undefined };
  await expect(read.run({ workspace: 'Demo', path: '../outside.ts' }, ctx)).rejects.toMatchObject({ code: 'invalid_input' });
  await expect(read.run({ workspace: 'Demo', path: '.env' }, ctx)).rejects.toThrow(/secrets/);
  await expect(read.run({ workspace: 'Nope', path: 'src/user.ts' }, ctx)).rejects.toMatchObject({ code: 'not_found' });
  const out = await read.run({ workspace: 'demo', path: 'src/user.ts', fromLine: 3, lines: 2 }, ctx);
  expect(out.text).toBe('3| export function getUserName(user?: User): string {\n4|   return user.name.trim();');
  const found = await getTool('code.search')!.run({ workspace: 'Demo', query: 'greet' }, ctx);
  expect(found.text).toMatch(/src\/user.ts:7:/);
  const agent = { id: 'a', name: 'A', purpose: '', tools: ['calculator'], limits: { maxSteps: 2, maxRetries: 0, stepTimeoutSec: 10 }, confirmPlan: false, enabled: true, version: 1, createdAt: 1, updatedAt: 1 };
  const plan = { steps: [{ tool: 'code.read', input: { workspace: 'Demo', path: 'src/user.ts' } }], source: 'model' as const };
  expect(validatePlan(plan, { agent, scope: [], modelReady: true }).errors.join()).toMatch(/not enabled/);
  expect(validatePlan({ steps: [{ tool: 'code.apply', input: {} }], source: 'model' }, { agent, scope: [], modelReady: true }).errors.join()).toMatch(/unknown tool/);
});

test('skills and workflows can only declare the read tools, with their permission', () => {
  const base = JSON.parse(JSON.stringify(BUILTIN_SKILLS.find(s => s.id === 'text-summary')));
  const def = (tools: string[], permissions: string[], tool: string) => ({ ...base, id: 'code-find', tools, permissions,
    compatibility: { tools: Object.fromEntries(tools.map(t => [t, 1])) }, inputs: [{ name: 'q', label: { en: 'Q' }, type: 'text', required: true }],
    output: 'text', steps: [{ tool, input: { workspace: 'Demo', query: '{{q}}' } }] });
  expect(validateSkill(def(['code.search'], ['workspace.read'], 'code.search')).errors).toEqual([]);
  expect(validateSkill(def(['code.search'], [], 'code.search')).errors.join()).toMatch(/permission/i);
  expect(validateSkill(def(['code.write'], ['workspace.write'], 'code.write')).errors.join()).toMatch(/unknown tool/i);
});

test('upgrading from v7 (and v4) keeps all existing data and adds the coding tables', async () => {
  const fs = node('fs'), os = node('os'), path = node('path');
  for (const from of [7, 4]) {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `v${from}-`)), 'chat.db');
    const raw = sqliteDb(f);
    for (const sql of ['CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)', ...chat.MIGRATIONS.slice(0, from).flat()]) raw.raw.exec(sql);
    raw.raw.exec(`INSERT INTO meta VALUES ('schema_version', '${from}')`);
    raw.raw.exec("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'Old chat', 1, 1)");
    raw.raw.exec("INSERT INTO messages (id, conversation_id, role, content, created_at, seq) VALUES ('m1', 'c1', 'user', 'hello', 1, 1)");
    raw.raw.exec("INSERT INTO documents (id, name, format, uri, status, created_at, updated_at) VALUES ('d1', 'doc', 'txt', 'content://d', 'ready', 1, 1)");
    if (from >= 7) raw.raw.exec("INSERT INTO skills (id, version, def_json, created_at, updated_at) VALUES ('s1', 1, '{}', 1, 1)");
    raw.close();
    chat.setDb(sqliteDb(f));
    expect(await chat.schemaVersion()).toBe(chat.SCHEMA_VERSION);
    expect((await chat.recentMessages('c1')).map(m => m.content)).toEqual(['hello']);
    expect(Number((await chat.db().query('SELECT COUNT(*) AS n FROM documents'))[0].n)).toBe(1);
    if (from >= 7) expect(Number((await chat.db().query('SELECT COUNT(*) AS n FROM skills'))[0].n)).toBe(1);
    expect(await store.listWorkspaces()).toEqual([]);
  }
});
