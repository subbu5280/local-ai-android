/**
 * Run a skill or workflow: enter its inputs, pick the answer language (or Auto), Run. The steps are compiled and
 * checked (runner.prepareRun) and then executed by the agent engine: progress per step, Cancel, permission prompts
 * for writes, the result with its sources, Re-run when safe, and this definition's run history (deletable).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { LANG_CODES, NAMES, type LangCode } from './core/language';
import * as agentStore from './agents/agentStore';
import { executeRun, RunHandle } from './agents/engine';
import { getTool } from './agents/tools';
import type { Run, StepRecord, StepStatus } from './agents/types';
import { RUN_STATUS_TEXT } from './AgentsScreen';
import { formatWhen } from './HistoryScreen';
import * as docStore from './knowledge/docStore';
import { sourceLabel } from './knowledge/knowledgePrompt';
import { metric } from './metrics';
import { pick, type SkillDef, type WorkflowDef } from './skills/format';
import { prepareRun } from './skills/runner';
import * as store from './skills/skillStore';
import type { DefKind } from './LibraryPanels';
import type { Colors } from './theme';

const STEP_TEXT: Record<StepStatus, string> = {
  planned: 'Planned', approved: 'Approved', running: 'Running…', succeeded: 'Done', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped',
};

/** Sample values for "Test on a sample": the first text input gets a topic or expression that fits its tools. */
export function sampleValues(def: SkillDef | WorkflowDef): Record<string, string> {
  const json = JSON.stringify(def.steps);
  const sample = /calculator|calc-/.test(json) ? '15% of 240' : /docs\.|doc-/.test(json) ? 'refund policy' : 'Local AI runs a small model on the phone and works offline.';
  return Object.fromEntries(def.inputs.filter(i => i.type === 'text').slice(0, 1).map(i => [i.name, sample]));
}

