/**
 * Phase 15.4: long-term memory owned by the phone (src/chatStore.ts storage + src/memoryCommands.ts rules).
 * Real SQL via Node's built-in SQLite (testUtils/sqliteDb, the same interface as AiStoreModule.kt); the App tests use
 * unit-test mocks of llama.rn (phone model) and RNFS. Ported from the original app (M11 carry-over); this app has no laptop.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { sqliteDb } from '../testUtils/sqliteDb';

const mockModelCalls: string[] = [];
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs', CachesDirectoryPath: '/cache',
  exists: jest.fn(async () => true),
  readFile: jest.fn(async () => require('../src/localModel').MODEL.sha256),
  getFSInfo: jest.fn(async () => ({ freeSpace: 50e9, totalSpace: 128e9 })),
}));
jest.mock('llama.rn', () => ({
  releaseAllLlama: jest.fn(async () => undefined),
  initLlama: jest.fn(async () => ({
    androidLib: 'test', gpu: false,
    completion: async (req: any, onToken: (d: { token: string }) => void) => {
      mockModelCalls.push(JSON.stringify(req.messages));
      onToken({ token: 'model answer' });
      return { text: 'model answer', timings: { predicted_n: 2, predicted_per_second: 5, prompt_ms: 10 } };
    },
  })),
}));

import * as chat from '../src/chatStore';
import * as memory from '../src/memoryCommands';
import { NativeModules } from 'react-native';
import App from '../App';

(NativeModules as any).AiDevice = { connectivity: jest.fn(async () => 'offline'), keepScreenOn: jest.fn() };

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
const fs = node('fs'), os = node('os'), path = node('path');
let file: string;
beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mem-')), 'chat.db');
  chat.setDb(sqliteDb(file));
  mockModelCalls.length = 0;
});

// ---------------------------------------------------------------- storage

test('migration: a Phase 15.3 (v1) phone database gains memories and keeps every chat row', async () => {
  const v1 = sqliteDb(file).raw;
  v1.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', '1');
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, laptop_conversation_id TEXT);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL,
      seq INTEGER NOT NULL, meta_json TEXT, UNIQUE (conversation_id, seq));
    INSERT INTO conversations VALUES ('c1', 'blue chat', 1, 2, NULL);
    INSERT INTO messages VALUES ('m1', 'c1', 'user', 'My favorite color is blue.', 1, 1, NULL);
    INSERT INTO messages VALUES ('m2', 'c1', 'assistant', 'Nice!', 2, 2, '{"lang":"en-IN"}');`);
  const before = ['conversations', 'messages'].map(t => v1.prepare(`SELECT * FROM ${t} ORDER BY 1`).all());
  chat.setDb(sqliteDb(file)); // the app starts with the new build
  expect(await chat.schemaVersion()).toBe(chat.SCHEMA_VERSION); // v1 migrates all the way forward
  const raw = sqliteDb(file).raw;
  expect(['conversations', 'messages'].map(t => raw.prepare(`SELECT * FROM ${t} ORDER BY 1`).all())).toEqual(before);
  expect(raw.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
  expect((await chat.createMemory('personal', 'name', 'Nihal')).value).toBe('Nihal');
  chat.setDb(sqliteDb(file));
  expect(await chat.schemaVersion()).toBe(chat.SCHEMA_VERSION); // reopening is a no-op
});

test('create, get, list active, update with timestamps, deactivate', async () => {
  const m = await chat.createMemory('personal', '  Name ', 'Nihal', { sourceMessageId: 'u1', now: 1000 });
  expect(m).toMatchObject({ type: 'personal', key: 'name', value: 'Nihal', scope_id: '', source: 'user_explicit',
    source_message_id: 'u1', confidence: 1, created_at: 1000, updated_at: 1000, active: true });
  expect(await chat.getMemory(m.id)).toEqual(m);
  const p = await chat.createMemory('preference', 'software_preference', 'free software', { now: 1001 });
  const u = await chat.updateMemory(p.id, { value: 'free/open-source software', confidence: 0.9, now: 1005 });
  expect(u).toMatchObject({ id: p.id, value: 'free/open-source software', confidence: 0.9, source: 'user_edit', created_at: 1001, updated_at: 1005 });
  expect((await chat.updateMemory(p.id, { value: 'free/open-source software', now: 1009 }))?.updated_at).toBe(1005); // no change
  expect(await chat.deactivateMemory(m.id, 1010)).toBe(true);
  expect(await chat.deactivateMemory(m.id)).toBe(false);
  expect(await chat.updateMemory(m.id, { value: 'X' })).toBeNull(); // inactive: not editable
  expect((await chat.listMemories()).map(x => x.id)).toEqual([p.id]); // inactive excluded by default
  expect((await chat.listMemories({ includeInactive: true })).length).toBe(2);
  expect((await chat.getMemory(m.id))?.value).toBe('Nihal'); // soft: kept, not physically deleted
});

test('validation: empty/long/invalid input and credentials are refused and nothing is stored', async () => {
  const bad: [string, string, any, any?][] = [['personal', '', 'x'], ['personal', '   ', 'x'], ['personal', 'name', ''],
    ['personal', 'name', '  \n '], ['personal', 'k'.repeat(101), 'x'], ['personal', 'bio', 'x'.repeat(2001)], ['mood', 'name', 'x'],
    ['project', 'framework', 'RN'], ['personal', 'framework', 'RN', { scopeId: 'c1' }], ['personal', 'name', 'x', { source: 'auto' }],
    ['personal', 'name', 'x', { confidence: 1.5 }]];
  for (const [type, key, value, opts] of bad) await expect(chat.createMemory(type as any, key, value, opts)).rejects.toThrow(chat.MemoryValidationError);
  for (const [key, value] of [['wifi password', 'hunter2'], ['mpin', '1234'], ['upi pin', '9876'], ['api key', 'abc'], ['note', 'my password is hunter2'],
    ['note', 'sk-abcdefghijklmnopqrstuv'], ['card', '4111111111111111']]) {
    await expect(chat.createMemory('personal', key, value)).rejects.toThrow(chat.CredentialRejected);
  }
  expect(await chat.listMemories({ includeInactive: true })).toEqual([]);
  expect((await chat.createMemory('personal', 'compass brand', 'Suunto')).key).toBe('compass brand'); // not a "pass"word
});

test('same logical key updates one row (also after forgetting); scopes and types stay separate', async () => {
  const a = await chat.createMemory('personal', 'Name', 'Nihal', { now: 1 });
  expect(await chat.createMemory('personal', ' NAME ', 'Nihal', { now: 2 })).toEqual(a); // identical: untouched
  const b = await chat.createMemory('personal', 'name', 'Nihal Kumar', { now: 3 });
  expect([b.id, b.created_at, b.updated_at, b.value]).toEqual([a.id, 1, 3, 'Nihal Kumar']);
  await chat.deactivateMemory(a.id, 4);
  const c = await chat.createMemory('personal', 'name', 'Nihal', { now: 5 });
  expect([c.id, c.active]).toEqual([a.id, true]);
  const ids = new Set([a.id, (await chat.createMemory('preference', 'name', 'x')).id,
    (await chat.createMemory('project', 'uses kafka', 'Kafka', { scopeId: 'chatA' })).id,
    (await chat.createMemory('project', 'uses kafka', 'Kafka', { scopeId: 'chatB' })).id]);
  expect(ids.size).toBe(4);
});

// ---------------------------------------------------------------- commands in the app

async function mount() {
  (globalThis as any).fetch = jest.fn(async () => { throw new TypeError('Network request failed'); }); // nothing here uses the network
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { r = ReactTestRenderer.create(<App />); });
  await ReactTestRenderer.act(async () => { await new Promise<void>(res => setTimeout(() => res(), 50)); }); // launch: model load
  const by = (label: string) => r.root.findAll(n => n.props.accessibilityLabel === label && typeof (n.props.onPress ?? n.props.onChangeText) === 'function')[0];
  // The reply as saved in the phone's history.
  const say = async (msg: string) => {
    await ReactTestRenderer.act(async () => by('Message').props.onChangeText(msg));
    await ReactTestRenderer.act(async () => by('Send').props.onPress());
    await ReactTestRenderer.act(async () => { await new Promise<void>(res => setTimeout(() => res(), 10)); });
    const [c] = await chat.listConversations(1);
    const rows = await chat.recentMessages(c.id, 2);
    return rows[rows.length - 1].role === 'assistant' ? rows[rows.length - 1].content : '';
  };
  const newChat = () => ReactTestRenderer.act(async () => by('New chat').props.onPress());
  return { say, newChat, unmount: () => ReactTestRenderer.act(async () => r.unmount()) };
}

test('remember, recall, update, forget on the phone; survives restart; no model involved', async () => {
  const a = await mount();
  expect(await a.say('Remember my name is Nihal.')).toBe("Got it. I'll remember that your name is Nihal.");
  expect(await a.say('Remember that I prefer free/open-source software.')).toBe("Got it. I'll remember that you prefer free/open-source software.");
  expect(await a.say('Please remember I use React Native')).toBe("Got it. I'll remember that you use React Native.");
  const [m] = await chat.listMemories({ type: 'personal' });
  expect(m).toMatchObject({ key: 'name', value: 'Nihal', source: 'user_explicit', active: true });
  expect(m.source_message_id).toBeTruthy(); // provenance: the phone message that asked for it
  await a.unmount();
  const b = await mount(); // restart: memories come from the phone database
  expect(await b.say('What is my name?')).toBe('Your name is Nihal.');
  expect(await b.say('What do you remember about me?')).toBe(
    'I remember:\n- Your name is Nihal.\n- You prefer free/open-source software.\n- You use React Native.');
  expect(await b.say('Remember my name is Nihal Kumar')).toBe("I've updated your name to Nihal Kumar.");
  expect(await b.say('Remember my name is Nihal Kumar')).toBe('I already remember that your name is Nihal Kumar.');
  expect(await b.say('Forget my name.')).toBe("Okay, I won't use that saved memory anymore.");
  expect(await b.say('What is my name?')).toBe(`I don't know your name yet. Tell me "My name is …" and I'll remember it.`);
  expect(await b.say('Forget that I use React Native.')).toBe("Okay, I won't use that saved memory anymore.");
  expect(await b.say('Forget my preference for free software.')).toBe("Okay, I won't use that saved memory anymore.");
  expect(await chat.listMemories()).toEqual([]);
  expect((await chat.listMemories({ includeInactive: true })).length).toBe(3); // soft-deleted, not removed
  expect(mockModelCalls.filter(c => /Nihal|React Native|open-source/.test(c))).toEqual([]);
});

test('memory commands bypass the model; normal chat still goes to it', async () => {
  const a = await mount();
  expect(await a.say('Remember my name is Nihal.')).toBe("Got it. I'll remember that your name is Nihal.");
  expect(await a.say('What is my name?')).toBe('Your name is Nihal.');
  expect(await a.say('Forget my name')).toBe("Okay, I won't use that saved memory anymore.");
  expect(mockModelCalls.filter(c => !c.includes('Say hi in three words'))).toEqual([]); // only the launch self-test ran
  expect(await a.say('Explain Kafka partitions in detail.')).toBe('model answer');
});

test('unclear, unknown and look-alike messages: asked, not invented, not saved', async () => {
  const a = await mount();
  expect(await a.say('Remember this.')).toBe('What would you like me to remember?');
  expect(await a.say('Remember I prefer tea')).toContain("I'm not sure what kind of preference that is.");
  expect(await a.say('Remember my name is Nihal and I prefer free software')).toContain('one thing at a time');
  expect(await a.say('What is my name?')).toBe(`I don't know your name yet. Tell me "My name is …" and I'll remember it.`);
  expect(await a.say('Do you remember my favourite color?')).toBe("I don't have your favourite color saved yet.");
  expect(await a.say('Forget my email.')).toContain("couldn't find a saved memory");
  for (const msg of ['My name is Nihal.', 'I like TypeScript.', 'Remember to drink water.', 'What is my IP address?', 'Forget it.']) {
    expect(await a.say(msg)).toBe('model answer'); // ordinary chat: answered by the model, nothing saved
  }
  expect(await chat.listMemories({ includeInactive: true })).toEqual([]);
});

test('project memories belong to their chat only', async () => {
  const a = await mount();
  expect(await a.say('Remember this project uses Kafka.')).toBe("Got it. I'll remember that this project uses Kafka.");
  expect(await a.say('What technology does this project use?')).toBe('I remember:\n- This project uses Kafka.');
  await a.newChat();
  expect(await a.say('What technology does this project use?')).toBe("I don't have anything saved for this project yet.");
  expect(await a.say('What do you remember about me?')).not.toContain('Kafka');
  expect(await a.say('Forget that this project uses Kafka.')).toContain("couldn't find a saved memory"); // not this chat's
  expect((await chat.listMemories({ type: 'project' }))[0].active).toBe(true);
});

test('credentials: refused, and the typed message is stored redacted (message and new chat title)', async () => {
  const secrets = { 'Remember my password is hunter2': 'hunter2', 'Remember my MPIN is 4321': '4321',
    'Remember my api key is sk-abcdefghijklmnopqrstuv': 'sk-abcdefghij', 'Remember my card number is 4111111111111111': '41111111' };
  for (const [msg, secret] of Object.entries(secrets)) {
    const a = await mount();
    await a.newChat();
    expect(await a.say(msg)).toBe(memory.CREDENTIAL_REPLY);
    const [c] = await chat.listConversations(1);
    const rows = await chat.recentMessages(c.id);
    expect(rows[0].content).toBe(memory.REDACTED);
    expect(JSON.stringify(rows) + c.title).not.toContain(secret);
    await a.unmount();
  }
  expect(await chat.listMemories({ includeInactive: true })).toEqual([]);
  const raw = sqliteDb(file).raw;
  const all = ['messages', 'conversations', 'memories'].map(t => JSON.stringify(raw.prepare(`SELECT * FROM ${t}`).all())).join(' ');
  for (const s of Object.values(secrets)) expect(all).not.toContain(s);
});

test('memory values are never logged', async () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(k => jest.spyOn(console, k));
  const a = await mount();
  await a.say('Remember my name is Nihal-Q7Z');
  await a.say('What is my name?');
  await a.say('Forget my name');
  const logged = spies.flatMap(s => s.mock.calls.map(c => c.map(String).join(' '))).join('\n');
  expect(logged).not.toContain('Nihal-Q7Z');
  spies.forEach(s => s.mockRestore());
});
