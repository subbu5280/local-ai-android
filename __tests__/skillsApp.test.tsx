/**
 * Skills and workflows in the real app (Jest): the real App with real SQLite and knowledge library; fakes for the
 * model (llama.rn incl. JSON drafts), the file picker/saver (AiDocsModule) and the share sheet. UI wiring only.
 */
import ReactTestRenderer from 'react-test-renderer';
import { Alert, NativeModules, Share, Text } from 'react-native';
import { sqliteDb } from '../testUtils/sqliteDb';

const mockLlm = { draft: '', hang: false, release: null as null | (() => void) };
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async (p: string) => !p.includes('multilingual-e5')),
  readFile: jest.fn(async () => require('../src/localModel').MODEL.sha256),
  getFSInfo: jest.fn(async () => ({ freeSpace: 50e9, totalSpace: 128e9 })),
}));
jest.mock('llama.rn', () => ({
  releaseAllLlama: jest.fn(async () => undefined),
  initLlama: jest.fn(async () => ({
    androidLib: 'test', gpu: false,
    stopCompletion: async () => { mockLlm.release?.(); },
    completion: async (req: any) => {
      if (req.response_format) return { text: mockLlm.draft, timings: { predicted_n: 1, predicted_per_second: 9, prompt_ms: 1 } };
      const last = req.messages[req.messages.length - 1].content as string;
      if (/three words/.test(last)) return { text: 'Hi there friend', timings: { predicted_n: 3, predicted_per_second: 9, prompt_ms: 1 } };
      if (mockLlm.hang) await new Promise<void>(r => { mockLlm.release = r; });
      const text = /<<<RESULT/.test(last) ? 'Q1. How long? A: 30 days [1].' : /<<<TEXT/.test(last) ? 'Refunds within 30 days [1].' : 'They agree on 30 days [1][2].';
      return { text, timings: { predicted_n: 8, predicted_per_second: 9, prompt_ms: 1 } };
    },
  })),
}));

import * as chat from '../src/chatStore';
import { importFiles } from '../src/knowledge/indexer';
import * as agentStore from '../src/agents/agentStore';
import * as store from '../src/skills/skillStore';
import { BUILTIN_SKILLS } from '../src/skills/builtins';
import App from '../App';

const files = new Map([['content://d/refunds.txt', 'Refund policy. Customers can request a refund within 30 days of purchase.'],
  ['content://d/store.txt', 'Store rules: a refund is possible for 30 days after purchase with a receipt.']]);
const saved: string[] = [];
const fakeDocs = {
  readText: jest.fn(async (uri: string) => ({ text: files.get(uri)!, bytes: 50, sha256: `sha-${uri}`, lossy: false })),
  readPdf: jest.fn(), pick: jest.fn(async () => []), info: jest.fn(), release: jest.fn(),
  createTextFile: jest.fn(async (name: string, _m: string, text: string) => { saved.push(`${name}:${text}`); return { uri: `content://s/${name}`, name, mime: 'text/plain', size: 1 }; }),
};
const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
const share = jest.spyOn(Share, 'share').mockImplementation(async () => ({ action: 'sharedAction' }) as any);
const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
beforeEach(async () => {
  const fs = node('fs'), os = node('os'), path = node('path');
  chat.setDb(sqliteDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skapp-')), 'chat.db')));
  NativeModules.AiDocs = fakeDocs;
  NativeModules.AiDevice = { connectivity: jest.fn(async () => 'offline'), keepScreenOn: jest.fn() };
  (globalThis as any).fetch = jest.fn(async () => { throw new Error('no network'); });
  Object.assign(mockLlm, { draft: '', hang: false, release: null });
  saved.length = 0;
  alerts.mockClear();
  share.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await importFiles([...files.keys()].map(uri => ({ uri, name: uri.split('/').pop()!, mime: null, size: 50 })));
});
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => ReactTestRenderer.act(async () => { mounted.splice(0).forEach(r => r.unmount()); }));

