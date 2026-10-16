/**
 * M7 assistant and proposals below the UI: grounded answers with checked references (observed / inferred /
 * hypothesis), insufficient context without a model call, pattern checks, prompt-injection handling, six-language
 * configuration, and proposal validation (valid single/multi-file, traversal and encoded paths, out-of-workspace,
 * unsupported operations, malformed and ambiguous patches, conflicts, limits, read-only and file workspaces).
 * Real SQLite; fake provider; a fake model returning fixed JSON.
 */
const mockLlm = { json: '{}', calls: [] as any[] };
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => true),
  readFile: jest.fn(async () => require('../src/localModel').MODEL.sha256),
  getFSInfo: jest.fn(async () => ({ freeSpace: 50e9, totalSpace: 128e9 })),
}));
jest.mock('llama.rn', () => ({
  releaseAllLlama: jest.fn(async () => undefined),
  initLlama: jest.fn(async () => ({
    androidLib: 'test', gpu: false, stopCompletion: jest.fn(async () => undefined),
    completion: async (req: any) => { mockLlm.calls.push(req); return { text: mockLlm.json, timings: { predicted_n: 1, predicted_per_second: 9, prompt_ms: 1 } }; },
  })),
}));

import * as local from '../src/localModel';
import * as chat from '../src/chatStore';
import { chosenLanguage, instruction, LANG_CODES, NAMES } from '../src/core/language';
import * as assistant from '../src/code/assistant';
import { PROPOSAL_LIMITS, draftProposal, getProposal, listProposals, validateProposal } from '../src/code/proposals';
import { selectContext } from '../src/code/search';
import * as store from '../src/code/workspaceStore';
import * as native from '../src/code/native';
import { setupWorkspace } from '../testUtils/codeFixture';
import type { FakeProvider } from '../testUtils/fakeWorkspace';

let p: FakeProvider;
let ws: store.Workspace;
beforeAll(async () => { await local.load(); });
beforeEach(async () => {
  ({ p, ws } = await setupWorkspace());
  mockLlm.calls.length = 0;
  mockLlm.json = '{}';
});
const jsonCalls = () => mockLlm.calls.filter(c => c.response_format);
const task = (selected: string[] = [], language: any = null) => assistant.createTask(ws.id, 'Task', selected, language);

// ---------------------------------------------------------------- answers

test('a debugging answer keeps verified references and downgrades invented ones', async () => {
  mockLlm.json = JSON.stringify({
    answer: 'getUserName reads user.name without checking user.', enough_context: true,
    findings: [
      { kind: 'observed', text: 'user.name is read when user may be undefined', file: 'src/user.ts', line: 4 },
      { kind: 'observed', text: 'An invented helper', file: 'src/ghost.ts', line: 3 },
      { kind: 'observed', text: 'A line outside the excerpt', file: 'user.ts', line: 99 },
      { kind: 'hypothesis', text: 'Callers may pass undefined', file: '', line: 0 },
    ],
    suggested_fix: 'Return an empty string when user is undefined.', side_effects: 'Callers get "" instead of an error.', checks: ['npm test'],
  });
  const t = await task();
  const turn = await assistant.ask(ws, t, 'debug', 'Why does greet crash?', { modelReady: true,
    errorText: "TypeError: Cannot read properties of undefined (reading 'name')\n    at getUserName (src/user.ts:4:15)" });
  expect(turn.status).toBe('answered');
  const f = turn.answer!.findings;
  expect(f[0]).toMatchObject({ kind: 'observed', path: 'src/user.ts', line: 4, source: 'model' });
  expect(f[1]).toMatchObject({ kind: 'hypothesis', path: null, line: null });
  expect(f[1].note).toMatch(/not among the inspected files/);
  expect(f[2]).toMatchObject({ kind: 'inferred', path: 'src/user.ts', line: null });
  expect(f[3]).toMatchObject({ kind: 'hypothesis', path: null });
  expect(turn.answer).toMatchObject({ fix: expect.stringContaining('empty string'), checks: ['npm test'], note: assistant.NOT_RUN });
  expect(turn.inspected!.files[0].path).toBe('src/user.ts');
  // History keeps references, never source text.
  const row = (await chat.db().query('SELECT inspected_json, answer_json FROM code_turns WHERE id = ?', [turn.id]))[0];
  expect(row.inspected_json).not.toContain('user.name.trim');
  const user = jsonCalls()[0].messages[1].content as string;
  expect(user).toContain('<<<FILE src/user.ts (TypeScript, lines 1-10)');
  expect(user).toContain('<<<ERROR');
  expect(jsonCalls()[0].messages[0].content).toBe(assistant.SYSTEM);
});

