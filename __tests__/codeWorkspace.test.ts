/**
 * M7 workspaces and source inspection, below the UI: registration, listing (skipped folders, limits, cancel),
 * revoked/unavailable documents, file filtering and size limits, binary and malformed text, secret redaction (and its
 * documented limits), name/content search, error-trace matching and bounded context selection. Real SQLite; a fake
 * Storage Access Framework provider (testUtils/fakeWorkspace.ts).
 */
import { estimateTokens } from '../src/chatStore';
import * as chat from '../src/chatStore';
import { LIMITS, redactSecrets, REDACTED } from '../src/code/files';
import * as native from '../src/code/native';
import { normalizePath } from '../src/code/paths';
import { matchRef, searchContent, searchNames, searchTerms, selectContext, traceRefs, windows } from '../src/code/search';
import * as store from '../src/code/workspaceStore';
import { FIXTURE, setupWorkspace } from '../testUtils/codeFixture';
import type { FakeProvider } from '../testUtils/fakeWorkspace';

let p: FakeProvider;
let ws: store.Workspace;
beforeEach(async () => { ({ p, ws } = await setupWorkspace()); });

test('registering and listing a folder skips dependency, output and VCS folders and stores metadata only', async () => {
  const paths = (await store.entries(ws.id)).map(e => e.path);
  expect(paths).toEqual(expect.arrayContaining(['', 'package.json', 'src', 'src/user.ts', 'docs/notes.md', 'app/Main.kt', '.env', 'assets/logo.png']));
  expect(paths.some(x => /node_modules|^build|\.git/.test(x))).toBe(false);
  expect(ws).toMatchObject({ name: 'Demo', kind: 'folder', canWrite: true, truncated: false, entryCount: paths.length - 1 });
  const cols = (await chat.db().query('SELECT * FROM code_entries LIMIT 1'))[0];
  expect(Object.keys(cols)).not.toContain('text'); // no contents stored
  await expect(store.registerFolder('Again', (await native.pickFolder())!)).rejects.toMatchObject({ code: 'exists' });
});

test('listing stops at the entry limit and a cancelled refresh keeps the previous listing', async () => {
  const before = (await store.entries(ws.id)).length;
  const saved = LIMITS.maxEntries;
  LIMITS.maxEntries = 5;
  try {
    expect(await store.scan(ws)).toEqual({ count: 4, truncated: true });
    expect((await store.getWorkspace(ws.id))!.truncated).toBe(true);
  } finally { LIMITS.maxEntries = saved; }
  await store.scan(ws);
  await expect(store.scan(ws, { signal: { cancelled: true } })).rejects.toMatchObject({ code: 'cancelled' });
  expect((await store.entries(ws.id)).length).toBe(before);
});

test('revoked access and deleted files are reported with what to do, never worked around', async () => {
  p.remove('docs/notes.md');
  await expect(store.readFile(ws, 'docs/notes.md')).rejects.toMatchObject({ code: 'not_found' });
  expect(store.explain(new native.WorkspaceError('not_found', 'x'))).toMatch(/can no longer be opened/);
  p.state.revoked = true;
  const e = await store.scan(ws).catch(x => x);
  expect(e.code).toBe('revoked');
  expect(store.explain(e)).toMatch(/Access to this workspace was removed/);
  expect(await store.checkAccess(ws)).toEqual({ read: false, write: false });
  await expect(store.readFile(ws, 'src/user.ts')).rejects.toMatchObject({ code: 'revoked' });
  expect(store.explain(new native.WorkspaceError('unsupported', "This storage provider can't list folders"))).toMatch(/does not work around/);
});

