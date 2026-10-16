/**
 * Test helper for M8: a fresh database with one of everything a backup can hold (chats, memories, a document with
 * text, an agent, a custom skill, a run, a workspace, a coding task and a proposal), plus the fake native modules.
 */
import { sqliteDb } from './sqliteDb';
import { fakeBackupPickers, fakeCrypto, fsState, pickerState } from './fakeBackupEnv';

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);

export const SECRET_TEXT = 'my private note about project Falcon';

export async function freshDb(): Promise<string> {
  const chat = require('../src/chatStore');
  const fs = node('fs'), os = node('os'), path = node('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bk-')), 'chat.db');
  chat.setDb(sqliteDb(f));
  await chat.open();
  const { NativeModules } = require('react-native');
  NativeModules.AiCrypto = fakeCrypto();
  NativeModules.AiDocs = { ...fakeBackupPickers() };
  Object.assign(fsState, { free: 50e9, failAppend: false });
  Object.assign(pickerState, { saveMode: 'ok', saved: [], openFrom: '' });
  return f;
}

/** Fill the database with known content; returns ids. */
export async function seed() {
  const chat = require('../src/chatStore');
  const docStore = require('../src/knowledge/docStore');
  const agentStore = require('../src/agents/agentStore');
  const skills = require('../src/skills/skillStore');
  // Fixed ids, so a second seed() matches what a backup of the first one holds.
  await chat.db().execute("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'Falcon planning', 1000, 1000)");
  const conv = { id: 'c1' };
  await chat.addMessage(conv.id, 'user', SECRET_TEXT, { lang: 'en' }, 'm1', 1001);
  await chat.addMessage(conv.id, 'assistant', 'Noted.', {}, 'm2', 1002);
  await chat.createMemory('preference', 'editor', 'vim', { now: 1000 });
  await docStore.createDocument({ id: 'd1', name: 'refunds.txt', format: 'txt', uri: 'content://docs/refunds.txt', mime: 'text/plain', size: 70, now: 1000 });
  await docStore.replaceChunks('d1', [{ ordinal: 0, page: null, text: 'Refunds are possible within 30 days of purchase.', tokens: 10 }],
    { sha256: 'abc', size: 70, pageCount: null, charCount: 48, warning: null, now: 1000 });
  await chat.db().execute("INSERT INTO collections (id, name, created_at, updated_at) VALUES ('col1', 'Policies', 1000, 1000)");
  await chat.db().execute("INSERT INTO collection_docs (collection_id, document_id) VALUES ('col1', 'd1')");
  await agentStore.listAgents(1000); // seeds the default agents
  await chat.db().execute(`INSERT INTO agents (id, name, purpose, tools_json, limits_json, confirm_plan, enabled, version, created_at, updated_at)
    VALUES ('a1', 'My helper', 'test', '["calculator"]', '{"maxSteps":2,"maxRetries":0,"stepTimeoutSec":10}', 0, 1, 1, 1000, 1000)`);
  const agent = { id: 'a1' };
  await skills.listSkills(1000); // seeds built-ins (never backed up)
  const base = (await skills.listSkills())[0].def;
  await skills.saveDefinition('skill', { ...JSON.parse(JSON.stringify(base)), id: 'my-skill', name: { en: 'My skill' } }, 'create');
  await chat.db().execute("INSERT INTO agent_runs (id, agent_id, agent_version, agent_name, task, plan_source, status, created_at) VALUES ('r1', ?, 1, 'My helper', '2+2', 'template', 'succeeded', 1000)", [agent.id]);
  await chat.db().execute("INSERT INTO agent_steps (run_id, idx, tool, tool_version, input_json, status, attempts) VALUES ('r1', 1, 'calculator', 1, '{}', 'succeeded', 1)");
  await chat.db().execute("INSERT INTO code_workspaces (id, name, kind, tree_uri, root_uri, can_write, scanned_at, entry_count, created_at, updated_at) VALUES ('w1', 'Demo', 'folder', 'content://tree/demo', 'content://tree/demo/root', 1, 5, 3, 1000, 1000)");
  await chat.db().execute("INSERT INTO code_entries (workspace_id, path, uri, tree_uri, dir, can_write, can_create) VALUES ('w1', 'a.ts', 'content://tree/demo/a', 'content://tree/demo', 0, 1, 0)");
  await chat.db().execute("INSERT INTO code_tasks (id, workspace_id, title, selected_json, created_at, updated_at) VALUES ('t1', 'w1', 'Why?', '[]', 1000, 1000)");
  await chat.db().execute("INSERT INTO code_turns (id, task_id, seq, mode, question, status, created_at) VALUES ('u1', 't1', 1, 'ask', 'Why?', 'answered', 1000)");
  await chat.db().execute("INSERT INTO code_proposals (id, workspace_id, title, body_json, status, created_at, updated_at) VALUES ('p1', 'w1', 'Fix', '{}', 'ready', 1000, 1000)");
  await chat.db().execute("INSERT INTO code_proposal_files (proposal_id, idx, op, path, purpose, original_sha, original_text, proposed_text, status) VALUES ('p1', 1, 'modify', 'a.ts', 'p', 'x', 'const apiKey = \"q9Zr8Xw7\";', 'const a = 2;', 'pending')");
  await chat.db().execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('proposal_retention_days', '30')");
  return { conv: conv.id, agent: agent.id };
}

export const ALL = ['settings', 'chats', 'memories', 'documents', 'documentText', 'collections', 'agents', 'skills', 'runHistory', 'workspaces', 'codingHistory', 'codeProposals'];
export const PW = 'correct horse battery';
export const FAST = 200_000; // the lowest accepted PBKDF2 iteration count, to keep tests quick