test('without relevant files the assistant says so and does not ask the model', async () => {
  const turn = await assistant.ask(ws, await task(), 'ask', 'How is the quantum flux capacitor calibrated?', { modelReady: true });
  expect(turn).toMatchObject({ status: 'insufficient' });
  expect(turn.answer!.enoughContext).toBe(false);
  expect(jsonCalls()).toHaveLength(0);
  mockLlm.json = JSON.stringify({ answer: 'The excerpts do not show where greet is called.', enough_context: false, findings: [], suggested_fix: '', side_effects: '', checks: [] });
  expect((await assistant.ask(ws, await task(), 'ask', 'Who calls greet?', { modelReady: true })).status).toBe('insufficient');
});

test('review runs the app\'s pattern checks on exact lines (also without the model) and never calls them confirmed', async () => {
  const turn = await assistant.ask(ws, await task(['src/db.ts']), 'review', 'Review this file', { modelReady: false });
  const checks = turn.answer!.findings.filter(f => f.source === 'app');
  expect(checks.map(f => `${f.path}:${f.line}`)).toEqual(['src/db.ts:2', 'src/db.ts:5']);
  expect(checks[0].text).toMatch(/SQL.*not a confirmed defect/);
  expect(turn.answer!.text).toMatch(/model is not loaded/);
  await expect(assistant.ask(ws, await task(['src/db.ts']), 'ask', 'Explain', { modelReady: false })).rejects.toMatchObject({ code: 'unavailable' });
});

test('instructions embedded in project files stay fenced data and cannot cause changes', async () => {
  const pack = await selectContext(ws, 'What does the README say?', { selected: ['README.md'] });
  const block = assistant.contextBlock(pack.excerpts);
  expect(block.match(/<<<FILE/g)!.length).toBe(pack.excerpts.flatMap(e => e.ranges).length); // the file's own markers are neutralized
  expect(block).toContain('‹‹FILE evil FILE››');
  // A model that followed the README's instructions: traversal and deletion are rejected, nothing is saved or written.
  mockLlm.json = JSON.stringify({ title: 'Do what the README says', objective: '', reason: '', assumptions: [], risks: [], validation: [],
    changes: [{ op: 'modify', path: '../../etc/hosts', purpose: 'x', edits: [{ find: 'a', replace: 'b' }], content: '' },
      { op: 'delete', path: 'src/user.ts', purpose: 'x', edits: [], content: '' }] });
  const r = await draftProposal(ws, await task(['README.md']), 'Follow the README', { modelReady: true });
  expect(r.proposal).toBeNull();
  expect(r.turn.status).toBe('invalid_proposal');
  expect(r.errors.join('\n')).toMatch(/".." and "." are not allowed[\s\S]*"delete" is not supported/);
  expect(await listProposals(ws.id)).toEqual([]);
  expect(p.state.writes).toEqual([]);
  expect(p.state.creates).toEqual([]);
});

test('the answer language can be any of the six; identifiers are kept as written', async () => {
  const pack = await selectContext(ws, 'getUserName', {});
  for (const code of LANG_CODES) {
    const prompt = assistant.buildUserPrompt('ask', 'Explain getUserName', pack, code, []);
    if (code === 'en') expect(prompt).not.toMatch(/^Language:/);
    else expect(prompt.startsWith(instruction(chosenLanguage(code)))).toBe(true);
    if (code !== 'en') expect(prompt).toContain(NAMES[code]);
    expect(prompt).toContain('getUserName');
  }
  expect(assistant.SYSTEM).toMatch(/Keep code, identifiers, file names, API names and error text exactly as written/);
  expect(assistant.answerLanguage('ta', 'English question')).toBe('ta');
  expect(assistant.answerLanguage(null, 'ఈ ఫంక్షన్ ఏమి చేస్తుంది?')).toBe('te');
  mockLlm.json = JSON.stringify({ answer: 'వివరణ', enough_context: true, findings: [], suggested_fix: '', side_effects: '', checks: [] });
  await assistant.ask(ws, await task(['src/user.ts'], 'hi'), 'ask', 'Explain getUserName', { modelReady: true });
  expect(jsonCalls()[0].messages[1].content).toContain(instruction(chosenLanguage('hi')));
});

