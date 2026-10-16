/**
 * Create, edit, duplicate, test or delete an agent. Problems are shown before saving (policy.validateAgent); limits
 * can only be set inside the application bounds.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import * as agentStore from './agents/agentStore';
import { LIMIT_LABEL, validateAgent } from './agents/policy';
import { TOOLS } from './agents/tools';
import { DEFAULT_LIMITS, LIMIT_BOUNDS, type AgentConfig, type Limits } from './agents/types';
import type { Colors } from './theme';

type Props = {
  colors: Colors;
  /** The agent to edit; null = a new agent. */
  id: string | null;
  /** Prefill a new agent from this one ("Duplicate"). */
  copyOf?: string;
  onBack: () => void;
  onSaved: () => void;
  onDuplicate: (id: string) => void;
  onTest: (id: string) => void;
};

const RISK_TEXT = { compute: 'no data access', read: 'reads local data', write: 'creates files: asks you every time' } as const;
const STEP: Record<keyof Limits, number> = { maxSteps: 1, maxRetries: 1, stepTimeoutSec: 15 };

export function AgentEditScreen({ colors: c, id, copyOf, onBack, onSaved, onDuplicate, onTest }: Props) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [limits, setLimits] = useState<Limits>({ ...DEFAULT_LIMITS });
  const [confirmPlan, setConfirmPlan] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [others, setOthers] = useState<AgentConfig[]>([]);
  const [saved, setSaved] = useState<AgentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);

  useEffect(() => {
    (async () => {
      const all = await agentStore.listAgents();
      setOthers(all);
      const from = all.find(a => a.id === (id ?? copyOf));
      if (from) {
        setName(id ? from.name : `Copy of ${from.name}`.slice(0, 40));
        setPurpose(from.purpose);
        setTools(from.tools);
        setLimits(from.limits);
        setConfirmPlan(from.confirmPlan);
        setEnabled(from.enabled);
        if (id) setSaved(from);
      }
    })().catch((e: any) => setError(`Couldn't read agents (${e?.message ?? e}).`));
  }, [id, copyOf]);

  const errors = useMemo(() => validateAgent({ id: id ?? saved?.id ?? '', name, purpose, tools, limits }, others), [id, saved, name, purpose, tools, limits, others]);
  const dirty = !saved || saved.name !== name.trim() || saved.purpose !== purpose.trim() || saved.tools.join() !== tools.join() ||
    JSON.stringify(saved.limits) !== JSON.stringify(limits) || saved.confirmPlan !== confirmPlan || saved.enabled !== enabled;

  const toggleTool = (t: string) => setTools(prev => (prev.includes(t) ? prev.filter(x => x !== t) : TOOLS.map(x => x.id).filter(x => x === t || prev.includes(x))));
  const bump = (k: keyof Limits, dir: 1 | -1) => setLimits(l => {
    const [lo, hi] = LIMIT_BOUNDS[k];
    return { ...l, [k]: Math.min(hi, Math.max(lo, l[k] + dir * STEP[k])) };
  });

  async function save() {
    if (saving.current || errors.length) return;
    saving.current = true;
    try {
      // A new agent, once saved, is updated by later saves (never created twice).
      const a = await agentStore.saveAgent({ id: id ?? saved?.id, name, purpose, tools, limits, confirmPlan, enabled });
      setSaved(a);
      setError(null);
      onSaved();
    } catch (e: any) {
      setError(`Couldn't save the agent (${e?.message ?? e}).`);
    } finally {
      saving.current = false;
    }
  }

  function remove() {
    if (!saved) return;
    Alert.alert('Delete this agent?', `"${saved.name}" will be deleted. Its past runs stay in the history.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try { await agentStore.deleteAgent(saved.id); onSaved(); onBack(); } catch (e: any) { setError(`Couldn't delete (${e?.message ?? e}).`); }
      } },
    ]);
  }

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">{id ? 'Edit agent' : 'New agent'}</Text>
        <Pressable style={[styles.chip, { borderColor: errors.length || !dirty ? c.border : c.accent }]} accessibilityRole="button"
          accessibilityLabel="Save agent" disabled={!!errors.length || !dirty} onPress={save}>
          <Text style={{ color: errors.length || !dirty ? c.muted : c.accent }}>Save</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.pad}>
        <Text style={[styles.label, { color: c.text }]}>Name</Text>
        <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={name} onChangeText={setName}
          maxLength={60} accessibilityLabel="Agent name" />
        <Text style={[styles.label, { color: c.text }]}>Purpose</Text>
        <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={purpose} onChangeText={setPurpose}
          multiline maxLength={320} accessibilityLabel="Agent purpose" />

        <Text style={[styles.label, { color: c.text }]}>Tools</Text>
        {TOOLS.map(t => (
          <View key={t.id} style={[styles.toolRow, { borderColor: c.border }]}>
            <View style={styles.flex}>
              <Text style={{ color: c.text }}>{t.name}</Text>
              <Text style={[styles.small, { color: c.muted }]}>{t.description.replace(/ input \{.*$/, '')}</Text>
              <Text style={[styles.small, { color: t.risk === 'write' ? c.stop : c.muted }]}>{RISK_TEXT[t.risk]}</Text>
            </View>
            <Switch value={tools.includes(t.id)} onValueChange={() => toggleTool(t.id)} accessibilityLabel={`Tool ${t.name}`} />
          </View>
        ))}

        <Text style={[styles.label, { color: c.text }]}>Limits</Text>
        {(Object.keys(LIMIT_BOUNDS) as (keyof Limits)[]).map(k => (
          <View key={k} style={styles.limitRow}>
            <Text style={[styles.flex, { color: c.text }]}>{LIMIT_LABEL[k]}</Text>
            <Pressable style={[styles.step, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Decrease ${LIMIT_LABEL[k]}`} onPress={() => bump(k, -1)}>
              <Text style={{ color: c.text }}>−</Text>
            </Pressable>
            <Text style={[styles.value, { color: c.text }]} accessibilityLabel={`${LIMIT_LABEL[k]} value`}>{limits[k]}</Text>
            <Pressable style={[styles.step, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Increase ${LIMIT_LABEL[k]}`} onPress={() => bump(k, 1)}>
              <Text style={{ color: c.text }}>+</Text>
            </Pressable>
          </View>
        ))}
        <View style={styles.limitRow}>
          <Text style={[styles.flex, { color: c.text }]}>Show the plan and wait for Run</Text>
          <Switch value={confirmPlan} onValueChange={setConfirmPlan} accessibilityLabel="Confirm plan before running" />
        </View>
        <View style={styles.limitRow}>
          <Text style={[styles.flex, { color: c.text }]}>Enabled</Text>
          <Switch value={enabled} onValueChange={setEnabled} accessibilityLabel="Agent enabled" />
        </View>

        {errors.length > 0 && (
          <View style={[styles.errors, { backgroundColor: c.errorBg }]} accessibilityLiveRegion="polite">
            {errors.map(e => <Text key={e} style={{ color: c.text }}>• {e}</Text>)}
          </View>
        )}
        {error && <Text style={{ color: c.stop }}>{error}</Text>}

        {saved && (
          <View style={styles.actions}>
            <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Test agent"
              disabled={dirty || !saved.enabled} onPress={() => onTest(saved.id)}>
              <Text style={{ color: dirty || !saved.enabled ? c.muted : c.accent }}>Test on a sample task</Text>
            </Pressable>
            <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Duplicate agent"
              onPress={() => onDuplicate(saved.id)}>
              <Text style={{ color: c.text }}>Duplicate</Text>
            </Pressable>
            <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel="Delete agent" onPress={remove}>
              <Text style={{ color: c.stop }}>Delete</Text>
            </Pressable>
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
  pad: { padding: 16, gap: 8 },
  label: { fontWeight: '600', marginTop: 12 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderBottomWidth: 1 },
  limitRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  step: { borderWidth: 1, borderRadius: 18, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  value: { minWidth: 36, textAlign: 'center' },
  errors: { padding: 10, borderRadius: 8, gap: 4, marginTop: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  small: { fontSize: 12 },
});
