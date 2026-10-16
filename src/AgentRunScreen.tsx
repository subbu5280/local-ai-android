/**
 * Running an agent: task -> plan (shown with who made it) -> Run -> step-by-step progress -> result with sources.
 * Steps that create files ask for permission right before they run. Cancel stops the running step and every later
 * one; leaving this screen cancels a running task. Past runs of the agent can be opened (read-only) or re-run.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as agentStore from './agents/agentStore';
import { executeRun, RunHandle } from './agents/engine';
import { makePlan } from './agents/planner';
import { validatePlan } from './agents/policy';
import { getTool } from './agents/tools';
import type { AgentConfig, Run, StepRecord, StepStatus } from './agents/types';
import { RUN_STATUS_TEXT } from './AgentsScreen';
import { formatWhen } from './HistoryScreen';
import * as docStore from './knowledge/docStore';
import { sourceLabel } from './knowledge/knowledgePrompt';
import { metric } from './metrics';
import type { Colors } from './theme';

type Props = {
  colors: Colors;
  agentId: string;
  /** Open this past run (read-only) instead of a new task. */
  runId?: string;
  /** Prefill the task (the editor's "Test on a sample task"). */
  sampleTask?: string;
  modelReady: boolean;
  onBack: () => void;
  onOpenSource: (documentId: string, ordinal: number) => void;
};

const STEP_TEXT: Record<StepStatus, string> = {
  planned: 'Planned', approved: 'Approved', running: 'Running…', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped',
};

/** A sample task for the agent's tools ("Test on a sample task"). */
export function sampleTaskFor(agent: Pick<AgentConfig, 'tools'>): string {
  if (agent.tools.includes('docs.search')) return 'What are the main points in my documents?';
  if (agent.tools.includes('calculator')) return 'What is 15% of 240?';
  if (agent.tools.includes('datetime')) return 'What day is it today?';
  return 'Summarize: Local AI runs a small language model on the phone, keeps documents private and works offline.';
}

/** "query: refund days" for a step input (short, for the step list). */
const inputText = (s: StepRecord) => Object.entries(s.input).map(([k, v]) => `${k}: ${String(v).slice(0, 60)}`).join(' · ') +
  (s.fromStep ? `${Object.keys(s.input).length ? ' · ' : ''}uses step ${s.fromStep}` : '');

