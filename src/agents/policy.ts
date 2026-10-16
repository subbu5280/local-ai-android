/**
 * The permission policy, enforced in code (the model is never asked to respect it):
 *
 * - A plan is untrusted input. Every step must name a registered tool that is enabled for this agent, with input that
 *   passes the tool's schema, a fromStep that points to an EARLIER step producing a kind of data the tool accepts,
 *   and documents inside the run's scope. The plan is fixed before anything runs: tool results (including document
 *   text) are passed on as data and can never add steps, change tools or grant permissions.
 * - A tool's permission is granted only by enabling the tool in the agent; there is no other way to obtain it, and a
 *   failure never widens it.
 * - 'write' tools (creating files) are confirmed by the user, step by step, every time, whatever the agent setting.
 * - Limits are clamped to application bounds (LIMIT_BOUNDS), whatever an agent's stored configuration says.
 */
import { getTool, TOOLS } from './tools';
import { LIMIT_BOUNDS, validateInput, type AgentConfig, type Limits, type Plan, type StepRecord, type Tool } from './types';

export type PolicyContext = { agent: AgentConfig; scope: string[]; modelReady: boolean };

/** True when a step with this tool must be confirmed by the user right before it runs. */
export const needsConfirmation = (tool: Tool) => tool.risk === 'write';

/** May this agent use this tool at all? (Only by having it enabled; disabled agents may use nothing.) */
export const permitted = (agent: AgentConfig, tool: Tool) => agent.enabled && agent.tools.includes(tool.id);

/** Limits inside the application bounds. */
export function clampLimits(l: Partial<Limits>): Limits {
  const clamp = (k: keyof Limits, v: unknown, fallback: number) => {
    const [lo, hi] = LIMIT_BOUNDS[k];
    return Math.min(hi, Math.max(lo, Number.isInteger(v) ? (v as number) : fallback));
  };
  return { maxSteps: clamp('maxSteps', l.maxSteps, 4), maxRetries: clamp('maxRetries', l.maxRetries, 1), stepTimeoutSec: clamp('stepTimeoutSec', l.stepTimeoutSec, 90) };
}

/**
 * Validate a proposed plan against the registry and the policy.
 * @returns the steps as records (status 'planned') when valid, else the reasons it was rejected
 */
export function validatePlan(plan: Plan, ctx: PolicyContext): { steps: StepRecord[]; errors: string[] } {
  const errors: string[] = [];
  const steps: StepRecord[] = [];
  const { agent } = ctx;
  if (!agent.enabled) return { steps, errors: ['This agent is disabled.'] };
  const limits = clampLimits(agent.limits);
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return { steps, errors: ['The plan has no steps.'] };
  if (plan.steps.length > limits.maxSteps) errors.push(`The plan has ${plan.steps.length} steps; this agent allows at most ${limits.maxSteps}.`);
  plan.steps.slice(0, limits.maxSteps).forEach((s, i) => {
    const n = i + 1;
    const tool = typeof s?.tool === 'string' ? getTool(s.tool) : undefined;
    if (!tool) { errors.push(`Step ${n}: unknown tool "${String(s?.tool)}".`); return; }
    if (!permitted(agent, tool)) { errors.push(`Step ${n}: "${tool.name}" is not enabled for this agent.`); return; }
    if (tool.needsModel && !ctx.modelReady) errors.push(`Step ${n}: "${tool.name}" needs the on-device model, which is not loaded.`);
    const { value, errors: inputErrors } = validateInput(tool.input, s.input ?? {});
    inputErrors.forEach(e => errors.push(`Step ${n} (${tool.name}): ${e}.`));
    if (typeof value.documentId === 'string' && !ctx.scope.includes(value.documentId)) {
      errors.push(`Step ${n} (${tool.name}): that document is not among the documents this task may read.`);
    }
    const from = s.fromStep;
    if (from !== undefined && from !== null) {
      if (!tool.consumes) errors.push(`Step ${n} (${tool.name}): takes no input from another step.`);
      else if (!Number.isInteger(from) || from < 1 || from >= n) errors.push(`Step ${n}: fromStep must be an earlier step.`);
      else {
        const src = getTool(plan.steps[from - 1].tool);
        if (src && !tool.consumes.kinds.includes(src.produces)) {
          errors.push(`Step ${n} (${tool.name}): can't use the ${src.produces} produced by step ${from} (${src.name}).`);
        }
      }
    } else if (tool.consumes?.required) errors.push(`Step ${n} (${tool.name}): needs the result of an earlier step (fromStep).`);
    steps.push({
      index: n, tool: tool.id, toolVersion: tool.version, purpose: typeof s.purpose === 'string' ? s.purpose.slice(0, 80) : tool.name,
      input: value, fromStep: Number.isInteger(from) ? (from as number) : null, status: 'planned', attempts: 0, summary: null,
      warning: null, errorCode: null, error: null, startedAt: null, endedAt: null, output: null,
    });
  });
  return { steps: errors.length ? [] : steps, errors };
}

/**
 * Validate an agent configuration before saving.
 * @param others the other saved agents (names must be unique, ignoring case)
 * @returns problems to show next to the form (empty = valid)
 */
export function validateAgent(a: Pick<AgentConfig, 'id' | 'name' | 'purpose' | 'tools' | 'limits'>, others: Pick<AgentConfig, 'id' | 'name'>[]): string[] {
  const errors: string[] = [];
  const name = a.name.trim();
  if (!name) errors.push('Name is required.');
  else if (name.length > 40) errors.push('Name must be at most 40 characters.');
  else if (others.some(o => o.id !== a.id && o.name.trim().toLowerCase() === name.toLowerCase())) errors.push('Another agent already has this name.');
  if (a.purpose.trim().length > 300) errors.push('Purpose must be at most 300 characters.');
  if (a.tools.length === 0) errors.push('Enable at least one tool.');
  a.tools.filter(t => !getTool(t)).forEach(t => errors.push(`Unknown tool "${t}".`));
  for (const k of Object.keys(LIMIT_BOUNDS) as (keyof Limits)[]) {
    const [lo, hi] = LIMIT_BOUNDS[k];
    const v = a.limits[k];
    if (!Number.isInteger(v) || v < lo || v > hi) errors.push(`${LIMIT_LABEL[k]} must be between ${lo} and ${hi}.`);
  }
  return errors;
}

export const LIMIT_LABEL: Record<keyof Limits, string> = { maxSteps: 'Maximum steps', maxRetries: 'Retries per step', stepTimeoutSec: 'Step time limit (seconds)' };
export const ALL_TOOL_IDS = TOOLS.map(t => t.id);
