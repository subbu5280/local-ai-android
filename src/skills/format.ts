/**
 * Skills and workflows: portable JSON definitions of reusable, bounded tool sequences (M6).
 *
 * A **skill** is a short, parameterized sequence of built-in tool calls ("search documents for {{topic}}, then
 * summarize the passages") with typed inputs. A **workflow** is a sequence of tool calls and skills. Neither contains
 * code: a definition can only name registered tools, fill their typed inputs (literals, `{{input}}` text templates or
 * `{ "$input": "name" }` references) and pass the result of an earlier step (`fromStep`). Both compile into the same
 * plan the agent engine runs (policy.validatePlan + engine.executeRun): one engine, one permission policy.
 *
 * Every definition, built in or imported, goes through validateSkill / validateWorkflow before it can be saved or
 * run. Validation is strict: unknown keys are errors (nothing can be smuggled in), declared permissions must equal the
 * permissions its tools need (a skill can't understate or invent permissions), tool and skill versions must match
 * what this app has, and sizes are bounded. Texts are data shown to the user; they are never executed.
 */
import { LANG_CODES, type LangCode } from '../core/language';
import { getTool, TOOLS } from '../agents/tools';
import { LIMIT_BOUNDS, type DataKind, type Limits, type Permission, type StepSpec } from '../agents/types';

export const FORMAT_VERSION = 1;
export const MAX_DEFINITION_BYTES = 32_000;
export const MAX_INPUTS = 6;
export const MAX_DEF_STEPS = LIMIT_BOUNDS.maxSteps[1]; // a definition never has more steps than the engine allows

export type Localized = { en: string } & Partial<Record<Exclude<LangCode, 'en'>, string>>;
export type InputDef = { name: string; label: Localized; type: 'text' | 'number'; required: boolean; maxLength?: number; min?: number; max?: number };
export type TemplateValue = string | number | boolean | { $input: string };
export type ToolStepDef = { tool: string; input: Record<string, TemplateValue>; fromStep?: number; purpose?: Localized };
export type SkillStepDef = { skill: string; skillVersion: number; inputs: Record<string, TemplateValue>; purpose?: Localized };
export type WorkflowStepDef = ToolStepDef | SkillStepDef;

export type SkillDef = {
  format: 'localai.skill'; formatVersion: 1; id: string; version: number;
  name: Localized; description: Localized; instructions: Localized;
  inputs: InputDef[]; output: DataKind; tools: string[]; permissions: Permission[]; limits: Limits;
  compatibility: { tools: Record<string, number> }; steps: ToolStepDef[];
};
export type WorkflowDef = {
  format: 'localai.workflow'; formatVersion: 1; id: string; version: number;
  name: Localized; purpose: Localized; inputs: InputDef[]; limits: Limits;
  compatibility: { tools: Record<string, number>; skills: Record<string, number> }; steps: WorkflowStepDef[];
};
export type Validation<T> = { def: T | null; errors: string[] };