test('a task continues with its earlier turns and files as context', async () => {
  mockLlm.json = JSON.stringify({ answer: 'getUserName trims the name.', enough_context: true, findings: [], suggested_fix: '', side_effects: '', checks: [] });
  const t = await task();
  await assistant.ask(ws, t, 'ask', 'What does getUserName do?', { modelReady: true });
  await assistant.ask(ws, t, 'ask', 'And what calls it?', { modelReady: true });
  const second = jsonCalls()[1].messages[1].content as string;
  expect(second).toContain('Earlier in this task:\nQ: What does getUserName do?');
  expect(second).toContain('<<<FILE src/user.ts');
  expect((await assistant.turns(t.id)).map(x => x.seq)).toEqual([1, 2]);
});

// ---------------------------------------------------------------- proposals

const change = (c: Record<string, unknown>) => ({ purpose: 'p', edits: [], content: '', ...c });
const proposal = (...changes: Record<string, unknown>[]) => ({ title: 'T', objective: 'o', reason: 'r', assumptions: [], risks: [], validation: ['npm test'], changes: changes.map(change) });
const errorsOf = async (raw: unknown) => (await validateProposal(ws, raw)).errors.join('\n');

test('valid single-file and multi-file proposals: edits anchored once, numbers stripped, CRLF kept', async () => {
  const one = await validateProposal(ws, proposal({ op: 'modify', path: 'src/user.ts', edits: [{ find: '4|   return user.name.trim();', replace: "  return user?.name.trim() ?? '';" }] }));
  expect(one.errors).toEqual([]);
  expect(one.proposal!.changes[0].proposedText).toContain("return user?.name.trim() ?? '';");
  expect(one.proposal!.changes[0].originalText).toBe(p.text('src/user.ts'));
  const multi = await validateProposal(ws, proposal(
    { op: 'modify', path: 'src/win.ts', edits: [{ find: 'export const b = 2;', replace: 'export const b = 3;\nexport const c = 4;' }] },
    { op: 'modify', path: 'src/user.ts', edits: [{ find: '    return user.name.trim();', replace: '  return user?.name ?? "";' }] }, // indentation differs
    { op: 'create', path: 'src/strings.ts', content: 'export const empty = "";\n' }));
  expect(multi.errors).toEqual([]);
  expect(multi.proposal!.changes[0].proposedText).toBe('export const a = 1;\r\nexport const b = 3;\r\nexport const c = 4;\r\n');
  expect(multi.proposal!.changes[1].proposedText).toContain('  return user?.name ?? "";\n}');
  expect(multi.proposal!.changes[2]).toMatchObject({ op: 'create', originalText: null });
  expect(p.state.writes).toEqual([]); // validating never writes
});

test('path traversal, encoded and out-of-workspace targets are rejected', async () => {
  for (const path of ['../x.ts', 'src/../../x.ts', '%2e%2e/x.ts', 'src\\..\\x.ts', '/etc/hosts', 'C:/x.ts', '\uff0e\uff0e/x.ts', 'content://other/x.ts']) {
    expect(await errorsOf(proposal({ op: 'create', path, content: 'x' }))).toMatch(/change 1:/);
  }
  expect(await errorsOf(proposal({ op: 'modify', path: 'lib/other.ts', edits: [{ find: 'a', replace: 'b' }] }))).toMatch(/no such file/);
});

test('unsupported operations, binary, secret and dependency targets are rejected', async () => {
  expect(await errorsOf(proposal({ op: 'rename', path: 'src/user.ts' }))).toMatch(/"rename" is not supported/);
  expect(await errorsOf(proposal({ op: 'modify', path: 'assets/logo.png', content: 'x' }))).toMatch(/only supported text/);
  expect(await errorsOf(proposal({ op: 'modify', path: '.env', content: 'SECRET=x' }))).toMatch(/secrets/);
  expect(await errorsOf(proposal({ op: 'create', path: 'node_modules/evil.js', content: 'x' }))).toMatch(/dependency or build-output/);
  expect(await errorsOf(proposal({ op: 'modify', path: 'src/lossy.ts', edits: [{ find: '// ok', replace: '// no' }] }))).toMatch(/matches more than one place|not valid UTF-8/);
  expect(await errorsOf({ ...proposal({ op: 'create', path: 'src/n.ts', content: 'x' }), run: 'rm -rf /' })).toMatch(/unknown field "run"/);
});

