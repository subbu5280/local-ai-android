/**
 * One document: its details and status, its passages one at a time (opened at a search result or a cited source),
 * and the actions Ask about it, Retry (failed imports) and Remove (from the library only; the file stays).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatWhen } from './HistoryScreen';
import * as store from './knowledge/docStore';
import * as indexer from './knowledge/indexer';
import type { Colors } from './theme';

type Props = {
  colors: Colors;
  id: string;
  /** The passage to show first (a search result or a cited source); default the first. */
  ordinal?: number;
  onBack: () => void;
  /** Use this document for the chat's Docs mode and return to the chat. */
  onAsk: (id: string) => void;
  onRemoved: (id: string) => void;
};

const SIZE = (n: number | null) => (n == null || n < 0 ? 'unknown size' : n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(1)} MB`);

export function DocumentScreen({ colors: c, id, ordinal = 0, onBack, onAsk, onRemoved }: Props) {
  const [doc, setDoc] = useState<store.Doc | null | undefined>(undefined); // undefined = loading, null = gone
  const [at, setAt] = useState(ordinal);
  const [passage, setPassage] = useState<store.StoredChunk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const acting = useRef(false); // one Retry/Remove at a time, whatever the taps

  const load = useCallback(async () => {
    try {
      setDoc(await store.getDocument(id));
    } catch (e: any) {
      setError(`Couldn't read this document (${e?.message ?? e}).`);
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    store.getChunk(id, at).then(setPassage).catch(() => setPassage(null));
  }, [id, at, doc?.indexed_at]);

  async function act(label: string, work: () => Promise<void>) {
    if (acting.current) return;
    acting.current = true;
    setBusy(label);
    try {
      await work();
    } catch (e: any) {
      setError(`${label} failed (${e?.message ?? e}).`);
    } finally {
      acting.current = false;
      setBusy(null);
    }
  }

  const retry = () => act('Retry', async () => {
    const r = await indexer.retry(id);
    if (r.status !== 'indexed' && r.status !== 'unchanged') setError(r.message);
    else setError(null);
    await load();
  });

  const remove = () => {
    if (acting.current || !doc) return;
    Alert.alert('Remove this document?', `"${doc.name}" and its search index will be removed from Local AI. ` +
      'The original file stays on your phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => act('Remove', async () => {
        if (await indexer.removeDocument(id)) onRemoved(id);
      }) },
    ]);
  };

  const back = (
    <View style={[styles.header, { borderColor: c.border }]}>
      <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
        <Text style={{ color: c.text }}>‹ Back</Text>
      </Pressable>
      <Text style={[styles.title, styles.flex, { color: c.text }]} numberOfLines={1} accessibilityRole="header">
        {doc ? doc.name : 'Document'}
      </Text>
    </View>
  );
  if (doc === null) {
    return (
      <View style={[styles.flex, { backgroundColor: c.bg }]}>
        {back}
        <Text style={[styles.pad, { color: c.muted }]}>This document is no longer in the library.</Text>
      </View>
    );
  }

  const rows: [string, string][] = doc ? [
    ['Format', doc.format.toUpperCase()],
    ['Status', doc.status === 'ready' ? 'Ready' : doc.status === 'indexing' ? 'Indexing…' : 'Failed'],
    ['Size', SIZE(doc.size)],
    ...(doc.page_count != null ? [['Pages', String(doc.page_count)] as [string, string]] : []),
    ['Passages', String(doc.chunk_count)],
    ['Imported', formatWhen(doc.created_at)],
    ['Updated', formatWhen(doc.updated_at)],
  ] : [];

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      {back}
      <ScrollView contentContainerStyle={styles.pad}>
        {rows.map(([k, v]) => (
          <Text key={k} style={{ color: c.text }}><Text style={styles.bold}>{k}: </Text>{v}</Text>
        ))}
        {doc?.warning ? <Text style={[styles.note, { color: c.muted }]}>⚠ {doc.warning}</Text> : null}
        {doc?.status === 'failed' && doc.error ? (
          <Text style={[styles.note, { color: c.stop }]} accessibilityLiveRegion="polite">{doc.error}</Text>
        ) : null}
        {error ? <Text style={[styles.note, { color: c.stop }]} accessibilityLiveRegion="polite">{error}</Text> : null}
        {busy ? <Text style={[styles.note, { color: c.muted }]}>{busy}…</Text> : null}

        <View style={styles.actions}>
          {doc?.status === 'ready' && (
            <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Ask about this document"
              onPress={() => onAsk(id)}>
              <Text style={{ color: c.accent }}>Ask about this document</Text>
            </Pressable>
          )}
          {doc && indexer.canRetry(doc) && (
            <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Retry import"
              onPress={retry} disabled={!!busy}>
              <Text style={{ color: c.accent }}>Retry</Text>
            </Pressable>
          )}
          <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel="Remove document"
            onPress={remove} disabled={!!busy}>
            <Text style={{ color: c.stop }}>Remove</Text>
          </Pressable>
        </View>

        {doc && doc.status === 'ready' && doc.chunk_count > 0 && (
          <View style={[styles.passage, { borderColor: c.border }]}>
            <Text style={[styles.bold, { color: c.text }]}>
              Passage {at + 1} of {doc.chunk_count}{passage?.page != null ? ` · page ${passage.page}` : ''}
            </Text>
            <Text selectable style={{ color: c.text }}>{passage?.text ?? '…'}</Text>
            <View style={styles.actions}>
              <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Previous passage"
                disabled={at <= 0} onPress={() => setAt(a => Math.max(0, a - 1))}>
                <Text style={{ color: at <= 0 ? c.muted : c.text }}>‹ Previous</Text>
              </Pressable>
              <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Next passage"
                disabled={at >= doc.chunk_count - 1} onPress={() => setAt(a => Math.min(doc.chunk_count - 1, a + 1))}>
                <Text style={{ color: at >= doc.chunk_count - 1 ? c.muted : c.text }}>Next ›</Text>
              </Pressable>
            </View>
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
  pad: { padding: 16, gap: 6 },
  note: { marginTop: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  passage: { marginTop: 16, borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 },
  bold: { fontWeight: '600' },
});
