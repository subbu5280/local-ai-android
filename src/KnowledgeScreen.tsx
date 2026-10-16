/**
 * Documents: the library (import, status, open), keyword search across it, and choosing which documents the chat's
 * "Docs" mode answers from. Search never calls the language model.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatWhen } from './HistoryScreen';
import * as store from './knowledge/docStore';
import * as indexer from './knowledge/indexer';
import { pickFiles } from './knowledge/native';
import type { Passage } from './knowledge/retrieve';
import { retrievePassages, type RetrievalMode } from './knowledge/hybrid';
import * as semantic from './knowledge/semantic';
import * as collections from './knowledge/collections';
import * as ocr from './knowledge/ocr';
import { E5_SMALL } from './knowledge/embeddings';
import { connectivity } from './device';
import { sourceLabel } from './knowledge/knowledgePrompt';
import type { Colors } from './theme';

type Props = {
  colors: Colors;
  /** Choose documents for the chat's Docs mode instead of browsing. */
  select: boolean;
  /** The current Docs-mode scope (null = all documents), preselected in select mode. */
  scope: string[] | null;
  /** On top of the screen stack (false while a document opened from here is shown on top of it). */
  focused: boolean;
  onBack: () => void;
  onOpenDocument: (id: string, ordinal?: number) => void;
  /** Use these documents (null = all) for Docs mode and return to the chat. */
  onUseScope: (ids: string[] | null) => void;
};

const ENGINE_TEXT: Record<store.FtsEngine, string> = {
  fts5: 'Keyword search · SQLite FTS5',
  fts4: 'Keyword search · SQLite FTS4',
  none: 'Search unavailable: this phone has no SQLite full-text index',
};
const STATUS_TEXT: Record<store.DocStatus, string> = { ready: 'Ready', indexing: 'Indexing…', failed: 'Failed' };

/** `text` with every occurrence of the search terms in bold (case-insensitive). */
export function Highlighted({ text, terms, color }: { text: string; terms: string[]; color: string }) {
  const words = terms.flatMap(t => t.split(' ')).filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <Text style={{ color }}>{text}</Text>;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  return (
    <Text style={{ color }}>
      {parts.map((p, i) => (i % 2 ? <Text key={i} style={styles.bold}>{p}</Text> : p))}
    </Text>
  );
}

/** What search actually runs: keyword only, or keyword plus meaning (with how many passages have vectors). */
export function searchLabel(engine: store.FtsEngine, s: semantic.SemanticState | null): string {
  if (engine === 'none') return ENGINE_TEXT.none;
  const kw = ENGINE_TEXT[engine];
  if (!s?.installed || !s.enabled || s.status.embedded === 0) return kw;
  return `${kw} + meaning (${s.status.embedded} of ${s.status.passages} passages)`;
}

