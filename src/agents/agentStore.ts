/**
 * Agents and their run history in the phone's SQLite (schema v5, src/chatStore.ts).
 *
 * Agent definitions are versioned (version + 1 on every edit); a run records the agent id, name and version it ran
 * with, each step's tool id and version, input, status, attempts, timings, summary and error. Step outputs are stored
 * in a bounded form: answer/summary text (capped) and passage references with short excerpts, never whole documents.
 */
import { db, newId, open } from '../chatStore';
import { clampLimits } from './policy';
import { DEFAULT_LIMITS, type AgentConfig, type Run, type StepOutput, type StepRecord } from './types';

const STORED_TEXT = 4000; // characters of a step's text kept in history

/** Agents created on first use, so the screen is useful immediately (they can be edited, disabled or deleted). */
export const DEFAULT_AGENTS: Omit<AgentConfig, 'id' | 'version' | 'createdAt' | 'updatedAt'>[] = [
  { name: 'Document assistant', purpose: 'Answers questions from your imported documents, with sources.',
    tools: ['docs.search', 'docs.passages', 'docs.read', 'docs.answer', 'text.summarize'], limits: DEFAULT_LIMITS, confirmPlan: true, enabled: true },
  { name: 'Calculator and clock', purpose: 'Exact arithmetic and the date and time, without guessing.',
    tools: ['calculator', 'datetime'], limits: { ...DEFAULT_LIMITS, maxSteps: 2 }, confirmPlan: false, enabled: true },
  { name: 'Notes writer', purpose: 'Answers from your documents and saves the answer as a text file you place.',
    tools: ['docs.search', 'docs.answer', 'file.export'], limits: DEFAULT_LIMITS, confirmPlan: true, enabled: true },
];

const row2agent = (r: any): AgentConfig => ({
  id: r.id, name: r.name, purpose: r.purpose, tools: JSON.parse(r.tools_json), limits: clampLimits(JSON.parse(r.limits_json)),
  confirmPlan: Number(r.confirm_plan) === 1, enabled: Number(r.enabled) === 1, version: Number(r.version),
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});

