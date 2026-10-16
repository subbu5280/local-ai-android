/**
 * Saved conversations: open one, or delete it after confirmation. Reads and deletes through src/chatStore.ts only.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import * as chat from './chatStore';
import type { Colors } from './theme';

/** How many conversations the list shows (most recent first). */
export const HISTORY_LIMIT = 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:05" today, "12 Oct" this year, "12 Oct 2025" otherwise (fixed format, not device-locale dependent). */
export function formatWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === n.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** The list title: the conversation's saved title (its first message), or a fallback when it is empty. */
export const titleOf = (c: Pick<chat.Conversation, 'title'>) => c.title.trim() || 'Untitled chat';

type Props = {
  colors: Colors;
  /** The conversation open in the chat screen, marked in the list. */
  currentId: string | null;
  /** Open a conversation; rejects if its messages couldn't be read (the list stays open and shows why). */
  onOpen: (c: chat.Conversation) => Promise<void>;
  /** A conversation was deleted (the chat screen clears it if it was open). */
  onDeleted: (id: string) => void;
  onBack: () => void;
};

export function HistoryScreen({ colors: c, currentId, onOpen, onDeleted, onBack }: Props) {
  const [items, setItems] = useState<chat.Conversation[] | null>(null); // null = loading
  const [error, setError] = useState<string | null>(null);
  // One open or delete at a time: a double tap must not open twice or delete while opening.
  const busy = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await chat.listConversations(HISTORY_LIMIT));
    } catch (e: any) {
      setItems([]);
      setError(`Couldn't read saved chats (${e?.message ?? e}).`);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function open(conv: chat.Conversation) {
    if (busy.current) return;
    busy.current = true;
    try {
      await onOpen(conv);
    } catch (e: any) {
      setError(`Couldn't open "${titleOf(conv)}" (${e?.message ?? e}).`);
    } finally {
      busy.current = false;
    }
  }

  async function remove(conv: chat.Conversation) {
    if (busy.current) return;
    busy.current = true;
    try {
      await chat.deleteConversation(conv.id);
      onDeleted(conv.id);
      await load();
    } catch (e: any) {
      setError(`Couldn't delete "${titleOf(conv)}" (${e?.message ?? e}). Nothing was deleted.`);
    } finally {
      busy.current = false;
    }
  }

  function confirmDelete(conv: chat.Conversation) {
    if (busy.current) return;
    Alert.alert('Delete this chat?', `"${titleOf(conv)}" and all its messages will be removed from this phone. ` +
      "This can't be undone.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => remove(conv) },
    ]);
  }

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back to chat"
          onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Chat</Text>
        </Pressable>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">Saved chats</Text>
      </View>
      {error && (
        <View style={[styles.error, { backgroundColor: c.errorBg }]} accessibilityLiveRegion="polite">
          <Text style={{ color: c.text }}>{error}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry reading saved chats" onPress={load}>
            <Text style={[styles.link, { color: c.accent }]}>Retry</Text>
          </Pressable>
        </View>
      )}
      <FlatList
        style={styles.flex}
        data={items ?? []}
        keyExtractor={conv => conv.id}
        ListEmptyComponent={items && !error ? (
          <Text style={[styles.empty, { color: c.muted }]}>No saved chats yet. Your conversations appear here.</Text>
        ) : undefined}
        renderItem={({ item }) => (
          <View style={[styles.row, { borderColor: c.border }, item.id === currentId && { backgroundColor: c.bubble }]}>
            <Pressable style={styles.flex} accessibilityRole="button" accessibilityLabel={`Open chat ${titleOf(item)}`}
              onPress={() => open(item)}>
              <Text style={[styles.rowTitle, { color: c.text }]} numberOfLines={1}>{titleOf(item)}</Text>
              <Text style={{ color: c.muted }}>
                {formatWhen(item.updated_at)}{item.id === currentId ? ' · open now' : ''}
              </Text>
            </Pressable>
            <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button"
              accessibilityLabel={`Delete chat ${titleOf(item)}`} onPress={() => confirmDelete(item)}>
              <Text style={{ color: c.stop }}>Delete</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: '600' },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  rowTitle: { fontSize: 16 },
  error: { padding: 12, gap: 6 },
  link: { fontWeight: '600' },
  empty: { padding: 24, textAlign: 'center' },
});
