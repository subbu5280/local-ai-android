/**
 * The app end to end in Jest: the real App component, real SQL (Node's SQLite via testUtils/sqliteDb), and unit-test
 * mocks for the model runtime (llama.rn) and the file system (RNFS). No real model runs here: these tests prove the
 * app's wiring (language line reaches the model, history is saved and restored, Stop works, no network use), not
 * answer quality or on-device speed.
 */
import ReactTestRenderer from 'react-test-renderer';
import { Alert, BackHandler, NativeModules, Text } from 'react-native';
import { sqliteDb } from '../testUtils/sqliteDb';

const mockModel = { calls: [] as any[][], installed: true, releaseStop: null as null | (() => void), stops: 0 };
const mockDownload = { started: 0 }; // RNFS.downloadFile calls: a started download is a network transfer
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => mockModel.installed),
  readFile: jest.fn(async () => require('../src/localModel').MODEL.sha256),
  getFSInfo: jest.fn(async () => ({ freeSpace: 50e9, totalSpace: 128e9 })),
  mkdir: jest.fn(async () => undefined),
  unlink: jest.fn(async () => undefined),
  // A connected network can still fail the transfer: the download is attempted and fails like a dropped connection.
  downloadFile: jest.fn(() => {
    mockDownload.started++;
    return { jobId: 1, promise: Promise.reject(new Error('Network request failed')) };
  }),
}));
jest.mock('llama.rn', () => ({
  releaseAllLlama: jest.fn(async () => undefined),
  initLlama: jest.fn(async () => ({
    androidLib: 'test', gpu: false,
    stopCompletion: async () => { mockModel.stops++; mockModel.releaseStop?.(); },
    completion: async (req: any, onToken: (d: { token: string }) => void) => {
      mockModel.calls.push(req.messages);
      const last = req.messages[req.messages.length - 1].content as string;
      if (/long story/.test(last)) { // streams one token, then runs until Stop is pressed
        onToken({ token: 'Once upon' });
        await new Promise<void>(r => { mockModel.releaseStop = r; });
        return { text: 'Once upon', timings: { predicted_n: 2, predicted_per_second: 5, prompt_ms: 1 } };
      }
      const text = /three words/.test(last) ? 'Hi there friend' : `Answer to: ${last.split('\n').pop()}`;
      onToken({ token: text });
      return { text, timings: { predicted_n: 5, predicted_per_second: 5, prompt_ms: 1 } };
    },
  })),
}));

import * as chat from '../src/chatStore';
import App from '../App';

// Node built-ins without @types/node: the test runs in Node, so they exist at runtime.
const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
const fs = node('fs'), os = node('os'), path = node('path');
let file: string;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'localai-')), 'chat.db');
  chat.setDb(sqliteDb(file));
  Object.assign(mockModel, { calls: [], installed: true, releaseStop: null, stops: 0 });
  (globalThis as any).fetch = jest.fn(async () => { throw new Error('chat must not use the network'); });
  mockDownload.started = 0;
  NativeModules.AiDevice = { connectivity: jest.fn(async () => 'online'), keepScreenOn: jest.fn() };
  alerts.mockClear();
});
// Alert is recorded, not shown; a test presses a dialog button with pressAlert().
const alerts = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
const lastAlert = () => alerts.mock.calls[alerts.mock.calls.length - 1];
const pressAlert = (button: string) => ReactTestRenderer.act(async () => {
  await (lastAlert()[2] as any[]).find(b => b.text === button).onPress?.(); // Cancel has none: it only dismisses
});

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
// Unmount everything a test left open, so FlatList timers can't fire after the test ended.
afterEach(() => ReactTestRenderer.act(async () => { mounted.splice(0).forEach(r => r.unmount()); }));

