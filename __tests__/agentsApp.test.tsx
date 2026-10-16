/**
 * Agents in the real app (Jest): the real App, real SQLite and knowledge library; fakes for the model (llama.rn,
 * including its JSON planner output), the file reader/saver (AiDocsModule) and RNFS. Proves the UI wiring of plans,
 * approval, progress, confirmation of writes, cancel, history and the agent editor; not model quality.
 */
import ReactTestRenderer from 'react-test-renderer';
import { Alert, NativeModules, Text } from 'react-native';
import { sqliteDb } from '../testUtils/sqliteDb';

const mockLlm = { plan: '', hang: false, release: null as null | (() => void), stops: 0 };
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => true),
  readFile: jest.fn(async () => require('../src/localModel').MODEL.sha256),
  getFSInfo: jest.fn(async () => ({ freeSpace: 50e9, totalSpace: 128e9 })),
}));
jest.mock('llama.rn', () => ({
  releaseAllLlama: jest.fn(async () => undefined),
  initLlama: jest.fn(async () => ({
    androidLib: 'test', gpu: false,
    stopCompletion: async () => { mockLlm.stops++; mockLlm.release?.(); },
    completion: async (req: any, onToken?: (d: { token: string }) => void) => {
      if (req.response_format) return { text: mockLlm.plan, timings: { predicted_n: 1, predicted_per_second: 9, prompt_ms: 1 } };
      const last = req.messages[req.messages.length - 1].content as string;
      if (/three words/.test(last)) return { text: 'Hi there friend', timings: { predicted_n: 3, predicted_per_second: 9, prompt_ms: 1 } };
      if (mockLlm.hang) await new Promise<void>(r => { mockLlm.release = r; });
      const text = 'Refunds are possible within 30 days [1].';
      onToken?.({ token: text });
      return { text, timings: { predicted_n: 8, predicted_per_second: 9, prompt_ms: 1 } };
    },
  })),
}));

import * as chat from '../src/chatStore';
import { importFiles } from '../src/knowledge/indexer';
import * as agentStore from '../src/agents/agentStore';
import App from '../App';

const files = new Map<string, string>([['content://d/refunds.txt', 'Refund policy\n\nCustomers can request a refund within 30 days.']]);
const saved: string[] = [];
const fakeDocs = {
  readText: jest.fn(async (uri: string) => ({ text: files.get(uri)!, bytes: 50, sha256: `sha-${uri}`, lossy: false })),
  readPdf: jest.fn(), pick: jest.fn(async () => []), info: jest.fn(), release: jest.fn(),
  createTextFile: jest.fn(async (name: string) => { saved.push(name); return { uri: `content://saved/${name}`, name, mime: 'text/plain', size: 1 }; }),
};
const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
beforeEach(async () => {
  const fs = node('fs'), os = node('os'), path = node('path');
  chat.setDb(sqliteDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agapp-')), 'chat.db')));
  NativeModules.AiDocs = fakeDocs;
  NativeModules.AiDevice = { connectivity: jest.fn(async () => 'offline'), keepScreenOn: jest.fn() };
  (globalThis as any).fetch = jest.fn(async () => { throw new Error('no network'); });
  Object.assign(mockLlm, { plan: '', hang: false, release: null, stops: 0 });
  saved.length = 0;
  fakeDocs.createTextFile.mockClear();
  alerts.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  await importFiles([{ uri: 'content://d/refunds.txt', name: 'refunds.txt', mime: null, size: 50 }]);
});
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => ReactTestRenderer.act(async () => { mounted.splice(0).forEach(r => r.unmount()); }));

const settle = (ms = 30) => ReactTestRenderer.act(async () => { await new Promise<void>(r => setTimeout(() => r(), ms)); });
async function mount() {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { r = ReactTestRenderer.create(<App />); });
  mounted.push(r);
  await settle();
  const all = (label: string) => r.root.findAll(n => n.props.accessibilityLabel === label && typeof (n.props.onPress ?? n.props.onChangeText ?? n.props.onValueChange) === 'function');
  const byLabel = (label: string) => all(label).filter(n => !hidden(n))[0];
  const hidden = (n: ReactTestRenderer.ReactTestInstance): boolean => {
    for (let p: any = n; p; p = p.parent) if ([].concat(p.props?.style ?? []).flat().some((s: any) => s?.display === 'none')) return true;
    return false;
  };
  const press = async (label: string) => {
    const n = byLabel(label);
    if (!n) throw new Error(`no visible "${label}":\n${screen()}`);
    await ReactTestRenderer.act(async () => n.props.onPress());
    await settle();
  };
  /** Press without waiting for the work it starts (a run waiting for "Allow", or a step that hangs). */
  const tap = async (label: string) => {
    const n = byLabel(label);
    if (!n) throw new Error(`no visible "${label}":
${screen()}`);
    ReactTestRenderer.act(() => { n.props.onPress(); });
    await settle(60);
  };
  const type = (label: string, text: string) => ReactTestRenderer.act(async () => byLabel(label).props.onChangeText(text));
  const toggle = (label: string) => ReactTestRenderer.act(async () => byLabel(label).props.onValueChange(true));
  const screen = () => r.root.findAllByType(Text).filter(t => !hidden(t))
    .map(t => [].concat(t.props.children).flat().filter((x: any) => typeof x === 'string' || typeof x === 'number').join('')).join('\n');
  return { press, tap, type, toggle, screen, byLabel };
}
const pressAlert = (button: string) => ReactTestRenderer.act(async () => {
  const call = alerts.mock.calls[alerts.mock.calls.length - 1];
  await (call[2] as any[]).find(b => b.text === button).onPress?.();
});
const MODEL_PLAN = JSON.stringify({ steps: [
  { tool: 'docs.search', input: { query: 'refund days' }, purpose: 'Find refund rules' },
  { tool: 'docs.answer', input: { question: 'How many days for a refund?' }, fromStep: 1, purpose: 'Answer' }] });