const settle = (ms = 40) => ReactTestRenderer.act(async () => { await new Promise<void>(r => setTimeout(() => r(), ms)); });
async function mount() {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { r = ReactTestRenderer.create(<App />); });
  mounted.push(r);
  await settle();
  const hidden = (n: ReactTestRenderer.ReactTestInstance): boolean => {
    for (let p: any = n; p; p = p.parent) if ([].concat(p.props?.style ?? []).flat().some((s: any) => s?.display === 'none')) return true;
    return false;
  };
  const byLabel = (label: string) => r.root.findAll(n => n.props.accessibilityLabel === label && typeof (n.props.onPress ?? n.props.onChangeText ?? n.props.onValueChange) === 'function').filter(n => !hidden(n))[0];
  const screen = () => r.root.findAllByType(Text).filter(t => !hidden(t))
    .map(t => [].concat(t.props.children).flat().filter((x: any) => typeof x === 'string' || typeof x === 'number').join('')).join('\n');
  const press = async (label: string) => {
    const n = byLabel(label);
    if (!n) throw new Error(`no visible "${label}":\n${screen()}`);
    await ReactTestRenderer.act(async () => n.props.onPress());
    await settle();
  };
  const tap = async (label: string) => { const n = byLabel(label); if (!n) throw new Error(`no "${label}"`); ReactTestRenderer.act(() => { n.props.onPress(); }); await settle(80); };
  const type = (label: string, text: string) => ReactTestRenderer.act(async () => byLabel(label).props.onChangeText(text));
  const toggle = (label: string, v: boolean) => ReactTestRenderer.act(async () => byLabel(label).props.onValueChange(v));
  return { press, tap, type, toggle, screen, byLabel };
}
const pressAlert = (button: string) => ReactTestRenderer.act(async () => {
  const call = alerts.mock.calls[alerts.mock.calls.length - 1];
  await (call[2] as any[]).find(b => b.text === button).onPress?.();
});

test('skills tab: built-ins with tools and permissions; run a document skill; sources; history; delete history', async () => {
  const a = await mount();
  await a.press('Agents');
  await a.press('Skills tab');
  expect(a.screen()).toContain('Summarize documents on a topic · TE HI');
  expect(a.screen()).toContain('Tools: Search documents, Summarize · Permissions: documents.read, model.generate');
  await a.press('Run skill doc-summary');
  await a.type('Input topic', 'refund');
  await a.press('Run this skill');
  await settle(80);
  expect(a.screen()).toContain('1. Find relevant passages · Done');
  expect(a.screen()).toContain('Refunds within 30 days [1].');
  expect(a.screen()).toContain('Sources (retrieved from your documents):');
  const cited = a.screen().match(/\[1\] (\S+), passage 1/)![1]; // whichever document the search ranked first
  await a.press(`Open source 1: ${cited}, passage 1`);
  expect(a.screen()).toContain('Passage 1 of 1');
  await a.press('Back');
  expect(a.screen()).toContain('Past runs');
  await a.press('Delete run history');
  await pressAlert('Delete');
  await settle();
  expect(await agentStore.listSourceRuns('skill', 'doc-summary')).toEqual([]);
});

test('create a skill with the form: validation first, then save; names in another language; test on a sample', async () => {
  const a = await mount();
  await a.press('Agents');
  await a.press('Skills tab');
  await a.press('New skill');
  expect(a.screen()).toContain('• name.en (English) is required');
  expect(a.byLabel('Save skill').props.disabled).toBe(true);
  await a.type('Name in English', 'Short summary');
  await a.press('Add input');
  await a.type('Input 1 name', 'text');
  await a.press('Add step');
  await a.press('Add tool text.summarize');
  await a.type('Step 1 text', '{{text}}');
  await a.type('Step 1 maxWords', '40');
  expect(a.screen()).toContain('Requires tools: text.summarize · permissions: model.generate');
  await a.press('Edit texts in Telugu');
  await a.type('Name in Telugu', 'చిన్న సారాంశం');
  expect(a.byLabel('Save skill').props.disabled).toBe(false);
  await a.press('Save skill');
  const s = (await store.listSkills()).find(x => x.id === 'short-summary')!;
  expect(s.def).toMatchObject({ name: { en: 'Short summary', te: 'చిన్న సారాంశం' }, tools: ['text.summarize'], permissions: ['model.generate'],
    steps: [{ tool: 'text.summarize', input: { text: '{{text}}', maxWords: 40 } }] });
  await a.press('Test skill');
  expect(a.byLabel('Input text').props.value).toMatch(/Local AI runs a small model/);
});

test('import: hostile JSON is refused with reasons; a valid one shows its tools; conflicts offer replace or copy; export shares JSON', async () => {
  const a = await mount();
  await a.press('Agents');
  await a.press('Skills tab');
  await a.press('Import skill');
  await a.type('Definition JSON', JSON.stringify({ ...BUILTIN_SKILLS[0], id: 'evil', tools: ['shell.exec'], permissions: [], code: 'rm -rf /' }));
  await a.press('Check definition');
  expect(a.screen()).toContain('• skill: unknown field "code"');
  expect(a.screen()).toContain('• requires tool "shell.exec", which this app does not have');
  expect(a.byLabel('Confirm import')).toBeUndefined();
  await a.type('Definition JSON', JSON.stringify({ ...BUILTIN_SKILLS[2], id: 'pasted-summary' }));
  await a.press('Check definition');
  expect(a.screen()).toContain('Needs tools: text.summarize · permissions: model.generate');
  await a.press('Confirm import');
  expect((await store.listSkills()).some(x => x.id === 'pasted-summary')).toBe(true);
  await a.press('Import skill');
  await a.type('Definition JSON', JSON.stringify({ ...BUILTIN_SKILLS[2], id: 'pasted-summary' }));
  await a.press('Check definition');
  expect(a.screen()).toContain('A skill with this id already exists.');
  await a.press('Import as a copy');
  expect((await store.listSkills()).some(x => x.id === 'pasted-summary-copy')).toBe(true);
  await a.press('Export skill pasted-summary');
  await pressAlert('Share');
  expect(JSON.parse(share.mock.calls[0][0].message!)).toMatchObject({ format: 'localai.skill', id: 'pasted-summary' });
});