const ID = /^[a-z0-9][a-z0-9-]{2,40}$/;
const INPUT_NAME = /^[a-z][a-z0-9_]{0,23}$/;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,23})\s*\}\}/g;
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Errors for keys not in `allowed` (also catches "__proto__", "constructor" and any smuggled field). */
function onlyKeys(o: Record<string, unknown>, allowed: string[], where: string, errors: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${where}: unknown field "${k}"`);
}

/** A localized text: an object of language code -> text, English required. */
function localized(v: unknown, where: string, max: number, errors: string[], required = true): Localized | null {
  if (!isObj(v)) { if (required) errors.push(`${where} must be an object of language -> text (with "en")`); return null; }
  const out: Record<string, string> = {};
  for (const [k, t] of Object.entries(v)) {
    if (!(LANG_CODES as readonly string[]).includes(k)) { errors.push(`${where}: unsupported language "${k}"`); continue; }
    if (typeof t !== 'string') { errors.push(`${where}.${k} must be text`); continue; }
    const c = clean(t);
    if (c.length > max) errors.push(`${where}.${k} is longer than ${max} characters`);
    else if (c) out[k] = c;
  }
  if (!out.en) { if (required) errors.push(`${where}.en (English) is required`); return required ? null : { en: '' }; }
  return out as Localized;
}

/** The text for a language, falling back to English (ids and tool parameters are never translated). */
export const pick = (t: Localized | undefined, lang: LangCode | null | undefined) => (t ? (lang && t[lang]) || t.en : '');

function inputsOf(v: unknown, errors: string[]): InputDef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) { errors.push('inputs must be a list'); return []; }
  if (v.length > MAX_INPUTS) errors.push(`at most ${MAX_INPUTS} inputs`);
  const out: InputDef[] = [];
  v.slice(0, MAX_INPUTS).forEach((x, i) => {
    const w = `inputs[${i}]`;
    if (!isObj(x)) { errors.push(`${w} must be an object`); return; }
    onlyKeys(x, ['name', 'label', 'type', 'required', 'maxLength', 'min', 'max'], w, errors);
    const name = typeof x.name === 'string' ? x.name : '';
    if (!INPUT_NAME.test(name)) { errors.push(`${w}.name must be lowercase letters, digits or _ (starting with a letter)`); return; }
    if (out.some(o => o.name === name)) errors.push(`${w}: duplicate input "${name}"`);
    const type = x.type === 'number' ? 'number' : x.type === 'text' || x.type === undefined ? 'text' : null;
    if (!type) { errors.push(`${w}.type must be "text" or "number"`); return; }
    const num = (k: string, lo: number, hi: number) => {
      if (x[k] === undefined) return undefined;
      if (typeof x[k] !== 'number' || !Number.isFinite(x[k] as number) || (x[k] as number) < lo || (x[k] as number) > hi) { errors.push(`${w}.${k} must be a number from ${lo} to ${hi}`); return undefined; }
      return x[k] as number;
    };
    out.push({ name, label: localized(x.label ?? { en: name }, `${w}.label`, 60, errors) ?? { en: name }, type, required: x.required !== false,
      maxLength: num('maxLength', 1, 20000), min: num('min', -1e9, 1e9), max: num('max', -1e9, 1e9) });
  });
  return out;
}

function limitsOf(v: unknown, errors: string[]): Limits {
  const out: Limits = { maxSteps: 4, maxRetries: 1, stepTimeoutSec: 90 };
  if (!isObj(v)) { errors.push('limits must be an object'); return out; }
  onlyKeys(v, ['maxSteps', 'maxRetries', 'stepTimeoutSec'], 'limits', errors);
  for (const k of Object.keys(LIMIT_BOUNDS) as (keyof Limits)[]) {
    const [lo, hi] = LIMIT_BOUNDS[k];
    if (v[k] === undefined) continue;
    if (!Number.isInteger(v[k]) || (v[k] as number) < lo || (v[k] as number) > hi) errors.push(`limits.${k} must be a whole number from ${lo} to ${hi}`);
    else out[k] = v[k] as number;
  }
  return out;
}

/** Placeholders a template value refers to. */
function refsOf(v: TemplateValue): string[] {
  if (isObj(v)) return [String((v as { $input: string }).$input)];
  if (typeof v === 'string') return [...v.matchAll(PLACEHOLDER)].map(m => m[1]);
  return [];
}

/** Check one tool step's input map against the tool's fields and the declared inputs (types and references). */
function stepInput(toolId: string, v: unknown, inputs: InputDef[], where: string, errors: string[]): Record<string, TemplateValue> {
  const tool = getTool(toolId)!;
  const out: Record<string, TemplateValue> = {};
  if (v === undefined) return out;
  if (!isObj(v)) { errors.push(`${where}.input must be an object`); return out; }
  for (const [k, val] of Object.entries(v)) {
    const spec = own(tool.input.fields, k) ? tool.input.fields[k] : undefined;
    if (!spec) { errors.push(`${where}.input: "${k}" is not an input of ${tool.id}`); continue; }
    if (isObj(val)) {
      onlyKeys(val, ['$input'], `${where}.input.${k}`, errors);
      const ref = inputs.find(i => i.name === val.$input);
      if (!ref) { errors.push(`${where}.input.${k}: refers to unknown input "${String(val.$input)}"`); continue; }
      if (spec.type === 'integer' && ref.type !== 'number') errors.push(`${where}.input.${k}: needs a number input, "${ref.name}" is text`);
      out[k] = { $input: ref.name };
    } else if (typeof val === 'string') {
      if (spec.type !== 'string') { errors.push(`${where}.input.${k} must be a ${spec.type}`); continue; }
      const s = clean(val);
      if (s.length > spec.maxLength) errors.push(`${where}.input.${k} is longer than ${spec.maxLength} characters`);
      for (const r of refsOf(s)) if (!inputs.some(i => i.name === r)) errors.push(`${where}.input.${k}: {{${r}}} is not a declared input`);
      out[k] = s;
    } else if (typeof val === 'number') {
      if (spec.type !== 'integer' || !Number.isInteger(val)) errors.push(`${where}.input.${k} must be ${spec.type === 'integer' ? 'a whole number' : spec.type}`);
      else out[k] = val;
    } else if (typeof val === 'boolean') {
      if (spec.type !== 'boolean') errors.push(`${where}.input.${k} must be ${spec.type}`); else out[k] = val;
    } else errors.push(`${where}.input.${k} has an unsupported value`);
  }
  for (const [k, spec] of Object.entries(tool.input.fields)) if (spec.required && !(k in out)) errors.push(`${where}: ${tool.id} needs "${k}"`);
  return out;
}

/** The permissions a set of tools needs ('none' left out). */
export const permissionsFor = (tools: string[]): Permission[] =>
  [...new Set(tools.map(t => getTool(t)?.permission).filter((p): p is Permission => !!p && p !== 'none'))].sort();

function sizeAndShape(raw: unknown, format: string, errors: string[]): raw is Record<string, unknown> {
  let size = Infinity;
  try { size = JSON.stringify(raw)?.length ?? Infinity; } catch { /* cyclic */ }
  if (size > MAX_DEFINITION_BYTES) { errors.push(`definition is larger than ${MAX_DEFINITION_BYTES / 1000} KB`); return false; }
  if (!isObj(raw)) { errors.push('definition must be a JSON object'); return false; }
  if (raw.format !== format) { errors.push(`"format" must be "${format}"`); return false; }
  if (raw.formatVersion !== FORMAT_VERSION) { errors.push(`formatVersion ${String(raw.formatVersion)} is not supported (this app reads ${FORMAT_VERSION})`); return false; }
  return true;
}
const idOf = (raw: Record<string, unknown>, errors: string[]) => {
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!ID.test(id)) errors.push('id must be 3-41 lowercase letters, digits or "-"');
  return id;
};
const versionOf = (raw: Record<string, unknown>, errors: string[]) => {
  if (!Number.isInteger(raw.version) || (raw.version as number) < 1 || (raw.version as number) > 1e6) { errors.push('version must be a whole number from 1'); return 1; }
  return raw.version as number;
};

/** Kind of data each step produces, for fromStep checks: tool steps by their tool, skill steps by the skill's output. */
function checkFrom(from: unknown, n: number, consumer: string, produced: (DataKind | null)[], where: string, errors: string[]): number | undefined {
  const tool = getTool(consumer)!;
  if (from === undefined || from === null) {
    if (tool.consumes?.required) errors.push(`${where}: ${tool.id} needs the result of an earlier step (fromStep)`);
    return undefined;
  }
  if (!tool.consumes) { errors.push(`${where}: ${tool.id} takes no result from another step`); return undefined; }
  if (!Number.isInteger(from) || (from as number) < 1 || (from as number) >= n) { errors.push(`${where}: fromStep must be an earlier step`); return undefined; }
  const kind = produced[(from as number) - 1];
  if (kind && !tool.consumes.kinds.includes(kind)) errors.push(`${where}: ${tool.id} can't use the ${kind} produced by step ${from}`);
  return from as number;
}