/** All agents, by name. Creates the default agents the first time. */
export async function listAgents(now = Date.now()): Promise<AgentConfig[]> {
  await open();
  const seeded = (await db().query("SELECT value FROM meta WHERE key = 'agents_seeded'"))[0];
  if (!seeded) {
    await db().batch([
      ...DEFAULT_AGENTS.map(a => ({ sql: `INSERT INTO agents (id, name, purpose, tools_json, limits_json, confirm_plan, enabled, version,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      params: [newId(), a.name, a.purpose, JSON.stringify(a.tools), JSON.stringify(a.limits), a.confirmPlan ? 1 : 0, 1, now, now] })),
      { sql: "INSERT INTO meta (key, value) VALUES ('agents_seeded', '1')" },
    ]);
  }
  return (await db().query('SELECT * FROM agents ORDER BY name COLLATE NOCASE')).map(row2agent);
}

export async function getAgent(id: string): Promise<AgentConfig | null> {
  await open();
  const r = (await db().query('SELECT * FROM agents WHERE id = ?', [id]))[0];
  return r ? row2agent(r) : null;
}

/**
 * Create (no id) or update an agent; an update increments its version. The caller validates first (policy.validateAgent).
 * @returns the saved agent
 */
export async function saveAgent(a: Omit<AgentConfig, 'id' | 'version' | 'createdAt' | 'updatedAt'> & { id?: string }, now = Date.now()): Promise<AgentConfig> {
  await open();
  const limits = JSON.stringify(clampLimits(a.limits));
  const existing = a.id ? await getAgent(a.id) : null;
  if (existing) {
    await db().execute(`UPDATE agents SET name = ?, purpose = ?, tools_json = ?, limits_json = ?, confirm_plan = ?, enabled = ?,
      version = version + 1, updated_at = ? WHERE id = ?`,
    [a.name.trim(), a.purpose.trim(), JSON.stringify(a.tools), limits, a.confirmPlan ? 1 : 0, a.enabled ? 1 : 0, now, existing.id]);
    return (await getAgent(existing.id))!;
  }
  const id = newId();
  await db().execute(`INSERT INTO agents (id, name, purpose, tools_json, limits_json, confirm_plan, enabled, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [id, a.name.trim(), a.purpose.trim(), JSON.stringify(a.tools), limits, a.confirmPlan ? 1 : 0, a.enabled ? 1 : 0, now, now]);
  return (await getAgent(id))!;
}

/** Delete an agent. Its run history stays (it records the agent's name and version). */
export async function deleteAgent(id: string): Promise<boolean> {
  await open();
  if (!(await getAgent(id))) return false;
  await db().execute('DELETE FROM agents WHERE id = ?', [id]);
  return true;
}

// ---------------------------------------------------------------- runs

/** A step output reduced for storage: capped text, passage references and short excerpts (no full passages). */
function storedOutput(o: StepOutput | null): string | null {
  if (!o) return null;
  return JSON.stringify({
    kind: o.kind, summary: o.summary, warning: o.warning, value: o.kind === 'value' ? o.value : undefined, sources: o.sources,
    text: o.text?.slice(0, STORED_TEXT),
    // M6: references only (document, passage, page); the text itself stays in the document and can be reopened there.
    passages: o.passages?.map(p => ({ ...p, text: '', excerpt: '' })),
  });
}

/** Save the whole run (run row + its steps) in one transaction. */
export async function saveRun(run: Run): Promise<void> {
  await open();
  await db().batch([
    { sql: `INSERT OR REPLACE INTO agent_runs (id, agent_id, agent_version, agent_name, task, scope_json, plan_source, plan_note,
      status, final_text, sources_json, error, warnings_json, created_at, started_at, ended_at, kind, source_id, source_version,
      input_summary, language, retry_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [run.id, run.agentId, run.agentVersion, run.agentName, run.task, JSON.stringify(run.scope), run.planSource, run.planNote,
      run.status, run.finalText, JSON.stringify(run.sources), run.error, JSON.stringify(run.warnings), run.createdAt, run.startedAt, run.endedAt,
      run.kind ?? 'agent', run.sourceId ?? null, run.sourceVersion ?? null, run.inputSummary ?? null, run.language ?? null, run.retryOf ?? null] },
    { sql: 'DELETE FROM agent_steps WHERE run_id = ?', params: [run.id] },
    ...run.steps.map(s => ({ sql: `INSERT INTO agent_steps (run_id, idx, tool, tool_version, purpose, input_json, from_step, status,
      attempts, summary, warning, error_code, error, output_json, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [run.id, s.index, s.tool, s.toolVersion, s.purpose, JSON.stringify(s.input), s.fromStep, s.status, s.attempts, s.summary,
      s.warning, s.errorCode, s.error, storedOutput(s.output), s.startedAt, s.endedAt] })),
  ]);
}

const num = (v: any) => (v == null ? null : Number(v));
const row2step = (r: any): StepRecord => ({
  index: Number(r.idx), tool: r.tool, toolVersion: Number(r.tool_version), purpose: r.purpose ?? '', input: JSON.parse(r.input_json),
  fromStep: num(r.from_step), status: r.status, attempts: Number(r.attempts), summary: r.summary, warning: r.warning,
  errorCode: r.error_code, error: r.error, startedAt: num(r.started_at), endedAt: num(r.ended_at),
  output: r.output_json ? JSON.parse(r.output_json) : null,
});

export async function getRun(id: string): Promise<Run | null> {
  await open();
  const r = (await db().query('SELECT * FROM agent_runs WHERE id = ?', [id]))[0];
  if (!r) return null;
  const steps = (await db().query('SELECT * FROM agent_steps WHERE run_id = ? ORDER BY idx', [id])).map(row2step);
  return {
    id: r.id, agentId: r.agent_id, agentVersion: Number(r.agent_version), agentName: r.agent_name, task: r.task,
    scope: r.scope_json ? JSON.parse(r.scope_json) : null, planSource: r.plan_source, planNote: r.plan_note, status: r.status,
    steps, finalText: r.final_text, sources: r.sources_json ? JSON.parse(r.sources_json) : [], error: r.error,
    warnings: r.warnings_json ? JSON.parse(r.warnings_json) : [], createdAt: Number(r.created_at), startedAt: num(r.started_at), endedAt: num(r.ended_at),
    kind: r.kind ?? 'agent', sourceId: r.source_id ?? undefined, sourceVersion: num(r.source_version) ?? undefined,
    inputSummary: r.input_summary ?? undefined, language: r.language ?? null, retryOf: r.retry_of ?? null,
  };
}

/** Recent runs (newest first), optionally of one agent; summaries only (no steps). */
export async function listRuns(agentId: string | null, limit = 20): Promise<Pick<Run, 'id' | 'agentId' | 'agentName' | 'task' | 'status' | 'createdAt'>[]> {
  await open();
  const cols = 'id, agent_id, agent_name, task, status, created_at';
  const rows = agentId
    ? await db().query(`SELECT ${cols} FROM agent_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ${Math.max(1, limit | 0)}`, [agentId])
    : await db().query(`SELECT ${cols} FROM agent_runs ORDER BY created_at DESC LIMIT ${Math.max(1, limit | 0)}`);
  return rows.map(r => ({ id: r.id, agentId: r.agent_id, agentName: r.agent_name, task: r.task, status: r.status, createdAt: Number(r.created_at) }));
}

/** Recent runs of one skill or workflow (newest first). */
export async function listSourceRuns(kind: 'skill' | 'workflow', sourceId: string, limit = 20): Promise<Pick<Run, 'id' | 'task' | 'status' | 'createdAt' | 'sourceVersion'>[]> {
  await open();
  const rows = await db().query(`SELECT id, task, status, created_at, source_version FROM agent_runs WHERE kind = ? AND source_id = ?
    ORDER BY created_at DESC LIMIT ${Math.max(1, limit | 0)}`, [kind, sourceId]);
  return rows.map(r => ({ id: r.id, task: r.task, status: r.status, createdAt: Number(r.created_at), sourceVersion: num(r.source_version) ?? undefined }));
}

/**
 * Delete the run history of one skill or workflow (or of all skills/workflows when sourceId is null). Steps go with
 * their runs. Agent runs, chats, documents and models are not touched.
 * @returns how many runs were deleted
 */
export async function deleteSourceRuns(kind: 'skill' | 'workflow', sourceId: string | null): Promise<number> {
  await open();
  const where = sourceId ? 'kind = ? AND source_id = ?' : 'kind = ?';
  const args = sourceId ? [kind, sourceId] : [kind];
  const n = Number((await db().query(`SELECT COUNT(*) AS n FROM agent_runs WHERE ${where}`, args))[0]?.n ?? 0);
  await db().batch([
    { sql: `DELETE FROM agent_steps WHERE run_id IN (SELECT id FROM agent_runs WHERE ${where})`, params: args },
    { sql: `DELETE FROM agent_runs WHERE ${where}`, params: args },
  ]);
  return n;
}

/** At launch: runs cut off by the app closing become 'interrupted'; their unfinished steps are marked cancelled. */
export async function recoverInterruptedRuns(now = Date.now()): Promise<number> {
  await open();
  const stuck = await db().query("SELECT id FROM agent_runs WHERE status = 'running'");
  for (const r of stuck) {
    await db().batch([
      { sql: "UPDATE agent_runs SET status = 'interrupted', error = 'The app closed while this task was running.', ended_at = ? WHERE id = ?", params: [now, r.id] },
      { sql: "UPDATE agent_steps SET status = 'cancelled', error = 'Interrupted (the app closed).', ended_at = ? WHERE run_id = ? AND status IN ('approved', 'running')",
        params: [now, r.id] },
    ]);
  }
  return stuck.length;
}

/** A new run in status 'planned' for a validated plan (not saved until it starts or the user keeps it). */
export function newRun(agent: AgentConfig, task: string, scope: string[] | null, plan: { source: Run['planSource']; note?: string },
  steps: StepRecord[], now = Date.now()): Run {
  return {
    id: newId(), agentId: agent.id, agentVersion: agent.version, agentName: agent.name, task, scope, planSource: plan.source,
    planNote: plan.note ?? null, status: 'planned', steps, finalText: null, sources: [], error: null, warnings: [],
    createdAt: now, startedAt: null, endedAt: null,
  };
}

/** A failed/cancelled/interrupted run may be re-run when none of its steps already wrote something. */
export const canRerun = (run: Pick<Run, 'status' | 'steps'>) =>
  ['failed', 'cancelled', 'interrupted', 'no_evidence'].includes(run.status) &&
  !run.steps.some(s => s.tool === 'file.export' && s.status === 'succeeded');
