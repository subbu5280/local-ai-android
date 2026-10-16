/**
 * Chat repository tests, ported from the reference POC's __tests__/chatHistory.test.tsx (repository section).
 * Real SQL: Node's built-in SQLite via testUtils/sqliteDb, the same interface as AiStoreModule.kt on the phone.
 */
import { sqliteDb } from '../testUtils/sqliteDb';
import * as chat from '../src/chatStore';


// Node built-ins without @types/node (this RN project has none): the test runs in Node, so they exist at runtime.
const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
const fs = node('fs'), os = node('os'), path = node('path');
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-'));
  file = path.join(dir, 'chat.db');
  chat.setDb(sqliteDb(file));
});

// ---------------------------------------------------------------- repository

test('schema: tables, foreign key, indexes; opening twice changes nothing', async () => {
  expect(await chat.schemaVersion()).toBe(chat.SCHEMA_VERSION);
  const raw = sqliteDb(file);
  const names = raw.raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all().map((r: any) => r.name);
  expect(names).toEqual(expect.arrayContaining(['conversations', 'messages', 'meta', 'ix_conversations_updated',
    'ix_messages_conv_seq', 'ix_messages_conv_time']));
  await expect(chat.addMessage('no-such-conversation', 'user', 'hi')).rejects.toThrow(/FOREIGN KEY/);
  chat.setDb(sqliteDb(file)); // a second open (app restart) re-runs nothing
  expect(await chat.schemaVersion()).toBe(chat.SCHEMA_VERSION);
});

test('create a conversation, save user + assistant messages, read them back in order', async () => {
  const c = await chat.createConversation('  My favorite   color is blue. ', 1000);
  expect(c).toMatchObject({ title: 'My favorite color is blue.', created_at: 1000, updated_at: 1000 });
  await chat.addMessage(c.id, 'user', 'My favorite color is blue.', {}, 'u1', 1001);
  await chat.addMessage(c.id, 'assistant', 'Blue is a calm color.', { lang: 'en-IN' }, 'a1', 1001); // same ms: seq orders
  await chat.addMessage(c.id, 'user', 'Why?', { replyTo: { localId: 'a1', id: '', role: 'assistant', content: 'Blue is a calm color.' } }, 'u2', 1002);
  const rows = await chat.recentMessages(c.id);
  expect(rows.map(r => [r.id, r.role, r.seq])).toEqual([['u1', 'user', 1], ['a1', 'assistant', 2], ['u2', 'user', 3]]);
  expect(rows[1].meta).toEqual({ lang: 'en-IN' });
  expect(rows[2].meta.replyTo?.localId).toBe('a1');
  expect((await chat.getConversation(c.id))?.updated_at).toBe(1002);
  expect((await chat.recentMessages(c.id, 2)).map(r => r.id)).toEqual(['a1', 'u2']); // bounded: the latest only
});

test('restart: a new connection to the same file sees the same history', async () => {
  const c = await chat.createConversation('hello');
  await chat.addMessage(c.id, 'user', 'hello', {}, 'u1');
  await chat.addMessage(c.id, 'assistant', 'Hi!', {}, 'a1');
  chat.setDb(sqliteDb(file)); // like closing and reopening the app
  expect((await chat.listConversations())[0].id).toBe(c.id);
  expect((await chat.recentMessages(c.id)).map(r => r.content)).toEqual(['hello', 'Hi!']);
});

test('conversations stay isolated and are listed most-recent first', async () => {
  const a = await chat.createConversation('A', 1);
  const b = await chat.createConversation('B', 2);
  await chat.addMessage(a.id, 'user', 'only in A', {}, 'ua', 3);
  await chat.addMessage(b.id, 'user', 'only in B', {}, 'ub', 4);
  expect((await chat.recentMessages(a.id)).map(r => r.content)).toEqual(['only in A']);
  expect((await chat.recentMessages(b.id)).map(r => r.content)).toEqual(['only in B']);
  expect((await chat.listConversations()).map(c => c.title)).toEqual(['B', 'A']);
});

