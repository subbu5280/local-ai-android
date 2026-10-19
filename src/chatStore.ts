/**
 * The phone owns its chat history. Conversations and messages live in the phone's own SQLite database
 * (android/.../AiStoreModule.kt on Android's built-in SQLite). Reused from the reference POC (its Phase 15.3-15.5,
 * phone-verified there) without the laptop link: this app has no backend.
 *
 * - Bounded reads only: a conversation opens with its latest RECENT_LOAD messages; the model gets a bounded window
 *   (recentContext). Nothing loads the whole database into memory.
 * - Saved: the user's message and real assistant answers. Errors, status notices and images are not stored (an image
 *   message records only that a picture was attached; the picture itself stays in memory, as since Phase 13).
 * - Nothing in this module logs message text.
 */
import { NativeModules } from 'react-native';

export type Role = 'user' | 'assistant';
export type Db = {
  execute(sql: string, params?: any[]): Promise<unknown>;
  batch(statements: { sql: string; params?: any[] }[]): Promise<unknown>;
  query(sql: string, params?: any[]): Promise<any[]>;
};
export type Conversation = { id: string; title: string; created_at: number; updated_at: number };
/** UI details kept with a message so it renders the same after a restart (small JSON; never the image itself). */
export type MessageMeta = {
  sources?: any[]; links?: any[]; prompt?: string; interactive?: any; artifact?: any; lang?: string; serverId?: string; image?: boolean;
  picture?: string; // a generated image's file path (app-private files/images)
  replyTo?: { localId?: string; id: string; role: 'user' | 'assistant'; content: string };
  /** M3 Docs mode: the scope a question was asked in (null = all), or how its answer was produced. */
  docs?: { scope?: string[] | null; status?: 'grounded' | 'uncited' | 'none' };
};
export type StoredMessage = { id: string; conversation_id: string; role: Role; content: string; created_at: number; seq: number; meta: MessageMeta };