/**
 * Validate a skill definition (from the form, storage or an import).
 * @returns the normalized definition, or null with the reasons
 */
export function validateSkill(raw: unknown): Validation<SkillDef> {
  const errors: string[] = [];
  if (!sizeAndShape(raw, 'localai.skill', errors)) return { def: null, errors };
  onlyKeys(raw, ['format', 'formatVersion', 'id', 'version', 'name', 'description', 'instructions', 'inputs', 'output', 'tools',
    'permissions', 'limits', 'compatibility', 'steps'], 'skill', errors);
  const id = idOf(raw, errors);
  const version = versionOf(raw, errors);
  const name = localized(raw.name, 'name', 60, errors);
  const description = localized(raw.description ?? { en: '' }, 'description', 400, errors, false) ?? { en: '' };
  const instructions = localized(raw.instructions ?? { en: '' }, 'instructions', 2000, errors, false) ?? { en: '' };
  const inputs = inputsOf(raw.inputs, errors);
  const limits = limitsOf(raw.limits ?? {}, errors);

  const tools = Array.isArray(raw.tools) ? [...new Set(raw.tools.filter((t): t is string => typeof t === 'string'))] : [];
  if (!Array.isArray(raw.tools) || !tools.length) errors.push('tools must list at least one tool');
  for (const t of tools) if (!getTool(t)) errors.push(`requires tool "${t}", which this app does not have`);
  const known = tools.filter(t => getTool(t));
  // Declared permissions must be exactly what the tools need: understated or invented permissions are rejected.
  const declared = Array.isArray(raw.permissions) ? [...new Set(raw.permissions.map(String))].sort() : null;
  const needed = permissionsFor(known);
  if (!declared) errors.push(`permissions must list: ${needed.join(', ') || '(none)'}`);
  else if (declared.join() !== needed.join()) errors.push(`permissions must be exactly what its tools need: ${needed.join(', ') || '(none)'} (declared: ${declared.join(', ') || '(none)'})`);
  const compat = isObj(raw.compatibility) ? raw.compatibility : null;
  if (!compat) errors.push('compatibility must give the tool versions it was made for');
  else {
    onlyKeys(compat, ['tools'], 'compatibility', errors);
    const tv = isObj(compat.tools) ? compat.tools : {};
    for (const t of known) {
      if (tv[t] !== getTool(t)!.version) errors.push(`made for ${t} v${String(tv[t] ?? '?')}, this app has v${getTool(t)!.version}`);
    }
  }

  const steps: ToolStepDef[] = [];
  const produced: (DataKind | null)[] = [];
  if (!Array.isArray(raw.steps) || !raw.steps.length) errors.push('steps must list at least one step');
  else if (raw.steps.length > Math.min(limits.maxSteps, MAX_DEF_STEPS)) errors.push(`${raw.steps.length} steps; the limit is ${Math.min(limits.maxSteps, MAX_DEF_STEPS)}`);
  (Array.isArray(raw.steps) ? raw.steps.slice(0, MAX_DEF_STEPS) : []).forEach((s, i) => {
    const w = `steps[${i + 1}]`;
    if (!isObj(s)) { errors.push(`${w} must be an object`); produced.push(null); return; }
    onlyKeys(s, ['tool', 'input', 'fromStep', 'purpose'], w, errors);
    const tool = typeof s.tool === 'string' ? getTool(s.tool) : undefined;
    if (!tool) { errors.push(`${w}: unknown tool "${String(s.tool)}"`); produced.push(null); return; }
    if (!tools.includes(tool.id)) errors.push(`${w}: uses ${tool.id}, which the skill does not declare in tools`);
    const input = stepInput(tool.id, s.input, inputs, w, errors);
    const fromStep = checkFrom(s.fromStep, i + 1, tool.id, produced, w, errors);
    produced.push(tool.produces);
    steps.push({ tool: tool.id, input, ...(fromStep ? { fromStep } : {}), ...(s.purpose ? { purpose: localized(s.purpose, `${w}.purpose`, 80, errors) ?? undefined } : {}) });
  });
  const output = produced[produced.length - 1];
  if (raw.output !== undefined && output && raw.output !== output) errors.push(`output says "${String(raw.output)}" but the last step produces ${output}`);
  if (errors.length || !name || !output) return { def: null, errors: errors.length ? errors : ['incomplete definition'] };
  return { def: { format: 'localai.skill', formatVersion: 1, id, version, name, description, instructions, inputs, output, tools, permissions: needed, limits,
    compatibility: { tools: Object.fromEntries(tools.map(t => [t, getTool(t)!.version])) }, steps }, errors: [] };
}