test('recent context: newest kept, bounded by message count and token budget, user turn first', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as chat.Role, content: `message ${i}` }));
  const ctx = chat.recentContext(many);
  expect(ctx.length).toBeLessThanOrEqual(chat.CONTEXT_MESSAGES);
  expect(ctx[ctx.length - 1].content).toBe('message 19'); // newest kept
  expect(ctx[0].role).toBe('user');
  const telugu = 'నా పేరు నిహాల్ '.repeat(80); // ~1 token per character: a few of these exhaust the budget
  const heavy = chat.recentContext([{ role: 'user', content: telugu }, { role: 'assistant', content: telugu }, { role: 'user', content: 'ok' }]);
  const used = heavy.reduce((n, t) => n + chat.estimateTokens(t.content) + 4, 0);
  expect(used).toBeLessThanOrEqual(chat.CONTEXT_TOKENS);
  expect(heavy.map(t => t.content)).toEqual(['ok']);
  const long = chat.recentContext([{ role: 'user', content: 'x'.repeat(5000) }]);
  expect(long[0].content.length).toBe(chat.MESSAGE_CHARS + 1); // capped, with "…"
  expect(chat.recentContext(many, 'y'.repeat(6000))).toEqual([]); // a huge prompt leaves no room for history
});


// ---------------------------------------------------------------- M2.3: delete a conversation

test('delete removes the conversation, its messages and its project memories; other chats are untouched', async () => {
  const a = await chat.createConversation('Chat A', 1);
  const b = await chat.createConversation('Chat B', 2);
  await chat.addMessage(a.id, 'user', 'a1', {}, 'a1', 3);
  await chat.addMessage(a.id, 'assistant', 'a2', {}, 'a2', 4);
  await chat.addMessage(b.id, 'user', 'b1', {}, 'b1', 5);
  await chat.createMemory('project', 'uses kafka', 'Kafka', { scopeId: a.id });
  await chat.createMemory('project', 'uses kotlin', 'Kotlin', { scopeId: b.id });
  await chat.createMemory('personal', 'name', 'Nihal');
  await chat.learnFact('learning', 'learning kafka', 'Kafka', { conversationId: a.id, confidence: 0.8, lifetime: 'lasting' });

  expect(await chat.deleteConversation(a.id)).toBe(true);

  expect(await chat.getConversation(a.id)).toBeNull();
  expect(await chat.recentMessages(a.id)).toEqual([]);
  expect((await chat.listConversations()).map(c => c.id)).toEqual([b.id]);
  expect((await chat.recentMessages(b.id)).map(m => m.content)).toEqual(['b1']);
  expect((await chat.listMemories()).map(m => m.key).sort()).toEqual(['name', 'uses kotlin']); // only A's project memory
  const learned = await chat.listLearned();
  expect(learned.map(l => [l.value, l.conversation_id])).toEqual([['Kafka', null]]); // kept, link cleared (SET NULL)
  expect(await chat.deleteConversation(a.id)).toBe(false); // already gone: nothing changes
});

test('delete does not rely on foreign keys being on: messages are removed explicitly', async () => {
  const raw = sqliteDb(file);
  raw.raw.exec('PRAGMA foreign_keys = OFF');
  chat.setDb(raw);
  const c = await chat.createConversation('x');
  await chat.addMessage(c.id, 'user', 'hello', {}, 'm1');
  await chat.deleteConversation(c.id);
  expect(raw.raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n).toBe(0);
});

test('a failed delete changes nothing (one transaction)', async () => {
  const c = await chat.createConversation('keep me');
  await chat.addMessage(c.id, 'user', 'still here', {}, 'm1');
  const real = sqliteDb(file);
  chat.setDb({ ...real, batch: async st => real.batch([...st, { sql: 'DELETE FROM no_such_table' }]) }); // last step fails
  await expect(chat.deleteConversation(c.id)).rejects.toThrow(/no such table/);
  chat.setDb(sqliteDb(file));
  expect((await chat.recentMessages(c.id)).map(m => m.content)).toEqual(['still here']);
});
