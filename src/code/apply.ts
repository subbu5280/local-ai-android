/**
 * Applying an approved proposal: the ONLY code in the app that changes a project file. It is called from the proposal
 * review screen after the user approves specific changes; agents, tools, skills, workflows and the model have no path
 * to it (tests check that nothing under src/agents or src/skills imports it).
 *
 * Order of work, so that nothing is overwritten by surprise and failures are reported exactly:
 * 1. The proposal must be "ready" (an approval is used once: applied, stale, failed or rejected proposals can't be
 *    applied again; a fresh proposal is needed), belong to this workspace, and the approved changes must be its own.
 * 2. Every approved change is re-validated against the provider's CURRENT listing (path normalization, workspace,
 *    file type, grants and provider flags) and every file to modify is re-read: if its bytes differ from what the
 *    proposal was made from, nothing at all is written and the proposal is marked stale.
 * 3. Changes are then written one at a time. Each write re-checks the file's hash natively right before writing and
 *    reads the result back (AiWorkspaceModule.write). New files are created only where no file of that name exists.
 * 4. Each file's outcome is saved as soon as it is known. A failure stops the rest: the result lists applied,
 *    failed and not-applied files; the proposal is "partial", not "applied".
 * Recovery: the original text of every modified file is kept with the proposal, and "Restore original" writes it back
 * only while the file still holds exactly the applied text (never over newer edits). Created files are never deleted
 * by the app. Storage providers don't offer atomic multi-file replacement or rollback, so neither is claimed.
 */
import { db, open } from '../chatStore';
import { looksBinary, LIMITS, REDACTED } from './files';
import * as native from './native';
import { WorkspaceError } from './native';
import { baseName, normalizePath } from './paths';
import { checkTarget, getProposal, PROPOSAL_LIMITS, type FileStatus, type Proposal, type ProposalStatus } from './proposals';
import { exclusive, explain, type Workspace } from './workspaceStore';

export type ApplyResult = { status: ProposalStatus; files: { idx: number; path: string; status: FileStatus; error: string | null }[]; summary: string };

const MIME: Record<string, string> = { json: 'application/json', md: 'text/markdown', html: 'text/html', css: 'text/css', xml: 'text/xml', js: 'text/javascript' };
const mimeOf = (path: string) => MIME[path.split('.').pop()!.toLowerCase()] ?? 'text/plain';

async function setFile(proposalId: string, idx: number, status: FileStatus, error: string | null = null, resultSha: string | null = null) {
  await db().execute('UPDATE code_proposal_files SET status = ?, error = ?, result_sha = COALESCE(?, result_sha) WHERE proposal_id = ? AND idx = ?',
    [status, error, resultSha, proposalId, idx]);
}
async function setProposal(id: string, status: ProposalStatus, outcome: string | null, appliedAt: number | null = null) {
  await db().execute('UPDATE code_proposals SET status = ?, outcome_json = ?, applied_at = COALESCE(?, applied_at), updated_at = ? WHERE id = ?',
    [status, outcome === null ? null : JSON.stringify(outcome), appliedAt, Date.now(), id]);
}
async function result(id: string, summary: string): Promise<ApplyResult> {
  const p = (await getProposal(id))!;
  return { status: p.status, summary, files: p.files.map(f => ({ idx: f.idx, path: f.path, status: f.status, error: f.error })) };
}

/** Why a stored change can't be written now, or null (the cheap checks that don't need the provider). */
function storedProblem(f: Proposal['files'][number]): string | null {
  try { if (normalizePath(f.path) !== f.path) return 'its path is not in normal form'; } catch (e: any) { return e.message; }
  if (f.op !== 'modify' && f.op !== 'create') return 'unsupported operation';
  if (f.proposedText.length > PROPOSAL_LIMITS.maxFileChars || looksBinary(f.proposedText) || f.proposedText.includes(REDACTED)) return 'the proposed content is not acceptable';
  if (f.op === 'modify' && (f.originalText === null || !f.originalSha)) return 'the original it was made from is missing';
  return null;
}

