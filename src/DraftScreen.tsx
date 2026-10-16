/**
 * Describe a workflow in your own words; the on-device model drafts it, the app checks it, and you review it. A draft
 * is never saved or run by itself: Save, Edit before saving, or discard.
 */
import { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { getTool } from './agents/tools';
import * as docStore from './knowledge/docStore';
import { draftWorkflow, type Draft } from './skills/draft';
import * as store from './skills/skillStore';
import type { Colors } from './theme';

export function DraftScreen({ colors: c, modelReady, onBack, onSaved, onEdit }: {
  colors: Colors; modelReady: boolean; onBack: () => void; onSaved: (id: string) => void; onEdit: (json: string) => void;
}) {
  const [request, setRequest] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const acting = useRef(false);

  async function make() {
    if (acting.current || !request.trim()) return;
    acting.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const docs = (await docStore.listDocuments()).filter(d => d.status === 'ready').map(d => ({ id: d.id, name: d.name }));
      setDraft(await draftWorkflow(request, { skills: await store.skillMap(), modelReady, docs }));
    } catch (e: any) {
      setMessage(String(e?.message ?? e));
    } finally { setBusy(false); acting.current = false; }
  }

  async function save() {
    if (!draft?.def || acting.current) return;
    acting.current = true;
    try {
      const def = await store.saveDefinition('workflow', draft.def, 'create');
      onSaved(def.id);
    } catch (e: any) { setMessage(e?.errors?.join('; ') ?? String(e?.message ?? e)); } finally { acting.current = false; }
  }

  const d = draft?.def;
  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">Describe a workflow</Text>
      </View>
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <Text style={{ color: c.muted }}>Say what it should do, e.g. "Compare my documents about refunds and save a report". The model on this phone
          drafts it; the app checks every step; nothing is saved or run until you choose.</Text>
        <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={request} onChangeText={setRequest} multiline
          editable={!busy} placeholder="What should the workflow do?" placeholderTextColor={c.muted} accessibilityLabel="Workflow request" />
        <Pressable style={[styles.chip, styles.self, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Make draft" disabled={busy || !request.trim()} onPress={make}>
          <Text style={{ color: busy || !request.trim() ? c.muted : c.accent }}>{busy ? 'Drafting…' : 'Make draft'}</Text>
        </Pressable>
        {draft && (
          <View style={styles.gap} accessibilityLiveRegion="polite">
            <Text style={[styles.small, { color: c.muted }]}>{draft.note}</Text>
            {draft.rejected.length > 0 && (
              <View style={[styles.box, { backgroundColor: c.errorBg }]}>
                <Text style={[styles.bold, { color: c.text }]}>Not possible in the model's proposal:</Text>
                {draft.rejected.map(e => <Text key={e} style={{ color: c.text }}>• {e}</Text>)}
              </View>
            )}
            {d && (
              <View style={[styles.box, { backgroundColor: c.bubble }]}>
                <Text style={[styles.bold, { color: c.text }]}>{d.name.en} ({draft.source === 'model' ? 'drafted by the model' : "from the app's rules"})</Text>
                {d.steps.map((s, i) => (
                  <Text key={i} style={{ color: c.text }}>
                    {i + 1}. {'tool' in s ? `${getTool(s.tool)?.name ?? s.tool} ${JSON.stringify(s.input)}${s.fromStep ? ` · uses step ${s.fromStep}` : ''}`
                      : `Skill ${s.skill} ${JSON.stringify(s.inputs)}`}{draft.expects[i] ? ` → ${draft.expects[i]}` : ''}
                  </Text>
                ))}
              </View>
            )}
            {draft.errors.map(e => <Text key={e} style={{ color: c.stop }}>• {e}</Text>)}
            {d && (
              <View style={styles.actions}>
                <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Save draft" onPress={save}>
                  <Text style={{ color: c.accent }}>Save</Text>
                </Pressable>
                <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Edit draft before saving" onPress={() => onEdit(JSON.stringify(d))}>
                  <Text style={{ color: c.text }}>Edit before saving</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
        {message && <Text style={{ color: c.stop }}>{message}</Text>}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: '600' },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  self: { alignSelf: 'flex-start' },
  pad: { padding: 16, gap: 10 },
  gap: { gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, minHeight: 70 },
  box: { borderRadius: 10, padding: 12, gap: 4 },
  small: { fontSize: 12 },
  bold: { fontWeight: '600' },
});
