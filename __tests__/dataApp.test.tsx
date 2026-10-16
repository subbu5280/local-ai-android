/**
 * Privacy and data screens in the real app (Jest): create an encrypted backup through the screen, restore it into a
 * fresh app with a wrong then the right password, confirm a replacement, and see storage and the database check.
 * Fakes: file system (temp dir), AiCrypto on Node crypto, the save/open pickers, alerts. UI wiring only.
 */
import ReactTestRenderer from 'react-test-renderer';
import { Alert, NativeModules, Text } from 'react-native';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => require('../testUtils/fakeBackupEnv').fakeFs());
jest.mock('llama.rn', () => ({ releaseAllLlama: jest.fn(async () => undefined), initLlama: jest.fn(async () => { throw new Error('no model in this test'); }) }));

import * as chat from '../src/chatStore';
import { freshDb, seed, SECRET_TEXT } from '../testUtils/backupFixture';
import { pickerState } from '../testUtils/fakeBackupEnv';
import App from '../App';

const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => ReactTestRenderer.act(async () => { mounted.splice(0).forEach(r => r.unmount()); }));
beforeEach(() => {
  NativeModules.AiDevice = { connectivity: jest.fn(async () => 'offline'), keepScreenOn: jest.fn() };
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  alerts.mockClear();
});

const settle = (ms = 60) => ReactTestRenderer.act(async () => { await new Promise<void>(r => setTimeout(() => r(), ms)); });
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
  const press = async (label: string, ms = 60) => {
    const n = byLabel(label);
    if (!n) throw new Error(`no visible "${label}":\n${screen()}`);
    await ReactTestRenderer.act(async () => n.props.onPress());
    await settle(ms);
  };
  const type = (label: string, text: string) => ReactTestRenderer.act(async () => byLabel(label).props.onChangeText(text));
  return { press, type, screen };
}
const pressAlert = (button: string) => ReactTestRenderer.act(async () => {
  const call = alerts.mock.calls[alerts.mock.calls.length - 1];
  await (call[2] as any[]).find(b => b.text === button).onPress?.();
});

test('back up through the screen, then restore into a fresh app; replace needs confirmation', async () => {
  await freshDb();
  await seed();
  let a = await mount();
  await a.press('Privacy and data');
  expect(a.screen()).toMatch(/App database: [\d.]+ MB \(measured\)/);
  expect(a.screen()).toContain('Android\'s cloud backup and device-to-device transfer are switched off');
  await a.press('Check database');
  expect(a.screen()).toContain('SQLite: no problems found');
  await a.press('Backup and restore');
  expect(a.screen()).toContain('Code proposals');
  expect(a.screen()).toContain('Contains source code, which may include secrets');
  await a.type('Backup password', 'correct horse battery');
  await a.type('Repeat backup password', 'correct horse batter');
  expect(a.screen()).toContain('The two passwords are different.');
  await a.type('Repeat backup password', 'correct horse battery');
  await a.press('Create backup', 3000); // PBKDF2 with 600,000 iterations, twice (create + verify)
  expect(a.screen()).toMatch(/Saved "local-ai-backup-[\d-]+\.laibackup"/);
  const file = pickerState.saved[0];
  expect(require('fs').readFileSync(file, 'utf8')).not.toContain(SECRET_TEXT);
  await ReactTestRenderer.act(async () => { mounted.splice(0).forEach(r => r.unmount()); });

  // A new phone: empty app, one local chat.
  await freshDb();
  const local = await chat.createConversation('Only here');
  pickerState.openFrom = file;
  a = await mount();
  await a.press('Privacy and data');
  await a.press('Backup and restore');
  await a.press('Restore tab');
  await a.press('Choose backup file');
  await a.type('Restore password', 'wrong password!!');
  await a.press('Check backup', 2000);
  expect(a.screen()).toContain('Wrong password, or the file was changed or damaged. Nothing was restored.');
  await a.type('Restore password', 'correct horse battery');
  await a.press('Check backup', 2000);
  expect(a.screen()).toContain('Authenticated and checked.');
  expect(a.screen()).toContain('· 3 records'); // the chats (1 conversation, 2 messages)
  await a.press('Chats replace');
  await a.press('Restore selected');
  expect(alerts.mock.calls[alerts.mock.calls.length - 1][0]).toBe('Replace data on this phone?');
  await pressAlert('Cancel');
  expect(await chat.getConversation(local.id)).not.toBeNull();
  await a.press('Chats merge');
  await a.press('Restore selected', 300);
  expect(a.screen()).toContain('Restore finished.');
  expect(a.screen()).toMatch(/Chats \(merge\): added 1/);
  expect((await chat.listConversations()).map(x => x.title).sort()).toEqual(['Falcon planning', 'Only here']);
}, 60_000); // real PBKDF2 (600,000 iterations) runs four times