/**
 * Validate a workflow definition against this app's tools and the installed skills.
 * @param skills installed skills by id, with whether each is enabled (disabled or invalid skills make the workflow invalid)
 */
export function validateWorkflow(raw: unknown, skills: Map<string, { def: SkillDef; enabled: boolean }>): Validation<WorkflowDef> {
  const errors: string[] = [];
  if (!sizeAndShape(raw, 'localai.workflow', errors)) return { def: null, errors };
  onlyKeys(raw, ['format', 'formatVersion', 'id', 'version', 'name', 'purpose', 'inputs', 'limits', 'compatibility', 'steps'], 'workflow', errors);
  const id = idOf(raw, errors);
  const version = versionOf(raw, errors);
  const name = localized(raw.name, 'name', 60, errors);
  const purpose = localized(raw.purpose ?? { en: '' }, 'purpose', 400, errors, false) ?? { en: '' };
  const inputs = inputsOf(raw.inputs, errors);
  const limits = limitsOf(raw.limits ?? {}, errors);
  const compat = isObj(raw.compatibility) ? raw.compatibility : null;
  if (!compat) errors.push('compatibility must give the tool and skill versions it was made for');
  else onlyKeys(compat, ['tools', 'skills'], 'compatibility', errors);
  const toolVersions = compat && isObj(compat.tools) ? compat.tools : {};
  const skillVersions = compat && isObj(compat.skills) ? compat.skills : {};

  const steps: WorkflowStepDef[] = [];
  const produced: (DataKind | null)[] = [];
  let expanded = 0;
  if (!Array.isArray(raw.steps) || !raw.steps.length) errors.push('steps must list at least one step');
  (Array.isArray(raw.steps) ? raw.steps.slice(0, MAX_DEF_STEPS) : []).forEach((s, i) => {
    const w = `steps[${i + 1}]`;
    if (!isObj(s)) { errors.push(`${w} must be an object`); produced.push(null); return; }
    if (own(s, 'skill')) {
      onlyKeys(s, ['skill', 'skillVersion', 'inputs', 'purpose'], w, errors);
      const sk = skills.get(String(s.skill));
      if (!sk) { errors.push(`${w}: skill "${String(s.skill)}" is not installed`); produced.push(null); return; }
      if (!sk.enabled) errors.push(`${w}: skill "${sk.def.id}" is disabled`);
      if (s.skillVersion !== sk.def.version) errors.push(`${w}: made for skill ${sk.def.id} v${String(s.skillVersion)}, installed is v${sk.def.version}`);
      if (skillVersions[sk.def.id] !== undefined && skillVersions[sk.def.id] !== sk.def.version) errors.push(`compatibility: skill ${sk.def.id} v${String(skillVersions[sk.def.id])} differs from installed v${sk.def.version}`);
      const values: Record<string, TemplateValue> = {};
      const given = isObj(s.inputs) ? s.inputs : {};
      if (s.inputs !== undefined && !isObj(s.inputs)) errors.push(`${w}.inputs must be an object`);
      for (const [k, v] of Object.entries(given)) {
        const target = sk.def.inputs.find(x => x.name === k);
        if (!target) { errors.push(`${w}.inputs: "${k}" is not an input of skill ${sk.def.id}`); continue; }
        if (isObj(v)) {
          onlyKeys(v, ['$input'], `${w}.inputs.${k}`, errors);
          if (!inputs.some(x => x.name === v.$input)) errors.push(`${w}.inputs.${k}: refers to unknown input "${String(v.$input)}"`);
          values[k] = { $input: String(v.$input) };
        } else if (typeof v === 'string') {
          for (const r of refsOf(v)) if (!inputs.some(x => x.name === r)) errors.push(`${w}.inputs.${k}: {{${r}}} is not a declared input`);
          values[k] = clean(v).slice(0, 20000);
        } else if (typeof v === 'number' && target.type === 'number') values[k] = v;
        else errors.push(`${w}.inputs.${k} has an unsupported value`);
      }
      for (const x of sk.def.inputs) if (x.required && !(x.name in values)) errors.push(`${w}: skill ${sk.def.id} needs input "${x.name}"`);
      expanded += sk.def.steps.length;
      produced.push(sk.def.output);
      steps.push({ skill: sk.def.id, skillVersion: sk.def.version, inputs: values, ...(s.purpose ? { purpose: localized(s.purpose, `${w}.purpose`, 80, errors) ?? undefined } : {}) });
    } else {
      onlyKeys(s, ['tool', 'input', 'fromStep', 'purpose'], w, errors);
      const tool = typeof s.tool === 'string' ? getTool(s.tool) : undefined;
      if (!tool) { errors.push(`${w}: unknown tool "${String(s.tool)}"`); produced.push(null); return; }
      if (toolVersions[tool.id] !== undefined && toolVersions[tool.id] !== tool.version) errors.push(`made for ${tool.id} v${String(toolVersions[tool.id])}, this app has v${tool.version}`);
      const input = stepInput(tool.id, s.input, inputs, w, errors);
      const fromStep = checkFrom(s.fromStep, i + 1, tool.id, produced, w, errors);
      expanded += 1;
      produced.push(tool.produces);
      steps.push({ tool: tool.id, input, ...(fromStep ? { fromStep } : {}), ...(s.purpose ? { purpose: localized(s.purpose, `${w}.purpose`, 80, errors) ?? undefined } : {}) });
    }
  });
  if (Array.isArray(raw.steps) && raw.steps.length > MAX_DEF_STEPS) errors.push(`${raw.steps.length} steps; the limit is ${MAX_DEF_STEPS}`);
  if (expanded > limits.maxSteps) errors.push(`runs ${expanded} tool steps (skills included); its limit is ${limits.maxSteps} (at most ${MAX_DEF_STEPS})`);
  if (errors.length || !name) return { def: null, errors: errors.length ? errors : ['incomplete definition'] };
  const usedTools = [...new Set(steps.flatMap(s => ('tool' in s ? [s.tool] : skills.get(s.skill)!.def.tools)))];
  return { def: { format: 'localai.workflow', formatVersion: 1, id, version, name, purpose, inputs, limits,
    compatibility: { tools: Object.fromEntries(usedTools.map(t => [t, getTool(t)!.version])),
      skills: Object.fromEntries(steps.filter((s): s is SkillStepDef => 'skill' in s).map(s => [s.skill, s.skillVersion])) }, steps }, errors: [] };
}

