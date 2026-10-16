/**
 * A workflow draft from a request in plain words, made on the phone (never sent anywhere).
 *
 * The on-device model proposes {name, steps}; llama.rn constrains the output to a JSON schema whose tool and skill ids
 * are limited to registered tools and enabled skills. The draft is then validated like an imported workflow
 * (format.validateWorkflow). If the model is not loaded, or its draft is invalid, the app offers a draft from its own
 * rules (planner.templatePlan) and says why. A draft is only shown: saving and running are separate user actions.
 */
import { completeJson } from '../localModel';
import { quoteSafe } from '../knowledge/knowledgePrompt';
import { templatePlan, type DocRef } from '../agents/planner';
import { DEFAULT_LIMITS, type AgentConfig } from '../agents/types';
import { getTool, TOOLS } from '../agents/tools';
import { validateWorkflow, type WorkflowDef, type WorkflowStepDef } from './format';
import type { SkillMap } from './skillStore';

export type Draft = {
  def: WorkflowDef | null; source: 'model' | 'template' | null;
  /** Why the model's draft could not be used (empty when it was used). */
  rejected: string[];
  /** Problems of the offered draft (empty = it can be saved). */
  errors: string[];
  note: string;
  /** What each step is expected to produce, as proposed (for review). */
  expects: string[];
};

// A request that starts with an action outside this app's tools (booking, buying, messaging, calling, installing,
// scheduling): explained instead of being turned into a document search. Only the start of the request is checked, so
// "Summarize this text" or "what do the documents say about opening hours" are not caught.
const UNSUPPORTED = /^\s*(?:please\s+|can you\s+|could you\s+)?(book|buy|order|pay|send|email|e-mail|call|phone|install|uninstall|tweet|schedule|remind me|set an alarm|navigate)\b/i;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'workflow';
const suffix = () => Math.random().toString(36).slice(2, 6);

/** A workflow definition around proposed steps (no inputs: values are written into the steps). */
function wrap(name: string, request: string, steps: WorkflowStepDef[], skills: SkillMap): unknown {
  return {
    format: 'localai.workflow', formatVersion: 1, id: `${slug(name)}-${suffix()}`, version: 1,
    name: { en: name.slice(0, 60) || 'New workflow' }, purpose: { en: request.slice(0, 400) }, inputs: [],
    limits: { ...DEFAULT_LIMITS, maxSteps: 6, stepTimeoutSec: 120 },
    compatibility: {
      tools: Object.fromEntries(steps.filter((s): s is Extract<WorkflowStepDef, { tool: string }> => 'tool' in s).map(s => [s.tool, getTool(s.tool)?.version ?? 0])),
      skills: Object.fromEntries(steps.filter((s): s is Extract<WorkflowStepDef, { skill: string }> => 'skill' in s).map(s => [s.skill, skills.get(s.skill)?.def.version ?? 0])),
    },
    steps,
  };
}

