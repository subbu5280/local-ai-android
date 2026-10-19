/**
 * Memory: what the app tells the model about you, all in one place.
 * - Instructions for the model (your standing instructions, e.g. "Answer briefly; I'm a Java developer").
 * - What you asked it to remember ("Remember my name is Ravi"): edit or forget each one.
 * - What it picked up from your chats (learned facts): forget each one.
 * Everything stays in the phone's database; credentials are refused by the same checks as the chat commands.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import * as chat from './chatStore';
import { MAX_INSTRUCTIONS, setInstructions } from './localModel';
import { styles } from './CodeScreen';
import type { Colors } from './theme';

const KEY = 'custom_instructions';

/** Load the saved instructions into the model's system message (called once at app start). */
export async function loadInstructions(): Promise<void> {
  const row = (await chat.db().query('SELECT value FROM meta WHERE key = ?', [KEY]))[0];
  setInstructions(row ? String(row.value) : '');
}

export function MemoryScreen({ colors: c, onBack }: { colors: Colors; onBack: () => void }) {
  const [instructions, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [memories, setMemories] = useState<chat.Memory[]>([]);
  const [learned, setLearned] = useState<chat.Learned[]>([]);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const refresh = useCallback(async () => {
    const row = (await chat.db().query('SELECT value FROM meta WHERE key = ?', [KEY]))[0];
    const text = row ? String(row.value) : '';
    setText(text); setSaved(text);
    setMemories(await chat.listMemories());
    setLearned(await chat.listLearned());
  }, []);
  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  async function saveInstructions() {
    const text = instructions.trim().slice(0, MAX_INSTRUCTIONS);
    if (chat.containsSecretValue(text)) { Alert.alert('Not saved', 'Instructions must not contain passwords, PINs or keys.'); return; }
    await chat.db().execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [KEY, text]);
    setInstructions(text);
    setSaved(text);
  }
  async function saveEdit() {
    if (!editing) return;
    try { await chat.updateMemory(editing.id, { value: editing.value, source: 'user_edit' }); setEditing(null); refresh(); }
    catch (e: any) { Alert.alert('Not saved', String(e?.message ?? e)); }
  }
  const forget = (label: string, run: () => Promise<unknown>) => Alert.alert(`Forget "${label}"?`, 'The model will no longer be told this.', [
    { text: 'Cancel', style: 'cancel' }, { text: 'Forget', style: 'destructive', onPress: () => { run().then(refresh); } }]);

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">Memory</Text>
      </View>
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <Text style={[styles.bold, { color: c.text }]}>Instructions for the model</Text>
        <Text style={{ color: c.muted }}>Added to every chat. For example: "Answer in short points. I'm a Java developer learning Kafka."</Text>
        <TextInput style={[styles.input, { borderColor: c.border, color: c.text, minHeight: 90, textAlignVertical: 'top' }]} multiline
          value={instructions} onChangeText={t => setText(t.slice(0, MAX_INSTRUCTIONS))} maxLength={MAX_INSTRUCTIONS}
          placeholder="Your standing instructions (optional)" placeholderTextColor={c.muted} accessibilityLabel="Instructions for the model" />
        <View style={styles.row}>
          <Text style={[styles.small, styles.flex, { color: c.muted }]}>{instructions.length}/{MAX_INSTRUCTIONS}</Text>
          <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Save instructions"
            disabled={instructions.trim() === saved.trim()} onPress={saveInstructions}>
            <Text style={{ color: instructions.trim() === saved.trim() ? c.muted : c.accent }}>{instructions.trim() === saved.trim() ? 'Saved' : 'Save'}</Text>
          </Pressable>
        </View>

        <Text style={[styles.bold, { color: c.text, marginTop: 12 }]}>What you asked me to remember</Text>
        {memories.length === 0 && <Text style={{ color: c.muted }}>Nothing yet. Say "Remember my name is …" in chat.</Text>}
        {memories.map(m => (
          <View key={m.id} style={[styles.card, { backgroundColor: c.bubble }]}>
            <Text style={[styles.small, { color: c.muted }]}>{m.type} · {m.key}</Text>
            {editing?.id === m.id ? (
              <View style={styles.row}>
                <TextInput style={[styles.input, styles.flex, { borderColor: c.border, color: c.text }]} value={editing.value}
                  onChangeText={v => setEditing({ id: m.id, value: v })} accessibilityLabel={`Edit ${m.key}`} />
                <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel={`Save ${m.key}`} onPress={saveEdit}>
                  <Text style={{ color: c.accent }}>Save</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.row}>
                <Text style={[styles.flex, { color: c.text }]}>{m.value}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel={`Edit ${m.key}`} hitSlop={10} onPress={() => setEditing({ id: m.id, value: m.value })}>
                  <Text style={{ color: c.accent }}>Edit</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`Forget ${m.key}`} hitSlop={10} onPress={() => forget(m.key, () => chat.deactivateMemory(m.id))}>
                  <Text style={{ color: c.stop }}>Forget</Text>
                </Pressable>
              </View>
            )}
          </View>
        ))}

        <Text style={[styles.bold, { color: c.text, marginTop: 12 }]}>Picked up from your chats</Text>
        {learned.length === 0 && <Text style={{ color: c.muted }}>Nothing yet.</Text>}
        {learned.map(l => (
          <View key={l.id} style={[styles.card, styles.row, { backgroundColor: c.bubble }]}>
            <Text style={[styles.flex, { color: c.text }]}>{l.key}: {l.value}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`Forget ${l.key}`} hitSlop={10} onPress={() => forget(l.key, () => chat.forgetLearned(l.id))}>
              <Text style={{ color: c.stop }}>Forget</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
