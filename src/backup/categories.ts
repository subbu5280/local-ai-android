/**
 * What a backup can contain: categories the user chooses, the tables and columns in each, and the strict row schema
 * every restored record is checked against. Anything not listed here is never written to a backup.
 *
 * Never included: model files (downloaded again and verified), meaning-search vectors and the keyword index (rebuilt),
 * workspace file listings (re-listed from the folder), Android storage grants (the OS can't transfer them), temporary
 * files, logs, the restore journal, and any password or key.
 */
import { db } from '../chatStore';

export type ColType = 'text' | 'int' | 'real' | 'json';
export type Col = { type: ColType; null?: boolean; max?: number; enum?: string[]; default?: unknown };
export type TableSpec = { cols: Record<string, Col>; key: string[]; where?: string };

const T = (max = 200, extra: Partial<Col> = {}): Col => ({ type: 'text', max, ...extra });
const TN = (max = 2000): Col => ({ type: 'text', max, null: true });
const I: Col = { type: 'int' };
const IN: Col = { type: 'int', null: true };
const J = (max = 20000, nullable = false): Col => ({ type: 'json', max, null: nullable });
const ID = T(64);

export const TABLES: Record<string, TableSpec> = {
  conversations: { key: ['id'], cols: { id: ID, title: T(200), created_at: I, updated_at: I } },
  messages: { key: ['id'], cols: { id: ID, conversation_id: ID, role: T(20, { enum: ['user', 'assistant'] }), content: T(200_000), created_at: I, seq: I, meta_json: J(50_000, true) } },
  memories: { key: ['id'], cols: { id: ID, type: T(40), key: T(200), value: T(4000), scope_id: T(64), source: T(40), source_message_id: TN(64),
    confidence: { type: 'real' }, created_at: I, updated_at: I, active: I } },
  learned: { key: ['id'], cols: { id: ID, kind: T(40), key: T(200), value: T(4000), conversation_id: TN(64), source_message_id: TN(64),
    confidence: { type: 'real' }, lifetime: T(20), expires_at: IN, created_at: I, updated_at: I, active: I } },
  documents: { key: ['id'], cols: { id: ID, name: T(300), format: T(20), uri: T(2000), mime: TN(200), size: IN, sha256: TN(64),
    status: T(20), error_code: TN(64), error: TN(2000), warning: TN(2000), page_count: IN, char_count: I, chunk_count: I,
    created_at: I, updated_at: I, indexed_at: IN } },
  collections: { key: ['id'], cols: { id: ID, name: T(40), created_at: I, updated_at: I } },
  collection_docs: { key: ['collection_id', 'document_id'], cols: { collection_id: ID, document_id: ID } },
  chunks: { key: ['document_id', 'ordinal'], cols: { document_id: ID, ordinal: I, page: IN, text: T(40_000), token_count: I, word_count: I } },
  agents: { key: ['id'], cols: { id: ID, name: T(80), purpose: T(1000), tools_json: J(4000), limits_json: J(1000), confirm_plan: I, enabled: I,
    version: I, created_at: I, updated_at: I } },
  skills: { key: ['id'], where: 'builtin = 0', cols: { id: ID, version: I, def_json: J(40_000), enabled: I, builtin: I, created_at: I, updated_at: I } },
  workflows: { key: ['id'], where: 'builtin = 0', cols: { id: ID, version: I, def_json: J(40_000), enabled: I, builtin: I, created_at: I, updated_at: I } },
  agent_runs: { key: ['id'], cols: { id: ID, agent_id: ID, agent_version: I, agent_name: T(200), task: T(8000), scope_json: J(20_000, true),
    plan_source: T(20), plan_note: TN(2000), status: T(20), final_text: TN(20_000), sources_json: J(20_000, true), error: TN(4000),
    warnings_json: J(10_000, true), created_at: I, started_at: IN, ended_at: IN, kind: T(20, { default: 'agent' }), source_id: TN(64),
    source_version: IN, input_summary: TN(2000), language: TN(8), retry_of: TN(64) } },
  agent_steps: { key: ['run_id', 'idx'], cols: { run_id: ID, idx: I, tool: T(64), tool_version: I, purpose: TN(200), input_json: J(20_000),
    from_step: IN, status: T(20), attempts: I, summary: TN(4000), warning: TN(2000), error_code: TN(64), error: TN(4000),
    output_json: J(40_000, true), started_at: IN, ended_at: IN } },
  code_workspaces: { key: ['id'], cols: { id: ID, name: T(80), kind: T(20, { enum: ['folder', 'files'] }), tree_uri: T(2000), root_uri: T(2000),
    can_write: I, scanned_at: IN, entry_count: IN, truncated: I, created_at: I, updated_at: I } },
  code_tasks: { key: ['id'], cols: { id: ID, workspace_id: ID, title: T(200), selected_json: J(20_000), language: TN(8), created_at: I, updated_at: I } },
  code_turns: { key: ['id'], cols: { id: ID, task_id: ID, seq: I, mode: T(20), question: T(8000), status: T(30), answer_json: J(60_000, true),
    inspected_json: J(60_000, true), error: TN(8000), proposal_id: TN(64), created_at: I } },
  code_proposals: { key: ['id'], cols: { id: ID, workspace_id: ID, task_id: TN(64), title: T(200), body_json: J(30_000), status: T(20),
    outcome_json: J(4000, true), created_at: I, updated_at: I, applied_at: IN } },
  code_proposal_files: { key: ['proposal_id', 'idx'], cols: { proposal_id: ID, idx: I, op: T(10, { enum: ['modify', 'create'] }), path: T(300),
    purpose: T(400), original_sha: TN(64), original_text: { type: 'text', max: 400_000, null: true }, proposed_text: T(400_000), status: T(20),
    result_sha: TN(64), error: TN(4000) } },
  // Settings kept in meta. Later additions: standing instructions, scheduled tasks (re-armed at the next app start) and
  // MCP servers (addresses and tool on/off switches; no credentials exist to back up).
  meta: { key: ['key'], where: "key IN ('semantic_enabled', 'proposal_retention_days', 'custom_instructions', 'scheduled_tasks', 'mcp_servers')",
    cols: { key: T(40, { enum: ['semantic_enabled', 'proposal_retention_days', 'custom_instructions', 'scheduled_tasks', 'mcp_servers'] }), value: T(200_000) } },
};