async function modelDraft(request: string, skills: SkillMap): Promise<{ name: string; steps: WorkflowStepDef[]; expects: string[] }> {
  const enabledSkills = [...skills.values()].filter(s => s.enabled);
  const toolIds = TOOLS.map(t => t.id);
  const schema = {
    type: 'object', additionalProperties: false, required: ['name', 'steps'],
    properties: {
      name: { type: 'string', maxLength: 60 },
      steps: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['input'],
        properties: {
          tool: { type: 'string', enum: toolIds }, skill: { type: 'string', enum: enabledSkills.length ? enabledSkills.map(s => s.def.id) : ['none'] },
          input: { type: 'object' }, fromStep: { type: 'integer', minimum: 1, maximum: 6 },
          purpose: { type: 'string', maxLength: 80 }, expect: { type: 'string', maxLength: 120 },
        } } },
    },
  };
  const list = [
    ...TOOLS.map(t => `- tool ${t.id}: ${t.description}`),
    ...enabledSkills.map(s => `- skill ${s.def.id}: ${s.def.description.en} input {${s.def.inputs.map(i => i.name).join(', ')}}`),
  ].join('\n');
  const user = `Available steps:\n${list}\n\nPlan a workflow of at most 6 steps for the request. Each step uses one tool OR one ` +
    'skill. For a skill, put its inputs in "input". Use fromStep to give a tool the result of an earlier step. ' +
    `Say in "expect" what the step produces.\n\nRequest: ${quoteSafe(request)}`;
  const raw = JSON.parse(await completeJson('You design short workflows for an assistant on a phone. Reply with JSON only.', user, schema, 400));
  const steps: WorkflowStepDef[] = (Array.isArray(raw?.steps) ? raw.steps : []).map((s: any) => (s?.skill && s.skill !== 'none'
    ? { skill: String(s.skill), skillVersion: skills.get(String(s.skill))?.def.version ?? 0, inputs: s.input ?? {}, ...(s.purpose ? { purpose: { en: String(s.purpose) } } : {}) }
    : { tool: String(s?.tool), input: s?.input ?? {}, ...(s?.fromStep ? { fromStep: s.fromStep } : {}), ...(s?.purpose ? { purpose: { en: String(s.purpose) } } : {}) }));
  return { name: String(raw?.name ?? ''), steps, expects: (raw?.steps ?? []).map((s: any) => String(s?.expect ?? '')) };
}

/**
 * Draft a workflow for a request. Never saves or runs anything.
 * @param ctx.skills installed skills; ctx.modelReady whether the on-device model can draft; ctx.docs document names
 */
export async function draftWorkflow(request: string, ctx: { skills: SkillMap; modelReady: boolean; docs: DocRef[] }): Promise<Draft> {
  const text = request.trim().slice(0, 1000);
  let rejected: string[] = [];
  let note = 'The on-device model is not loaded, so this draft comes from the app\'s rules.';
  if (ctx.modelReady) {
    try {
      const m = await modelDraft(text, ctx.skills);
      const v = validateWorkflow(wrap(m.name, text, m.steps, ctx.skills), ctx.skills);
      if (v.def) return { def: v.def, source: 'model', rejected: [], errors: [], note: 'Drafted by the on-device model and checked by the app. Review it before saving.', expects: m.expects };
      rejected = v.errors;
      note = 'The model proposed steps this app cannot run (see below), so the closest supported draft from the app\'s rules is offered instead.';
    } catch (e: any) {
      rejected = [`the model's draft could not be read (${String(e?.message ?? e).slice(0, 80)})`];
      note = 'The model\'s draft could not be read, so a draft from the app\'s rules is offered.';
    }
  }
  const action = text.match(UNSUPPORTED)?.[0];
  if (action) {
    return { def: null, source: null, rejected, errors: [`"${action}" is an action this app's tools can't do. Supported: search your documents and answer or summarize from them, summarize given text, calculate, read the date, write from a result, and save a text file you place.`], note, expects: [] };
  }
  const everything: AgentConfig = { id: 'draft', name: 'draft', purpose: '', tools: TOOLS.map(t => t.id), limits: { ...DEFAULT_LIMITS, maxSteps: 6 },
    confirmPlan: true, enabled: true, version: 1, createdAt: 0, updatedAt: 0 };
  const steps = templatePlan(text, everything, ctx.docs);
  if (!steps) {
    return { def: null, source: null, rejected, errors: ['None of the available tools or skills fits this request (supported: document search, answers and summaries from documents, summaries of given text, calculations, the date, writing from a result, saving a text file).'], note, expects: [] };
  }
  const v = validateWorkflow(wrap(text.split(/\s+/).slice(0, 6).join(' '), text, steps.map(s => ({ tool: s.tool, input: s.input as any, ...(s.fromStep ? { fromStep: s.fromStep } : {}),
    ...(s.purpose ? { purpose: { en: s.purpose } } : {}) })), ctx.skills), ctx.skills);
  return { def: v.def, source: 'template', rejected, errors: v.errors, note, expects: steps.map(s => s.purpose ?? '') };
}
