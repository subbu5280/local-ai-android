/**
 * The coding assistant in the real app (Jest): add a folder through the (fake) picker, ask a debugging question and
 * open its file reference, get a proposal, cancel the approval (nothing changes), approve it (the file changes),
 * restore the original, and remove the workspace. Fakes: model (llama.rn), document provider, alerts. UI wiring only.
 */
import ReactTestRenderer from 'react-test-renderer';
import { Alert, NativeModules, Text } from 'react-native';
import { sqliteDb } from '../testUtils/sqliteDb';
import { fakeProvider, installProvider, type FakeProvider } from '../testUtils/fakeWorkspace';
import { FIXTURE } from '../testUtils/codeFixture';

const mockLlm = { json: '{}' };
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
    androidLib: 'test', gpu: false, stopCompletion: async () => undefined,
    completion: async (req: any) => ({ text: req.response_format ? mockLlm.json : 'Hi there friend', timings: { predicted_n: 3, predicted_per_second: 9, prompt_ms: 1 } }),
  })),
}));

import * as chat from '../src/chatStore';
import App from '../App';

let p: FakeProvider;
const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
beforeEach(() => {
  const fs = node('fs'), os = node('os'), path = node('path');
  chat.setDb(sqliteDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codeapp-')), 'chat.db')));
  p = fakeProvider(FIXTURE);
  installProvider(p);
  NativeModules.AiDevice = { connectivity: jest.fn(async () => 'offline'), keepScreenOn: jest.fn() };
  (globalThis as any).fetch = jest.fn(async () => { throw new Error('no network'); });
  alerts.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
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
    for (let x: any = n; x; x = x.parent) if ([].concat(x.props?.style ?? []).flat().some((s: any) => s?.display === 'none')) return true;
    return false;
  };
  const byLabel = (label: string) => r.root.findAll(n => n.props.accessibilityLabel === label && typeof (n.props.onPress ?? n.props.onChangeText) === 'function').filter(n => !hidden(n))[0];
  const screen = () => r.root.findAllByType(Text).filter(t => !hidden(t))
    .map(t => [].concat(t.props.children).flat().filter((x: any) => typeof x === 'string' || typeof x === 'number').join('')).join('\n');
  const press = async (label: string) => {
    const n = byLabel(label);
    if (!n) throw new Error(`no visible "${label}":\n${screen()}`);
    await ReactTestRenderer.act(async () => n.props.onPress());
    await settle();
  };
  const type = (label: string, text: string) => ReactTestRenderer.act(async () => byLabel(label).props.onChangeText(text));
  return { press, type, screen };
}
const pressAlert = (button: string) => ReactTestRenderer.act(async () => {
  const call = alerts.mock.calls[alerts.mock.calls.length - 1];
  await (call[2] as any[]).find(b => b.text === button).onPress?.();
});

test('add a folder, debug with file references, review and approve a proposal, restore, remove', async () => {
  const a = await mount();
  await a.press('Code');
  await a.type('Workspace name', 'Demo');
  await a.press('Add project folder');
  await settle(100);
  expect(a.screen()).toContain('Demo');
  expect(a.screen()).toContain('.env  (files like this usually hold secrets, so the assistant does not read them)');

  // Debug: the answer's observed finding links to the real file and line.
  mockLlm.json = JSON.stringify({ answer: 'getUserName reads user.name without a check.', enough_context: true,
    findings: [{ kind: 'observed', text: 'user.name is read when user may be undefined', file: 'src/user.ts', line: 4 }],
    suggested_fix: 'Guard against a missing user.', side_effects: 'None expected.', checks: ['npm test'] });
  await a.press('Mode Debug');
  await a.type('Task question', 'Why does greet crash?');
  await a.type('Error message', "TypeError: Cannot read properties of undefined (reading 'name')\n    at getUserName (src/user.ts:4:15)");
  await a.press('Start task');
  await settle(150);
  const s = a.screen();
  expect(s).toContain('Debug · Answered');
  expect(s).toContain('Observed: ');
  expect(s).toContain('src/user.ts:4');
  expect(s).toMatch(/src\/user.ts \(lines 1-10\) — named in the error/);
  expect(s).toContain('Nothing was compiled, run or tested');
  await a.press('Open src/user.ts line 4');
  expect(a.screen()).toContain('4    return user.name.trim();');
  await a.press('Back');

  // Propose a change: reviewed, cancelled (nothing changes), then approved.
  mockLlm.json = JSON.stringify({ title: 'Guard getUserName', objective: 'Avoid the crash', reason: 'user may be undefined', assumptions: [], risks: ['Callers get ""'],
    validation: ['npm test'], changes: [{ op: 'modify', path: 'src/user.ts', purpose: 'Guard', content: '', edits: [{ find: 'return user.name.trim();', replace: "return user?.name.trim() ?? '';" }] }] });
  await a.press('Mode Propose change');
  await a.type('Follow-up question', 'Make getUserName safe');
  await a.press('Send follow-up');
  await settle(150);
  expect(a.screen()).toContain('Modify src/user.ts');
  await a.press('Show changes in src/user.ts');
  expect(a.screen()).toContain("+    4   return user?.name.trim() ?? '';");
  await a.press('Apply approved changes');
  await pressAlert('Cancel');
  expect(p.state.writes).toEqual([]);
  await a.press('Apply approved changes');
  await pressAlert('Apply');
  await settle(80);
  expect(p.text('src/user.ts')).toContain("user?.name.trim() ?? ''");
  expect(a.screen()).toContain('Applied and verified');
  await a.press('Restore original src/user.ts');
  await pressAlert('Restore');
  await settle(80);
  expect(p.text('src/user.ts')).toBe(FIXTURE['src/user.ts']);

  // Remove the workspace: the project files stay.
  await a.press('Back');
  await a.press('Back');
  await a.press('Back');
  await a.press('Remove workspace Demo');
  await pressAlert('Remove');
  await settle(80);
  expect(a.screen()).toContain('No workspaces yet');
  expect(p.text('src/user.ts')).toBe(FIXTURE['src/user.ts']);
}, 30_000); // M9: the flow's own UI waits add up to ~5 s, Jest's default limit; on a busy machine (Gradle + emulator) it timed out
