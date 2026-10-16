/**
 * One workspace file as read-only text with line numbers (bounded by the file-size limit, secrets redacted as the
 * model would see them), scrolled to a referenced line.
 */
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { styles } from './CodeScreen';
import * as store from './code/workspaceStore';
import type { Colors } from './theme';

export function CodeFileScreen({ workspaceId, path, line, colors: c, onBack }: {
  workspaceId: string; path: string; line?: number; colors: Colors; onBack: () => void;
}) {
  const [file, setFile] = useState<store.SourceFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<string>>(null);

  useEffect(() => {
    (async () => {
      const ws = await store.getWorkspace(workspaceId);
      if (!ws) throw new Error('This workspace was removed.');
      setFile(await store.readFile(ws, path));
    })().catch(e => setError(store.explain(e)));
  }, [workspaceId, path]);

  const lines = file?.text.split('\n') ?? [];
  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header" numberOfLines={1}>{path}</Text>
      </View>
      {error && <Text style={[styles.pad, { color: c.stop }]}>{error}</Text>}
      {file && (
        <Text style={[styles.small, styles.pad, { color: c.muted }]}>
          {file.language} · {lines.length} lines · {Math.round(file.bytes / 100) / 10} KB{file.lossy ? ' · not valid UTF-8 (shown with replacement characters)' : ''}
          {file.redactions ? ` · ${file.redactions} value(s) that look like secrets are hidden («redacted»); detection is a best-effort pattern match` : ''}
        </Text>
      )}
      <FlatList
        ref={listRef}
        data={lines}
        keyExtractor={(_l, i) => String(i)}
        initialNumToRender={Math.max(40, (line ?? 0) + 20)}
        onLayout={() => { if (line && line > 1 && line <= lines.length) listRef.current?.scrollToIndex({ index: line - 1, viewPosition: 0.3, animated: false }); }}
        onScrollToIndexFailed={() => undefined}
        renderItem={({ item, index }) => (
          <Text selectable style={[styles.mono, { color: c.text, backgroundColor: index + 1 === line ? c.bubble : undefined, paddingHorizontal: 8 }]}>
            {String(index + 1).padStart(4, ' ')}  {item}
          </Text>
        )}
      />
    </View>
  );
}
