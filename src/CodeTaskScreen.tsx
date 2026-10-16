/**
 * A coding task: a conversation about one workspace. Each turn shows the question, which files and lines were
 * inspected (and which were skipped and why), the answer with findings labelled observed / inferred / hypothesis and
 * linked to their file and line, suggested fix and checks, and any change proposal it produced. Follow-up questions
 * keep the task's selected files, language and recent turns as context.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { styles } from './CodeScreen';
import * as assistant from './code/assistant';
import { draftProposal } from './code/proposals';
import * as store from './code/workspaceStore';
import type { LangCode } from './core/language';
import type { Colors } from './theme';
import { LanguageChips, MODE_LABEL, type TaskMode } from './WorkspaceScreen';

const KIND_LABEL: Record<assistant.FindingKind, string> = { observed: 'Observed', inferred: 'Inferred', hypothesis: 'Hypothesis (unverified)' };
const STATUS_LABEL: Record<assistant.TurnStatus, string> = { answered: 'Answered', insufficient: 'Not enough context', failed: 'Failed',
  cancelled: 'Cancelled', proposal: 'Proposal ready for review', invalid_proposal: 'Proposal rejected by checks' };

export function CodeTaskScreen({ workspaceId, taskId, start, modelReady, colors: c, onBack, onOpenFile, onProposal }: {
  workspaceId: string; taskId: string; start?: { mode: TaskMode; question: string; errorText: string }; modelReady: boolean;
  colors: Colors; onBack: () => void; onOpenFile: (path: string, line?: number) => void; onProposal: (id: string) => void;
}) {
  const [task, setTask] = useState<assistant.Task | null>(null);
  const [turns, setTurns] = useState<assistant.Turn[]>([]);
  const [mode, setMode] = useState<TaskMode>(start?.mode ?? 'ask');
  const [question, setQuestion] = useState('');
  const [errorText, setErrorText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const signal = useRef<store.Signal | null>(null);
  const started = useRef(false);
  const running = useRef(false);
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);

  const load = useCallback(async () => {
    setTask(await assistant.getTask(taskId));
    setTurns(await assistant.turns(taskId));
  }, [taskId]);

  async function run(m: TaskMode, q: string, err: string) {
    if (running.current) return; // a ref, not state: two quick taps must not start two runs
    running.current = true;
    const ws = await store.getWorkspace(workspaceId);
    const t = await assistant.getTask(taskId);
    if (!ws || !t) { setMessage('This workspace or task was removed.'); running.current = false; return; }
    signal.current = { cancelled: false };
    setMessage(null);
    setBusy('Selecting relevant files…');
    try {
      if (m === 'propose') {
        const r = await draftProposal(ws, t, q, { signal: signal.current, onProgress: setBusy, modelReady });
        if (r.proposal) onProposal(r.proposal.id);
      } else {
        await assistant.ask(ws, t, m, q, { errorText: err || undefined, signal: signal.current, onProgress: setBusy, modelReady });
      }
    } catch (e) {
      setMessage(store.explain(e));
    } finally {
      running.current = false;
      setBusy(null);
      await load().catch(() => undefined);
    }
  }

  useEffect(() => {
    load().then(() => {
      if (start && !started.current) { started.current = true; run(start.mode, start.question, start.errorText); }
    }).catch(e => setMessage(store.explain(e)));
    // Opening the task runs its first question once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function send() {
    const q = question.trim();
    if (!q || busy) return;
    setQuestion('');
    setErrorText('');
    await run(mode, q, errorText.trim());
  }

  async function setLanguage(l: LangCode | null) {
    await assistant.updateTask(taskId, { language: l });
    await load();
  }

  const ref = (path: string | null, line: number | null) => (path ? (
    <Pressable accessibilityRole="link" accessibilityLabel={`Open ${path}${line ? ` line ${line}` : ''}`} onPress={() => onOpenFile(path, line ?? undefined)}>
      <Text style={[styles.mono, { color: c.accent }]}>{path}{line ? `:${line}` : ''}</Text>
    </Pressable>
  ) : null);

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header" numberOfLines={1}>{task?.title ?? 'Task'}</Text>
      </View>
      <ScrollView ref={scroll} contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled" onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        {task && (
          <>
            <Text style={[styles.small, { color: c.muted }]}>
              {task.selected.length ? `Selected files: ${task.selected.join(', ')}` : 'No files selected: relevant files are searched for each question.'}
            </Text>
            <LanguageChips value={task.language} onChange={setLanguage} colors={c} />
          </>
        )}
        {turns.map(t => (
          <View key={t.id} style={[styles.card, { backgroundColor: c.bubble }]}>
            <Text style={[styles.small, { color: c.muted }]}>{MODE_LABEL[t.mode]} · {STATUS_LABEL[t.status]}</Text>
            <Text style={[styles.bold, { color: c.text }]} selectable>{t.question}</Text>
            {t.inspected && (
              <View>
                <Text style={[styles.small, { color: c.muted }]}>Inspected:</Text>
                {t.inspected.files.map(f => (
                  <Pressable key={f.path} accessibilityRole="link" accessibilityLabel={`Open inspected ${f.path}`} onPress={() => onOpenFile(f.path, f.ranges[0]?.start)}>
                    <Text style={[styles.small, { color: c.accent }]}>
                      {f.path} (lines {f.ranges.map(r => `${r.start}-${r.end}`).join(', ')}) — {f.reason}{f.redactions ? ` · ${f.redactions} redacted` : ''}
                    </Text>
                  </Pressable>
                ))}
                {t.inspected.files.length === 0 && <Text style={[styles.small, { color: c.muted }]}>No matching files.</Text>}
                {t.inspected.skipped.length > 0 && (
                  <Text style={[styles.small, { color: c.muted }]}>Skipped: {t.inspected.skipped.slice(0, 5).map(s => `${s.path} (${s.reason})`).join('; ')}</Text>
                )}
                {t.inspected.truncated && <Text style={[styles.small, { color: c.muted }]}>Context was limited: not everything relevant may have been read.</Text>}
              </View>
            )}
            {t.answer && (
              <View style={styles.pad0}>
                {!t.answer.enoughContext && <Text style={{ color: c.stop }}>The inspected files were not enough to answer fully.</Text>}
                <Text style={{ color: c.text }} selectable>{t.answer.text}</Text>
                {t.answer.findings.map((f, i) => (
                  <View key={i}>
                    <Text style={{ color: c.text }} selectable>
                      <Text style={styles.bold}>{f.source === 'app' ? 'App check' : KIND_LABEL[f.kind]}: </Text>{f.text}
                    </Text>
                    {ref(f.path, f.line)}
                    {f.note && <Text style={[styles.small, { color: c.muted }]}>{f.note}</Text>}
                  </View>
                ))}
                {!!t.answer.fix && <Text style={{ color: c.text }} selectable><Text style={styles.bold}>Suggested fix: </Text>{t.answer.fix}</Text>}
                {!!t.answer.sideEffects && <Text style={{ color: c.text }} selectable><Text style={styles.bold}>Possible side effects: </Text>{t.answer.sideEffects}</Text>}
                {t.answer.checks.length > 0 && (
                  <Text style={{ color: c.text }} selectable><Text style={styles.bold}>Checks to run yourself (not run): </Text>{t.answer.checks.join(' · ')}</Text>
                )}
                {t.answer.note && <Text style={[styles.small, { color: c.muted }]}>{t.answer.note}</Text>}
              </View>
            )}
            {t.error && <Text style={{ color: c.stop }} selectable>{t.error}</Text>}
            {t.proposalId && (
              <Pressable accessibilityRole="link" accessibilityLabel="Review proposal" onPress={() => onProposal(t.proposalId!)}>
                <Text style={{ color: c.accent }}>Review the proposal ›</Text>
              </Pressable>
            )}
          </View>
        ))}
        {busy && <Text style={{ color: c.muted }} accessibilityLiveRegion="polite">{busy}</Text>}
        {message && <Text style={{ color: c.stop }} accessibilityLiveRegion="polite">{message}</Text>}
      </ScrollView>
      <View style={[styles.pad, { borderTopWidth: 1, borderColor: c.border }]}>
        <View style={styles.row}>
          {(Object.keys(MODE_LABEL) as TaskMode[]).map(m => (
            <Pressable key={m} style={[styles.chip, { borderColor: mode === m ? c.accent : c.border }]} accessibilityRole="radio" accessibilityState={{ selected: mode === m }}
              accessibilityLabel={`Mode ${MODE_LABEL[m]}`} onPress={() => setMode(m)}>
              <Text style={{ color: mode === m ? c.accent : c.text }}>{MODE_LABEL[m]}</Text>
            </Pressable>
          ))}
        </View>
        {mode === 'debug' && (
          <TextInput style={[styles.input, styles.mono, { color: c.text, borderColor: c.border }]} value={errorText} onChangeText={setErrorText} multiline maxLength={4000}
            placeholder="Error message or stack trace (optional)" placeholderTextColor={c.muted} accessibilityLabel="Follow-up error message" />
        )}
        <View style={styles.row}>
          <TextInput style={[styles.input, styles.flex, { color: c.text, borderColor: c.border }]} value={question} onChangeText={setQuestion} multiline maxLength={2000}
            placeholder="Follow-up question" placeholderTextColor={c.muted} accessibilityLabel="Follow-up question" />
          {busy ? (
            <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => { if (signal.current) signal.current.cancelled = true; }}>
              <Text style={{ color: c.stop }}>Cancel</Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Send follow-up" onPress={send}>
              <Text style={{ color: c.accent }}>Send</Text>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}
