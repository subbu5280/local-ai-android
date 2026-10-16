/**
 * Feature combinations in the real app (M12): the chat routes one message through photo → memory command → Docs mode
 * → live lookup → model. These tests check the features against EACH OTHER, not one at a time: Docs mode with live and
 * memory questions, voice into memory and live, a photo with Docs mode and memory-like text, learned facts across
 * routes, offline and model-missing states, ambiguity with prompt editing, live follow-ups after other answers,
 * collections as the Docs scope, and a double Send. Fakes only at the device boundary: llama.rn, fetch, AiDocs,
 * AiLocation, AiVoice, AiDevice, the image picker; real SQLite and real app code everywhere else.
 */
import ReactTestRenderer from 'react-test-renderer';
import { Alert, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { sqliteDb } from '../testUtils/sqliteDb';

const mockEnv = { modelInstalled: true, calls: [] as { kind: string; text: string; system: string }[], hang: null as null | Promise<void> };
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs', CachesDirectoryPath: '/cache',
  exists: jest.fn(async (p: string) => (p.includes('multilingual-e5') || p.includes('voice_lang') || p.includes('location_permission') ? false : mockEnv.modelInstalled)),
  readFile: jest.fn(async () => require('../src/localModel').MODEL.sha256), writeFile: jest.fn(async () => undefined),
  mkdir: jest.fn(async () => undefined), unlink: jest.fn(async () => undefined), readDir: jest.fn(async () => []),
  getFSInfo: jest.fn(async () => ({ freeSpace: 50e9, totalSpace: 128e9 })),
}));
jest.mock('llama.rn', () => ({
  releaseAllLlama: jest.fn(async () => undefined),
  initLlama: jest.fn(async () => ({
    androidLib: 'test', gpu: false, stopCompletion: async () => undefined, initMultimodal: async () => true,
    completion: async (req: any) => {
      const last = req.messages[req.messages.length - 1].content;
      const timings = { predicted_n: 3, predicted_per_second: 5, prompt_ms: 1 };
      if (Array.isArray(last)) { mockEnv.calls.push({ kind: 'image', text: last.find((x: any) => x.type === 'text').text, system: '' }); return { text: 'A red apple on a table.', timings }; }
      if (/three words/.test(last)) return { text: 'Hi there friend', timings };
      if (mockEnv.hang) await mockEnv.hang;
      mockEnv.calls.push({ kind: /<<<SOURCES/.test(last) ? 'docs' : 'chat', text: last, system: req.messages[0].content });
      return { text: /<<<SOURCES/.test(last) ? 'Refunds are possible within 30 days [1].' : 'model answer', timings };
    },
  })),
}));

const FORECAST = { timezone: 'Asia/Kolkata', current: { time: '2026-10-09T09:00', temperature_2m: 27.9, apparent_temperature: 31.2,
  relative_humidity_2m: 80, weather_code: 2, wind_speed_10m: 9.4 },
  daily: { time: ['2026-10-09', '2026-10-10'], weather_code: [2, 61], temperature_2m_min: [22, 21], temperature_2m_max: [31, 29], precipitation_probability_max: [10, 70] } };
const CHENNAI = { name: 'Chennai', admin1: 'Tamil Nadu', country: 'India', latitude: 13.08, longitude: 80.27 };
const fetched: string[] = [];
const net = { state: 'online' as 'online' | 'offline' };
const files = new Map([['content://d/refunds.txt', 'Refund policy. Customers can request a refund within 30 days of purchase.']]);
const voiceNative = { startListening: jest.fn(), stopListening: jest.fn(), cancelListening: jest.fn(), recognitionSupport: jest.fn(), ttsLanguages: jest.fn(),
  speak: jest.fn(async () => true), stopSpeaking: jest.fn(), memoryInfo: jest.fn(async () => null), addListener: jest.fn(), removeListeners: jest.fn() };

