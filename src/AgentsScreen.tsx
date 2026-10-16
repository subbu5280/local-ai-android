/**
 * Agents: the list of agents (run, edit, create) and recent runs of all agents.
 */
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DefinitionList, type DefKind } from './LibraryPanels';
import * as agentStore from './agents/agentStore';
import type { AgentConfig, RunStatus } from './agents/types';
import { formatWhen } from './HistoryScreen';
import type { Colors } from './theme';

export const RUN_STATUS_TEXT: Record<RunStatus, string> = {
  planned: 'Planned', running: 'Running…', succeeded: 'Succeeded', no_evidence: 'Not found in documents',
  failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
};

type Props = {
  colors: Colors;
  focused: boolean;
  onBack: () => void;
  onEdit: (id: string | null) => void;
  onRun: (agentId: string, runId?: string) => void;
  /** Developer: the on-device answer-quality evaluation (M5). */
  onEval: () => void;
  /** M6: skills and workflows (tabs of this screen). */
  onDefEdit: (kind: DefKind, id: string | null) => void;
  onDefRun: (kind: DefKind, id: string) => void;
  onDraft: () => void;
};

export function AgentsScreen({ colors: c, focused, onBack, onEdit, onRun, onEval, onDefEdit, onDefRun, onDraft }: Props) {
  const [tab, setTab] = useState<'agents' | DefKind>('agents');
  const [agents, setAgents] = useState<AgentConfig[] | null>(null);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof agentStore.listRuns>>>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await agentStore.listAgents();
      setAgents(list);
      const recent = await agentStore.listRuns(null, 10);
      setRuns(recent);
      setError(null);
    } catch (e: any) {
      setAgents([]);
      setError(`Couldn't read agents (${e?.message ?? e}).`);
    }
  }, []);
  useEffect(() => { if (focused) load(); }, [focused, load]);

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back to chat" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Chat</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">Agents</Text>
        <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="New agent" onPress={() => onEdit(null)}>
          <Text style={{ color: c.accent }}>New</Text>
        </Pressable>
      </View>
      <View style={styles.tabs}>
        {(['agents', 'skill', 'workflow'] as const).map(t => (
          <Pressable key={t} style={[styles.chip, { borderColor: tab === t ? c.accent : c.border }]} accessibilityRole="tab"
            accessibilityState={{ selected: tab === t }} accessibilityLabel={`${t === 'agents' ? 'Agents' : t === 'skill' ? 'Skills' : 'Workflows'} tab`} onPress={() => setTab(t)}>
            <Text style={{ color: tab === t ? c.accent : c.text }}>{t === 'agents' ? 'Agents' : t === 'skill' ? 'Skills' : 'Workflows'}</Text>
          </Pressable>
        ))}
      </View>
      {tab !== 'agents' && (
        <ScrollView style={styles.flex} keyboardShouldPersistTaps="handled">
          <DefinitionList kind={tab} colors={c} focused={focused} onEdit={id => onDefEdit(tab, id)} onRun={id => onDefRun(tab, id)}
            onDraft={tab === 'workflow' ? onDraft : undefined} />
        </ScrollView>
      )}
      {tab === 'agents' && error && <Text style={[styles.pad, { color: c.stop }]}>{error}</Text>}
      {tab === 'agents' && <FlatList
        style={styles.flex}
        data={agents ?? []}
        keyExtractor={a => a.id}
        ListHeaderComponent={<Text style={[styles.note, { color: c.muted }]}>
          Agents run fixed, checked tools on this phone. The model may propose a plan; the app validates every step and
          asks you before anything is saved.
        </Text>}
        ListEmptyComponent={agents && !error ? <Text style={[styles.pad, { color: c.muted }]}>No agents. Tap New to create one.</Text> : undefined}
        renderItem={({ item }) => (
          <View style={[styles.row, { borderColor: c.border }]}>
            <View style={styles.flex}>
              <Text style={[styles.bold, { color: item.enabled ? c.text : c.muted }]}>{item.name}{item.enabled ? '' : ' (disabled)'}</Text>
              <Text style={{ color: c.muted }} numberOfLines={2}>{item.purpose || 'No purpose given.'}</Text>
              <Text style={[styles.small, { color: c.muted }]}>{item.tools.length} tool{item.tools.length === 1 ? '' : 's'} · version {item.version}</Text>
            </View>
            <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Edit agent ${item.name}`}
              onPress={() => onEdit(item.id)}>
              <Text style={{ color: c.text }}>Edit</Text>
            </Pressable>
            <Pressable style={[styles.chip, { borderColor: item.enabled ? c.accent : c.border }]} accessibilityRole="button"
              accessibilityLabel={`Run agent ${item.name}`} disabled={!item.enabled} onPress={() => onRun(item.id)}>
              <Text style={{ color: item.enabled ? c.accent : c.muted }}>Run</Text>
            </Pressable>
          </View>
        )}
        ListFooterComponent={
          <View>
            <Pressable style={styles.run} accessibilityRole="button" accessibilityLabel="Model evaluation" onPress={onEval}>
              <Text style={{ color: c.accent }}>Model evaluation (developer)</Text>
            </Pressable>
            {runs.length > 0 && <View>
            <Text style={[styles.section, { color: c.text }]}>Recent runs</Text>
            {runs.map(r => {
              const agentId = r.agentId && agents?.some(a => a.id === r.agentId) ? r.agentId : undefined; // deleted agent: view only via history
              return (
                <Pressable key={r.id} style={[styles.run, { borderColor: c.border }]} accessibilityRole="button"
                  accessibilityLabel={`Open run ${r.task}`} disabled={!agentId} onPress={() => agentId && onRun(agentId, r.id)}>
                  <Text style={{ color: c.text }} numberOfLines={1}>{r.task}</Text>
                  <Text style={[styles.small, { color: c.muted }]}>{r.agentName} · {RUN_STATUS_TEXT[r.status]} · {formatWhen(r.createdAt)}</Text>
                </Pressable>
              );
            })}
            </View>}
          </View>
        }
      />}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: '600' },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 10 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  run: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  note: { padding: 16, fontSize: 13 },
  section: { paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6, fontWeight: '600' },
  pad: { padding: 16 },
  small: { fontSize: 12 },
  bold: { fontWeight: '600' },
});