export function DefinitionRunScreen({ kind, id, sample, modelReady, colors: c, onBack, onOpenSource }: {
  kind: DefKind; id: string; sample?: boolean; modelReady: boolean; colors: Colors; onBack: () => void; onOpenSource: (documentId: string, ordinal: number) => void;
}) {
  const [item, setItem] = useState<store.Stored<SkillDef | WorkflowDef> | null | undefined>(undefined);
  const [values, setValues] = useState<Record<string, string>>({});
  const [language, setLanguage] = useState<LangCode | 'auto'>('auto');
  const [run, setRun] = useState<Run | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [past, setPast] = useState<Awaited<ReturnType<typeof agentStore.listSourceRuns>>>([]);
  const handle = useRef<RunHandle | null>(null);
  const acting = useRef(false);

  const loadPast = useCallback(() => agentStore.listSourceRuns(kind, id, 10).then(setPast).catch(() => undefined), [kind, id]);
  useEffect(() => {
    (async () => {
      const list = kind === 'skill' ? await store.listSkills() : await store.listWorkflows();
      const it = list.find(x => x.id === id) ?? null;
      setItem(it);
      if (it?.def && sample) setValues(sampleValues(it.def));
      await loadPast();
    })().catch(e => setErrors([String(e?.message ?? e)]));
  }, [kind, id, sample, loadPast]);
  useEffect(() => () => handle.current?.cancel(), []); // leaving cancels a running task

  const confirm = (step: StepRecord, preview: string) => new Promise<boolean>(resolve => {
    Alert.alert(`Allow step ${step.index}: ${getTool(step.tool)?.name ?? step.tool}?`, preview, [
      { text: "Don't allow", style: 'cancel', onPress: () => resolve(false) },
      { text: 'Allow', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });

  async function start(retryOf: string | null = null) {
    if (!item?.def || acting.current) return;
    acting.current = true;
    setErrors([]);
    try {
      const typed = Object.fromEntries(item.def.inputs.map(i => [i.name, i.type === 'number' && values[i.name] !== undefined && values[i.name] !== ''
        ? Number(values[i.name]) : values[i.name]]));
      const scope = (await docStore.listDocuments()).filter(d => d.status === 'ready').map(d => d.id);
      const p = prepareRun(kind, item.def, item.enabled, typed, { skills: await store.skillMap(), scope, modelReady, language, retryOf });
      if (!p.run || !p.principal) { setErrors(p.errors); return; }
      const h = new RunHandle();
      handle.current = h;
      setRunning(true);
      setRun(p.run);
      const t0 = Date.now();
      const done = await executeRun(p.run, p.principal, scope, h, { confirm, onUpdate: setRun, persist: agentStore.saveRun });
      setRun(done);
      metric('definition_run', { kind, id: item.def.id, version: item.def.version, status: done.status, steps: done.steps.length, ms: Date.now() - t0, retry: !!retryOf });
    } catch (e: any) {
      setErrors([String(e?.message ?? e)]);
    } finally {
      handle.current = null;
      setRunning(false);
      acting.current = false;
      loadPast();
    }
  }

  const deleteHistory = () => Alert.alert('Delete run history?', `All past runs of this ${kind} are deleted from this phone. Agents' runs, chats and documents stay.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { agentStore.deleteSourceRuns(kind, id).then(loadPast).catch(() => undefined); } },
  ]);

  if (item === null) return <View style={[styles.flex, { backgroundColor: c.bg }]}><Text style={[styles.pad, { color: c.muted }]}>This {kind} no longer exists.</Text></View>;
  const def = item?.def;
  const finished = run && !['planned', 'running'].includes(run.status);
  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} numberOfLines={1} accessibilityRole="header">{def ? pick(def.name, language === 'auto' ? 'en' : language) : id}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        {item && !def && item.errors.map(e => <Text key={e} style={{ color: c.stop }}>• {e}</Text>)}
        {def && 'instructions' in def && def.instructions.en ? <Text style={{ color: c.muted }}>{pick(def.instructions, language === 'auto' ? 'en' : language)}</Text> : null}
        {def?.inputs.map(i => (
          <View key={i.name}>
            <Text style={[styles.label, { color: c.text }]}>{pick(i.label, language === 'auto' ? 'en' : language)}{i.required ? '' : ' (optional)'}</Text>
            <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={values[i.name] ?? ''} multiline={i.type === 'text'}
              keyboardType={i.type === 'number' ? 'numeric' : 'default'} editable={!running} accessibilityLabel={`Input ${i.name}`}
              onChangeText={t => setValues(v => ({ ...v, [i.name]: t }))} />
          </View>
        ))}
        <View style={styles.actions}>
          <Text style={[styles.small, { color: c.muted }]}>Answer language:</Text>
          {(['auto', ...LANG_CODES] as const).map(l => (
            <Pressable key={l} style={[styles.chip, { borderColor: l === language ? c.accent : c.border }]} accessibilityRole="button"
              accessibilityLabel={`Answer language ${l === 'auto' ? 'automatic' : NAMES[l]}`} disabled={running} onPress={() => setLanguage(l)}>
              <Text style={{ color: l === language ? c.accent : c.text }}>{l === 'auto' ? 'Auto' : l.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.actions}>
          {running ? (
            <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel="Cancel run" onPress={() => handle.current?.cancel()}>
              <Text style={{ color: c.stop }}>Cancel</Text>
            </Pressable>
          ) : (
            <Pressable style={[styles.chip, { borderColor: def && item?.enabled ? c.accent : c.border }]} accessibilityRole="button" accessibilityLabel={`Run this ${kind}`}
              disabled={!def || !item?.enabled} onPress={() => start()}>
              <Text style={{ color: def && item?.enabled ? c.accent : c.muted }}>Run</Text>
            </Pressable>
          )}
          {finished && !running && agentStore.canRerun(run!) && (
            <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Re-run" onPress={() => start(run!.id)}>
              <Text style={{ color: c.text }}>Re-run</Text>
            </Pressable>
          )}
        </View>
        {errors.length > 0 && (
          <View style={[styles.box, { backgroundColor: c.errorBg }]} accessibilityLiveRegion="polite">
            <Text style={[styles.bold, { color: c.text }]}>Can't run:</Text>
            {errors.map(e => <Text key={e} style={{ color: c.text }}>• {e}</Text>)}
          </View>
        )}
        {run && (
          <View style={styles.gap}>
            <Text style={[styles.small, { color: c.muted }]}>{run.planNote}</Text>
            {run.steps.map(s => (
              <View key={s.index} style={[styles.step, { borderColor: s.status === 'failed' ? c.stop : c.border }]} accessibilityLabel={`Step ${s.index} ${STEP_TEXT[s.status]}`}>
                <Text style={[styles.bold, { color: c.text }]}>{s.index}. {s.purpose} · {STEP_TEXT[s.status]}{s.attempts > 1 ? ` (attempt ${s.attempts})` : ''}</Text>
                <Text style={[styles.small, { color: c.muted }]}>{getTool(s.tool)?.name ?? s.tool} v{s.toolVersion}{s.startedAt && s.endedAt ? ` · ${Math.max(0, s.endedAt - s.startedAt)} ms` : ''}</Text>
                {s.summary ? <Text style={{ color: c.text }}>{s.summary}</Text> : null}
                {s.warning ? <Text style={[styles.small, { color: c.muted }]}>⚠ {s.warning}</Text> : null}
                {s.error ? <Text style={{ color: c.stop }}>{s.error}</Text> : null}
              </View>
            ))}
            {finished && (
              <View style={[styles.box, { backgroundColor: run.status === 'succeeded' ? c.bubble : c.errorBg }]} accessibilityLiveRegion="polite">
                <Text style={[styles.bold, { color: c.text }]}>{RUN_STATUS_TEXT[run.status]}</Text>
                {run.finalText ? <Text selectable style={{ color: c.text }}>{run.finalText}</Text> : null}
                {run.sources.length > 0 && <Text style={[styles.small, { color: c.muted }]}>Sources (retrieved from your documents):</Text>}
                {run.sources.map(src => (
                  <Pressable key={src.n} accessibilityRole="link" accessibilityLabel={`Open source ${src.n}: ${sourceLabel(src)}`} onPress={() => onOpenSource(src.documentId, src.ordinal)}>
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
            <View style={styles.actions}>
              <Text style={[styles.label, styles.flex, { color: c.text }]}>Past runs</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Delete run history" onPress={deleteHistory}>
                <Text style={{ color: c.stop }}>Delete history</Text>
              </Pressable>
            </View>
            {past.map(p => (
              <Pressable key={p.id} style={[styles.pastRow, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Open past run ${p.task}`}
                disabled={running} onPress={async () => { const r = await agentStore.getRun(p.id); if (r) setRun(r); }}>
                <Text style={{ color: c.text }} numberOfLines={1}>{p.task}</Text>
                <Text style={[styles.small, { color: c.muted }]}>{RUN_STATUS_TEXT[p.status]} · v{p.sourceVersion ?? '?'} · {formatWhen(p.createdAt)}</Text>
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
  pad: { padding: 16, gap: 10 },
  gap: { gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  step: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 4 },
  box: { borderRadius: 10, padding: 12, gap: 6 },
  pastRow: { paddingVertical: 10, borderBottomWidth: 1 },
  label: { fontWeight: '600', marginTop: 8 },
  small: { fontSize: 12 },
  bold: { fontWeight: '600' },
});
