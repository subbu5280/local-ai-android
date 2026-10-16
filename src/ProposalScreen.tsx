/**
 * Review and approval of a change proposal: the objective, reason, assumptions, risks and suggested checks; per file
 * the operation, purpose and a diff of the original and proposed text, with Accept/Reject. Nothing changes until
 * "Apply approved changes" is confirmed; then each file's outcome (applied, stale, failed, not applied) is shown.
 * Applied files can be restored to their saved original while they still hold the applied text.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { styles } from './CodeScreen';
import { applyProposal, restoreOriginal } from './code/apply';
import { hunks } from './code/diff';
import { deleteProposal, getProposal, rejectProposal, type FileStatus, type Proposal } from './code/proposals';
import * as store from './code/workspaceStore';
import type { Colors } from './theme';

const FILE_STATUS: Record<FileStatus, string> = { pending: 'Not applied yet', rejected: 'Rejected', applied: 'Applied and verified', failed: 'Failed',
  stale: 'Stale: the file changed', not_applied: 'Not applied', restored: 'Restored to original', unknown: 'Unknown: check the file' };

export function ProposalScreen({ id, colors: c, onBack, onOpenFile }: {
  id: string; colors: Colors; onBack: () => void; onOpenFile: (path: string, line?: number) => void;
}) {
  const [p, setP] = useState<Proposal | null>(null);
  const [accepted, setAccepted] = useState<number[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const acting = useRef(false);

  const load = useCallback(async () => {
    const next = await getProposal(id);
    setP(next);
    if (!next) setMessage('This proposal is not in the app (it was deleted, or not included in a restore).');
    return next;
  }, [id]);
  useEffect(() => {
    load().then(next => { if (next?.status === 'ready') setAccepted(next.files.map(f => f.idx)); }).catch(e => setMessage(store.explain(e)));
  }, [load]);

  async function act(work: () => Promise<string | void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    try {
      const said = await work();
      if (said) setMessage(said);
    } catch (e) { setMessage(store.explain(e)); } finally {
      acting.current = false;
      setBusy(false);
      await load().catch(() => undefined);
    }
  }

  function confirmApply() {
    if (!p) return;
    const files = p.files.filter(f => accepted.includes(f.idx));
    Alert.alert(`Apply ${files.length} change${files.length === 1 ? '' : 's'}?`,
      `${files.map(f => `• ${f.op === 'create' ? 'Create' : 'Modify'} ${f.path}`).join('\n')}\n\nEach file is checked again first: if any changed since ` +
      'this proposal was made, nothing is written. Originals of modified files are kept so they can be restored.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Apply', onPress: () => act(async () => {
          const ws = await store.getWorkspace(p.workspaceId);
          if (!ws) throw new Error('This workspace was removed.');
          return (await applyProposal(ws, p.id, accepted)).summary;
        }) },
      ]);
  }

  function confirmRestore(idx: number, path: string) {
    Alert.alert(`Restore "${path}"?`, 'Writes back the original text saved with this proposal, only if the file still holds exactly the applied text.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Restore', onPress: () => act(async () => {
        const ws = await store.getWorkspace(p!.workspaceId);
        if (!ws) throw new Error('This workspace was removed.');
        return restoreOriginal(ws, p!.id, idx);
      }) },
    ]);
  }

  function confirmDelete() {
    Alert.alert('Delete this proposal?', 'Deletes it and its saved original texts from the app. Project files are not changed.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => act(async () => { await deleteProposal(id); onBack(); }) },
    ]);
  }

  if (!p) return <View style={[styles.flex, { backgroundColor: c.bg }]}><Text style={[styles.pad, { color: c.muted }]}>{message ?? 'Loading…'}</Text></View>;
  const ready = p.status === 'ready';
  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header" numberOfLines={1}>{p.title}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.pad}>
        <Text style={[styles.small, { color: c.muted }]} accessibilityLiveRegion="polite">Status: {p.status}{p.outcome ? ` — ${p.outcome}` : ''}</Text>
        {!!p.body.objective && <Text style={{ color: c.text }}><Text style={styles.bold}>Objective: </Text>{p.body.objective}</Text>}
        {!!p.body.reason && <Text style={{ color: c.text }}><Text style={styles.bold}>Why: </Text>{p.body.reason}</Text>}
        {p.body.assumptions.length > 0 && <Text style={{ color: c.text }}><Text style={styles.bold}>Assumptions: </Text>{p.body.assumptions.join(' · ')}</Text>}
        {p.body.risks.length > 0 && <Text style={{ color: c.text }}><Text style={styles.bold}>Risks: </Text>{p.body.risks.join(' · ')}</Text>}
        <Text style={{ color: c.text }}><Text style={styles.bold}>Checks to run yourself: </Text>{p.body.validation.join(' · ') || '(none suggested)'}</Text>
        <Text style={[styles.small, { color: c.muted }]}>Proposed by the on-device model and checked by the app (paths, file types, unique edit anchors, limits).
          Nothing was compiled, run or tested.</Text>

        {p.files.map(f => (
          <View key={f.idx} style={[styles.card, { backgroundColor: c.bubble }]}>
            <View style={styles.row}>
              <Text style={[styles.bold, styles.flex, { color: c.text }]}>{f.op === 'create' ? 'Create' : 'Modify'} {f.path}</Text>
              {ready && (
                <Pressable style={[styles.chip, { borderColor: accepted.includes(f.idx) ? c.accent : c.border }]} accessibilityRole="checkbox"
                  accessibilityState={{ checked: accepted.includes(f.idx) }} accessibilityLabel={`Accept change to ${f.path}`}
                  onPress={() => setAccepted(a => (a.includes(f.idx) ? a.filter(x => x !== f.idx) : [...a, f.idx]))}>
                  <Text style={{ color: accepted.includes(f.idx) ? c.accent : c.muted }}>{accepted.includes(f.idx) ? 'Accepted' : 'Rejected'}</Text>
                </Pressable>
              )}
            </View>
            <Text style={{ color: c.text }}>{f.purpose}</Text>
            {!ready && <Text style={[styles.small, { color: ['failed', 'stale', 'unknown'].includes(f.status) ? c.stop : c.muted }]}>{FILE_STATUS[f.status]}{f.error ? `: ${f.error}` : ''}</Text>}
            <Pressable accessibilityRole="button" accessibilityLabel={`${open === f.idx ? 'Hide' : 'Show'} changes in ${f.path}`} onPress={() => setOpen(open === f.idx ? null : f.idx)}>
              <Text style={{ color: c.accent }}>{open === f.idx ? 'Hide changes' : 'Show changes'}</Text>
            </Pressable>
            {open === f.idx && (
              <View>
                {hunks(f.originalText ?? '', f.proposedText).map((h, hi) => (
                  <View key={hi} style={{ borderTopWidth: 1, borderColor: c.border }}>
                    {h.lines.map((l, li) => (
                      <Text key={li} selectable style={[styles.mono, { color: l.type === '-' ? c.stop : l.type === '+' ? c.accent : c.muted }]}>
                        {l.type} {String(l.newLine ?? l.oldLine ?? '').padStart(4, ' ')} {l.text}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            )}
            {f.op === 'modify' && (
              <Pressable accessibilityRole="link" accessibilityLabel={`Open current ${f.path}`} onPress={() => onOpenFile(f.path)}>
                <Text style={[styles.small, { color: c.accent }]}>Open the current file</Text>
              </Pressable>
            )}
            {f.op === 'modify' && ['applied', 'unknown'].includes(f.status) && (
              <Pressable accessibilityRole="button" accessibilityLabel={`Restore original ${f.path}`} disabled={busy} onPress={() => confirmRestore(f.idx, f.path)}>
                <Text style={{ color: c.stop }}>Restore original</Text>
              </Pressable>
            )}
          </View>
        ))}

        {ready && (
          <View style={styles.row}>
            <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Apply approved changes"
              disabled={busy || !accepted.length} onPress={confirmApply}>
              <Text style={{ color: busy || !accepted.length ? c.muted : c.accent }}>{busy ? 'Applying…' : `Apply ${accepted.length} approved`}</Text>
            </Pressable>
            <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Reject proposal" disabled={busy}
              onPress={() => act(async () => { await rejectProposal(p.id); return 'Rejected; nothing was changed.'; })}>
              <Text style={{ color: c.text }}>Reject all</Text>
            </Pressable>
          </View>
        )}
        {message && <Text style={{ color: c.text }} accessibilityLiveRegion="polite">{message}</Text>}
        {p.status !== 'applying' && (
          <Pressable style={styles.self} accessibilityRole="button" accessibilityLabel="Delete proposal" disabled={busy} onPress={confirmDelete}>
            <Text style={{ color: c.stop }}>Delete proposal</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}
