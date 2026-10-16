/**
 * Restore rules per category: given a category's validated rows from a backup and the user's choice, decide against
 * the CURRENT database what happens to each record, and produce the statements of one transaction.
 *
 * Merge (default): new records are added; a record identical to one already here is skipped (duplicate); a record
 * with the same identity but different content is a conflict: the current one is KEPT, or — where meaningful (chats,
 * agents, skills/workflows) and the user chose it — the backup's version is added as a copy with a new id. A current
 * user-created record is never replaced in merge mode.
 * Replace: the category's current records are deleted and the backup's inserted, in the same transaction; only when
 * the user confirmed it. Built-in skills, workspaces and other categories are never touched.
 * Definitions (agents, skills, workflows) are validated again exactly as when they are created; invalid ones are
 * skipped with the reason.
 */
import { db, newId } from '../chatStore';
import { validateAgent } from '../agents/policy';
import { validateSkill, validateWorkflow, type SkillDef } from '../skills/format';
import type { CategoryId } from './categories';
import type { Rows } from './payload';

export type Mode = 'merge' | 'replace';
export type OnConflict = 'keep' | 'copy';
export type Stats = { new: number; duplicate: number; conflict: number; copied: number; invalid: number; skipped: number };
export type Statement = { sql: string; params?: unknown[] };
export type Decision = { stmts: Statement[]; stats: Stats; notes: string[]; inserted: { table: string; id: string }[]; textFor: string[] };

