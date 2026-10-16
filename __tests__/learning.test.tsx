/**
 * Phase 15.5: quiet learning from normal chat (src/learning.ts) and relevance-only use of it.
 * Real SQL via Node's built-in SQLite (testUtils/sqliteDb); the App tests mock llama.rn and RNFS. Ported from the original
 * app (M11 carry-over); this app has no laptop, so facts reach the local model only.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { sqliteDb } from '../testUtils/sqliteDb';

const mockSystem: string[] = []; // the system message of every phone-model request
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
      mockSystem.push(req.messages[0].content);
      onToken({ token: 'model answer' });
      return { text: 'model answer', timings: { predicted_n: 2, predicted_per_second: 5, prompt_ms: 10 } };
    },
  })),
}));

import * as chat from '../src/chatStore';
import * as learning from '../src/learning';
import { NativeModules } from 'react-native';
import App from '../App';

(NativeModules as any).AiDevice = { connectivity: jest.fn(async () => 'offline'), keepScreenOn: jest.fn() };

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
const fs = node('fs'), os = node('os'), path = node('path');
beforeEach(() => {
  chat.setDb(sqliteDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learn-')), 'chat.db')));
  mockSystem.length = 0;
});
const facts = (msg: string) => learning.extractFacts(msg).map(f => `${f.kind}:${f.key}=${f.value}`);

// ---------------------------------------------------------------- what is learned

test('useful first-person facts are learned, several per message', () => {
  expect(facts("My name is Nihal and I'm learning Kafka for my career.")).toEqual(['personal:name=Nihal', 'learning:learning Kafka=Kafka']);
  // Other common ways of saying a name; capitalized and not a common word, so "I'm tired" isn't a name
  for (const said of ["Hi, I'm Subbu.", 'I am Subbu', 'This is Subbu', 'Myself Subbu from Hyderabad', 'My name Subbu',
    'You can call me Subbu']) expect(facts(said)).toEqual(['personal:name=Subbu']);
  for (const said of ["I'm tired.", "I'm Fine", 'This is great', 'This is Python', "I'm learning", 'i am subbu']) {
    expect(facts(said).filter(f => f.startsWith('personal:name'))).toEqual([]);
  }
  expect(facts('I prefer budget-friendly options.')).toEqual(['preference:budget_preference=budget-friendly options']);
  expect(facts('I prefer free software.')).toEqual(['preference:software_preference=free software']);
  expect(facts("I'm planning an Ayodhya and Varanasi trip in December.")).toEqual(['plan:trip=Ayodhya and Varanasi trip in December']);
  expect(facts("I'm working on a Unity multiplayer project.")).toEqual(['project:current=Unity multiplayer project']);
  expect(facts('I use VS Code.')).toEqual(['tool:uses VS Code=VS Code']);
  expect(facts("I'm a backend developer.")).toEqual(['personal:occupation=backend developer']);
  expect(facts('Actually, I am studying machine learning these days.')).toEqual(['learning:learning machine learning=machine learning']);
});

test('temporary, third-person, questions, negations, hypotheticals and credentials are never learned', () => {
  for (const msg of ["I'm hungry.", "I'm tired today.", 'It is raining.', 'I am sitting at my desk.', 'I will go outside now.',
    "I'm going to the shop.", 'My friend Nihal is learning Kafka.', 'Puneeth prefers Python.', 'Should I learn Kafka?',
    "I'm not learning Java anymore.", 'If I prefer Python, what then?', 'I use the bus to go to work.', 'My password is hunter2.',
    "I'm learning my bank PIN 1234", 'What is Kafka?', 'I prefer tea.', 'Maybe I prefer Python.']) {
    expect([msg, facts(msg)]).toEqual([msg, []]);
  }
});

test('a newer statement supersedes the old value (history kept); a repeat changes nothing; plans expire', async () => {
  await learning.learnFrom('I prefer Python.', null, 'm1', 1000);
  await learning.learnFrom("Actually, I'm moving to Java.", null, 'm2', 2000);
  const current = await chat.listLearned();
  expect(current.map(l => [l.key, l.value])).toEqual([['programming_language_preference', 'Java']]); // one active value
  const history = (await chat.listLearned({ includeInactive: true })).sort((x, y) => x.created_at - y.created_at);
  expect(history.map(l => [l.value, l.active])).toEqual([['Python', false], ['Java', true]]); // old value kept as history
  await learning.learnFrom('I prefer Java.', null, 'm3', 3000);
  expect((await chat.listLearned({ includeInactive: true })).length).toBe(2); // same value: no new row
  await learning.learnFrom("I'm planning a Goa trip.", null, 'm4', 1000);
  expect((await chat.listLearned({ now: 1000 + 119 * 864e5 })).some(l => l.kind === 'plan')).toBe(true);
  expect((await chat.listLearned({ now: 1000 + 121 * 864e5 })).some(l => l.kind === 'plan')).toBe(false); // the trip is over
});

// ---------------------------------------------------------------- what is used

test('only relevant knowledge is retrieved; unrelated questions get nothing; explicit memory wins', async () => {
  await learning.learnFrom("I'm learning Kafka. I prefer free software. I'm working on a Unity multiplayer project.", null, 'm1');
  const practice = await learning.relevantKnowledge('How should I practice?', null);
  expect(practice).toContain('The user is learning Kafka (a software technology).');
  expect(practice).not.toContain('free software');
  expect(practice).not.toContain('Unity');
  expect(await learning.relevantKnowledge('What is the capital of France?', null)).toBe('');
  expect(await learning.relevantKnowledge('Explain Kafka consumer groups.', null)).toContain('learning Kafka');
  expect(await learning.relevantKnowledge('Which editor should I use?', null)).toContain('The user prefers free software.');
  expect(await learning.relevantKnowledge('How do I sync players in my game?', null)).toContain('Unity multiplayer project');
  await learning.learnFrom("I'm planning an Ayodhya and Varanasi trip in December. I prefer budget-friendly options.", null, 'm2');
  const book = await learning.relevantKnowledge('What should I book first?', null);
  expect(book).toContain('Ayodhya and Varanasi trip');
  expect(await learning.relevantKnowledge('Suggest something for me.', null)).toContain('budget-friendly options');
  await chat.createMemory('preference', 'software_preference', 'open-source tools only');
  const editor = await learning.relevantKnowledge('Which editor should I use?', null);
  expect(editor).toContain('open-source tools only'); // explicit memory wins over the learned value for the same thing
  expect(editor).not.toContain('The user prefers free software.');
  expect(await learning.relevantKnowledge('What should I learn next?', null, 'm1')).not.toContain('Kafka'); // its own message
});

test('the knowledge block is bounded: at most MAX_ITEMS items within KNOWLEDGE_TOKENS', async () => {
  for (const t of ['Kafka', 'Spark', 'Flink', 'Airflow', 'dbt', 'Kubernetes', 'Terraform'])
    await learning.learnFrom(`I'm learning ${t}.`, null, t);
  const k = await learning.relevantKnowledge('What should I learn next for my career?', null);
  const lines = k.split('\n').filter(l => l.startsWith('- '));
  expect(lines.length).toBeLessThanOrEqual(learning.MAX_ITEMS);
  expect(lines.reduce((n, l) => n + chat.estimateTokens(l.slice(2)), 0)).toBeLessThanOrEqual(learning.KNOWLEDGE_TOKENS);
});

// ---------------------------------------------------------------- in the app

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

test('learning is quiet, the follow-up gets the fact, unrelated questions do not', async () => {
  const { say } = await mount();
  expect(await say("I'm learning Kafka for my career.")).toBe('model answer'); // no "I learned that…" interruption
  expect((await chat.listLearned()).map(l => l.value)).toEqual(['Kafka']);
  await say('What should I learn next?');
  expect(mockSystem[mockSystem.length - 1]).toContain('The user is learning Kafka (a software technology).');
  await say('What is the capital of France?');
  expect(mockSystem[mockSystem.length - 1]).toBe('You are a concise, helpful assistant.'); // nothing forced in
});

test('a statement carries its own fact to the model; the message itself is unchanged', async () => {
  const { say } = await mount();
  await say("I'm planning an Ayodhya and Varanasi trip in December.");
  await say('What should I book first for the trip, in detail?');
  expect(mockSystem[mockSystem.length - 1]).toContain('The user is planning Ayodhya and Varanasi trip in December.');
});

test('user control: recall shows learned items separately; forget removes them; explicit memory stays explicit', async () => {
  const { say } = await mount();
  await say("My name is Nihal and I'm learning Kafka.");
  expect(await say('What is my name?')).toBe('Your name is Nihal.'); // learned, not explicitly saved
  await say('Remember that I prefer free software.');
  expect((await chat.listLearned()).some(l => l.kind === 'preference')).toBe(false); // explicit, not learned
  expect(await say('What do you remember about me?')).toBe(
    "I remember:\n- You prefer free software.\n\nFrom our chats, I've also noted:\n- Your name is Nihal.\n- You're learning Kafka.");
  expect(await say("Forget that I'm learning Kafka.")).toBe("Okay, I won't use that saved memory anymore.");
  await say('What should I learn next?');
  expect(mockSystem[mockSystem.length - 1]).not.toContain('Kafka');
  expect(await say('Remember my name is Nihal')).toContain("I'll remember that your name is Nihal");
  expect(await say('Forget my name')).toBe("Okay, I won't use that saved memory anymore."); // both copies of the name
  expect(await say('What is my name?')).toBe(`I don't know your name yet. Tell me "My name is …" and I'll remember it.`);
  // The polite forms are the same question, answered from the phone's memory (not left to the model)
  await say("Hi, I'm Subbu.");
  for (const q of ['Can you tell me my name', 'Could you please tell me my name?', 'Who am I?', 'Do you know my name?']) {
    expect(await say(q)).toBe('Your name is Subbu.');
  }
});
