/**
 * Coding assistant home: the registered project workspaces. Add a project folder or individual files through
 * Android's picker (only what you pick becomes readable to the app), open one, or remove it from the app (its
 * listing, coding tasks and proposals; the project's files are never changed or deleted by removing it).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as native from './code/native';
import * as store from './code/workspaceStore';
import type { Colors } from './theme';

export function CodeScreen({ colors: c, focused, onBack, onOpen }: {
  colors: Colors; focused: boolean; onBack: () => void; onOpen: (id: string) => void;
}) {
  const [list, setList] = useState<store.Workspace[]>([]);
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const acting = useRef(false);

  const load = useCallback(() => store.listWorkspaces().then(setList).catch(e => setMessage(store.explain(e))), []);
  useEffect(() => { if (focused) load(); }, [focused, load]);

  async function add(kind: store.WorkspaceKind) {
    if (acting.current) return;
    acting.current = true;
    setMessage(null);
    try {
      let ws: store.Workspace;
      if (kind === 'folder') {
        const picked = await native.pickFolder();
        if (!picked) return;
        ws = await store.registerFolder(name.trim() || picked.name, picked);
        setBusy('Listing the folder…');
        await store.scan(ws, { onProgress: p => setBusy(`Listing the folder… ${p.listed} items`) }).catch(e => setMessage(store.explain(e)));
      } else {
        const picked = await native.pickFiles();
        if (!picked.length) return;
        ws = await store.registerFiles(name.trim() || (picked.length === 1 ? picked[0].name : `${picked.length} files`), picked);
      }
      if (!ws.canWrite) setMessage(`"${ws.name}" was added with read-only access: the assistant can read it, but proposed changes can't be applied.`);
      setName('');
      await load();
      onOpen(ws.id);
    } catch (e) {
      setMessage(store.explain(e));
    } finally { setBusy(null); acting.current = false; }
  }

  function remove(ws: store.Workspace) {
    Alert.alert(`Remove "${ws.name}"?`, 'Removes it from this app: its file listing, coding tasks and proposals (including saved ' +
      'originals). Your project files are not changed or deleted. Chats, documents, models, agents, skills and workflows are not affected.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => { store.removeWorkspace(ws.id).then(load).catch(e => setMessage(store.explain(e))); } },
    ]);
  }

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">Code</Text>
      </View>
      <View style={styles.pad}>
        <Text style={{ color: c.muted }}>Pick a project folder or files. The assistant reads only what you pick, on this phone; source code is
          never uploaded. Changes it proposes are applied only after you review and approve them.</Text>
        <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={name} onChangeText={setName} maxLength={60}
          placeholder="Workspace name (optional)" placeholderTextColor={c.muted} accessibilityLabel="Workspace name" />
        <View style={styles.row}>
          <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Add project folder" disabled={!!busy} onPress={() => add('folder')}>
            <Text style={{ color: c.accent }}>Add folder</Text>
          </Pressable>
          <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Add files" disabled={!!busy} onPress={() => add('files')}>
            <Text style={{ color: c.text }}>Add files</Text>
          </Pressable>
        </View>
        {busy && <Text style={{ color: c.muted }} accessibilityLiveRegion="polite">{busy}</Text>}
        {message && <Text style={{ color: c.stop }} accessibilityLiveRegion="polite">{message}</Text>}
      </View>
      <FlatList
        data={list}
        keyExtractor={w => w.id}
        contentContainerStyle={styles.pad}
        ListEmptyComponent={<Text style={{ color: c.muted }}>No workspaces yet. Add a project folder to start.</Text>}
        renderItem={({ item: w }) => (
          <View style={[styles.card, { backgroundColor: c.bubble }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Open workspace ${w.name}`} onPress={() => onOpen(w.id)}>
              <Text style={[styles.bold, { color: c.text }]}>{w.name}</Text>
              <Text style={[styles.small, { color: c.muted }]}>
                {w.kind === 'folder' ? 'Folder' : 'Picked files'} · {w.entryCount} item{w.entryCount === 1 ? '' : 's'}
                {w.truncated ? ' (listing limit reached)' : ''} · {w.canWrite ? 'read and edit' : 'read only'}
              </Text>
            </Pressable>
            <Pressable style={styles.self} accessibilityRole="button" accessibilityLabel={`Remove workspace ${w.name}`} onPress={() => remove(w)}>
              <Text style={{ color: c.stop }}>Remove</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: '600' },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  pad: { padding: 16, gap: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  card: { borderRadius: 10, padding: 12, gap: 6 },
  small: { fontSize: 12 },
  bold: { fontWeight: '600' },
  self: { alignSelf: 'flex-start' },
  mono: { fontFamily: 'monospace', fontSize: 12 },
  pad0: { gap: 6 },
});