/**
 * Apply the approved changes (`approved` = file numbers the user accepted) of a ready proposal.
 * @returns the per-file outcome and the proposal's new status
 * @throws WorkspaceError when the request itself is invalid (unknown proposal, not ready, nothing approved, busy)
 */
export async function applyProposal(ws: Workspace, proposalId: string, approved: number[], now = Date.now()): Promise<ApplyResult> {
  await open();
  return exclusive(ws.id, 'Applying changes', async () => {
    const p = await getProposal(proposalId);
    if (!p || p.workspaceId !== ws.id) throw new WorkspaceError('not_found', 'This proposal does not belong to this workspace.');
    if (p.status !== 'ready') throw new WorkspaceError('stale', `This proposal is ${p.status}; it can't be applied again. Ask for a fresh proposal.`);
    const chosen = [...new Set(approved)];
    if (!chosen.length) throw new WorkspaceError('read_failed', 'Approve at least one change first.');
    if (chosen.some(n => !p.files.some(f => f.idx === n))) throw new WorkspaceError('read_failed', 'An approved change is not part of this proposal.');
    const todo = p.files.filter(f => chosen.includes(f.idx));

    // 2. Re-validate everything before writing anything.
    const targets = new Map<number, { uri: string; dirUri?: string; sha?: string }>();
    const problems: { idx: number; stale: boolean; error: string }[] = [];
    for (const f of todo) {
      const bad = storedProblem(f);
      if (bad) { problems.push({ idx: f.idx, stale: false, error: bad }); continue; }
      try {
        const t = await checkTarget(ws, f.op, f.path, true);
        if (f.op === 'modify') {
          const cur = await native.readText(t.uri, LIMITS.maxFileBytes);
          if (cur.sha256 !== f.originalSha) { problems.push({ idx: f.idx, stale: true, error: 'the file changed after this proposal was made' }); continue; }
          targets.set(f.idx, { ...t, sha: cur.sha256 });
        } else targets.set(f.idx, t);
      } catch (e: any) {
        const stale = e instanceof WorkspaceError && (e.code === 'exists' || e.code === 'not_found');
        problems.push({ idx: f.idx, stale, error: stale ? `${e.message} (the workspace changed after this proposal was made)` : explain(e) });
      }
    }
    if (problems.length) {
      for (const f of p.files) {
        const prob = problems.find(x => x.idx === f.idx);
        await setFile(p.id, f.idx, prob ? (prob.stale ? 'stale' : 'failed') : chosen.includes(f.idx) ? 'not_applied' : 'rejected', prob?.error ?? null);
      }
      const stale = problems.some(x => x.stale);
      const summary = `Nothing was changed: ${problems.length} change${problems.length === 1 ? '' : 's'} could not be checked safely. ` +
        (stale ? 'The files changed since the proposal was made; ask for a fresh proposal.' : 'See each file for the reason.');
      await setProposal(p.id, stale ? 'stale' : 'failed', summary);
      return result(p.id, summary);
    }

    // 3. Write, one file at a time, recording each outcome immediately.
    await db().batch([
      { sql: "UPDATE code_proposals SET status = 'applying', updated_at = ? WHERE id = ?", params: [now, p.id] },
      ...p.files.map(f => ({ sql: 'UPDATE code_proposal_files SET status = ?, error = NULL WHERE proposal_id = ? AND idx = ?',
        params: [chosen.includes(f.idx) ? 'pending' : 'rejected', p.id, f.idx] })),
    ]);
    let applied = 0;
    let failedAt: number | null = null;
    for (const f of todo) {
      const t = targets.get(f.idx)!;
      try {
        if (f.op === 'modify') {
          const w = await native.writeText(t.uri, f.proposedText, t.sha!);
          await setFile(p.id, f.idx, 'applied', null, w.sha256);
        } else {
          const doc = await native.createFile(t.dirUri!, baseName(f.path), mimeOf(f.path), f.proposedText);
          await setFile(p.id, f.idx, 'applied');
          await db().execute(`INSERT OR REPLACE INTO code_entries (workspace_id, path, uri, tree_uri, dir, size, modified, can_write, can_create)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0)`, [ws.id, f.path, doc.uri, ws.treeUri, doc.size, doc.modified, doc.canWrite ? 1 : 0]);
        }
        applied++;
      } catch (e: any) {
        const code = e instanceof WorkspaceError ? e.code : null;
        const why = code === 'verify_failed'
          ? (e.message === 'restored' ? 'the storage provider kept different content; the original was written back'
            : 'the result could not be verified and the file may be damaged: use "Restore original" or check it')
          : code === 'stale' ? 'the file changed just before writing; it was not changed' : explain(e);
        await setFile(p.id, f.idx, code === 'verify_failed' && e.message !== 'restored' ? 'unknown' : code === 'stale' ? 'stale' : 'failed', why);
        failedAt = f.idx;
        break;
      }
    }
    if (failedAt !== null) for (const f of todo.filter(x => x.idx > failedAt!)) await setFile(p.id, f.idx, 'not_applied', 'not applied because an earlier change failed');
    const status: ProposalStatus = applied === todo.length ? 'applied' : applied ? 'partial' : 'failed';
    const summary = status === 'applied' ? `Applied ${applied} change${applied === 1 ? '' : 's'}; each file was read back and matches the proposal.`
      : status === 'partial' ? `Only ${applied} of ${todo.length} approved changes were applied. The others were not; see each file. ` +
        'Applied files can be restored to their originals.'
      : 'No change was applied; see the file for the reason.';
    await setProposal(p.id, status, summary, applied ? Date.now() : null);
    return result(p.id, summary);
  });
}