test('file filtering: secrets, unsupported types, size limit, binary and malformed text', async () => {
  const entry = async (path: string) => (await store.entry(ws.id, path))!;
  expect(store.unreadableReason(await entry('.env'))).toMatch(/secrets/);
  expect(store.unreadableReason(await entry('assets/logo.png'))).toMatch(/not a supported/);
  expect(store.unreadableReason(await entry('big.ts'))).toMatch(/larger than 200 KB/);
  await expect(store.readFile(ws, 'big.ts')).rejects.toMatchObject({ code: 'too_large' });
  await expect(store.readFile(ws, 'src/blob.ts')).rejects.toThrow(/binary/);
  const lossy = await store.readFile(ws, 'src/lossy.ts');
  expect(lossy.lossy).toBe(true);
  const kt = await store.readFile(ws, 'app/Main.kt');
  expect(kt).toMatchObject({ language: 'Kotlin', redactions: 0 });
  await expect(store.readFile(ws, 'node_modules/lib/index.js')).rejects.toMatchObject({ code: 'not_found' }); // never listed
});

test('secret redaction hides recognizable secrets, keeps code readable, and is documented as imperfect', async () => {
  const cfg = await store.readFile(ws, 'src/config.ts');
  expect(cfg.text).not.toMatch(/AKIAABCDEFGHIJKLMNOP|hunter2secret/);
  expect(cfg.text).toContain('token: process.env.TOKEN');
  expect(cfg.text).toContain('export type Auth = { token: string };');
  expect(cfg.redactions).toBe(2);
  expect(cfg.text.split('\n').length).toBe(FIXTURE['src/config.ts'].split('\n').length); // line numbers unchanged
  const r = redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nghp_abcdefghijklmnopqrstuvwxyz0123\nDB_PASSWORD=s3cretPassw0rd\nlabel = "Enter password"');
  expect(r.text).not.toMatch(/MIIabc|ghp_|s3cretPassw0rd/);
  expect(r.text).toContain('label = "Enter password"');
  expect(r.text.split('\n').length).toBe(6);
  // Known limitation (documented): a secret with no secret-sounding name and no known token format is not found.
  expect(redactSecrets('const k = "q9Zr8Xw7Vt6Us5"').text).not.toContain(REDACTED);
});

test('name and content search find the right files and lines, and never search secret files', async () => {
  expect(searchNames(await store.entries(ws.id), 'user').map(e => e.path)).toEqual(['src/user.ts']);
  const r = await searchContent(ws, 'getUserName');
  expect(r.hits.map(h => `${h.path}:${h.line}`)).toEqual(['src/user.ts:3', 'src/user.ts:8']);
  expect((await searchContent(ws, 'abc123')).hits).toEqual([]); // only in .env, which is never read
  expect((await searchContent(ws, 'hunter2')).hits).toEqual([]); // redacted before matching
});

test('error messages and stack traces are matched to workspace files and lines', async () => {
  const refs = traceRefs([
    "TypeError: Cannot read properties of undefined (reading 'name')",
    '    at getUserName (/home/me/demo/src/user.ts:4:15)',
    '  File "/srv/app/tools/run.py", line 12, in main',
    '    at com.demo.MainKt.main(Main.kt:2)',
    'src/db.ts(5,10): error TS2345',
  ].join('\n'));
  expect(refs).toEqual(expect.arrayContaining([{ file: '/home/me/demo/src/user.ts', line: 4 }, { file: '/srv/app/tools/run.py', line: 12 },
    { file: 'Main.kt', line: 2 }, { file: 'src/db.ts', line: 5 }]));
  const list = await store.entries(ws.id);
  expect(matchRef(list, '/home/me/demo/src/user.ts')?.path).toBe('src/user.ts');
  expect(matchRef(list, 'Main.kt')?.path).toBe('app/Main.kt');
  expect(matchRef(list, '/srv/app/tools/run.py')).toBeNull();
  expect(searchTerms('Where is getUserName used?')).toContain('getUserName');
});