export function AgentRunScreen({ colors: c, agentId, runId, sampleTask, modelReady, onBack, onOpenSource }: Props) {
  const [agent, setAgent] = useState<AgentConfig | null | undefined>(undefined);
  const [docs, setDocs] = useState<docStore.Doc[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()); // empty = all ready documents
  const [task, setTask] = useState(sampleTask ?? '');
  const [run, setRun] = useState<Run | null>(null);
  const [planErrors, setPlanErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<'planning' | 'running' | null>(null);
  const [past, setPast] = useState<Awaited<ReturnType<typeof agentStore.listRuns>>>([]);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<RunHandle | null>(null);
  const acting = useRef(false); // one Plan/Run at a time, whatever the taps

  const loadPast = useCallback(() => agentStore.listRuns(agentId, 10).then(setPast).catch(() => undefined), [agentId]);
  useEffect(() => {
    (async () => {
      setAgent(await agentStore.getAgent(agentId));
      setDocs((await docStore.listDocuments()).filter(d => d.status === 'ready'));
      if (runId) setRun(await agentStore.getRun(runId));
      await loadPast();
    })().catch((e: any) => setError(`Couldn't load (${e?.message ?? e}).`));
  }, [agentId, runId, loadPast]);
  // Leaving the screen cancels a running task: no work continues unseen.
  useEffect(() => () => handle.current?.cancel(), []);

  const scope = () => (selected.size ? [...selected] : docs.map(d => d.id));

  async function plan() {
    if (!agent || acting.current || !task.trim()) return;
    acting.current = true;
    setBusy('planning');
    setPlanErrors([]);
    setError(null);
    try {
      const p = await makePlan(task.trim(), { agent, scope: scope(), modelReady }, docs.filter(d => scope().includes(d.id)).map(d => ({ id: d.id, name: d.name })));
      if (p.errors.length) { setPlanErrors(p.errors); setRun(null); return; }
      const r = agentStore.newRun(agent, task.trim(), selected.size ? [...selected] : null, p.plan, p.steps);
      setRun(r);
      if (!agent.confirmPlan) await execute(r);
    } catch (e: any) {
      setError(`Planning failed (${e?.message ?? e}).`);
    } finally {
      setBusy(null);
      acting.current = false;
    }
  }

  const confirm = (step: StepRecord, preview: string) => new Promise<boolean>(resolve => {
    Alert.alert(`Allow step ${step.index}: ${getTool(step.tool)?.name ?? step.tool}?`, preview, [
      { text: "Don't allow", style: 'cancel', onPress: () => resolve(false) },
      { text: 'Allow', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });

  async function execute(r: Run) {
    if (!agent) return;
    const h = new RunHandle();
    handle.current = h;
    setBusy('running');
    const t0 = Date.now();
    const done = await executeRun(r, agent, r.scope ?? docs.map(d => d.id), h, {
      confirm, onUpdate: setRun, persist: agentStore.saveRun,
    });
    handle.current = null;
    setRun(done);
    setBusy(null);
    metric('agent_run', { status: done.status, steps: done.steps.length, planSource: done.planSource,
      failed: done.steps.filter(s => s.status === 'failed').map(s => s.tool).join(',') || null, ms: Date.now() - t0 });
    loadPast();
  }

  async function start() {
    if (!run || acting.current || run.status !== 'planned') return;
    acting.current = true;
    try { await execute(run); } finally { acting.current = false; }
  }

  async function rerun() {
    if (!agent || !run || acting.current || !agentStore.canRerun(run)) return;
    // The same plan, validated again against the agent as it is now (its tools or limits may have changed).
    const checked = validatePlan({ steps: run.steps.map(s => ({ tool: s.tool, input: s.input, fromStep: s.fromStep ?? undefined, purpose: s.purpose })),
      source: run.planSource }, { agent, scope: run.scope ?? docs.map(d => d.id), modelReady });
    if (checked.errors.length) { setPlanErrors(checked.errors); return; }
    const fresh = agentStore.newRun(agent, run.task, run.scope, { source: run.planSource, note: run.planNote ?? undefined }, checked.steps);
    setRun(fresh);
    acting.current = true;
    try { await execute(fresh); } finally { acting.current = false; }
  }

  if (agent === null) {
    return (
      <View style={[styles.flex, { backgroundColor: c.bg }]}>
        <Pressable style={[styles.chip, styles.margin, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.pad, { color: c.muted }]}>This agent no longer exists.</Text>
      </View>
    );
  }
  const running = busy === 'running';
  const finished = run && !['planned', 'running'].includes(run.status);

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} numberOfLines={1} accessibilityRole="header">{agent?.name ?? 'Agent'}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={task} onChangeText={setTask} multiline
          editable={!busy} placeholder="What should the agent do?" placeholderTextColor={c.muted} accessibilityLabel="Agent task" />
        {agent?.tools.some(t => t.startsWith('docs.')) && docs.length > 0 && (
          <View style={styles.actions}>
            <Text style={[styles.small, { color: c.muted }]}>Documents: {selected.size ? `${selected.size} selected` : 'all'}</Text>
            {docs.slice(0, 12).map(d => (
              <Pressable key={d.id} style={[styles.docChip, { borderColor: selected.has(d.id) ? c.accent : c.border }]} accessibilityRole="checkbox"
                accessibilityState={{ checked: selected.has(d.id) }} accessibilityLabel={`Use document ${d.name}`} disabled={!!busy}
                onPress={() => setSelected(prev => { const n = new Set(prev); if (n.has(d.id)) n.delete(d.id); else n.add(d.id); return n; })}>
                <Text style={[styles.small, { color: selected.has(d.id) ? c.accent : c.text }]} numberOfLines={1}>{d.name}</Text>
              </Pressable>
            ))}
          </View>
        )}
        <View style={styles.actions}>
          <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Plan task"
            disabled={!!busy || !task.trim() || !agent} onPress={plan}>
            <Text style={{ color: busy || !task.trim() ? c.muted : c.accent }}>{busy === 'planning' ? 'Planning…' : 'Plan'}</Text>
          </Pressable>
          {run?.status === 'planned' && !busy && (
            <Pressable style={[styles.chip, { borderColor: c.accent, backgroundColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Run plan" onPress={start}>
              <Text style={styles.onAccent}>Run</Text>
            </Pressable>
          )}
          {running && (
            <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel="Cancel task" onPress={() => handle.current?.cancel()}>
              <Text style={{ color: c.stop }}>Cancel</Text>
            </Pressable>
          )}
          {finished && !busy && agentStore.canRerun(run!) && (
            <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Re-run task" onPress={rerun}>
              <Text style={{ color: c.text }}>Re-run</Text>
            </Pressable>
          )}
        </View>
        {error && <Text style={{ color: c.stop }}>{error}</Text>}
        {planErrors.length > 0 && (
          <View style={[styles.box, { backgroundColor: c.errorBg }]} accessibilityLiveRegion="polite">
            <Text style={[styles.bold, { color: c.text }]}>The plan can't run:</Text>
            {planErrors.map(e => <Text key={e} style={{ color: c.text }}>• {e}</Text>)}
          </View>
        )}

        {run && (
          <View style={styles.gap}>
            <Text style={[styles.small, { color: c.muted }]}>
              {run.planSource === 'model' ? 'Plan proposed by the on-device model and checked by the app.' : 'Default plan (fixed app rules).'}
              {run.planNote ? ` ${run.planNote}` : ''}
            </Text>
            {run.steps.map(s => (
              <View key={s.index} style={[styles.step, { borderColor: s.status === 'failed' ? c.stop : c.border }]}
                accessibilityLabel={`Step ${s.index} ${STEP_TEXT[s.status]}`}>
                <Text style={[styles.bold, { color: c.text }]}>{s.index}. {s.purpose} · {STEP_TEXT[s.status]}{s.attempts > 1 ? ` (attempt ${s.attempts})` : ''}</Text>
                <Text style={[styles.small, { color: c.muted }]}>{getTool(s.tool)?.name ?? s.tool} v{s.toolVersion}{inputText(s) ? ` · ${inputText(s)}` : ''}</Text>
                {s.summary ? <Text style={{ color: c.text }}>{s.summary}</Text> : null}
                {s.warning ? <Text style={[styles.small, { color: c.muted }]}>⚠ {s.warning}</Text> : null}
                {s.error ? <Text style={{ color: c.stop }}>{s.error}</Text> : null}
              </View>
            ))}
            {finished && (
              <View style={[styles.box, { backgroundColor: run.status === 'succeeded' ? c.bubble : c.errorBg }]} accessibilityLiveRegion="polite">
                <Text style={[styles.bold, { color: c.text }]}>{RUN_STATUS_TEXT[run.status]}</Text>
                {run.finalText ? <Text selectable style={{ color: c.text }}>{run.finalText}</Text> : null}
                {run.sources.map(src => (
                  <Pressable key={src.n} accessibilityRole="link" accessibilityLabel={`Open source ${src.n}: ${sourceLabel(src)}`}
                    onPress={() => onOpenSource(src.documentId, src.ordinal)}>
                    <Text style={{ color: c.accent }}>[{src.n}] {sourceLabel(src)}</Text>
                  </Pressable>
                ))}
                {run.warnings.map(w => <Text key={w} style={[styles.small, { color: c.muted }]}>⚠ {w}</Text>)}
                {run.status !== 'succeeded' && run.status !== 'no_evidence' && run.error ? <Text style={{ color: c.stop }}>{run.error}</Text> : null}
              </View>
            )}
          </View>
        )}

        {past.length > 0 && (
          <View>
            <Text style={[styles.label, { color: c.text }]}>Past runs</Text>
            {past.map(p => (
              <Pressable key={p.id} style={[styles.pastRow, { borderColor: c.border }]} accessibilityRole="button"
                accessibilityLabel={`Open past run ${p.task}`} disabled={!!busy}
                onPress={async () => { const r = await agentStore.getRun(p.id); if (r) { setRun(r); setTask(r.task); setPlanErrors([]); } }}>
                <Text style={{ color: c.text }} numberOfLines={1}>{p.task}</Text>
                <Text style={[styles.small, { color: c.muted }]}>{RUN_STATUS_TEXT[p.status]} · {formatWhen(p.createdAt)}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: '600' },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  docChip: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 6, maxWidth: 160 },
  margin: { margin: 16, alignSelf: 'flex-start' },
  pad: { padding: 16, gap: 10 },
  gap: { gap: 8 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, minHeight: 60 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  step: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 4 },
  box: { borderRadius: 10, padding: 12, gap: 6 },
  pastRow: { paddingVertical: 10, borderBottomWidth: 1 },
  label: { fontWeight: '600', marginTop: 12 },
  small: { fontSize: 12 },
  bold: { fontWeight: '600' },
  onAccent: { color: '#ffffff', fontWeight: '600' },
});