/**
 * Write a modified file's saved original back, only while the file still holds exactly the proposed text (or already
 * holds the original). New files are never deleted by the app.
 * @returns a sentence describing what happened
 */
export async function restoreOriginal(ws: Workspace, proposalId: string, idx: number): Promise<string> {
  await open();
  return exclusive(ws.id, 'Restoring a file', async () => {
    const p = await getProposal(proposalId);
    const f = p?.workspaceId === ws.id ? p.files.find(x => x.idx === idx) : undefined;
    if (!p || !f) throw new WorkspaceError('not_found', 'No such change.');
    if (f.op === 'create') return `The app never deletes files. If you don't want "${f.path}", delete it in your file manager.`;
    if (!['applied', 'unknown'].includes(f.status) || f.originalText === null) return 'This file was not changed by this proposal, so there is nothing to restore.';
    const t = await checkTarget(ws, 'modify', f.path, true);
    const cur = await native.readText(t.uri, LIMITS.maxFileBytes);
    if (cur.text === f.originalText) {
      await setFile(p.id, idx, 'restored', 'the file already holds its original text');
      return 'The file already holds its original text.';
    }
    if (cur.text !== f.proposedText) {
      return 'The file changed after the proposal was applied, so restoring would overwrite newer edits. Nothing was changed.';
    }
    await native.writeText(t.uri, f.originalText, cur.sha256);
    await setFile(p.id, idx, 'restored', null);
    return `"${f.path}" was restored to its original text.`;
  });
}

/** At launch: proposals cut off while applying are marked interrupted; files whose outcome wasn't recorded are "unknown". */
export async function recoverInterruptedProposals(): Promise<void> {
  await open();
  await db().batch([
    { sql: "UPDATE code_proposal_files SET status = 'unknown', error = 'The app closed while applying; open the file to check it (Restore original is offered if it holds the proposed text).' WHERE status = 'pending' AND proposal_id IN (SELECT id FROM code_proposals WHERE status = 'applying')" },
    { sql: "UPDATE code_proposals SET status = 'interrupted', outcome_json = ? WHERE status = 'applying'", params: [JSON.stringify('The app closed while applying these changes. Check each file\'s status.')] },
  ]);
}