/** Text recognition (OCR) languages for scanned PDFs and photos: each download is confirmed first, with its size. */
function OcrPanel({ colors: c }: { colors: Colors }) {
  const [installed, setInstalled] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => { ocr.installedLanguages().then(setInstalled).catch(() => undefined); }, []);
  useEffect(refresh, [refresh]);
  async function get(lang: ocr.OcrLanguage) {
    const online = (await connectivity()) !== 'offline';
    Alert.alert(`Download ${lang.name} text recognition?`, `${(lang.bytes / 1e6).toFixed(1)} MB from the Tesseract project ` +
      '(tessdata_fast, Apache-2.0). Recognition then runs on this phone; documents are never uploaded.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Download', onPress: async () => {
        setBusy(lang.code);
        try { await ocr.downloadLanguage(lang.code, online); } catch (e: any) { Alert.alert('Not downloaded', String(e?.message ?? e)); }
        setBusy(null);
        refresh();
      } },
    ]);
  }
  async function remove(lang: ocr.OcrLanguage) {
    await ocr.removeLanguage(lang.code).catch(() => undefined);
    refresh();
  }
  return (
    <View style={[styles.result, { borderColor: c.border }]}>
      <Text style={[styles.bold, { color: c.text }]}>Text recognition (scans and photos)</Text>
      <Text style={{ color: c.muted }}>Languages used to read scanned PDFs and JPG/PNG images. Results may contain mistakes.</Text>
      <View style={styles.collections}>
        {ocr.OCR_LANGUAGES.map(l => {
          const has = installed.includes(l.code);
          return (
            <Pressable key={l.code} style={[styles.chip, { borderColor: has ? c.accent : c.border }]} accessibilityRole="button"
              accessibilityLabel={has ? `Remove ${l.name} text recognition` : `Download ${l.name} text recognition`}
              disabled={busy !== null} onPress={() => (has ? remove(l) : get(l))}>
              <Text style={{ color: has ? c.accent : c.text }}>{busy === l.code ? `${l.name}…` : has ? `${l.name} ✓ ✕` : `${l.name} ↓`}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Meaning search: get, switch on/off, build/stop, remove. Never downloads without confirmation. */
function MeaningPanel({ colors: c, state: s }: { colors: Colors; state: semantic.SemanticState }) {
  const mb = Math.round(E5_SMALL.bytes / 1e6);
  async function get() {
    const net = await connectivity();
    if (net === 'offline') {
      Alert.alert('No internet connection', `Downloading the meaning-search model (${mb} MB) needs a connection. Nothing was downloaded.`);
      return;
    }
    Alert.alert('Download meaning search?', `${E5_SMALL.name}, ${mb} MB, license ${E5_SMALL.license}. It finds passages that ` +
      "match a question's meaning, also across languages. Building its index uses the processor for a while after each import. " +
      'Keyword search keeps working without it.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Download', onPress: () => { semantic.download(true).catch(() => undefined); } },
    ]);
  }
  const pending = s.status.passages - s.status.embedded;
  const line = s.downloading !== null ? `Downloading ${Math.floor(s.downloading * 100)}%…`
    : !s.installed ? 'Meaning search is off (not downloaded). Search uses keywords only.'
    : !s.enabled ? 'Meaning search is switched off. Search uses keywords only.'
    : s.building ? `Building meaning index: ${s.status.embedded} of ${s.status.passages} passages…`
    : pending > 0 ? `Meaning index: ${s.status.embedded} of ${s.status.passages} passages (${pending} waiting).`
    : `Meaning search on: ${s.status.embedded} passages indexed.`;
  return (
    <View style={[styles.banner, styles.column, { backgroundColor: c.bubble }]} accessibilityLiveRegion="polite">
      <Text style={{ color: c.text }}>{line}</Text>
      {s.error ? <Text style={{ color: c.stop }}>{s.error}</Text> : null}
      <View style={styles.row2}>
        {!s.installed && s.downloading === null && (
          <Pressable accessibilityRole="button" accessibilityLabel="Get meaning search" onPress={get}>
            <Text style={[styles.bold, { color: c.accent }]}>Get ({mb} MB)</Text>
          </Pressable>
        )}
        {s.installed && (
          <Pressable accessibilityRole="button" accessibilityLabel={s.enabled ? 'Turn meaning search off' : 'Turn meaning search on'}
            onPress={() => { semantic.setEnabled(!s.enabled).catch(() => undefined); }}>
            <Text style={[styles.bold, { color: c.accent }]}>{s.enabled ? 'Turn off' : 'Turn on'}</Text>
          </Pressable>
        )}
        {s.installed && s.enabled && !s.building && pending > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel="Build meaning index" onPress={() => semantic.startBuild()}>
            <Text style={[styles.bold, { color: c.accent }]}>Build</Text>
          </Pressable>
        )}
        {s.building && (
          <Pressable accessibilityRole="button" accessibilityLabel="Stop building meaning index" onPress={() => semantic.stopBuild()}>
            <Text style={[styles.bold, { color: c.stop }]}>Stop</Text>
          </Pressable>
        )}
        {s.installed && !s.building && (
          <Pressable accessibilityRole="button" accessibilityLabel="Remove meaning search" onPress={() => Alert.alert('Remove meaning search?',
            `The ${mb} MB model and its index are deleted. Documents and keyword search stay.`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Remove', style: 'destructive', onPress: () => { semantic.remove().catch(() => undefined); } }])}>
            <Text style={[styles.bold, { color: c.stop }]}>Remove</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function KnowledgeScreen({ colors: c, select, scope, focused, onBack, onOpenDocument, onUseScope }: Props) {
  const [docs, setDocs] = useState<store.Doc[] | null>(null);
  const [engine, setEngine] = useState<store.FtsEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ query: string; terms: string[]; passages: Passage[]; mode: RetrievalMode } | null>(null);
  const [sem, setSem] = useState<semantic.SemanticState | null>(null);
  useEffect(() => {
    const refresh = () => { semantic.getState().then(setSem).catch(() => undefined); };
    refresh();
    return semantic.subscribe(refresh);
  }, []);
  const [searching, setSearching] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<indexer.ImportOutcome[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(scope ?? []));
  const [cols, setCols] = useState<collections.Collection[]>([]);
  const [colName, setColName] = useState('');
  const loadCollections = useCallback(() => { collections.listCollections().then(setCols).catch(() => undefined); }, []);
  useEffect(() => { if (select && focused) loadCollections(); }, [select, focused, loadCollections]);
  async function saveCollection() {
    try {
      await collections.saveCollection(colName, [...selected]);
      setColName('');
      loadCollections();
    } catch (e: any) { Alert.alert('Collection not saved', String(e?.message ?? e)); }
  }
  const importing = useRef(false);
  const searchSeq = useRef(0); // only the latest search may show its results

  const load = useCallback(async () => {
    try {
      setEngine(await store.ensureIndex());
      setDocs(await store.listDocuments());
      setError(null);
    } catch (e: any) {
      setDocs([]);
      setError(`Couldn't read the document library (${e?.message ?? e}).`);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  // Back from a document: it may have been removed or retried there, so the list (and any search) is read again.
  const wasFocused = useRef(focused);
  useEffect(() => {
    if (focused && !wasFocused.current) {
      setOutcomes([]);
      load().then(() => { if (query.trim()) runSearch(query); });
    }
    wasFocused.current = focused;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused]);

  const runSearch = useCallback(async (q: string) => {
    const seq = ++searchSeq.current;
    if (!q.trim()) { setResults(null); setSearching(false); return; }
    setSearching(true);
    try {
      const r = await retrievePassages(q, { limit: 30, embedder: await semantic.activeEmbedder() });
      if (seq === searchSeq.current) setResults({ query: q, terms: r.terms, passages: r.passages, mode: r.mode });
    } catch (e: any) {
      if (seq === searchSeq.current) setError(`Search failed (${e?.message ?? e}).`);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);
  // Search as the user types, after a short pause.
  useEffect(() => {
    const t = setTimeout(() => { runSearch(query); }, 300);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  async function importDocuments() {
    if (importing.current) return;
    importing.current = true;
    setOutcomes([]);
    try {
      const files = await pickFiles();
      if (files.length) {
        const out = await indexer.importFiles(files, (i, n, name) => setProgress(`Importing ${i + 1} of ${n}: ${name}`));
        setOutcomes(out);
        semantic.startBuild(); // new passages get meaning vectors in the background (if meaning search is on)
      }
    } catch (e: any) {
      setError(`Couldn't open the file picker (${e?.message ?? e}).`);
    } finally {
      importing.current = false;
      setProgress(null);
      await load();
      if (query.trim()) runSearch(query);
    }
  }

  const ready = (docs ?? []).filter(d => d.status === 'ready');
  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const header = (
    <View style={[styles.header, { borderColor: c.border }]}>
      <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back to chat" onPress={onBack}>
        <Text style={{ color: c.text }}>‹ Chat</Text>
      </Pressable>
      <View style={styles.flex}>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">{select ? 'Choose documents' : 'Documents'}</Text>
        {engine && <Text style={[styles.small, { color: c.muted }]}>{searchLabel(engine, sem)}</Text>}
      </View>
      {!select && (
        <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Import documents"
          onPress={importDocuments} disabled={!!progress}>
          <Text style={{ color: c.accent }}>Import</Text>
        </Pressable>
      )}
    </View>
  );

  if (select) {
    return (
      <View style={[styles.flex, { backgroundColor: c.bg }]}>
        {header}
        {cols.length > 0 && (
          <View style={styles.collections}>
            {cols.map(col => (
              <View key={col.id} style={[styles.chip, styles.colChip, { borderColor: c.border }]}>
                <Pressable accessibilityRole="button" accessibilityLabel={`Select collection ${col.name}`}
                  onPress={() => setSelected(new Set(col.documentIds))}>
                  <Text style={{ color: c.text }}>📁 {col.name} ({col.documentIds.length})</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`Delete collection ${col.name}`}
                  onPress={() => Alert.alert(`Delete "${col.name}"?`, 'Only the collection is deleted; its documents stay in the library.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => { collections.deleteCollection(col.id).then(loadCollections).catch(() => undefined); } },
                  ])}>
                  <Text style={{ color: c.muted }}>  ✕</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <FlatList
          style={styles.flex}
          data={ready}
          keyExtractor={d => d.id}
          ListEmptyComponent={<Text style={[styles.empty, { color: c.muted }]}>No ready documents yet. Import some first.</Text>}
          renderItem={({ item }) => (
            <Pressable style={[styles.row, { borderColor: c.border }]} accessibilityRole="checkbox"
              accessibilityState={{ checked: selected.has(item.id) }} accessibilityLabel={`Select ${item.name}`}
              onPress={() => toggle(item.id)}>
              <Text style={[styles.check, { color: c.accent }]}>{selected.has(item.id) ? '☑' : '☐'}</Text>
              <Text style={[styles.flex, { color: c.text }]} numberOfLines={1}>{item.name}</Text>
            </Pressable>
          )}
        />
        <View style={[styles.footer, { borderColor: c.border }]}>
          <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Use all documents"
            onPress={() => onUseScope(null)}>
            <Text style={{ color: c.text }}>All documents</Text>
          </Pressable>
          <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Use selected documents"
            disabled={selected.size === 0} onPress={() => onUseScope([...selected])}>
            <Text style={{ color: selected.size ? c.accent : c.muted }}>Use selected ({selected.size})</Text>
          </Pressable>
        </View>
        {selected.size > 0 && (
          <View style={[styles.footer, { borderColor: c.border }]}>
            <TextInput style={[styles.colInput, { color: c.text, borderColor: c.border }]} value={colName} onChangeText={setColName} maxLength={40}
              placeholder="Collection name" placeholderTextColor={c.muted} accessibilityLabel="Collection name" />
            <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Save selection as collection"
              disabled={!colName.trim()} onPress={saveCollection}>
              <Text style={{ color: colName.trim() ? c.text : c.muted }}>Save as collection</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      {header}
      <TextInput
        style={[styles.search, { color: c.text, borderColor: c.border }]}
        value={query}
        onChangeText={setQuery}
        placeholder="Search your documents"
        placeholderTextColor={c.muted}
        accessibilityLabel="Search documents"
        returnKeyType="search"
        onSubmitEditing={() => runSearch(query)}
      />
      {!select && sem && <MeaningPanel colors={c} state={sem} />}
      {!select && <OcrPanel colors={c} />}
      {progress && (
        <View style={styles.banner} accessibilityLiveRegion="polite">
          <ActivityIndicator color={c.accent} />
          <Text style={{ color: c.text }}>{progress}</Text>
        </View>
      )}
      {outcomes.length > 0 && (
        <View style={[styles.banner, styles.column, { backgroundColor: c.bubble }]} accessibilityLiveRegion="polite">
          {outcomes.map((o, i) => (
            <Text key={i} style={{ color: c.text }}>{o.status === 'indexed' || o.status === 'unchanged' ? '✓' : '⚠'} {o.name}: {o.message}</Text>
          ))}
        </View>
      )}
      {error && (
        <View style={[styles.banner, { backgroundColor: c.errorBg }]}>
          <Text style={[styles.flex, { color: c.text }]}>{error}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry reading documents" onPress={load}>
            <Text style={[styles.bold, { color: c.accent }]}>Retry</Text>
          </Pressable>
        </View>
      )}
      {query.trim() ? (
        <FlatList
          style={styles.flex}
          data={results?.passages ?? []}
          keyExtractor={p => String(p.chunkId)}
          ListHeaderComponent={searching ? <ActivityIndicator style={styles.empty} color={c.accent} /> : undefined}
          ListEmptyComponent={!searching && results ? (
            <Text style={[styles.empty, { color: c.muted }]}>
              {engine === 'none' ? ENGINE_TEXT.none : `No passages match "${results.query}".`}
            </Text>
          ) : undefined}
          renderItem={({ item }) => (
            <Pressable style={[styles.result, { borderColor: c.border }]} accessibilityRole="button"
              accessibilityLabel={`Open passage ${sourceLabel(item)}`} onPress={() => onOpenDocument(item.documentId, item.ordinal)}>
              <Text style={[styles.bold, { color: c.text }]} numberOfLines={1}>{sourceLabel(item)}</Text>
              <Highlighted text={item.excerpt} terms={results?.terms ?? []} color={c.muted} />
            </Pressable>
          )}
        />
      ) : (
        <FlatList
          style={styles.flex}
          data={docs ?? []}
          keyExtractor={d => d.id}
          ListHeaderComponent={ready.length > 0 ? (
            <Pressable style={[styles.ask, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Ask all documents"
              onPress={() => onUseScope(null)}>
              <Text style={{ color: c.accent }}>Ask questions about all {ready.length} document{ready.length === 1 ? '' : 's'} in chat</Text>
            </Pressable>
          ) : undefined}
          ListEmptyComponent={docs && !error ? (
            <Text style={[styles.empty, { color: c.muted }]}>
              No documents yet. Tap Import to add TXT, Markdown, PDF, CSV, Word (.docx), Excel (.xlsx) files or photos of text. They stay on this phone.
            </Text>
          ) : undefined}
          renderItem={({ item }) => (
            <Pressable style={[styles.result, { borderColor: c.border }]} accessibilityRole="button"
              accessibilityLabel={`Open document ${item.name}`} onPress={() => onOpenDocument(item.id)}>
              <Text style={[styles.bold, { color: c.text }]} numberOfLines={1}>{item.name}</Text>
              <Text style={{ color: item.status === 'failed' ? c.stop : c.muted }} numberOfLines={2}>
                {item.format.toUpperCase()} · {STATUS_TEXT[item.status]}
                {item.status === 'ready' ? ` · ${item.chunk_count} passage${item.chunk_count === 1 ? '' : 's'}` : ''}
                {' · '}{formatWhen(item.updated_at)}
                {item.status === 'failed' && item.error ? `\n${item.error}` : ''}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  column: { flexDirection: 'column', alignItems: 'flex-start' },
  row2: { flexDirection: 'row', gap: 16, marginTop: 4 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: '600' },
  small: { fontSize: 12 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  search: { margin: 12, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 12, marginBottom: 8, padding: 10, borderRadius: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1 },
  check: { fontSize: 20 },
  result: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, gap: 4 },
  ask: { margin: 12, borderWidth: 1, borderRadius: 12, padding: 12 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', padding: 12, borderTopWidth: 1 },
  empty: { padding: 24, textAlign: 'center' },
  bold: { fontWeight: '600' },
  collections: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingTop: 10 },
  colChip: { flexDirection: 'row', alignItems: 'center' },
  colInput: { flex: 1, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
});