test('context selection: trace files first, real line numbers, each file once, within the token budget', async () => {
  const pack = await selectContext(ws, 'Why does greet crash?', {
    errorText: "TypeError: Cannot read properties of undefined (reading 'name')\n    at getUserName (src/user.ts:4:15)\n    at greet (src/user.ts:8:20)" });
  expect(pack.excerpts[0].path).toBe('src/user.ts');
  expect(pack.excerpts[0].reason).toMatch(/named in the error/);
  expect(pack.excerpts[0].ranges[0].text).toContain('4|   return user.name.trim();');
  expect(new Set(pack.excerpts.map(e => e.path)).size).toBe(pack.excerpts.length);

  const small = await selectContext(ws, 'getUserName greet config', { budget: 60 });
  const used = small.excerpts.flatMap(e => e.ranges).reduce((n, r) => n + estimateTokens(r.text) + 12, 0);
  expect(used).toBeLessThanOrEqual(60);
  expect(small.truncated).toBe(true);
  expect(windows([4, 8, 30], 2, 20)).toEqual([{ start: 2, end: 10 }]);

  const broad = await selectContext(ws, 'Summarize the project architecture');
  expect(broad.excerpts.map(e => e.path)).toEqual(expect.arrayContaining(['package.json', 'README.md']));
  expect(broad.excerpts.some(e => e.path === '.env')).toBe(false);
});

test('paths are normalized or rejected', () => {
  expect(normalizePath('./src/a.ts')).toBe('src/a.ts');
  for (const bad of ['../x.ts', 'src/../../x.ts', '/etc/passwd', 'C:/Windows/x.ts', '%2e%2e/x.ts', 'src/%2F/x.ts', 'src\\..\\x.ts',
    '\uff0e\uff0e/x.ts', 'src//x.ts', 'src/./x.ts', '', 'a\u0000b.ts', '~/x.ts', 'content://evil/x.ts', 'a/'.repeat(30) + 'x.ts']) {
    expect(() => normalizePath(bad)).toThrow();
  }
});

test('removing a workspace deletes only its own metadata and keeps the project files and other app data', async () => {
  const conv = await chat.createConversation('Keep me');
  await chat.db().execute("INSERT INTO agents (id, name, purpose, tools_json, limits_json, confirm_plan, enabled, version, created_at, updated_at) VALUES ('a1', 'A', '', '[]', '{}', 0, 1, 1, 1, 1)");
  await chat.db().execute("INSERT INTO skills (id, version, def_json, created_at, updated_at) VALUES ('s1', 1, '{}', 1, 1)");
  await chat.db().execute("INSERT INTO documents (id, name, format, uri, status, created_at, updated_at) VALUES ('d1', 'doc', 'txt', 'content://d', 'ready', 1, 1)");
  const before = p.paths().map(x => `${x}=${p.text(x)}`);
  expect(await store.removeWorkspace(ws.id)).toBe(true);
  for (const t of ['code_workspaces', 'code_entries', 'code_tasks', 'code_turns', 'code_proposals', 'code_proposal_files']) {
    expect(Number((await chat.db().query(`SELECT COUNT(*) AS n FROM ${t}`))[0].n)).toBe(0);
  }
  expect(await chat.getConversation(conv.id)).not.toBeNull();
  for (const t of ['agents', 'skills', 'documents']) expect(Number((await chat.db().query(`SELECT COUNT(*) AS n FROM ${t}`))[0].n)).toBe(1);
  expect(p.paths().map(x => `${x}=${p.text(x)}`)).toEqual(before);
  expect(p.state.released).toEqual(['content://fake/tree/root']);
});

test('a workspace of picked files: duplicate names are refused; files keep their own grants', async () => {
  const picked = await native.pickFiles();
  const fw = await store.registerFiles('Two files', picked);
  expect((await store.entries(fw.id)).map(e => e.path)).toEqual(picked.map(x => x.name).sort());
  await expect(store.registerFiles('Dup', [picked[0], picked[0]])).rejects.toMatchObject({ code: 'exists' });
});

test('only one operation runs per workspace at a time', async () => {
  let release!: () => void;
  const held = store.exclusive(ws.id, 'Answering', () => new Promise<void>(r => { release = r; }));
  await expect(store.scan(ws)).rejects.toThrow(/Answering/);
  await expect(store.removeWorkspace(ws.id)).rejects.toMatchObject({ code: 'busy' });
  release();
  await held;
  await expect(store.scan(ws)).resolves.toBeTruthy();
});