export const SCHEMA_VERSION = 10; // 1: conversations + messages (15.3); 2: memories (15.4); 3: learned (15.5); 4: documents (M3); 5: agents (M4); 6: passage vectors (M5); 7: skills + workflows (M6); 8: code workspaces (M7); 9: restore journal (M8); 10: document collections (M11)
/** Forward-only migrations, one list of statements per schema version (exported for upgrade tests). */
export const MIGRATIONS: string[][] = [
  [ // v1
    'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,
       conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
       role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL,
       created_at INTEGER NOT NULL, seq INTEGER NOT NULL, meta_json TEXT, UNIQUE (conversation_id, seq))`,
    'CREATE INDEX IF NOT EXISTS ix_messages_conv_seq ON messages (conversation_id, seq)',
    'CREATE INDEX IF NOT EXISTS ix_messages_conv_time ON messages (conversation_id, created_at)',
    'CREATE INDEX IF NOT EXISTS ix_conversations_updated ON conversations (updated_at)',
  ],
  [ // v2 (Phase 15.4): long-term memories, owned by the phone. One row per logical key (type, scope, key).
    // Allowed types/sources are checked here in TypeScript (MEMORY_TYPES / MEMORY_SOURCES), not by CHECK constraints,
    // so a later phase can add one without rebuilding the table. scope_id: the phone conversation a "project"
    // memory belongs to ('' for personal and preference memories).
    `CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, type TEXT NOT NULL,
       key TEXT NOT NULL CHECK (length(key) > 0), value TEXT NOT NULL CHECK (length(value) > 0),
       scope_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, source_message_id TEXT,
       confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)))`,
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_memories_logical_key ON memories (type, scope_id, key)',
    'CREATE INDEX IF NOT EXISTS ix_memories_active ON memories (active, type, updated_at)',
  ],
  [ // v3 (Phase 15.5): knowledge learned quietly from normal chat ("I'm learning Kafka"), kept apart from explicit
    // memories. Only one ACTIVE value per (kind, key): a newer statement supersedes the old row, which stays as history.
    `CREATE TABLE IF NOT EXISTS learned (id TEXT PRIMARY KEY, kind TEXT NOT NULL,
       key TEXT NOT NULL CHECK (length(key) > 0), value TEXT NOT NULL CHECK (length(value) > 0),
       conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL, source_message_id TEXT,
       confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1), lifetime TEXT NOT NULL, expires_at INTEGER,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)))`,
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_learned_current ON learned (kind, key) WHERE active = 1',
    'CREATE INDEX IF NOT EXISTS ix_learned_active ON learned (active, updated_at)',
  ],
  [ // v4 (M3): imported documents and their text passages (chunks). The full-text index over the chunks is created
    // by src/knowledge/docStore.ts, because which FTS engine exists (fts5 or fts4) is only known at runtime.
    `CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT NOT NULL, format TEXT NOT NULL,
       uri TEXT NOT NULL, mime TEXT, size INTEGER, sha256 TEXT,
       status TEXT NOT NULL CHECK (status IN ('indexing', 'ready', 'failed')), error_code TEXT, error TEXT, warning TEXT,
       page_count INTEGER, char_count INTEGER NOT NULL DEFAULT 0, chunk_count INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, indexed_at INTEGER)`,
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_documents_uri ON documents (uri)',
    'CREATE INDEX IF NOT EXISTS ix_documents_sha ON documents (sha256)',
    `CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY AUTOINCREMENT,
       document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, page INTEGER,
       text TEXT NOT NULL, token_count INTEGER NOT NULL, word_count INTEGER NOT NULL, UNIQUE (document_id, ordinal))`,
  ],
  [ // v5 (M4): agent definitions and their run history (src/agents/agentStore.ts). Runs keep the agent's name and
    // version, so history stays readable after an agent is edited or deleted (no foreign key to agents).
    `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL,
       tools_json TEXT NOT NULL, limits_json TEXT NOT NULL, confirm_plan INTEGER NOT NULL, enabled INTEGER NOT NULL,
       version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS agent_runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, agent_version INTEGER NOT NULL,
       agent_name TEXT NOT NULL, task TEXT NOT NULL, scope_json TEXT, plan_source TEXT NOT NULL, plan_note TEXT,
       status TEXT NOT NULL, final_text TEXT, sources_json TEXT, error TEXT, warnings_json TEXT,
       created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS ix_agent_runs_agent ON agent_runs (agent_id, created_at)',
    `CREATE TABLE IF NOT EXISTS agent_steps (run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
       idx INTEGER NOT NULL, tool TEXT NOT NULL, tool_version INTEGER NOT NULL, purpose TEXT, input_json TEXT NOT NULL,
       from_step INTEGER, status TEXT NOT NULL, attempts INTEGER NOT NULL, summary TEXT, warning TEXT, error_code TEXT,
       error TEXT, output_json TEXT, started_at INTEGER, ended_at INTEGER, PRIMARY KEY (run_id, idx))`,
  ],
  [ // v6 (M5): optional meaning-search vectors, one per passage and embedding model (src/knowledge/embeddings.ts).
    // text_hash lets a passage with the same text (e.g. a copied document) reuse a vector instead of re-embedding.
    `CREATE TABLE IF NOT EXISTS chunk_vectors (chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
       model TEXT NOT NULL, text_hash TEXT NOT NULL, vector TEXT NOT NULL, created_at INTEGER NOT NULL,
       PRIMARY KEY (chunk_id, model))`,
    'CREATE INDEX IF NOT EXISTS ix_chunk_vectors_hash ON chunk_vectors (model, text_hash)',
  ],
  [ // v7 (M6): skill and workflow definitions (validated JSON, src/skills/), and what a run executed. Runs of skills
    // and workflows use the existing run history (agent_runs/agent_steps); the new columns say what was run.
    `CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, version INTEGER NOT NULL, def_json TEXT NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY, version INTEGER NOT NULL, def_json TEXT NOT NULL,
       enabled INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    "ALTER TABLE agent_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'",
    'ALTER TABLE agent_runs ADD COLUMN source_id TEXT',
    'ALTER TABLE agent_runs ADD COLUMN source_version INTEGER',
    'ALTER TABLE agent_runs ADD COLUMN input_summary TEXT',
    'ALTER TABLE agent_runs ADD COLUMN language TEXT',
    'ALTER TABLE agent_runs ADD COLUMN retry_of TEXT',
    'CREATE INDEX IF NOT EXISTS ix_agent_runs_source ON agent_runs (kind, source_id, created_at)',
  ],
  [ // v8 (M7): coding assistant (src/code/). Workspaces keep only what is needed to reopen them (the granted URI) and the
    // last scan's listing (names, URIs, sizes; no contents). Tasks keep questions, answers and which file lines were
    // inspected, not the source text. Proposals keep the original and proposed text of the files they change (bounded
    // by the proposal limits): that is what the review shows and what "Restore original" writes back.
    `CREATE TABLE IF NOT EXISTS code_workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
       tree_uri TEXT NOT NULL, root_uri TEXT NOT NULL, can_write INTEGER NOT NULL, scanned_at INTEGER, entry_count INTEGER,
       truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS code_entries (workspace_id TEXT NOT NULL REFERENCES code_workspaces(id) ON DELETE CASCADE,
       path TEXT NOT NULL, uri TEXT NOT NULL, tree_uri TEXT NOT NULL, dir INTEGER NOT NULL, size INTEGER, modified INTEGER,
       can_write INTEGER NOT NULL, can_create INTEGER NOT NULL, PRIMARY KEY (workspace_id, path))`,
    `CREATE TABLE IF NOT EXISTS code_tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, title TEXT NOT NULL,
       selected_json TEXT NOT NULL, language TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS ix_code_tasks_ws ON code_tasks (workspace_id, updated_at)',
    `CREATE TABLE IF NOT EXISTS code_turns (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES code_tasks(id) ON DELETE CASCADE,
       seq INTEGER NOT NULL, mode TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, answer_json TEXT,
       inspected_json TEXT, error TEXT, proposal_id TEXT, created_at INTEGER NOT NULL, UNIQUE (task_id, seq))`,
    `CREATE TABLE IF NOT EXISTS code_proposals (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT,
       title TEXT NOT NULL, body_json TEXT NOT NULL, status TEXT NOT NULL, outcome_json TEXT,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, applied_at INTEGER)`,
    'CREATE INDEX IF NOT EXISTS ix_code_proposals_ws ON code_proposals (workspace_id, created_at)',
    `CREATE TABLE IF NOT EXISTS code_proposal_files (proposal_id TEXT NOT NULL REFERENCES code_proposals(id) ON DELETE CASCADE,
       idx INTEGER NOT NULL, op TEXT NOT NULL, path TEXT NOT NULL, purpose TEXT NOT NULL, original_sha TEXT, original_text TEXT,
       proposed_text TEXT NOT NULL, status TEXT NOT NULL, result_sha TEXT, error TEXT, PRIMARY KEY (proposal_id, idx))`,
  ],
  [ // v9 (M8): one row per restore from an encrypted backup (src/backup/restore.ts): which categories, in which mode,
    // how far it got and what each category's outcome was. Never the password or any restored content.
    `CREATE TABLE IF NOT EXISTS restore_journal (id TEXT PRIMARY KEY, status TEXT NOT NULL, plan_json TEXT NOT NULL,
       progress_json TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  ],
  [ // v10 (M11): named document collections (src/knowledge/collections.ts); a document can be in several.
    `CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_collections_name ON collections (name COLLATE NOCASE)',
    `CREATE TABLE IF NOT EXISTS collection_docs (collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
       document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, PRIMARY KEY (collection_id, document_id))`,
  ],
];