export type CategoryId = 'settings' | 'chats' | 'memories' | 'documents' | 'documentText' | 'collections' | 'agents' | 'skills' | 'runHistory'
  | 'workspaces' | 'codingHistory' | 'codeProposals';
export type Category = {
  id: CategoryId; label: string; description: string; tables: string[]; defaultOn: boolean; sensitive?: string;
  requires?: CategoryId; replace: boolean;
};

/** In backup and restore order (a category's dependencies come first). */
export const CATEGORIES: Category[] = [
  { id: 'settings', label: 'Settings', description: 'Instructions for the model, scheduled tasks, MCP connections, meaning-search on/off and proposal retention.', tables: ['meta'], defaultOn: true, replace: true },
  { id: 'chats', label: 'Chats', description: 'Conversations and their messages.', tables: ['conversations', 'messages'], defaultOn: true, replace: true },
  { id: 'memories', label: 'Memories', description: 'Facts you asked the app to remember, and what it learned from chats.', tables: ['memories', 'learned'], defaultOn: true, replace: true },
  { id: 'documents', label: 'Document list', description: 'Names, sources and status of imported documents (not their text). Restored entries need their text: restore "Document text" too, or re-import the files.',
    tables: ['documents'], defaultOn: true, replace: true },
  { id: 'documentText', label: 'Document text', description: 'The extracted text of imported documents, so they can be searched right after a restore. Can be large; may contain private content.',
    tables: ['chunks'], defaultOn: false, requires: 'documents', replace: true },
  { id: 'collections', label: 'Document collections', description: 'Named groups of documents (M11). Only documents that are in the library after the restore are added.',
    tables: ['collections', 'collection_docs'], defaultOn: true, requires: 'documents', replace: true },
  { id: 'agents', label: 'Agents', description: 'Your agent definitions (tools, limits).', tables: ['agents'], defaultOn: true, replace: true },
  { id: 'skills', label: 'Skills and workflows', description: 'Skills and workflows you created or imported (built-in examples are not included).', tables: ['skills', 'workflows'], defaultOn: true, replace: true },
  { id: 'runHistory', label: 'Agent, skill and workflow history', description: 'Past runs with their steps and results (passage references, not documents).', tables: ['agent_runs', 'agent_steps'], defaultOn: false, replace: true },
  { id: 'workspaces', label: 'Code workspaces', description: 'Names of registered project folders. Folder access can\'t be restored by Android: you will pick each folder again.', tables: ['code_workspaces'], defaultOn: true, replace: false },
  { id: 'codingHistory', label: 'Coding tasks', description: 'Questions and answers about your projects, and which lines were inspected (not the source).', tables: ['code_tasks', 'code_turns'], defaultOn: false, replace: true },
  { id: 'codeProposals', label: 'Code proposals', description: 'Proposed changes with the original and proposed text of the files they change.', tables: ['code_proposals', 'code_proposal_files'], defaultOn: false,
    sensitive: 'Contains source code, which may include secrets the app could not recognize.', replace: true },
];
export const category = (id: string) => CATEGORIES.find(c => c.id === id);

