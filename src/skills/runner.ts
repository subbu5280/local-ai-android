/**
 * Running a skill or workflow through the existing agent engine (no second engine).
 *
 * prepareRun: check the input values, compile the definition into engine steps, and validate them with the agent
 * policy (registered tools, schemas, document scope, model availability, step limit). The "principal" the policy
 * checks against is built from the definition itself: it may use exactly the tools the definition (and its skills)
 * declare, with limits clamped to the application bounds. Nothing in a definition can add a tool, a permission or a
 * higher limit, and 'write' steps still ask the user each time (engine).
 * executeRun (engine.ts) then runs it with confirmation, timeouts, retries, cancellation and history.
 */
import { detect, type LangCode } from '../core/language';
import { looksLikeCredential } from '../chatStore';
import { clampLimits, validatePlan } from '../agents/policy';
import { newRun } from '../agents/agentStore';
import type { AgentConfig, Run } from '../agents/types';
import { checkValues, compile, pick, toolsOf, type SkillDef, type WorkflowDef } from './format';
import type { SkillMap } from './skillStore';

export type Prepared = { run: Run | null; principal: AgentConfig | null; errors: string[] };

/** The permission principal for a definition: only its own tools, its own (clamped) limits, enabled as stored. */
export function principalFor(kind: 'skill' | 'workflow', def: SkillDef | WorkflowDef, enabled: boolean, skills: SkillMap): AgentConfig {
  return {
    id: `${kind}:${def.id}`, name: def.name.en, purpose: '', tools: kind === 'skill' ? (def as SkillDef).tools : toolsOf(def, skills),
    limits: clampLimits(def.limits), confirmPlan: true, enabled, version: def.version, createdAt: 0, updatedAt: 0,
  };
}

/**
 * A short, safe summary of the input values for history: each value cut to 80 characters, credential-like values
 * redacted, document text never included (inputs are what the user typed).
 */
export function inputSummary(def: SkillDef | WorkflowDef, values: Record<string, unknown>): string {
  return def.inputs.map(i => {
    const v = values[i.name];
    if (v === undefined || v === '') return null;
    const s = String(v).replace(/\s+/g, ' ');
    return `${i.name}: ${looksLikeCredential(s) ? '[redacted]' : s.length > 80 ? `${s.slice(0, 80)}…` : s}`;
  }).filter(Boolean).join(' · ') || '(no input)';
}

/** The answer language for a run: the user's choice, else detected from the text they entered (else English). */
export function runLanguage(choice: LangCode | 'auto', values: Record<string, unknown>): LangCode {
  if (choice !== 'auto') return choice;
  const text = Object.values(values).filter(v => typeof v === 'string').join(' ');
  return text.trim() ? detect(text).code : 'en';
}

/**
 * Validate and compile a run. Never runs anything.
 * @param ctx.scope documents the run may read; ctx.modelReady whether model-using tools can run
 */
export function prepareRun(kind: 'skill' | 'workflow', def: SkillDef | WorkflowDef, enabled: boolean, values: Record<string, unknown>,
  ctx: { skills: SkillMap; scope: string[]; modelReady: boolean; language: LangCode | 'auto'; retryOf?: string | null; now?: number }): Prepared {
  if (!enabled) return { run: null, principal: null, errors: [`This ${kind} is switched off.`] };
  const valueErrors = checkValues(def.inputs, values);
  if (valueErrors.length) return { run: null, principal: null, errors: valueErrors };
  const lang = runLanguage(ctx.language, values);
  const principal = principalFor(kind, def, enabled, ctx.skills);
  const compiled = compile(def, values, ctx.skills, lang);
  const checked = validatePlan({ steps: compiled.steps, source: 'template' }, { agent: principal, scope: ctx.scope, modelReady: ctx.modelReady });
  if (checked.errors.length) return { run: null, principal, errors: checked.errors };
  const summary = inputSummary(def, values);
  const run = newRun(principal, `${pick(def.name, lang)}: ${summary}`, null,
    { source: 'template', note: `${kind === 'skill' ? 'Skill' : 'Workflow'} ${def.id} v${def.version}: fixed steps, checked by the app.` }, checked.steps, ctx.now);
  return { run: { ...run, kind, sourceId: def.id, sourceVersion: def.version, inputSummary: summary, language: lang, retryOf: ctx.retryOf ?? null }, principal, errors: [] };
}