test('agents list, plan by the model, run with progress, answer with sources, open a source and come back', async () => {
  mockLlm.plan = MODEL_PLAN;
  const a = await mount();
  await a.press('Agents');
  expect(a.screen()).toContain('Document assistant');
  expect(a.screen()).toContain('Calculator and clock');
  await a.press('Run agent Document assistant');
  await a.type('Agent task', 'How many days for a refund?');
  await a.press('Plan task');
  expect(a.screen()).toContain('Plan proposed by the on-device model and checked by the app.');
  expect(a.screen()).toContain('1. Find refund rules · Planned');
  expect(a.screen()).toContain('2. Answer · Planned');
  await a.press('Run plan');
  await settle(60);
  expect(a.screen()).toContain('1. Find refund rules · Done');
  expect(a.screen()).toContain('2. Answer · Done');
  expect(a.screen()).toContain('Succeeded');
  expect(a.screen()).toContain('Refunds are possible within 30 days [1].');
  await a.press('Open source 1: refunds.txt, passage 1');
  expect(a.screen()).toContain('Passage 1 of 1');
  await a.press('Back');
  expect(a.screen()).toContain('Succeeded'); // the run screen kept its result
  const runs = await agentStore.listRuns(null);
  expect(runs[0]).toMatchObject({ status: 'succeeded', task: 'How many days for a refund?' });
});

