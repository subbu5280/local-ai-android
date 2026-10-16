/**
 * Turning a task into a plan.
 *
 * 1. Model plan: the on-device model proposes steps as JSON. llama.rn constrains the output to a JSON schema (tool ids
 *    limited to the agent's enabled tools, at most maxSteps steps), so it is always well-formed, but its content is
 *    still untrusted and goes through policy.validatePlan like any other plan.
 * 2. Default plan ("template"): if the model is not loaded, its output can't be parsed, or its plan is rejected,
 *    fixed application rules pick a plan for the kind of task (documents question, arithmetic, date/time, summary).
 *    The plan says which of the two it is, and why the model's plan was not used.
 *
 * The planner sees only the task, the tool list and the document names: never document contents.
 */
import { analyze } from '../core/intent';
import { completeJson } from '../localModel';
import { quoteSafe } from '../knowledge/knowledgePrompt';
import { extractExpression } from './calculator';
import { clampLimits, validatePlan, type PolicyContext } from './policy';
import { getTool } from './tools';
import type { AgentConfig, Plan, StepRecord, StepSpec } from './types';

export type DocRef = { id: string; name: string };
export type PlanResult = { plan: Plan; steps: StepRecord[]; errors: string[] };

const DATE_ASK = /\b(what|which|tell me)\b.*\b(time|date|day|today|year|month)\b|\b(today'?s date|current time|time now|what day)\b/i;
const SAVE_ASK = /\b(save|export|write)\b.*\b(file|note|notes|txt|markdown|md)\b/i;

/** The document a task names by file name ("summarize report.pdf"), if any. */
function namedDocument(task: string, docs: DocRef[]): DocRef | undefined {
  const t = task.toLowerCase();
  return docs.filter(d => t.includes(d.name.toLowerCase()) || t.includes(d.name.toLowerCase().replace(/\.[a-z0-9]+$/, '')))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/** A safe file name for an export, from the task's words. */
function fileNameFor(task: string): string {
  const words = task.toLowerCase().match(/[a-z0-9]+/g)?.filter(w => !/^(save|export|write|the|a|an|to|as|of|in|into|file|note|notes|txt|md|and|my|please|what|is|are|how|does|do|it|this|that)$/.test(w)).slice(0, 4) ?? [];
  return `${words.join('-') || 'notes'}.txt`;
}

/**
 * The application's default plan for a task (no model involved).
 * @returns steps, or null when none of the agent's tools fits the task
 */
export function templatePlan(task: string, agent: AgentConfig, docs: DocRef[]): StepSpec[] | null {
  const has = (id: string) => agent.tools.includes(id);
  const expression = extractExpression(task);
  if (expression && has('calculator')) return [{ tool: 'calculator', input: { expression }, purpose: 'Calculate exactly' }];
  if (DATE_ASK.test(task) && has('datetime') && !has('docs.search')) return [{ tool: 'datetime', input: {}, purpose: 'Read the phone clock' }];
  const { intent } = analyze(task);
  const named = namedDocument(task, docs);
  if (intent === 'summarize' && named && has('docs.read') && has('text.summarize')) {
    return [{ tool: 'docs.read', input: { documentId: named.id }, purpose: `Read "${named.name}"` },
      { tool: 'text.summarize', input: {}, fromStep: 1, purpose: 'Summarize it' }];
  }
  const pasted = task.match(/:\s*([\s\S]{40,})$/)?.[1];
  if (intent === 'summarize' && pasted && has('text.summarize')) {
    return [{ tool: 'text.summarize', input: { text: pasted.slice(0, 20000) }, purpose: 'Summarize the given text' }];
  }
  if (has('docs.search') && has('docs.answer')) {
    const steps: StepSpec[] = [
      { tool: 'docs.search', input: { query: task.slice(0, 300) }, purpose: 'Find relevant passages' },
      { tool: 'docs.answer', input: { question: task.slice(0, 1000) }, fromStep: 1, purpose: 'Answer from those passages' },
    ];
    if (SAVE_ASK.test(task) && has('file.export')) {
      steps.push({ tool: 'file.export', input: { fileName: fileNameFor(task) }, fromStep: 2, purpose: 'Save the answer as a file' });
    }
    return steps;
  }
  if (DATE_ASK.test(task) && has('datetime')) return [{ tool: 'datetime', input: {}, purpose: 'Read the phone clock' }];
  return null;
}

/** JSON schema the model's plan must follow (enforced by constrained decoding). */
function planSchema(agent: AgentConfig, maxSteps: number): object {
  return {
    type: 'object', additionalProperties: false, required: ['steps'],
    properties: {
      steps: {
        type: 'array', minItems: 1, maxItems: maxSteps,
        items: {
          type: 'object', additionalProperties: false, required: ['tool', 'input'],
          properties: {
            tool: { type: 'string', enum: agent.tools },
            input: { type: 'object' },
            fromStep: { type: 'integer', minimum: 1, maximum: maxSteps },
            purpose: { type: 'string', maxLength: 80 },
          },
        },
      },
    },
  };
}

/** The model's proposed steps (parsed JSON; content still unvalidated). */
export async function modelPlan(task: string, agent: AgentConfig, docs: DocRef[]): Promise<StepSpec[]> {
  const maxSteps = clampLimits(agent.limits).maxSteps;
  const tools = agent.tools.map(id => getTool(id)).filter(Boolean).map(t => `- ${t!.id}: ${t!.description}`).join('\n');
  const docList = agent.tools.some(t => t.startsWith('docs.')) && docs.length
    ? `\nDocuments (id: name):\n${docs.slice(0, 15).map(d => `- ${d.id}: ${quoteSafe(d.name)}`).join('\n')}\n` : '';
  const system = 'You plan tool calls for an assistant on a phone. Reply with JSON only: {"steps": [...]}.';
  const user = `Tools:\n${tools}\n${docList}\nRules: use at most ${maxSteps} steps, only the tools listed, the fewest steps that finish the ` +
    'task. Use fromStep (a step number) to give a step the result of an earlier step. Fill each input with the fields shown.' +
    `\n\nTask: ${quoteSafe(task)}`;
  const raw = await completeJson(system, user, planSchema(agent, maxSteps));
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.steps)) throw new Error('no steps in the model output');
  return parsed.steps;
}

/**
 * The plan for a task: the model's if it is valid, else the default plan (with the reason recorded).
 * @param ctx agent, document scope and whether the model is loaded
 * @param docs ready documents in scope (names shown to the planner; ids validated by the policy)
 */
export async function makePlan(task: string, ctx: PolicyContext, docs: DocRef[]): Promise<PlanResult> {
  let note = 'The on-device model is not loaded, so the default plan for this kind of task is used.';
  if (ctx.modelReady) {
    try {
      const steps = await modelPlan(task, ctx.agent, docs);
      const plan: Plan = { steps, source: 'model' };
      const checked = validatePlan(plan, ctx);
      if (!checked.errors.length) return { plan, ...checked };
      note = `The model's plan was rejected (${checked.errors[0]}), so the default plan for this kind of task is used.`;
    } catch (e: any) {
      note = `The model's plan could not be read (${String(e?.message ?? e).slice(0, 80)}), so the default plan is used.`;
    }
  }
  const steps = templatePlan(task, ctx.agent, docs);
  if (!steps) return { plan: { steps: [], source: 'template', note }, steps: [], errors: ["None of this agent's tools fits this task."] };
  const plan: Plan = { steps, source: 'template', note };
  return { plan, ...validatePlan(plan, ctx) };
}