const empty = (): Stats => ({ new: 0, duplicate: 0, conflict: 0, copied: 0, invalid: 0, skipped: 0 });
const insert = (table: string, row: Record<string, unknown>): Statement =>
  ({ sql: `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, params: Object.values(row) });

/** Which of `ids` exist in `table`.`col` now (queried in batches). */
async function existing(table: string, col: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    if (!part.length) continue;
    (await db().query(`SELECT ${col} AS k FROM ${table} WHERE ${col} IN (${part.map(() => '?').join(', ')})`, part)).forEach((r: any) => out.add(String(r.k)));
  }
  return out;
}
const same = (a: Record<string, unknown>, b: Record<string, unknown>, cols: string[]) => cols.every(c => String(a[c] ?? '') === String(b[c] ?? ''));
const s = (v: unknown) => String(v);

/** Decide one category. `docsWithText`: ids of documents whose text the backup holds and the user restores. */
export async function decide(id: CategoryId, rows: Rows, mode: Mode, onConflict: OnConflict, docsWithText: Set<string> = new Set()): Promise<Decision> {
  const d: Decision = { stmts: [], stats: empty(), notes: [], inserted: [], textFor: [] };
  const R = (t: string) => rows[t] ?? [];
  const add = (table: string, row: Record<string, unknown>, key = 'id') => { d.stmts.push(insert(table, row)); d.inserted.push({ table, id: s(row[key]) }); };
  const replace = mode === 'replace';

  switch (id) {
    case 'settings': {
      for (const r of R('meta')) {
        const cur = (await db().query('SELECT value FROM meta WHERE key = ?', [r.key]))[0];
        if (cur && cur.value === r.value) { d.stats.duplicate++; continue; }
        if (cur && !replace) { d.stats.conflict++; continue; }
        d.stmts.push({ sql: 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', params: [r.key, r.value] });
        d.stats.new++;
      }
      return d;
    }
    case 'chats': {
      if (replace) d.stmts.push({ sql: 'DELETE FROM messages' }, { sql: 'DELETE FROM conversations' });
      const convs = R('conversations');
      const msgs = new Map<string, Record<string, unknown>[]>();
      const convIds = new Set(convs.map(c => s(c.id)));
      for (const m of R('messages')) {
        if (!convIds.has(s(m.conversation_id))) { d.stats.invalid++; continue; }
        msgs.set(s(m.conversation_id), [...(msgs.get(s(m.conversation_id)) ?? []), m]);
      }
      const liveConv = replace ? new Set<string>() : await existing('conversations', 'id', [...convIds]);
      const liveMsg = replace ? new Set<string>() : await existing('messages', 'id', R('messages').map(m => s(m.id)));
      for (const c of convs) {
        const own = msgs.get(s(c.id)) ?? [];
        let convId = s(c.id), title = c.title;
        if (liveConv.has(convId)) {
          if (own.every(m => liveMsg.has(s(m.id)))) { d.stats.duplicate++; continue; }
          d.stats.conflict++;
          if (onConflict !== 'copy') continue;
          convId = newId();
          title = `${s(c.title).slice(0, 48)} (restored)`;
          d.stats.copied++;
        } else d.stats.new++;
        add('conversations', { ...c, id: convId, title });
        for (const m of own) add('messages', { ...m, id: liveMsg.has(s(m.id)) || convId !== c.id ? newId() : m.id, conversation_id: convId });
      }
      return d;
    }
    case 'memories': {
      if (replace) d.stmts.push({ sql: 'DELETE FROM memories' }, { sql: 'DELETE FROM learned' });
      const liveIds = replace ? new Set<string>() : await existing('memories', 'id', R('memories').map(r => s(r.id)));
      for (const r of R('memories')) {
        const cur = replace ? null : (await db().query('SELECT value FROM memories WHERE type = ? AND scope_id = ? AND key = ?', [r.type, r.scope_id, r.key]))[0];
        if (cur) { if (cur.value === r.value) d.stats.duplicate++; else d.stats.conflict++; continue; } // the current memory is kept
        add('memories', { ...r, id: liveIds.has(s(r.id)) ? newId() : r.id });
        d.stats.new++;
      }
      const liveLearned = replace ? new Set<string>() : await existing('learned', 'id', R('learned').map(r => s(r.id)));
      const activeNow = new Set<string>();
      if (!replace) (await db().query('SELECT kind, key FROM learned WHERE active = 1')).forEach((r: any) => activeNow.add(`${r.kind}\u0001${r.key}`));
      for (const r of R('learned')) {
        if (liveLearned.has(s(r.id))) { d.stats.duplicate++; continue; }
        const k = `${r.kind}\u0001${r.key}`;
        const active = Number(r.active) === 1 && !activeNow.has(k) ? 1 : 0; // only one current value per kind+key
        if (active) activeNow.add(k);
        else if (Number(r.active) === 1) d.notes.push('Some learned facts were added as history, because a current value already exists.');
        add('learned', { ...r, active });
        d.stats.new++;
      }
      d.notes = [...new Set(d.notes)];
      return d;
    }
    case 'documents': {
      if (replace) {
        const fts = (await db().query("SELECT 1 FROM sqlite_master WHERE name = 'chunks_fts'")).length > 0;
        if (fts) d.stmts.push({ sql: 'DELETE FROM chunks_fts' });
        d.stmts.push({ sql: 'DELETE FROM chunk_vectors' }, { sql: 'DELETE FROM chunks' }, { sql: 'DELETE FROM collection_docs' }, { sql: 'DELETE FROM documents' });
      }
      const docs = R('documents');
      const liveIds = replace ? new Set<string>() : await existing('documents', 'id', docs.map(r => s(r.id)));
      const liveUris = replace ? new Set<string>() : await existing('documents', 'uri', docs.map(r => s(r.uri)));
      for (const r of docs) {
        if (!/^content:\/\//.test(s(r.uri))) { d.stats.invalid++; continue; } // only Android document references
        if (liveIds.has(s(r.id)) || liveUris.has(s(r.uri))) { d.stats.duplicate++; continue; } // already in the library: kept
        const text = docsWithText.has(s(r.id));
        add('documents', { ...r, status: text ? 'indexing' : 'failed', error_code: text ? null : 'restored_without_text',
          error: text ? null : 'Restored from a backup without its text. Pick the file again (Import) to make it searchable.',
          chunk_count: 0, indexed_at: null });
        if (text) d.textFor.push(s(r.id));
        d.stats.new++;
      }
      if (docs.length && !docsWithText.size) d.notes.push('Documents were restored without their text: they are listed but not searchable until the files are imported again.');
      return d;
    }
    case 'collections': {
      if (replace) d.stmts.push({ sql: 'DELETE FROM collection_docs' }, { sql: 'DELETE FROM collections' });
      const cs = R('collections');
      const liveIds = replace ? new Set<string>() : await existing('collections', 'id', cs.map(r => s(r.id)));
      const liveNames = replace ? new Set<string>() : new Set(((await db().query('SELECT name FROM collections')) as any[]).map(r => s(r.name).toLowerCase()));
      const taken = new Set<string>();
      for (const r of cs) {
        if (liveIds.has(s(r.id)) || liveNames.has(s(r.name).toLowerCase())) { d.stats.duplicate++; continue; } // the current one is kept
        add('collections', r);
        taken.add(s(r.id));
        d.stats.new++;
      }
      // Memberships only for documents present in the library (restored earlier in this restore, or already here).
      for (const m of R('collection_docs')) {
        if (!taken.has(s(m.collection_id))) continue;
        d.stmts.push({ sql: 'INSERT OR IGNORE INTO collection_docs (collection_id, document_id) SELECT ?, id FROM documents WHERE id = ?', params: [m.collection_id, m.document_id] });
      }
      return d;
    }
    case 'agents': {
      if (replace) d.stmts.push({ sql: 'DELETE FROM agents' });
      const live = replace ? [] : await db().query('SELECT id, name, purpose, tools_json, limits_json, confirm_plan, enabled FROM agents');
      const names = new Set(live.map((a: any) => s(a.name).toLowerCase()));
      for (const r of R('agents')) {
        const cur = live.find((a: any) => a.id === r.id);
        // The same agent under another id (e.g. the default agents, created on each phone with their own ids).
        if (!cur && live.some((a: any) => same(a, r, ['name', 'purpose', 'tools_json', 'limits_json', 'confirm_plan', 'enabled']))) { d.stats.duplicate++; continue; }
        let row = { ...r };
        if (cur) {
          if (same(cur, r, ['name', 'purpose', 'tools_json', 'limits_json', 'confirm_plan', 'enabled'])) { d.stats.duplicate++; continue; }
          d.stats.conflict++;
          if (onConflict !== 'copy') continue;
          row = { ...row, id: newId() };
          d.stats.copied++;
        } else d.stats.new++;
        let name = s(row.name);
        for (let n = 1; names.has(name.toLowerCase()); n++) name = `${s(r.name).slice(0, 28)} (restored${n > 1 ? ` ${n}` : ''})`;
        row.name = name;
        const errors = validateAgent({ id: s(row.id), name, purpose: s(row.purpose), tools: JSON.parse(s(row.tools_json)), limits: JSON.parse(s(row.limits_json)) }, []);
        if (errors.length) { d.stats.invalid++; cur ? d.stats.copied-- : d.stats.new--; d.notes.push(`Agent "${s(r.name)}" was skipped: ${errors[0]}`); continue; }
        names.add(name.toLowerCase());
        add('agents', row);
      }
      return d;
    }
    case 'skills': {
      if (replace) d.stmts.push({ sql: 'DELETE FROM skills WHERE builtin = 0' }, { sql: 'DELETE FROM workflows WHERE builtin = 0' });
      const skillRows = (await db().query('SELECT id, def_json, enabled, builtin FROM skills')) as any[];
      const map = new Map<string, { def: SkillDef; enabled: boolean }>();
      for (const k of skillRows) { const v = validateSkill(JSON.parse(k.def_json)); if (v.def && !(replace && !isBuiltin(k.id, skillRows))) map.set(k.id, { def: v.def, enabled: Number(k.enabled) === 1 }); }
      for (const table of ['skills', 'workflows'] as const) {
        const live = replace ? new Map<string, any>() : new Map<string, any>(((await db().query(`SELECT id, def_json, builtin FROM ${table}`)) as any[]).map(x => [x.id, x]));
        for (const r of R(table)) {
          if (Number(r.builtin) !== 0) { d.stats.invalid++; continue; }
          let def = JSON.parse(s(r.def_json));
          const cur = live.get(s(r.id));
          if (cur) {
            if (cur.def_json === r.def_json) { d.stats.duplicate++; continue; }
            d.stats.conflict++;
            if (onConflict !== 'copy' || Number(cur.builtin) === 1) continue;
            let copyId = `${s(r.id).slice(0, 32)}-restored`;
            for (let n = 2; live.has(copyId); n++) copyId = `${s(r.id).slice(0, 30)}-restored${n}`;
            def = { ...def, id: copyId };
            d.stats.copied++;
          } else d.stats.new++;
          const v = table === 'skills' ? validateSkill(def) : validateWorkflow(def, map);
          if (!v.def) { d.stats.invalid++; cur ? d.stats.copied-- : d.stats.new--; d.notes.push(`${table === 'skills' ? 'Skill' : 'Workflow'} "${s(def?.id)}" was skipped: ${v.errors[0]}`); continue; }
          if (table === 'skills') map.set(v.def.id, { def: v.def as SkillDef, enabled: Number(r.enabled) === 1 });
          live.set(v.def.id, { id: v.def.id, def_json: JSON.stringify(v.def), builtin: 0 });
          add(table, { ...r, id: v.def.id, def_json: JSON.stringify(v.def), builtin: 0 });
        }
      }
      return d;
    }
    case 'runHistory': {
      if (replace) d.stmts.push({ sql: 'DELETE FROM agent_steps' }, { sql: 'DELETE FROM agent_runs' });
      const runs = R('agent_runs');
      const live = replace ? new Set<string>() : await existing('agent_runs', 'id', runs.map(r => s(r.id)));
      const taken = new Set<string>();
      for (const r of runs) {
        if (live.has(s(r.id))) { d.stats.duplicate++; continue; }
        add('agent_runs', r);
        taken.add(s(r.id));
        d.stats.new++;
      }
      for (const st of R('agent_steps')) if (taken.has(s(st.run_id))) d.stmts.push(insert('agent_steps', st));
      return d;
    }
    case 'workspaces': {
      const ws = R('code_workspaces');
      const liveIds = await existing('code_workspaces', 'id', ws.map(r => s(r.id)));
      const liveTrees = await existing('code_workspaces', 'tree_uri', ws.map(r => s(r.tree_uri)));
      for (const r of ws) {
        if (r.kind === 'folder' && !/^content:\/\//.test(s(r.tree_uri))) { d.stats.invalid++; continue; }
        if (liveIds.has(s(r.id)) || (r.kind === 'folder' && liveTrees.has(s(r.tree_uri)))) { d.stats.duplicate++; continue; }
        // The listing is not in backups and access must be granted again: start unlisted.
        add('code_workspaces', { ...r, scanned_at: null, entry_count: 0, truncated: 0 });
        d.stats.new++;
      }
      if (d.stats.new) d.notes.push('Restored workspaces need their folder picked again (Code → Add folder) before files can be read; Android does not restore folder access.');
      return d;
    }
    case 'codingHistory':
    case 'codeProposals': {
      const [parent, child, childKey] = id === 'codingHistory' ? ['code_tasks', 'code_turns', 'task_id'] : ['code_proposals', 'code_proposal_files', 'proposal_id'];
      if (replace) {
        if (id === 'codeProposals' && (await db().query("SELECT 1 FROM code_proposals WHERE status = 'applying'")).length) {
          throw new Error('A proposal is being applied right now; try again when it has finished.');
        }
        d.stmts.push({ sql: `DELETE FROM ${child}` }, { sql: `DELETE FROM ${parent}` });
      }
      const ps = R(parent);
      const live = replace ? new Set<string>() : await existing(parent, 'id', ps.map(r => s(r.id)));
      const wsLive = await existing('code_workspaces', 'id', ps.map(r => s(r.workspace_id)));
      const taken = new Set<string>();
      for (const r of ps) {
        if (live.has(s(r.id))) { d.stats.duplicate++; continue; }
        if (!wsLive.has(s(r.workspace_id))) { d.stats.skipped++; continue; }
        // A restored proposal can be reviewed, never applied: files may have changed since; ask for a fresh one.
        const row = id === 'codeProposals' && ['ready', 'applying'].includes(s(r.status))
          ? { ...r, status: 'stale', outcome_json: JSON.stringify('Restored from a backup: review only. Ask for a fresh proposal to change files.') } : r;
        add(parent, row);
        taken.add(s(r.id));
        d.stats.new++;
      }
      if (d.stats.skipped) d.notes.push(`${d.stats.skipped} item(s) were skipped because their workspace is not in the app (restore "Code workspaces" too).`);
      const childIds = id === 'codingHistory' ? await existing('code_turns', 'id', R(child).map(r => s(r.id))) : new Set<string>();
      for (const c of R(child)) {
        if (!taken.has(s(c[childKey]))) continue;
        const row = id === 'codingHistory' ? { ...c, id: childIds.has(s(c.id)) ? newId() : c.id }
          : { ...c, status: c.status === 'pending' ? 'not_applied' : c.status };
        d.stmts.push(insert(child, row));
      }
      return d;
    }
    default:
      return d; // documentText is restored per document (restore.ts)
  }
}

const isBuiltin = (skillId: string, rows: any[]) => rows.some(r => r.id === skillId && Number(r.builtin) === 1);