test('an unusable model plan falls back to the default plan, labelled so', async () => {
  mockLlm.plan = '{"steps": [{"tool": "shell", "input": {}}]}';
  const a = await mount();
  await a.press('Agents');
  await a.press('Run agent Document assistant');
  await a.type('Agent task', 'refund days');
  await a.press('Plan task');
  expect(a.screen()).toMatch(/Default plan \(fixed app rules\)\. The model's plan was rejected \(Step 1: unknown tool "shell"\.\)/);
});

test('no evidence is reported as such, not as success', async () => {
  mockLlm.plan = JSON.stringify({ steps: [{ tool: 'docs.search', input: { query: 'peru capital' } },
    { tool: 'docs.answer', input: { question: 'capital of Peru?' }, fromStep: 1 }] });
  const a = await mount();
  await a.press('Agents');
  await a.press('Run agent Document assistant');
  await a.type('Agent task', 'What is the capital of Peru?');
  await a.press('Plan task');
  await a.press('Run plan');
  await settle(60);
  expect(a.screen()).toContain('Not found in documents');
  expect(a.screen()).toContain("I couldn't find anything about this in your documents");
  expect(a.screen()).toContain('Skipped');
  expect(a.screen()).not.toContain('Succeeded');
});

test('saving a file asks first; "Don\'t allow" writes nothing; re-run and "Allow" saves', async () => {
  mockLlm.plan = JSON.stringify({ steps: [{ tool: 'docs.search', input: { query: 'refund' } },
    { tool: 'docs.answer', input: { question: 'refund rules?' }, fromStep: 1 },
    { tool: 'file.export', input: { fileName: 'refunds-notes.txt' }, fromStep: 2 }] });
  const a = await mount();
  await a.press('Agents');
  await a.press('Run agent Notes writer');
  await a.type('Agent task', 'Summarize the refund rules and save them as a note file');
  await a.press('Plan task');
  await a.tap('Run plan');
  const ask = alerts.mock.calls[alerts.mock.calls.length - 1];
  expect(ask[0]).toBe('Allow step 3: Save as a text file?');
  expect(ask[1]).toMatch(/Save "refunds-notes.txt" .* an existing file is never replaced/);
  await pressAlert("Don't allow");
  await settle(60);
  expect(a.screen()).toContain('Cancelled');
  expect(fakeDocs.createTextFile).not.toHaveBeenCalled();
  await a.tap('Re-run task');
  await pressAlert('Allow');
  await settle(60);
  expect(saved).toEqual(['refunds-notes.txt']);
  expect(a.screen()).toContain('Succeeded');
  expect(a.byLabel('Re-run task')).toBeUndefined(); // a run that wrote a file is not offered for re-run
});

test('Cancel stops a running task; leaving the screen also cancels', async () => {
  mockLlm.plan = MODEL_PLAN;
  mockLlm.hang = true;
  const a = await mount();
  await a.press('Agents');
  await a.press('Run agent Document assistant');
  await a.type('Agent task', 'refund days');
  await a.press('Plan task');
  await a.tap('Run plan');
  expect(a.screen()).toContain('2. Answer · Running…');
  await a.press('Cancel task');
  await settle(60);
  expect(a.screen()).toContain('2. Answer · Cancelled');
  expect(mockLlm.stops).toBeGreaterThanOrEqual(1);
  // leave while running
  mockLlm.release = null;
  await a.tap('Re-run task');
  await a.press('Back');
  await settle(60);
  const runs = await agentStore.listRuns(null);
  expect(runs[0].status).toBe('cancelled');
});

test('agent editor: validation before saving, save, edit (version), duplicate, test, delete', async () => {
  const a = await mount();
  await a.press('Agents');
  await a.press('New agent');
  expect(a.screen()).toContain('• Name is required.');
  expect(a.screen()).toContain('• Enable at least one tool.');
  expect(a.byLabel('Save agent').props.disabled).toBe(true);
  await a.type('Agent name', 'Document assistant');
  expect(a.screen()).toContain('• Another agent already has this name.');
  await a.type('Agent name', 'Math helper');
  await a.toggle('Tool Calculator');
  await a.press('Increase Maximum steps');
  await a.press('Increase Maximum steps');
  await a.press('Increase Maximum steps');
  await a.press('Increase Maximum steps'); // capped at the application bound
  expect(a.screen()).not.toContain('•');
  await a.press('Save agent');
  let saved1 = (await agentStore.listAgents()).find(x => x.name === 'Math helper')!;
  expect(saved1).toMatchObject({ version: 1, tools: ['calculator'], limits: { maxSteps: 6 } });
  await a.type('Agent purpose', 'Sums');
  await a.press('Save agent');
  saved1 = (await agentStore.getAgent(saved1.id))!;
  expect(saved1).toMatchObject({ version: 2, purpose: 'Sums' });
  expect((await agentStore.listAgents()).filter(x => x.name === 'Math helper')).toHaveLength(1); // not created twice
  await a.press('Test agent');
  expect((a.byLabel('Agent task').props.value as string)).toBe('What is 15% of 240?');
  await a.press('Back');
  await a.press('Duplicate agent');
  expect(a.byLabel('Agent name').props.value).toBe('Copy of Math helper');
  await a.press('Save agent');
  await a.press('Back');
  await a.press('Delete agent');
  await pressAlert('Delete');
  await settle();
  const names = (await agentStore.listAgents()).map(x => x.name);
  expect(names).toContain('Copy of Math helper');
  expect(names).not.toContain('Math helper');
});

test('a disabled agent cannot be run', async () => {
  const doc = (await agentStore.listAgents()).find(x => x.name === 'Document assistant')!;
  await agentStore.saveAgent({ ...doc, enabled: false });
  const a = await mount();
  await a.press('Agents');
  expect(a.screen()).toContain('Document assistant (disabled)');
  expect(a.byLabel('Run agent Document assistant').props.disabled).toBe(true);
});

test('the calculator agent runs without asking (plan confirmation off) and gives the exact result', async () => {
  const a = await mount();
  await a.press('Agents');
  await a.press('Run agent Calculator and clock');
  await a.type('Agent task', 'What is 12.5% of 80?');
  mockLlm.plan = JSON.stringify({ steps: [{ tool: 'calculator', input: { expression: '12.5% of 80' } }] });
  await a.press('Plan task');
  await settle(60);
  expect(a.screen()).toContain('Succeeded');
  expect(a.screen()).toContain('12.5% of 80 = 10');
});

test('developer model evaluation runs every case through the app prompts and reports automated checks', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const a = await mount();
  await a.press('Agents');
  await a.press('Model evaluation');
  await a.press('Run model evaluation');
  await settle(300);
  const lines = log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('LOCALAI_EVAL '));
  const done = JSON.parse(lines[lines.length - 1].slice('LOCALAI_EVAL '.length));
  expect(done).toMatchObject({ kind: 'done', cases: 30, of: 30, stopped: false });
  expect(a.screen()).toMatch(/en: \d+\/\d+ checks/);
  expect(a.screen()).toContain('te-docs · docs');
});