/** Always left out of backups, with the reason (shown to the user). */
export const EXCLUDED: { what: string; why: string }[] = [
  { what: 'On-device models', why: 'Large (1 GB+); downloaded again and verified (sha256) when needed.' },
  { what: 'Meaning-search vectors and the keyword search index', why: 'Rebuilt from the document text after a restore.' },
  { what: 'Code workspace file listings', why: 'Listed again from the folder once you pick it again.' },
  { what: 'Access to folders and files (Android grants)', why: 'Android does not allow transferring them; you pick the files again.' },
  { what: 'Temporary files, logs and the restore journal', why: 'Not user data.' },
  { what: 'Passwords and keys', why: 'Never stored by the app.' },
];

/** Check one untrusted row against its table's spec; returns the clean row (defaults applied) or the problems. */
export function checkRow(table: string, row: unknown): { row: Record<string, unknown> | null; error: string | null } {
  const spec = TABLES[table];
  if (!spec) return { row: null, error: `unknown table "${table}"` };
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { row: null, error: `${table}: a record is not an object` };
  const r = row as Record<string, unknown>;
  const extra = Object.keys(r).filter(k => !(k in spec.cols));
  if (extra.length) return { row: null, error: `${table}: unknown field "${extra[0]}"` };
  const out: Record<string, unknown> = {};
  for (const [name, col] of Object.entries(spec.cols)) {
    let v = r[name];
    if (v === undefined && col.default !== undefined) v = col.default; // a column added after the backup was made
    if (v === undefined || v === null) {
      if (!col.null) return { row: null, error: `${table}.${name} is missing` };
      out[name] = null;
      continue;
    }
    if (col.type === 'int' && !(typeof v === 'number' && Number.isSafeInteger(v))) return { row: null, error: `${table}.${name} must be a whole number` };
    if (col.type === 'real' && !(typeof v === 'number' && Number.isFinite(v))) return { row: null, error: `${table}.${name} must be a number` };
    if (col.type === 'text' || col.type === 'json') {
      if (typeof v !== 'string') return { row: null, error: `${table}.${name} must be text` };
      if (col.max && v.length > col.max) return { row: null, error: `${table}.${name} is too long` };
      if (col.enum && !col.enum.includes(v)) return { row: null, error: `${table}.${name} has an unsupported value` };
      if (col.type === 'json') { try { JSON.parse(v); } catch { return { row: null, error: `${table}.${name} is not valid JSON` }; } }
    }
    out[name] = v;
  }
  return { row: out, error: null };
}

export const keyOf = (table: string, row: Record<string, unknown>) => TABLES[table].key.map(k => String(row[k])).join('\u0001');

/** Every row of a table that belongs in a backup, page by page (500 rows; never the whole table in memory). */
export async function forEachRow(table: string, onRows: (rows: Record<string, unknown>[]) => Promise<void>): Promise<void> {
  const spec = TABLES[table];
  const cols = Object.keys(spec.cols).join(', ');
  for (let after = -1; ;) {
    const rows = await db().query(`SELECT rowid AS _rowid, ${cols} FROM ${table} WHERE rowid > ?${spec.where ? ` AND ${spec.where}` : ''} ORDER BY rowid LIMIT 500`, [after]);
    if (!rows.length) return;
    after = Number(rows[rows.length - 1]._rowid);
    await onRows(rows.map(({ _rowid, ...r }) => r));
  }
}

/** Rows and approximate characters per category (for the size estimate shown before a backup). */
export async function measure(id: CategoryId): Promise<{ records: number; chars: number }> {
  let records = 0, chars = 0;
  for (const t of category(id)!.tables) {
    const spec = TABLES[t];
    const text = Object.entries(spec.cols).filter(([, c]) => c.type !== 'int' && c.type !== 'real').map(([n]) => `COALESCE(length(${n}), 0)`).join(' + ') || '0';
    const r = (await db().query(`SELECT COUNT(*) AS n, COALESCE(SUM(${text}), 0) AS c FROM ${t}${spec.where ? ` WHERE ${spec.where}` : ''}`))[0];
    records += Number(r.n);
    chars += Number(r.c) + Number(r.n) * 40 * Object.keys(spec.cols).length / 4; // + JSON field names and numbers (rough)
  }
  return { records, chars: Math.round(chars) };
}