/** The database was written by a newer version of the app: it is left untouched rather than used or "repaired". */
export class NewerDatabaseError extends Error {}

export const RECENT_LOAD = 200; // messages shown when a conversation opens (a FlatList renders these lazily)
export const TITLE_CHARS = 60;

let dbImpl: Db | null = null;
let ready: Promise<void> | null = null;

/** Use another Db (unit tests: a real SQLite from node:sqlite). Resets the open state. */
export function setDb(next: Db | null) {
  dbImpl = next;
  ready = null;
}

/** The open database connection (other stores, e.g. src/knowledge/docStore.ts, share it; call open() first). */
export function db(): Db {
  if (!dbImpl) {
    const n = NativeModules.AiStore;
    if (!n) throw new Error('phone chat storage is not available in this build');
    dbImpl = { execute: (s, p = []) => n.execute(s, p), batch: st => n.batch(st), query: (s, p = []) => n.query(s, p) };
  }
  return dbImpl;
}

/** Create/upgrade the schema once (forward-only, each version in one transaction; existing rows are kept). */
export function open(): Promise<void> {
  ready ??= (async () => {
    // M8: deleted rows are overwritten with zeros instead of only being unlinked. This reduces what deletion leaves in
    // the database file; it is not a guaranteed erase (flash storage and the journal may keep older copies).
    try { await db().query('PRAGMA secure_delete = ON'); } catch {} // not every SQLite build allows it; deletion still works
    await db().execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = (await db().query("SELECT value FROM meta WHERE key = 'schema_version'"))[0];
    const have = row ? Number(row.value) : 0;
    if (!Number.isInteger(have) || have > MIGRATIONS.length) {
      throw new NewerDatabaseError(`This app's data was saved by a newer version of the app (schema ${row?.value}); it was not changed. Update the app.`);
    }
    for (let v = have; v < MIGRATIONS.length; v++) {
      await db().batch([...MIGRATIONS[v].map(sql => ({ sql })),
        { sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", params: [String(v + 1)] }]);
    }
  })().catch(e => { ready = null; throw e; }); // a failed open can be retried
  return ready;
}

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export async function schemaVersion(): Promise<number> {
  await open();
  return Number((await db().query("SELECT value FROM meta WHERE key = 'schema_version'"))[0]?.value ?? 0);
}

export async function createConversation(title: string, now = Date.now()): Promise<Conversation> {
  await open();
  const c = { id: newId(), title: title.replace(/\s+/g, ' ').trim().slice(0, TITLE_CHARS), created_at: now, updated_at: now };
  await db().execute('INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', [c.id, c.title, now, now]);
  return c;
}

export async function getConversation(id: string): Promise<Conversation | null> {
  await open();
  return (await db().query('SELECT * FROM conversations WHERE id = ?', [id]))[0] ?? null;
}

/** Most recently used first. */
export async function listConversations(limit = 20): Promise<Conversation[]> {
  await open();
  return db().query(`SELECT * FROM conversations ORDER BY updated_at DESC, id LIMIT ${Math.max(1, Math.floor(limit))}`);
}

/** Append a message (next sequence number in its conversation) and mark the conversation as just used. */
export async function addMessage(conversationId: string, role: Role, content: string, meta: MessageMeta = {},
  id = newId(), now = Date.now()): Promise<StoredMessage> {
  await open();
  const seqRow = (await db().query('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?', [conversationId]))[0];
  const seq = Number(seqRow?.next ?? 1);
  const metaJson = Object.keys(meta).length ? JSON.stringify(meta) : null;
  await db().batch([
    { sql: 'INSERT INTO messages (id, conversation_id, role, content, created_at, seq, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [id, conversationId, role, content, now, seq, metaJson] },
    { sql: 'UPDATE conversations SET updated_at = ? WHERE id = ?', params: [now, conversationId] },
  ]);
  return { id, conversation_id: conversationId, role, content, created_at: now, seq, meta };
}

const row2msg = (r: any): StoredMessage => {
  let meta: MessageMeta = {};
  try { meta = r.meta_json ? JSON.parse(r.meta_json) : {}; } catch { meta = {}; } // a damaged row still shows its text
  return { id: r.id, conversation_id: r.conversation_id, role: r.role, content: r.content, created_at: Number(r.created_at), seq: Number(r.seq), meta };
};

/** The latest `limit` messages of a conversation, oldest first (a bounded query, never the whole history). */
export async function recentMessages(conversationId: string, limit = RECENT_LOAD): Promise<StoredMessage[]> {
  await open();
  const rows = await db().query(
    `SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ${Math.max(1, Math.floor(limit))}`, [conversationId]);
  return rows.map(row2msg).reverse();
}

/**
 * Delete a conversation, its messages and its project memories, all or nothing (one transaction).
 * Messages are deleted explicitly, not only through ON DELETE CASCADE, so nothing depends on the connection having
 * foreign keys switched on. Project memories point at the conversation through a plain scope_id column (no foreign
 * key), so they are deleted here too. Learned facts keep their row and lose the link (ON DELETE SET NULL): they are
 * about the user, not the chat, and are forgotten separately. Model files are never touched.
 * @returns false if no such conversation existed (nothing changed); rejects if the database refused the delete.
 */
export async function deleteConversation(id: string): Promise<boolean> {
  await open();
  if (!(await getConversation(id))) return false;
  await db().batch([
    { sql: 'DELETE FROM messages WHERE conversation_id = ?', params: [id] },
    { sql: "DELETE FROM memories WHERE type = 'project' AND scope_id = ?", params: [id] },
    { sql: 'DELETE FROM conversations WHERE id = ?', params: [id] },
  ]);
  return true;
}

// ---------------------------------------------------------------- recent context for the phone model

/**
 * Context window for the on-device model (n_ctx 2048 tokens, answers up to 256 tokens):
 * at most CONTEXT_MESSAGES earlier messages, newest kept first, within CONTEXT_TOKENS estimated tokens, minus what
 * the current prompt itself needs. Each message is capped at MESSAGE_CHARS. 2048 = ~60 system + context ≤ 900
 * + prompt + 256 answer + headroom, so even a long Telugu exchange can't overflow the context or blow up RAM.
 */
export const CONTEXT_MESSAGES = 8;
export const CONTEXT_TOKENS = 900;
export const PROMPT_TOKENS = 1500; // context + current prompt together stay under this
export const MESSAGE_CHARS = 1200;

/** Rough token count: ~4 Latin characters per token; Indian scripts and other non-ASCII ~1 token per character. */
export function estimateTokens(text: string): number {
  let ascii = 0, other = 0;
  for (const ch of text) (ch.charCodeAt(0) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4) + other;
}

export type Turn = { role: Role; content: string };

/** The bounded, ordered (oldest -> newest) turns to give the phone model before the current prompt. */
export function recentContext(history: { role: Role; content: string }[], currentPrompt = ''): Turn[] {
  const budget = Math.min(CONTEXT_TOKENS, Math.max(0, PROMPT_TOKENS - estimateTokens(currentPrompt)));
  const out: Turn[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0 && out.length < CONTEXT_MESSAGES; i--) {
    const h = history[i];
    const content = h.content.length > MESSAGE_CHARS ? `${h.content.slice(0, MESSAGE_CHARS)}…` : h.content;
    const cost = estimateTokens(content) + 4; // role markers
    if (!content.trim()) continue;
    if (used + cost > budget) break;
    used += cost;
    out.unshift({ role: h.role, content });
  }
  // A chat template expects a user turn first; a window that starts with an answer drops it.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ---------------------------------------------------------------- Phase 15.4: long-term memory (phone-owned)
// Storage primitives only: what to remember is decided by memoryCommands.ts (explicit commands only). Nothing here
// logs, and errors name the field and rule, never the value.

export const MEMORY_TYPES = ['personal', 'preference', 'project'] as const;
export const MEMORY_SOURCES = ['user_explicit', 'user_edit'] as const; // no automatic, conversation-derived source
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemorySource = (typeof MEMORY_SOURCES)[number];
export type Memory = {
  id: string; type: MemoryType; key: string; value: string; scope_id: string; source: MemorySource;
  source_message_id: string | null; confidence: number; created_at: number; updated_at: number; active: boolean;
};
export const MAX_MEMORY_KEY = 100;
export const MAX_MEMORY_VALUE = 2000;

export class MemoryValidationError extends Error {}
/** Credential-like content: never stored. ponytail: keyword/pattern heuristic; a determined user can phrase around it. */
export class CredentialRejected extends MemoryValidationError {}

const SECRET_KEY = /\bpass(word|wd|code|phrase)s?\b|\bpwd\b|api[\s_-]?keys?|secret|\btokens?\b|\botp\b|\b[mgt]?pins?\b|\bcvv\b|private[\s_-]?key|credentials?|\blogin\b|\bauth(entication|orization)?( code)?\b|\b(card|account|iban|routing) (number|no)\b|net ?banking|\bupi id\b/i;
const SECRET_VALUE = /\b(password|passcode|[mgt]?pin|otp|cvv|api[\s_-]?key|token|secret)\s*(is|=|:)|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bhf_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\beyJ[\w-]{10,}\.[\w-]{10,}\.|-----BEGIN [A-Z ]*PRIVATE KEY|\b\d{13,19}\b/i;
/** True when text looks like a credential (used to redact a refused command before it is stored). */
export const looksLikeCredential = (text: string) => SECRET_KEY.test(text) || SECRET_VALUE.test(text);
/** True when text contains an actual secret value ("password is …", API keys, card numbers); topic words alone pass. */
export const containsSecretValue = (text: string) => SECRET_VALUE.test(text);

/** The logical key two writes are compared by: "  Favourite  Editor " -> "favourite editor". */
export const normalizeMemoryKey = (key: string) => key.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The single validation authority for a memory. Returns the normalized key and cleaned value.
 * Throws CredentialRejected for credential-like content, MemoryValidationError for anything else invalid.
 */
export function validateMemory(type: string, key: unknown, value: unknown, scopeId = ''): { key: string; value: string } {
  if (!MEMORY_TYPES.includes(type as MemoryType)) throw new MemoryValidationError(`type must be one of ${MEMORY_TYPES.join(', ')}`);
  if ((type === 'project') !== !!scopeId) throw new MemoryValidationError('project memories need a scope, and only they may have one');
  return validateKeyValue(key, value);
}

/** Key/value rules shared by explicit memories and learned knowledge: non-empty, bounded, never a credential. */
export function validateKeyValue(key: unknown, value: unknown): { key: string; value: string } {
  if (typeof key !== 'string' || !normalizeMemoryKey(key)) throw new MemoryValidationError('key must be a non-empty string');
  const k = normalizeMemoryKey(key);
  if (k.length > MAX_MEMORY_KEY) throw new MemoryValidationError(`key is longer than ${MAX_MEMORY_KEY} characters`);
  if (SECRET_KEY.test(k)) throw new CredentialRejected('key names a password, PIN, API key or token; credentials are never stored');
  if (typeof value !== 'string' || !value.trim()) throw new MemoryValidationError('value must be a non-empty string');
  const v = value.trim();
  if (v.length > MAX_MEMORY_VALUE) throw new MemoryValidationError(`value is longer than ${MAX_MEMORY_VALUE} characters`);
  if (SECRET_VALUE.test(v)) throw new CredentialRejected('value looks like a password, PIN, API key or token; credentials are never stored');
  return { key: k, value: v };
}

function checkConfidence(c: unknown): number {
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) throw new MemoryValidationError('confidence must be a number from 0 to 1');
  return c;
}
function checkSource(s: unknown): MemorySource {
  if (!MEMORY_SOURCES.includes(s as MemorySource)) throw new MemoryValidationError(`source must be one of ${MEMORY_SOURCES.join(', ')}`);
  return s as MemorySource;
}
const row2memory = (r: any): Memory => ({ ...r, confidence: Number(r.confidence), created_at: Number(r.created_at),
  updated_at: Number(r.updated_at), active: Number(r.active) === 1 });

export async function getMemory(id: string): Promise<Memory | null> {
  await open();
  const r = (await db().query('SELECT * FROM memories WHERE id = ?', [id]))[0];
  return r ? row2memory(r) : null;
}

/** The memory for a logical key (active or not), or null. */
export async function findMemory(type: MemoryType, key: string, scopeId = ''): Promise<Memory | null> {
  await open();
  const r = (await db().query('SELECT * FROM memories WHERE type = ? AND scope_id = ? AND key = ?', [type, scopeId, normalizeMemoryKey(key)]))[0];
  return r ? row2memory(r) : null;
}

/** Memories, most recently updated first; active only unless includeInactive. scopeId filters by scope. */
export async function listMemories(opts: { type?: MemoryType; scopeId?: string; includeInactive?: boolean } = {}): Promise<Memory[]> {
  await open();
  let q = 'SELECT * FROM memories WHERE 1 = 1';
  const args: any[] = [];
  if (!opts.includeInactive) q += ' AND active = 1';
  if (opts.type) { q += ' AND type = ?'; args.push(opts.type); }
  if (opts.scopeId !== undefined) { q += ' AND scope_id = ?'; args.push(opts.scopeId); }
  return (await db().query(`${q} ORDER BY updated_at DESC, id`, args)).map(row2memory);
}

/**
 * Remember `value` under (type, scope, key). Same logical key again (active or not) -> that same row is updated: the
 * latest explicit write wins, it becomes active, id and created_at are kept. Identical content changes nothing.
 * Throws MemoryValidationError / CredentialRejected for invalid input; a SQLite error rejects (nothing claimed saved).
 */
export async function createMemory(type: MemoryType, key: string, value: string, opts: {
  scopeId?: string; source?: MemorySource; confidence?: number; sourceMessageId?: string | null; now?: number;
} = {}): Promise<Memory> {
  const scopeId = opts.scopeId ?? '';
  const v = validateMemory(type, key, value, scopeId);
  const source = checkSource(opts.source ?? 'user_explicit');
  const confidence = checkConfidence(opts.confidence ?? 1);
  const now = opts.now ?? Date.now();
  const cur = await findMemory(type, v.key, scopeId);
  if (!cur) {
    const id = newId();
    await db().execute(`INSERT INTO memories (id, type, key, value, scope_id, source, source_message_id, confidence,
      created_at, updated_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [id, type, v.key, v.value, scopeId, source, opts.sourceMessageId ?? null, confidence, now, now]);
    return (await getMemory(id))!;
  }
  if (cur.value !== v.value || cur.source !== source || cur.confidence !== confidence || !cur.active) {
    await db().execute('UPDATE memories SET value = ?, source = ?, source_message_id = ?, confidence = ?, updated_at = ?, active = 1 WHERE id = ?',
      [v.value, source, opts.sourceMessageId ?? null, confidence, now, cur.id]);
  }
  return (await getMemory(cur.id))!;
}

/** Change an ACTIVE memory's value and/or confidence (type, key, created_at never change); null if missing/inactive. */
export async function updateMemory(id: string, changes: { value?: string; confidence?: number; source?: MemorySource;
  sourceMessageId?: string | null; now?: number }): Promise<Memory | null> {
  const source = checkSource(changes.source ?? 'user_edit');
  const cur = await getMemory(id);
  if (!cur || !cur.active) return null;
  const value = changes.value === undefined ? cur.value : validateMemory(cur.type, cur.key, changes.value, cur.scope_id).value;
  const confidence = changes.confidence === undefined ? cur.confidence : checkConfidence(changes.confidence);
  if (value === cur.value && confidence === cur.confidence) return cur;
  await db().execute('UPDATE memories SET value = ?, confidence = ?, source = ?, source_message_id = ?, updated_at = ? WHERE id = ? AND active = 1',
    [value, confidence, source, changes.sourceMessageId ?? null, changes.now ?? Date.now(), id]);
  return getMemory(id);
}

/** Stop using a memory ("forget"): kept as an inactive row, not physically deleted. False if missing/already inactive. */
export async function deactivateMemory(id: string, now = Date.now()): Promise<boolean> {
  const cur = await getMemory(id);
  if (!cur || !cur.active) return false;
  await db().execute('UPDATE memories SET active = 0, updated_at = ? WHERE id = ? AND active = 1', [now, id]);
  return true;
}

// ---------------------------------------------------------------- Phase 15.5: learned conversational knowledge
// Facts picked up quietly from normal chat (learning.ts decides what qualifies). Different from explicit memories:
// lower confidence, a lifetime ('lasting' or 'plan', which expires), the chat it came from, and history kept on change.

export const LEARNED_KINDS = ['personal', 'preference', 'learning', 'tool', 'project', 'plan'] as const;
export type LearnedKind = (typeof LEARNED_KINDS)[number];
export type Lifetime = 'lasting' | 'plan';
export type Learned = {
  id: string; kind: LearnedKind; key: string; value: string; conversation_id: string | null; source_message_id: string | null;
  confidence: number; lifetime: Lifetime; expires_at: number | null; created_at: number; updated_at: number; active: boolean;
};
const row2learned = (r: any): Learned => ({ ...r, confidence: Number(r.confidence), created_at: Number(r.created_at),
  updated_at: Number(r.updated_at), expires_at: r.expires_at == null ? null : Number(r.expires_at), active: Number(r.active) === 1 });

/**
 * Record a learned fact. Same (kind, key) with the same value: nothing changes. A different value supersedes the
 * current one (that row becomes inactive history) in one transaction, so only one value is ever current.
 * Validated with the same rules as explicit memories (credentials refused). Returns the current row.
 */
export async function learnFact(kind: LearnedKind, key: string, value: string, opts: { conversationId?: string | null;
  sourceMessageId?: string | null; confidence: number; lifetime: Lifetime; expiresAt?: number | null; now?: number }): Promise<Learned> {
  if (!LEARNED_KINDS.includes(kind)) throw new MemoryValidationError(`kind must be one of ${LEARNED_KINDS.join(', ')}`);
  const v = validateKeyValue(key, value);
  const confidence = checkConfidence(opts.confidence);
  const now = opts.now ?? Date.now();
  await open();
  const cur = (await db().query('SELECT * FROM learned WHERE kind = ? AND key = ? AND active = 1', [kind, v.key]))[0];
  if (cur && cur.value === v.value) return row2learned(cur);
  const id = newId();
  await db().batch([
    ...(cur ? [{ sql: 'UPDATE learned SET active = 0, updated_at = ? WHERE id = ?', params: [now, cur.id] }] : []),
    { sql: `INSERT INTO learned (id, kind, key, value, conversation_id, source_message_id, confidence, lifetime, expires_at,
      created_at, updated_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    params: [id, kind, v.key, v.value, opts.conversationId ?? null, opts.sourceMessageId ?? null, confidence, opts.lifetime,
      opts.expiresAt ?? null, now, now] },
  ]);
  return row2learned((await db().query('SELECT * FROM learned WHERE id = ?', [id]))[0]);
}

/** Current learned facts (active and not expired), newest first; `includeInactive` adds superseded/forgotten history. */
export async function listLearned(opts: { includeInactive?: boolean; now?: number } = {}): Promise<Learned[]> {
  await open();
  const now = opts.now ?? Date.now();
  const rows = opts.includeInactive
    ? await db().query('SELECT * FROM learned ORDER BY updated_at DESC, id')
    : await db().query('SELECT * FROM learned WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC, id', [now]);
  return rows.map(row2learned);
}

/** Stop using a learned fact ("forget"); kept as inactive history. False if missing/already inactive. */
export async function forgetLearned(id: string, now = Date.now()): Promise<boolean> {
  await open();
  const cur = (await db().query('SELECT active FROM learned WHERE id = ?', [id]))[0];
  if (!cur || Number(cur.active) !== 1) return false;
  await db().execute('UPDATE learned SET active = 0, updated_at = ? WHERE id = ?', [now, id]);
  return true;
}