test('workflow builder: skill + tool steps, typed reference, reorder keeps references, save and run', async () => {
  const a = await mount();
  await a.press('Agents');
  await a.press('Workflows tab');
  await a.press('New workflow');
  await a.type('Name in English', 'My study notes');
  await a.press('Add input');
  await a.type('Input 1 name', 'topic');
  await a.press('Add step');
  await a.press('Add tool text.compose');
  await a.type('Step 1 instruction', 'Make two study questions.');
  await a.press('Add step');
  await a.press('Add skill doc-summary');
  await a.type('Step 2 topic', '{{topic}}');
  expect(a.screen()).toContain('• steps[1]: text.compose needs the result of an earlier step (fromStep)');
  await a.press('Move step 2 up'); // the skill now comes first
  await a.press('Step 2 uses step 1');
  expect(a.screen()).not.toContain('•');
  await a.press('Save workflow');
  const wf = (await store.listWorkflows()).find(x => x.id === 'my-study-notes')!;
  expect(wf.def!.steps).toEqual([{ skill: 'doc-summary', skillVersion: 1, inputs: { topic: '{{topic}}' } },
    { tool: 'text.compose', input: { instruction: 'Make two study questions.' }, fromStep: 1 }]);
  await a.press('Back');
  await a.press('Run workflow my-study-notes');
  await a.type('Input topic', 'refund');
  await a.press('Run this workflow');
  await settle(80);
  expect(a.screen()).toContain('Succeeded');
  expect(a.screen()).toContain('Q1. How long? A: 30 days [1].');
  expect(a.screen()).toContain('⚠ Step 3: Rewritten from document-based text: check its claims against the listed sources.');
});

test('report workflow asks before saving; deny cancels; re-run and allow saves with sources; cancel stops a run', async () => {
  const a = await mount();
  await a.press('Agents');
  await a.press('Workflows tab');
  await a.press('Run workflow research-report');
  await a.type('Input topic', 'refund');
  await a.tap('Run this workflow');
  expect(alerts.mock.calls[alerts.mock.calls.length - 1][0]).toBe('Allow step 3: Save as a text file?');
  await pressAlert("Don't allow");
  await settle(60);
  expect(a.screen()).toContain('Cancelled');
  expect(saved).toEqual([]);
  await a.tap('Re-run');
  await pressAlert('Allow');
  await settle(60);
  expect(saved[0]).toMatch(/^research-report.txt:They agree on 30 days \[1\]\[2\]\.\n\nSources:\n\[1\]/);
  expect(a.byLabel('Re-run')).toBeUndefined();
  const runs = await agentStore.listSourceRuns('workflow', 'research-report');
  expect((await agentStore.getRun(runs[0].id))!.retryOf).toBe(runs[1].id); // the retry is recorded
  mockLlm.hang = true;
  await a.tap('Run this workflow');
  await a.press('Cancel run');
  await settle(60);
  expect(a.screen()).toContain('Cancelled');
});

test('a workflow whose skill is switched off is shown invalid with the reason and cannot run', async () => {
  await store.setEnabled('skill', 'doc-compare', false);
  const a = await mount();
  await a.press('Agents');
  await a.press('Workflows tab');
  expect(a.screen()).toContain('• steps[1]: skill "doc-compare" is disabled');
  expect(a.byLabel('Run workflow research-report').props.disabled).toBe(true);
});

test('describe a workflow: the draft is shown for review, saved only on request, then ready to run', async () => {
  mockLlm.draft = JSON.stringify({ name: 'Refund comparison', steps: [{ skill: 'doc-compare', input: { topic: 'refunds' }, expect: 'a comparison with sources' }] });
  const a = await mount();
  await a.press('Agents');
  await a.press('Workflows tab');
  await a.press('Describe a workflow');
  await a.type('Workflow request', 'Compare what my documents say about refunds');
  await a.press('Make draft');
  expect(a.screen()).toContain('Refund comparison (drafted by the model)');
  expect(a.screen()).toContain('→ a comparison with sources');
  expect((await store.listWorkflows()).length).toBe(3); // not saved yet
  await a.press('Save draft');
  expect((await store.listWorkflows()).length).toBe(4);
  expect(a.byLabel('Run this workflow')).toBeTruthy();
});