async function mount() {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { r = ReactTestRenderer.create(<App />); });
  mounted.push(r);
  const byLabel = (label: string) => r.root.findAll(n => n.props.accessibilityLabel === label && typeof (n.props.onPress ?? n.props.onChangeText) === 'function')[0];
  const type = (text: string) => ReactTestRenderer.act(async () => byLabel('Message').props.onChangeText(text));
  const press = (label: string) => ReactTestRenderer.act(async () => byLabel(label).props.onPress());
  const say = async (text: string) => { await type(text); await press('Send'); };
  const screen = () => r.root.findAllByType(Text).map(t => [].concat(t.props.children).join('')).join('\n');
  return { say, type, press, byLabel, screen, unmount: () => ReactTestRenderer.act(async () => { mounted.splice(mounted.indexOf(r), 1); r.unmount(); }) };
}
/** Let pending model/database promises finish inside act(). */
const settle = () => ReactTestRenderer.act(async () => { await new Promise<void>(r => setTimeout(() => r(), 10)); });
const lastUserTurn = () => mockModel.calls[mockModel.calls.length - 1].at(-1).content as string;

test('offline chat: language line reaches the model, history is saved, restored after restart, and keeps its language', async () => {
  const a = await mount();
  expect(a.screen()).toContain('On-device · offline ready');
  await a.say('Kafka గురించి చెప్పండి');
  expect(lastUserTurn()).toMatch(/^Language: Respond in Telugu/);
  expect(a.screen()).toContain('Answer to: Kafka గురించి చెప్పండి');
  await a.unmount();

  const b = await mount(); // app restart: the conversation comes back from SQLite
  expect(b.screen()).toContain('Kafka గురించి చెప్పండి');
  expect(b.screen()).toContain('Answer to: Kafka గురించి చెప్పండి');
  await b.say('ok');
  expect(lastUserTurn()).toMatch(/^Language: Respond in Telugu/); // restored language is used for the short reply
  const sent = mockModel.calls[mockModel.calls.length - 1];
  expect(sent.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']); // earlier turns included
  const [conv] = await chat.listConversations(1);
  expect((await chat.recentMessages(conv.id)).map(m => [m.role, m.meta.lang])).toEqual(
    [['user', 'te'], ['assistant', 'te'], ['user', 'te'], ['assistant', 'te']]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test('task guidance reaches the model but only the typed text is saved and shown', async () => {
  const a = await mount();
  await a.say('Translate "good morning" to Telugu');
  expect(lastUserTurn()).toMatch(/^Language: Respond in Telugu.*\nTask: Translate faithfully.*\n\nTranslate "good morning" to Telugu$/);
  const [conv] = await chat.listConversations(1);
  expect((await chat.recentMessages(conv.id))[0].content).toBe('Translate "good morning" to Telugu');
  expect(a.screen()).not.toContain('Task:');
});

test('Stop ends a running answer; the partial answer is kept and the app is ready for the next message', async () => {
  const a = await mount();
  await a.type('Tell me a long story');
  ReactTestRenderer.act(() => { a.byLabel('Send').props.onPress(); }); // not awaited: the answer is still running
  await settle();
  expect(a.screen()).toContain('Once upon');
  await a.press('Stop answer');
  expect(mockModel.stops).toBe(1);
  await settle();
  expect(a.byLabel('Send')).toBeTruthy(); // Send is back
  const [conv] = await chat.listConversations(1);
  expect((await chat.recentMessages(conv.id)).map(m => m.content)).toEqual(['Tell me a long story', 'Once upon']);
});

test('no model downloaded: says so, offers the download, and never calls the model or the network', async () => {
  mockModel.installed = false;
  const a = await mount();
  expect(a.screen()).toContain('No model yet');
  expect(a.byLabel('Get model')).toBeTruthy();
  await a.say('Hello');
  expect(a.screen()).toContain('not ready yet');
  expect(mockModel.calls).toEqual([]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------- M2.3: saved chats (history screen)

/** Two saved chats: an older Telugu one (3 messages) and a newer English one. */
async function seedTwoChats() {
  const old = await chat.createConversation('Kafka గురించి చెప్పండి', 1000);
  await chat.addMessage(old.id, 'user', 'Kafka గురించి చెప్పండి', { lang: 'te' }, 'o1', 1001);
  await chat.addMessage(old.id, 'assistant', 'Kafka ఒక distributed log.', { lang: 'te' }, 'o2', 1002);
  await chat.addMessage(old.id, 'user', 'ఇంకా చెప్పు', { lang: 'te' }, 'o3', 1003);
  const recent = await chat.createConversation('What is Python?', 2000);
  await chat.addMessage(recent.id, 'user', 'What is Python?', { lang: 'en' }, 'r1', 2001);
  return { old, recent };
}
const allChats = async () => (await chat.listConversations(50)).map(c => c.title);

test('history lists saved chats newest first; opening an older one shows its messages in order', async () => {
  const { old } = await seedTwoChats();
  const a = await mount();
  expect(a.screen()).toContain('What is Python?'); // launch reopens the most recent chat
  await a.press('Saved chats');
  const list = a.screen();
  expect(list.indexOf('What is Python?')).toBeLessThan(list.indexOf('Kafka గురించి చెప్పండి'));
  expect(list).toContain('1 Jan 1970'); // dates from updated_at (fixed test timestamps)
  await a.press(`Open chat ${old.title}`);
  const shown = a.screen();
  expect(shown.indexOf('Kafka గురించి చెప్పండి')).toBeLessThan(shown.indexOf('Kafka ఒక distributed log.'));
  expect(shown.indexOf('Kafka ఒక distributed log.')).toBeLessThan(shown.indexOf('ఇంకా చెప్పు'));
  expect(shown).not.toContain('What is Python?');
});

test('a reopened chat continues: same conversation, earlier turns as context, its language kept', async () => {
  const { old } = await seedTwoChats();
  const a = await mount();
  await a.press('Saved chats');
  await a.press(`Open chat ${old.title}`);
  await a.say('ok');
  expect(lastUserTurn()).toMatch(/^Language: Respond in Telugu/); // language from the saved messages
  const sent = mockModel.calls[mockModel.calls.length - 1];
  expect(sent.some((m: any) => m.content === 'Kafka ఒక distributed log.')).toBe(true); // its own history as context
  expect((await chat.listConversations(50)).length).toBe(2); // no duplicate conversation
  expect((await chat.recentMessages(old.id)).map(m => m.content).slice(-2)).toEqual(['ok', 'Answer to: ok']);
  expect((await chat.listConversations(1))[0].id).toBe(old.id); // now the most recently used
});

test('New chat starts a separate conversation; a double-tapped Send saves one message', async () => {
  await seedTwoChats();
  const a = await mount();
  await a.press('New chat');
  expect(a.screen()).not.toContain('What is Python?');
  await a.type('Hello there friend, explain Kotlin');
  await ReactTestRenderer.act(async () => { // two taps before the first send has re-rendered
    const send = a.byLabel('Send').props.onPress;
    await Promise.all([send(), send()]);
  });
  await settle();
  expect(await allChats()).toEqual(['Hello there friend, explain Kotlin', 'What is Python?', 'Kafka గురించి చెప్పండి']);
  const [newest] = await chat.listConversations(1);
  expect((await chat.recentMessages(newest.id)).map(m => m.role)).toEqual(['user', 'assistant']);
});

test('delete asks first; Cancel keeps everything; Delete removes only that chat and closes it if open', async () => {
  const { old, recent } = await seedTwoChats();
  const a = await mount(); // the recent chat is open
  await a.press('Saved chats');
  await a.press(`Delete chat ${recent.title}`);
  expect(lastAlert()[0]).toBe('Delete this chat?');
  await pressAlert('Cancel');
  expect(await allChats()).toEqual(['What is Python?', 'Kafka గురించి చెప్పండి']);
  await a.press(`Delete chat ${recent.title}`);
  await pressAlert('Delete');
  await settle();
  expect(await allChats()).toEqual(['Kafka గురించి చెప్పండి']);
  expect(await chat.recentMessages(recent.id)).toEqual([]);
  expect((await chat.recentMessages(old.id)).length).toBe(3); // the other chat is intact
  expect(a.screen()).not.toContain('What is Python?');
  await a.press('Back to chat');
  expect(a.screen()).not.toContain('What is Python?'); // the deleted open chat is closed, a new chat is shown
  expect(mockDownload.started).toBe(0); // model files untouched (no download, nothing else)
});

test('empty history says so; a database error is shown with Retry, and the app keeps working', async () => {
  const a = await mount();
  await a.press('Saved chats');
  expect(a.screen()).toContain('No saved chats yet');
  const real = sqliteDb(file);
  let broken = true;
  chat.setDb({ ...real, query: async (sql, p) => {
    if (broken && /FROM conversations ORDER BY/.test(sql)) throw new Error('disk I/O error');
    return real.query(sql, p);
  } });
  await a.press('Back to chat');
  await a.press('Saved chats');
  expect(a.screen()).toContain("Couldn't read saved chats (disk I/O error)");
  expect(a.screen()).not.toContain('No saved chats yet'); // an error is not reported as "empty"
  broken = false;
  await a.press('Retry reading saved chats');
  expect(a.screen()).not.toContain("Couldn't read");
});

test('a failed delete is reported and nothing is removed', async () => {
  const { recent } = await seedTwoChats();
  const a = await mount();
  await a.press('Saved chats');
  const real = sqliteDb(file);
  chat.setDb({ ...real, batch: async () => { throw new Error('database is locked'); } });
  await a.press(`Delete chat ${recent.title}`);
  await pressAlert('Delete');
  await settle();
  expect(a.screen()).toContain(`Couldn't delete "${recent.title}" (database is locked). Nothing was deleted.`);
  chat.setDb(sqliteDb(file));
  expect((await chat.listConversations(50)).length).toBe(2);
});

// ---------------------------------------------------------------- M2.3: offline download protection

test('offline: the download is refused with a clear message and never started; chat history still opens', async () => {
  mockModel.installed = false;
  await seedTwoChats();
  NativeModules.AiDevice.connectivity.mockResolvedValue('offline');
  const a = await mount();
  await a.press('Get model');
  expect(lastAlert()[0]).toBe('No internet connection');
  expect(lastAlert()[1]).toMatch(/needs an internet connection.*Nothing was downloaded/);
  expect(lastAlert()[2]).toBeUndefined(); // no Download button offered
  expect(mockDownload.started).toBe(0);
  expect(a.byLabel('Get model')).toBeTruthy(); // not stuck
  await a.press('Saved chats');
  expect(a.screen()).toContain('Kafka గురించి చెప్పండి'); // history works offline
});

test('online: the download is offered, attempted after confirming, and a failed transfer returns the button', async () => {
  mockModel.installed = false;
  const a = await mount();
  await a.press('Get model');
  expect(lastAlert()[0]).toBe('Download the on-device model?');
  expect(mockDownload.started).toBe(0); // nothing before the user confirms
  await pressAlert('Download');
  await settle();
  expect(mockDownload.started).toBe(1);
  // The screen is kept on for the download (device finding: screen-off aborted it) and released afterwards.
  expect(NativeModules.AiDevice.keepScreenOn.mock.calls).toEqual([[true], [false]]);
  expect(a.screen()).toContain('Model download failed: Download interrupted: Network request failed');
  expect(a.screen()).toContain('No model yet');
  expect(a.byLabel('Get model')).toBeTruthy(); // can try again
});

test('connected without confirmed internet: warns first, and "Try anyway" leads to the normal confirmation', async () => {
  mockModel.installed = false;
  NativeModules.AiDevice.connectivity.mockResolvedValue('no_internet');
  const a = await mount();
  await a.press('Get model');
  expect(lastAlert()[0]).toBe('Internet not confirmed');
  await pressAlert('Try anyway');
  await settle();
  expect(lastAlert()[0]).toBe('Download the on-device model?');
  expect(mockDownload.started).toBe(0);
});

test('the connection dropping while the dialog is open: download refused by the existing offline guard', async () => {
  mockModel.installed = false;
  const a = await mount();
  await a.press('Get model');
  NativeModules.AiDevice.connectivity.mockResolvedValue('offline');
  await pressAlert('Download');
  await settle();
  expect(mockDownload.started).toBe(0);
  expect(a.screen()).toContain("You're offline");
  expect(a.byLabel('Get model')).toBeTruthy();
});

test('offline never blocks local chat when the model is installed', async () => {
  NativeModules.AiDevice.connectivity.mockResolvedValue('offline');
  const a = await mount();
  await a.say('Explain Kafka simply.');
  expect(a.screen()).toContain('Answer to: Explain Kafka simply.');
  expect(NativeModules.AiDevice.connectivity).not.toHaveBeenCalled(); // chat doesn't even check the network
});

// ---------------------------------------------------------------- M2.4: Android Back

test('Android Back on History returns to the same chat and is consumed; on Chat it is left to Android', async () => {
  const listeners: { handler: (event: any) => boolean | null | undefined; removed: boolean }[] = [];
  const spy = jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    const l = { handler, removed: false };
    listeners.push(l);
    return { remove: () => { l.removed = true; } };
  });
  const active = () => listeners.filter(l => !l.removed);
  const pressBack = () => {
    let handled = false;
    ReactTestRenderer.act(() => { handled = active().reverse().some(l => l.handler({}) === true); });
    return handled; // false = Android would run its default (leave the app)
  };
  try {
    const { old } = await seedTwoChats();
    const a = await mount();
    expect(pressBack()).toBe(false); // Chat screen: nothing intercepts Back
    await a.press('Saved chats');
    await a.press(`Open chat ${old.title}`); // select the older chat, then look at History again
    await a.press('Saved chats');
    expect(a.screen()).toContain('Saved chats');
    expect(pressBack()).toBe(true); // History: Back is handled in-app, the app does not close
    await settle();
    expect(a.screen()).not.toContain('Saved chats');
    expect(a.screen()).toContain('Kafka ఒక distributed log.'); // the selected conversation is still shown
    expect(active()).toEqual([]); // listener removed with the History screen
    await a.say('ok');
    expect((await chat.recentMessages(old.id)).map(m => m.content).slice(-1)).toEqual(['Answer to: ok']); // same chat
  } finally {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------- M2.4: device-verification metrics

test('metrics: load, answer and Stop are logged with numbers only, never the message text', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const metrics = () => log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('LOCALAI_METRIC '))
    .map(l => JSON.parse(l.slice('LOCALAI_METRIC '.length)));
  try {
    const a = await mount();
    await a.say('My secret plan: explain Kafka partitions');
    await a.type('Tell me a long story about my secret');
    ReactTestRenderer.act(() => { a.byLabel('Send').props.onPress(); });
    await settle();
    await a.press('Stop answer');
    await settle();
    const all = metrics();
    expect(all.find(e => e.event === 'docs_ready')).toMatchObject({ engine: 'fts5' }); // M3: search engine at launch
    const m = all.filter(e => e.event !== 'docs_ready' && e.event !== 'need_classified'); // the classifier's label is checked in combinations
    expect(m.map(e => e.event)).toEqual(['model_state', 'model_loaded', 'answer', 'answer']);
    expect(m[0]).toMatchObject({ state: 'installed' });
    expect(m[1]).toMatchObject({ model: 'qwen2.5-1.5b-instruct-q4_k_m', gpu: false, testTokPerSec: 5 });
    expect(m[2]).toMatchObject({ lang: 'en', intent: 'explain', tokens: 5, tokPerSec: 5, stopped: false });
    expect(m[3]).toMatchObject({ stopped: true });
    expect(JSON.stringify(m)).not.toMatch(/secret|Kafka|story/i); // no user text in any metric
  } finally {
    log.mockRestore();
  }
});