import * as chat from '../src/chatStore';
import * as local from '../src/localModel';
import * as live from '../src/liveData';
import * as location from '../src/location';
import { importFiles } from '../src/knowledge/indexer';
import * as docStore from '../src/knowledge/docStore';
import * as collections from '../src/knowledge/collections';
import App from '../App';

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
beforeEach(async () => {
  const fs = node('fs'), os = node('os'), path = node('path');
  chat.setDb(sqliteDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'combo-')), 'chat.db')));
  Object.assign(mockEnv, { modelInstalled: true, calls: [], hang: null });
  net.state = 'online';
  fetched.length = 0;
  (Platform as any).OS = 'android';
  NativeModules.AiDevice = { connectivity: jest.fn(async () => net.state), keepScreenOn: jest.fn() };
  NativeModules.AiLocation = { isLocationEnabled: jest.fn(async () => true), currentLocation: jest.fn(async () => ({ latitude: 17.38, longitude: 78.48, accuracy: 1000, time: 0 })),
    locality: jest.fn(async () => 'Hyderabad, Telangana, India') };
  NativeModules.AiVoice = voiceNative;
  NativeModules.AiDocs = { readText: jest.fn(async (uri: string) => ({ text: files.get(uri)!, bytes: 70, sha256: `sha-${uri}`, lossy: false })),
    readPdf: jest.fn(), pick: jest.fn(async () => []), info: jest.fn(), release: jest.fn() };
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    fetched.push(url);
    if (url.includes('geocoding-api')) return { ok: true, json: async () => ({ results: [CHENNAI] }) };
    if (url.includes('api.open-meteo.com')) return { ok: true, json: async () => FORECAST };
    if (url.includes('news.google.com')) return { ok: true, text: async () => '<rss><channel><item><title>Headline one</title><link>https://example.com/1</link><source>Example</source></item></channel></rss>' };
    throw new Error(`unexpected network call ${url}`);
  });
  jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  location.clearCache();
  live.clearWeatherCache();
  await importFiles([{ uri: 'content://d/refunds.txt', name: 'refunds.txt', mime: null, size: 70 }]);
});
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => ReactTestRenderer.act(async () => { mounted.splice(0).forEach(r => r.unmount()); }));

const settle = (ms = 30) => ReactTestRenderer.act(async () => { await new Promise<void>(r => setTimeout(() => r(), ms)); });
async function mount() {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { r = ReactTestRenderer.create(<App />); });
  mounted.push(r);
  await settle(60);
  const hidden = (n: any): boolean => { for (let p = n; p; p = p.parent) if ([].concat(p.props?.style ?? []).flat().some((s: any) => s?.display === 'none')) return true; return false; };
  const by = (label: string) => r.root.findAll(n => n.props.accessibilityLabel === label && typeof (n.props.onPress ?? n.props.onChangeText ?? n.props.onLongPress) === 'function').filter(n => !hidden(n))[0];
  const type = (t: string) => ReactTestRenderer.act(async () => by('Message').props.onChangeText(t));
  const tap = async (label: string) => { const n = by(label); if (!n) throw new Error(`no "${label}"`); await ReactTestRenderer.act(async () => n.props.onPress()); await settle(); };
  /** Send a message and return the newest stored reply. */
  const say = async (t: string) => {
    await type(t);
    await tap('Send');
    await settle(40);
    const [c] = await chat.listConversations(1);
    const rows = await chat.recentMessages(c.id, 1);
    return rows[0]?.role === 'assistant' ? rows[0].content : `(no reply; last was ${rows[0]?.role})`;
  };
  const input = () => by('Message').props.value as string;
  return { r, by, type, tap, say, input };
}
const calls = (kind: string) => mockEnv.calls.filter(c => c.kind === kind);