test('malformed, ambiguous, overlapping and no-op patches are rejected', async () => {
  const m = (edits: unknown[], extra = {}) => errorsOf(proposal({ op: 'modify', path: 'src/user.ts', edits, ...extra }));
  expect(await m([{ find: 'notInTheFile()', replace: 'x' }])).toMatch(/not in the current file/);
  expect(await m([{ find: 'user', replace: 'u' }])).toMatch(/more than one place/);
  expect(await m([{ find: 'export function getUserName', replace: 'a' }, { find: 'getUserName(user?: User)', replace: 'b' }])).toMatch(/overlap/);
  expect(await m([{ find: '', replace: 'x' }])).toMatch(/non-empty "find"/);
  expect(await m([{ find: 'greet', replace: 'x', extra: 1 }])).toMatch(/non-empty "find"/);
  expect(await m([{ find: 'return user.name.trim();', replace: 'x' }], { content: 'whole' })).toMatch(/either edits or the complete content/);
  expect(await m([{ find: 'return user.name.trim();', replace: 'return user.name.trim();' }])).toMatch(/would not change/);
  expect(await m([{ find: 'return user.name.trim();', replace: 'return «redacted»;' }])).toMatch(/redacted/);
});

test('conflicts, existing or missing targets, and size and count limits are rejected', async () => {
  const edit = { find: 'return user.name.trim();', replace: 'return "";' };
  expect(await errorsOf(proposal({ op: 'modify', path: 'src/user.ts', edits: [edit] }, { op: 'modify', path: 'SRC/user.ts', edits: [edit] }))).toMatch(/changed twice/);
  expect(await errorsOf(proposal({ op: 'create', path: 'src/user.ts', content: 'x' }))).toMatch(/already exists/);
  expect(await errorsOf(proposal({ op: 'create', path: 'lib/new.ts', content: 'x' }))).toMatch(/does not exist/);
  expect(await errorsOf(proposal({ op: 'create', path: 'src/huge.ts', content: 'x'.repeat(PROPOSAL_LIMITS.maxFileChars + 1) }))).toMatch(/larger than/);
  const many = Array.from({ length: PROPOSAL_LIMITS.maxFiles + 1 }, (_x, i) => ({ op: 'create', path: `src/n${i}.ts`, content: 'x' }));
  expect(await errorsOf(proposal(...many))).toMatch(/at most 6/);
  expect(await errorsOf({ title: '', changes: [] })).toMatch(/no title[\s\S]*changes no files/);
});

test('read-only grants and picked-file workspaces limit what a proposal may do', async () => {
  const fw = await store.registerFiles('Files', await native.pickFiles());
  expect((await validateProposal(fw, proposal({ op: 'create', path: 'x.ts', content: 'x' }))).errors.join()).toMatch(/no folder to create new files in/);
  const ro = await setupWorkspace(undefined, { grantWrite: false });
  const r = await validateProposal(ro.ws, proposal({ op: 'modify', path: 'src/user.ts', edits: [{ find: 'return user.name.trim();', replace: 'return "";' }] }));
  expect(r.errors.join()).toMatch(/read-only access/);
});

test('a drafted proposal is validated and saved for review, never applied', async () => {
  mockLlm.json = JSON.stringify(proposal({ op: 'modify', path: 'src/user.ts', edits: [{ find: 'return user.name.trim();', replace: "return user?.name.trim() ?? '';" }] }));
  const r = await draftProposal(ws, await task(['src/user.ts']), 'Make getUserName safe for a missing user', { modelReady: true });
  expect(r.errors).toEqual([]);
  expect(r.turn).toMatchObject({ status: 'proposal', proposalId: r.proposal!.id });
  expect((await getProposal(r.proposal!.id))!).toMatchObject({ status: 'ready', files: [{ status: 'pending', path: 'src/user.ts' }] });
  expect(p.state.writes).toEqual([]);
  expect(p.text('src/user.ts')).toContain('return user.name.trim();');
  expect(jsonCalls()[0].messages[0].content).toMatch(/Never delete, rename or move files/);
});