// ---------------------------------------------------------------- compiling to an engine plan

/** Check run-time input values against the declared inputs; returns problems (empty = fine). */
export function checkValues(inputs: InputDef[], values: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const i of inputs) {
    const v = values[i.name];
    if (v === undefined || v === null || v === '') { if (i.required) errors.push(`"${pick(i.label, 'en')}" is required`); continue; }
    if (i.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`"${pick(i.label, 'en')}" must be a number`);
      else if ((i.min !== undefined && v < i.min) || (i.max !== undefined && v > i.max)) errors.push(`"${pick(i.label, 'en')}" is out of range`);
    } else if (typeof v !== 'string') errors.push(`"${pick(i.label, 'en')}" must be text`);
    else if (v.length > (i.maxLength ?? 1000)) errors.push(`"${pick(i.label, 'en')}" is longer than ${i.maxLength ?? 1000} characters`);
  }
  return errors;
}

/** A template value with the run's input values filled in (text placeholders become the text of the value). */
function fill(v: TemplateValue, values: Record<string, unknown>): unknown {
  if (isObj(v)) return values[(v as { $input: string }).$input];
  if (typeof v === 'string') return v.replace(PLACEHOLDER, (_, n) => (values[n] === undefined ? '' : String(values[n]))).trim();
  return v;
}