test('Docs mode on: a weather question is answered from the documents (no web), and memory commands still work', async () => {
  const a = await mount();
  await a.tap('Ask documents');
  expect(await a.say("What's the weather in Chennai today?")).toMatch(/couldn't find anything about this/);
  expect(fetched).toEqual([]); // Docs mode never looks things up online
  expect(await a.say('What is the refund period?')).toBe('Refunds are possible within 30 days [1].');
  expect(await a.say('Remember my name is Ravi.')).toBe("Got it. I'll remember that your name is Ravi.");
  expect(await a.say('What is my name?')).toBe('Your name is Ravi.');
  expect(calls('chat')).toEqual([]); // nothing went to the general model
});

test('the model missing: live answers and memory still work; ordinary chat says the model is not ready', async () => {
  mockEnv.modelInstalled = false;
  const a = await mount();
  expect(await a.say("What's the weather in Chennai today?")).toMatch(/^Today in Chennai, Tamil Nadu/);
  expect(await a.say('Remember my name is Asha.')).toContain('your name is Asha');
  await a.type('Explain Kafka partitions');
  await a.tap('Send');
  await settle();
  expect(a.r.root.findAll(n => typeof n.props.children === 'string' && /model is not ready yet/.test(n.props.children)).length).toBeGreaterThan(0);
  expect(a.input()).toBe('Explain Kafka partitions'); // the typed text is not lost
});

test('offline: live lookups say so honestly; memory and on-device chat keep working', async () => {
  net.state = 'offline';
  const a = await mount();
  expect(await a.say("What's the weather in Chennai today?")).toMatch(/offline/i);
  expect(fetched).toEqual([]);
  expect(await a.say('Remember my name is Asha.')).toContain('your name is Asha');
  expect(await a.say('Explain Kafka partitions')).toBe('model answer');
});

test('voice → memory command and voice → live question: transcriptions are never sent until Send', async () => {
  const a = await mount();
  voiceNative.startListening.mockResolvedValueOnce('remember my name is Meera');
  await a.tap('Speak a message in English');
  expect(a.input()).toBe('remember my name is Meera');
  expect(mockEnv.calls).toEqual([]); // not sent
  await a.tap('Send');
  await settle(40);
  expect((await chat.listMemories()).map(m => m.value)).toEqual(['Meera']);
  voiceNative.startListening.mockResolvedValueOnce('weather in Chennai today');
  await a.tap('Speak a message in English');
  await a.tap('Send');
  await settle(40);
  const [c] = await chat.listConversations(1);
  expect((await chat.recentMessages(c.id, 1))[0].content).toMatch(/^Today in Chennai/);
});

test('a photo wins over Docs mode and memory-like text; the text model comes back afterwards', async () => {
  // The image model itself is a device file: its load and answer are faked here (the camera gate is tested separately).
  let visionLoaded = false;
  jest.spyOn(local, 'isVisionInstalled').mockResolvedValue(true);
  jest.spyOn(local, 'isVisionLoaded').mockImplementation(() => visionLoaded);
  jest.spyOn(local, 'loadVision').mockImplementation(async () => { visionLoaded = true; return { loadMs: 1, gpu: false } as any; });
  jest.spyOn(local, 'describeImage').mockImplementation(async (q: string) => { mockEnv.calls.push({ kind: 'image', text: q, system: '' });
    return { text: 'A red apple on a table.', firstTokenMs: 1, totalMs: 1, tokens: 5, tokPerSec: 5, promptMs: 1 }; });
  require('react-native-image-picker').launchImageLibrary.mockResolvedValueOnce({ assets: [{ uri: 'content://p', type: 'image/jpeg', base64: 'AAAA', width: 2, height: 2 }] });
  (Alert.alert as jest.Mock).mockImplementation((title: string, _m: any, buttons: any[]) => buttons?.find(b => b.text === (title === 'Add a photo' ? 'Gallery' : 'Download'))?.onPress?.());
  const a = await mount();
  await a.tap('Ask documents');
  await a.tap('Add a photo');
  await settle(60);
  expect(a.by('Remove photo')).toBeTruthy();
  expect(await a.say('Remember my name is Kiran')).toBe('A red apple on a table.');
  expect(calls('image').map(c => c.text)).toEqual(['Remember my name is Kiran']);
  expect(await chat.listMemories()).toEqual([]); // the photo question was not a memory command
  await settle(60); // the text model is reloaded in the background
  expect(local.isLoaded()).toBe(true);
  expect(await a.say('What is the refund period?')).toBe('Refunds are possible within 30 days [1].'); // Docs mode still on
});

test('learned facts reach the general model, but not live answers or document answers', async () => {
  const a = await mount();
  await a.say("I'm learning Kafka for my career.");
  await a.say('What should I learn next?');
  expect(calls('chat').pop()!.system).toContain('The user is learning Kafka');
  await a.say("What's the weather in Chennai today?");
  expect(calls('chat').length).toBe(2); // the live question went to the weather service only
  await a.tap('Ask documents');
  await a.say('What is the refund period?');
  expect(calls('docs').pop()!.system).not.toContain('Kafka'); // document answers use only the documents
});

test('ambiguity: "Fix it" in a new chat is asked about; an edited prompt is sent exactly as edited', async () => {
  const a = await mount();
  expect(await a.say('Fix it')).toMatch(/What does "it" refer to/);
  expect(calls('chat')).toEqual([]);
  expect(await a.say('Explain Kafka partitions')).toBe('model answer');
  expect(await a.say('Fix it')).toBe('model answer'); // now there is something to refer to
  await a.type('నాకు Kafka గురించి చెప్పండి');
  await ReactTestRenderer.act(async () => a.by('Send').props.onLongPress());
  const box = a.by('Prompt for the model');
  expect(box.props.value).toMatch(/^Language: Respond in Telugu[\s\S]*నాకు Kafka గురించి చెప్పండి$/); // what the app added is visible
  await ReactTestRenderer.act(async () => box.props.onChangeText('Answer in two lines: what is Kafka?'));
  await a.tap('Send this prompt');
  await settle(40);
  expect(calls('chat').pop()!.text).toBe('Answer in two lines: what is Kafka?');
  const [c] = await chat.listConversations(1);
  const [user] = (await chat.recentMessages(c.id, 2));
  expect(user).toMatchObject({ role: 'user', content: 'నాకు Kafka గురించి చెప్పండి' }); // the chat keeps what you typed
  expect(user.meta.prompt).toBe('Answer in two lines: what is Kafka?'); // and what the model received
  expect(a.by('Show what the model received')).toBeTruthy();
});

test('live follow-ups: a memory command in between keeps the city; an unrelated question in between ends the chain', async () => {
  const a = await mount();
  expect(await a.say('What is the weather in Chennai?')).toMatch(/Chennai, Tamil Nadu/);
  expect(await a.say('Remember my name is Ravi.')).toContain('Ravi');
  expect(await a.say('What about tomorrow?')).toMatch(/^Tomorrow in Chennai, Tamil Nadu/);
  expect(await a.say('Explain Kafka partitions')).toBe('model answer');
  const before = fetched.length;
  expect(await a.say('What about tomorrow?')).toBe('model answer'); // nothing to continue: ordinary chat, no web search
  expect(fetched.length).toBe(before);
  expect(await a.say('Any news about Chennai?')).toMatch(/Headline one/);
});

test('a collection becomes the Docs scope; deleting its document leaves Docs mode working', async () => {
  const [doc] = await docStore.listDocuments();
  await collections.saveCollection('Policies', [doc.id]);
  const a = await mount();
  await a.tap('Ask documents');
  await a.tap('Change documents');
  await a.tap('Select collection Policies');
  await a.tap('Use selected documents');
  expect(a.r.root.findAll(n => n.props.children !== undefined && /Answering from 1 selected document/.test([].concat(n.props.children).join(''))).length).toBeGreaterThan(0);
  expect(await a.say('What is the refund period?')).toBe('Refunds are possible within 30 days [1].');
  await docStore.deleteDocument(doc.id);
  expect((await collections.listCollections())[0].documentIds).toEqual([]);
  expect(await a.say('What is the refund period?')).toMatch(/couldn't find anything/);
});

test('a second Send while an answer is running is ignored (one answer, one message)', async () => {
  let release!: () => void;
  mockEnv.hang = new Promise<void>(r => { release = r; });
  const a = await mount();
  await a.type('Explain Kafka partitions');
  await ReactTestRenderer.act(async () => { a.by('Send')?.props.onPress(); });
  await a.type('Explain Kafka partitions');
  const stop = a.by('Stop answer');
  expect(stop).toBeTruthy(); // the Send button is replaced by Stop while answering
  await ReactTestRenderer.act(async () => { release(); });
  await settle(60);
  const [c] = await chat.listConversations(1);
  expect((await chat.recentMessages(c.id)).map(m => m.role)).toEqual(['user', 'assistant']);
});

test('after Android closes the app: Docs mode is still on, and an in-chat game is still in the conversation', async () => {
  let a = await mount();
  await a.tap('Ask documents');
  expect(await a.say('What is the refund period?')).toBe('Refunds are possible within 30 days [1].');
  await a.tap('Ask documents'); // off
  expect(await a.say('Play tic tac toe')).toMatch(/play right here/);
  await a.tap('Ask documents'); // on again, then the app is closed
  await ReactTestRenderer.act(async () => { mounted.splice(0).forEach(r => r.unmount()); });
  a = await mount(); // a fresh start reopens the latest conversation
  expect(a.by('Ask documents').props.accessibilityState).toEqual({ checked: true });
  expect(a.r.root.findAll(n => n.props.testID === 'ttt-cell-4').length).toBeGreaterThan(0); // the Tic-Tac-Toe board is back
  expect(calls('chat')).toEqual([]); // the game request never reached the model
});
