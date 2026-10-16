/**
 * Skills and workflows in the phone's SQLite (schema v7): validated JSON definitions with an enabled flag and a
 * built-in flag. Everything read back from storage is validated again, so a damaged or outdated record shows its
 * problems instead of running. Built-in examples are seeded once (only if valid); they can be switched off or
 * duplicated, not edited or deleted. Deleting a definition never deletes run history, chats, documents or models.
 */
import { db, open } from '../chatStore';
import { BUILTIN_SKILLS, BUILTIN_WORKFLOWS } from './builtins';
import { validateSkill, validateWorkflow, type SkillDef, type WorkflowDef } from './format';

export type Stored<T> = { id: string; version: number; def: T | null; raw: unknown; errors: string[]; enabled: boolean; builtin: boolean; updatedAt: number };
export type SkillMap = Map<string, { def: SkillDef; enabled: boolean }>;

let seededFor: unknown = null;
async function seed(now: number): Promise<void> {
  if (seededFor === db()) return;
  await open();
  const done = (await db().query("SELECT value FROM meta WHERE key = 'skills_seeded'"))[0];
  if (!done) {
    const statements: { sql: string; params: any[] }[] = [];
    for (const raw of BUILTIN_SKILLS) {
      const v = validateSkill(raw);
      if (v.def) statements.push({ sql: 'INSERT OR IGNORE INTO skills (id, version, def_json, enabled, builtin, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)',
        params: [v.def.id, v.def.version, JSON.stringify(v.def), now, now] });
    }
    // Workflows reference skills: validate them against the built-in skills just prepared.
    const skills: SkillMap = new Map(BUILTIN_SKILLS.map(r => validateSkill(r).def).filter((d): d is SkillDef => !!d).map(d => [d.id, { def: d, enabled: true }]));
    for (const raw of BUILTIN_WORKFLOWS) {
      const v = validateWorkflow(raw, skills);
      if (v.def) statements.push({ sql: 'INSERT OR IGNORE INTO workflows (id, version, def_json, enabled, builtin, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)',
        params: [v.def.id, v.def.version, JSON.stringify(v.def), now, now] });
    }
    statements.push({ sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('skills_seeded', '1')", params: [] });
    await db().batch(statements);
  }
  seededFor = db();
}

const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

/** All skills, validated (an invalid record has def null and its errors). */
export async function listSkills(now = Date.now()): Promise<Stored<SkillDef>[]> {
  await seed(now);
  const rows = await db().query('SELECT * FROM skills ORDER BY builtin DESC, id');
  return rows.map(r => {
    const raw = parse(r.def_json);
    const v = validateSkill(raw);
    return { id: r.id, version: Number(r.version), def: v.def, raw, errors: raw === null ? ['stored definition is not valid JSON'] : v.errors,
      enabled: Number(r.enabled) === 1, builtin: Number(r.builtin) === 1, updatedAt: Number(r.updated_at) };
  });
}

/** Valid skills by id (what workflows can use). */
export async function skillMap(): Promise<SkillMap> {
  return new Map((await listSkills()).filter(s => s.def).map(s => [s.id, { def: s.def!, enabled: s.enabled }]));
}

/** All workflows, validated against the current skills (a workflow using a removed or disabled skill is invalid). */
export async function listWorkflows(now = Date.now()): Promise<Stored<WorkflowDef>[]> {
  await seed(now);
  const skills = await skillMap();
  const rows = await db().query('SELECT * FROM workflows ORDER BY builtin DESC, id');
  return rows.map(r => {
    const raw = parse(r.def_json);
    const v = validateWorkflow(raw, skills);
    return { id: r.id, version: Number(r.version), def: v.def, raw, errors: raw === null ? ['stored definition is not valid JSON'] : v.errors,
      enabled: Number(r.enabled) === 1, builtin: Number(r.builtin) === 1, updatedAt: Number(r.updated_at) };
  });
}

export type SaveMode = 'create' | 'update' | 'replace';
export class DefinitionError extends Error {
  constructor(public errors: string[], public code: 'invalid' | 'exists' | 'builtin' | 'missing' = 'invalid') { super(errors.join('; ')); }
}

/**
 * Save a skill or workflow after validating it.
 * - create: the id must be new (an import with an existing id fails with code 'exists');
 * - update: an edit of an existing user definition; its version becomes stored version + 1;
 * - replace: an import replacing an existing user definition (version: the higher of the two, + 1).
 * Built-in definitions can't be updated or replaced (duplicate them instead). New definitions start enabled.
 * @throws DefinitionError with the validation errors or the conflict
 */
export async function saveDefinition(kind: 'skill' | 'workflow', raw: unknown, mode: SaveMode, now = Date.now()): Promise<SkillDef | WorkflowDef> {
  await seed(now);
  const table = kind === 'skill' ? 'skills' : 'workflows';
  const id = (raw as any)?.id;
  const existing = typeof id === 'string' ? (await db().query(`SELECT version, builtin FROM ${table} WHERE id = ?`, [id]))[0] : undefined;
  if (mode === 'create' && existing) throw new DefinitionError([`a ${kind} with id "${id}" already exists`], 'exists');
  if (mode !== 'create' && !existing) throw new DefinitionError([`no ${kind} with id "${id}"`], 'missing');
  if (existing && Number(existing.builtin) === 1) throw new DefinitionError(['built-in definitions can only be duplicated, not changed'], 'builtin');
  const version = existing ? Math.max(Number(existing.version), Number((raw as any)?.version) || 0) + 1 : Number((raw as any)?.version) || 1;
  const candidate = { ...(raw as object), version };
  const v = kind === 'skill' ? validateSkill(candidate) : validateWorkflow(candidate, await skillMap());
  if (!v.def) throw new DefinitionError(v.errors);
  await db().execute(existing
    ? `UPDATE ${table} SET version = ?, def_json = ?, updated_at = ? WHERE id = ?`
    : `INSERT INTO ${table} (id, version, def_json, enabled, builtin, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)`,
  existing ? [v.def.version, JSON.stringify(v.def), now, v.def.id] : [v.def.id, v.def.version, JSON.stringify(v.def), now, now]);
  return v.def;
}

/** Switch a definition on or off (built-ins too). Off: it can't run, and workflows using a disabled skill are invalid. */
export async function setEnabled(kind: 'skill' | 'workflow', id: string, enabled: boolean, now = Date.now()): Promise<void> {
  await seed(now);
  await db().execute(`UPDATE ${kind === 'skill' ? 'skills' : 'workflows'} SET enabled = ?, updated_at = ? WHERE id = ?`, [enabled ? 1 : 0, now, id]);
}

/** Delete a user definition (not a built-in). Run history, chats, documents and models stay. */
export async function deleteDefinition(kind: 'skill' | 'workflow', id: string): Promise<boolean> {
  await seed(Date.now());
  const table = kind === 'skill' ? 'skills' : 'workflows';
  const row = (await db().query(`SELECT builtin FROM ${table} WHERE id = ?`, [id]))[0];
  if (!row) return false;
  if (Number(row.builtin) === 1) throw new DefinitionError(['built-in definitions can be switched off, not deleted'], 'builtin');
  await db().execute(`DELETE FROM ${table} WHERE id = ?`, [id]);
  return true;
}

/** A copy with a new, unused id and version 1 (for "Duplicate" and "import as a copy"). */
export async function duplicateDefinition(kind: 'skill' | 'workflow', def: SkillDef | WorkflowDef): Promise<SkillDef | WorkflowDef> {
  const table = kind === 'skill' ? 'skills' : 'workflows';
  const base = def.id.replace(/-copy(-\d+)?$/, '').slice(0, 30);
  let id = `${base}-copy`;
  for (let n = 2; (await db().query(`SELECT 1 FROM ${table} WHERE id = ?`, [id])).length; n++) id = `${base}-copy-${n}`;
  return saveDefinition(kind, { ...def, id, version: 1, name: { ...def.name, en: `Copy of ${def.name.en}`.slice(0, 60) } }, 'create');
}

/** The portable JSON of a definition (what Export shares or saves). */
export const exportDefinition = (def: SkillDef | WorkflowDef) => JSON.stringify(def, null, 2);

/**
 * Parse and validate an imported definition (pasted text or a file). Never saves: the caller shows the result and
 * saves only after the user confirms.
 */
export async function parseImport(text: string): Promise<{ kind: 'skill' | 'workflow' | null; def: SkillDef | WorkflowDef | null; errors: string[]; exists: boolean }> {
  await seed(Date.now());
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: null, def: null, errors: ['not valid JSON'], exists: false };
  }
  const fmt = (raw as any)?.format;
  const kind = fmt === 'localai.skill' ? 'skill' : fmt === 'localai.workflow' ? 'workflow' : null;
  if (!kind) return { kind: null, def: null, errors: ['"format" must be "localai.skill" or "localai.workflow"'], exists: false };
  const v = kind === 'skill' ? validateSkill(raw) : validateWorkflow(raw, await skillMap());
  const exists = !!v.def && (await db().query(`SELECT 1 FROM ${kind === 'skill' ? 'skills' : 'workflows'} WHERE id = ?`, [v.def.id])).length > 0;
  return { kind, def: v.def, errors: v.errors, exists };
}
