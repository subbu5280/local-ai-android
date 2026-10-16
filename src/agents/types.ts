/**
 * Agent engine types: tools, plans, runs, agent configuration, limits, and the small input-schema validator.
 *
 * Vocabulary used throughout: a *plan* is a list of *steps*; each step calls one *tool* from the registry with an
 * input; a *run* executes a validated plan for one task of one *agent*. Plans may come from the model (untrusted, always
 * validated) or from the app's rules ("template"); execution and permissions are enforced by application code only.
 */
import type { Passage } from '../knowledge/retrieve';
import type { Source } from '../knowledge/knowledgePrompt';
import type { LangCode } from '../core/language';

// ---------------------------------------------------------------- tool inputs

export type FieldSpec =
  | { type: 'string'; minLength?: number; maxLength: number; pattern?: RegExp; description: string }
  | { type: 'integer'; min: number; max: number; description: string }
  | { type: 'boolean'; description: string };
export type InputSchema = { fields: Record<string, FieldSpec & { required?: boolean }> };

/**
 * Check `input` against `schema`: only known fields, required ones present, types, lengths and ranges.
 * @returns the cleaned input (strings trimmed) and the list of problems (empty = valid)
 */
export function validateInput(schema: InputSchema, input: unknown): { value: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const value: Record<string, unknown> = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { value, errors: ['input must be an object'] };
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!(key in schema.fields)) errors.push(`unknown field "${key}"`);
  for (const [key, spec] of Object.entries(schema.fields)) {
    const v = raw[key];
    if (v === undefined || v === null || v === '') {
      if (spec.required) errors.push(`"${key}" is required`);
      continue;
    }
    if (spec.type === 'string') {
      if (typeof v !== 'string') { errors.push(`"${key}" must be text`); continue; }
      const s = v.trim();
      if (s.length < (spec.minLength ?? 0)) errors.push(`"${key}" is too short`);
      else if (s.length > spec.maxLength) errors.push(`"${key}" is longer than ${spec.maxLength} characters`);
      else if (spec.pattern && !spec.pattern.test(s)) errors.push(`"${key}" has an invalid format`);
      else value[key] = s;
    } else if (spec.type === 'integer') {
      if (typeof v !== 'number' || !Number.isInteger(v)) { errors.push(`"${key}" must be a whole number`); continue; }
      if (v < spec.min || v > spec.max) errors.push(`"${key}" must be between ${spec.min} and ${spec.max}`);
      else value[key] = v;
    } else if (typeof v !== 'boolean') errors.push(`"${key}" must be true or false`);
    else value[key] = v;
  }
  return { value, errors };
}

// ---------------------------------------------------------------- tools

/** What a tool may touch. Granted only by enabling the tool in an agent; 'files.create' also needs confirmation.
 * 'workspace.read' (M7) reads registered project workspaces; there is no workspace write permission for tools at all:
 * project files change only through the coding assistant's approval screen (src/code/apply.ts). */
export type Permission = 'none' | 'clock' | 'documents.read' | 'model.generate' | 'files.create' | 'workspace.read';
/** read: reads local data; compute: no side effects; write: creates data outside the app (always confirmed). */
export type Risk = 'compute' | 'read' | 'write';
/** The kind of data a step produces, and which kind a step can take from an earlier step. */
export type DataKind = 'value' | 'text' | 'passages';

export type StepOutput = {
  kind: DataKind;
  /** Shown in the step list and saved in the run history (never the full document text). */
  summary: string;
  text?: string;
  passages?: Passage[];
  sources?: Source[];
  value?: unknown;
  /** Something the user should know although the step succeeded (e.g. "the answer cited no source"). */
  warning?: string;
};

export type ToolErrorCode =
  | 'invalid_input' | 'not_permitted' | 'out_of_scope' | 'no_evidence' | 'not_found' | 'model_not_ready'
  | 'timeout' | 'cancelled' | 'declined' | 'failed' | 'check_failed';
export class ToolError extends Error {
  constructor(public code: ToolErrorCode, message: string, public recoverable = false) { super(message); }
}

/** What a running tool can see: never the app's files, settings or other conversations. */
export type ToolContext = {
  /** Document ids this run may read (all ready documents, or the user's selection). */
  scope: string[];
  /** Result of the earlier step named in the plan's fromStep, already clipped to the context budget. */
  previous: StepOutput | null;
  isCancelled: () => boolean;
  /** The language answers should be in, when the run fixes one (M6 workflows/skills); else tools detect it. */
  language?: LangCode;
  /** Register a function that stops the tool's work (e.g. stop generation) when the run is cancelled or times out. */
  onCancel: (stop: () => void) => void;
};

export type Tool = {
  id: string;
  version: number;
  name: string;
  description: string; // one line, also shown to the planner model
  input: InputSchema;
  permission: Permission;
  risk: Risk;
  /** What fromStep must provide: required, optional, or not accepted. */
  consumes: { kinds: DataKind[]; required: boolean } | null;
  produces: DataKind;
  timeoutMs: number;
  needsModel: boolean;
  /** Short preview of what the step will do, shown before a 'write' step runs. */
  preview?: (input: Record<string, unknown>, previous: StepOutput | null) => string;
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<StepOutput>;
};

// ---------------------------------------------------------------- plans and runs

export type StepSpec = { tool: string; input: Record<string, unknown>; fromStep?: number; purpose?: string };
export type PlanSource = 'model' | 'template';
export type Plan = { steps: StepSpec[]; source: PlanSource; note?: string };

export type StepStatus = 'planned' | 'approved' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
export type StepRecord = {
  index: number; // 1-based, as shown and as referenced by fromStep
  tool: string; toolVersion: number; purpose: string; input: Record<string, unknown>; fromStep: number | null;
  status: StepStatus; attempts: number; summary: string | null; warning: string | null;
  errorCode: string | null; error: string | null; startedAt: number | null; endedAt: number | null;
  output: StepOutput | null; // in memory; persisted in a bounded form
};
export type RunStatus = 'planned' | 'running' | 'succeeded' | 'no_evidence' | 'failed' | 'cancelled' | 'interrupted';
export type Run = {
  id: string; agentId: string; agentVersion: number; agentName: string; task: string; scope: string[] | null;
  planSource: PlanSource; planNote: string | null; status: RunStatus; steps: StepRecord[];
  finalText: string | null; sources: Source[]; error: string | null; warnings: string[];
  createdAt: number; startedAt: number | null; endedAt: number | null;
  /** M6: what was run (an agent, a skill or a workflow), its id and version, a short input summary, the answer
   * language fixed for the run, and the run this one re-ran. Absent on agent runs from before M6. */
  kind?: 'agent' | 'skill' | 'workflow'; sourceId?: string; sourceVersion?: number; inputSummary?: string;
  language?: LangCode | null; retryOf?: string | null;
};

// ---------------------------------------------------------------- agents

export type Limits = { maxSteps: number; maxRetries: number; stepTimeoutSec: number };
/** Application bounds: an agent's limits must stay inside these, whatever its configuration says. */
export const LIMIT_BOUNDS: { [K in keyof Limits]: [number, number] } = { maxSteps: [1, 6], maxRetries: [0, 2], stepTimeoutSec: [5, 180] };
export const DEFAULT_LIMITS: Limits = { maxSteps: 4, maxRetries: 1, stepTimeoutSec: 90 };

export type AgentConfig = {
  id: string; name: string; purpose: string; tools: string[]; limits: Limits;
  /** Show the plan and wait for "Run". Steps that write data are confirmed one by one regardless. */
  confirmPlan: boolean;
  enabled: boolean; version: number; createdAt: number; updatedAt: number;
};