/**
 * Engine steps for a skill or workflow and these input values: skills are expanded in place, their internal
 * fromStep numbers shifted, and a workflow's fromStep to a skill points at the skill's last step. The result is
 * still validated by the agent policy (tools, schemas, permissions, limits) before it runs.
 */
export function compile(def: SkillDef | WorkflowDef, values: Record<string, unknown>, skills: Map<string, { def: SkillDef }>,
  lang: LangCode | null = null): { steps: StepSpec[]; tools: string[] } {
  const out: StepSpec[] = [];
  const endOf: number[] = []; // definition step index -> engine step number of its result
  const addTools = (s: ToolStepDef, vals: Record<string, unknown>, offset: number, fromMap?: number[]) => {
    const input = Object.fromEntries(Object.entries(s.input).map(([k, v]) => [k, fill(v, vals)]).filter(([, v]) => v !== '' && v !== undefined));
    const from = s.fromStep ? (fromMap ? fromMap[s.fromStep - 1] : offset + s.fromStep) : undefined;
    out.push({ tool: s.tool, input, ...(from ? { fromStep: from } : {}), purpose: pick(s.purpose, lang) || getTool(s.tool)!.name });
  };
  def.steps.forEach(s => {
    if ('skill' in s) {
      const sk = skills.get(s.skill)!.def;
      const inner = Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, fill(v, values)]));
      const offset = out.length;
      sk.steps.forEach(x => addTools(x, inner, offset));
      endOf.push(out.length);
    } else {
      addTools(s, values, 0, endOf);
      endOf.push(out.length);
    }
  });
  return { steps: out, tools: [...new Set(out.map(s => s.tool))] };
}

/** Tools this definition uses (directly or through its skills). */
export const toolsOf = (def: SkillDef | WorkflowDef, skills: Map<string, { def: SkillDef }>) =>
  [...new Set(def.steps.flatMap(s => ('skill' in s ? skills.get(s.skill)?.def.tools ?? [] : [s.tool])))];

/** All registered tools, for forms (ids and versions are stable; names are for display only). */
export const ALL_TOOLS = TOOLS;
