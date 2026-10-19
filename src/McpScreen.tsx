/**
 * Connections (M14): remote MCP servers the user adds. Tools start switched off; a switched-on tool runs only after
 * the user confirms the exact call (server, tool, arguments). Results are shown here and can be put into the chat.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { styles } from './CodeScreen';
import * as mcp from './mcp';
import type { Colors } from './theme';

type Props = { colors: Colors; onBack: () => void; onUseText: (text: string) => void };

export function McpScreen({ colors: c, onBack, onUseText }: Props) {
  const [servers, setServers] = useState<mcp.McpServer[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ title: string; text: string } | null>(null);
  const refresh = useCallback(() => { mcp.listServers().then(setServers).catch(() => undefined); }, []);
  useEffect(refresh, [refresh]);

  async function add(target = url) {
    setBusy(true);
    try { await mcp.addServer(target); setUrl(''); } catch (e: any) { Alert.alert('Not added', String(e?.message ?? e)); }
    setBusy(false);
    refresh();
  }

  function run(s: mcp.McpServer, t: mcp.McpTool) {
    const key = `${s.url} ${t.name}`;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(args[key]?.trim() || '{}'); } catch { Alert.alert('Arguments', 'Arguments must be JSON, e.g. {"city": "Pune"}.'); return; }
    Alert.alert(`Send to ${s.name}?`, `Tool: ${t.name}\nServer: ${s.url}\nArguments: ${JSON.stringify(parsed)}\n\nOnly these arguments are sent.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send', onPress: async () => {
        setBusy(true);
        try { setResult({ title: `${s.name} · ${t.name}`, text: await mcp.callTool(s.url, t.name, parsed) }); } catch (e: any) {
          setResult({ title: `${s.name} · ${t.name}`, text: String(e?.message ?? e) });
        }
        setBusy(false);
      } },
    ]);
  }

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">Connections (MCP)</Text>
      </View>
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <Text style={{ color: c.muted }}>Optional. Add an MCP server you trust by its https address. Its tools start switched off, and
          every call asks you first. Nothing else leaves this phone.</Text>
        <View style={styles.row}>
          <TextInput style={[styles.input, styles.flex, { borderColor: c.border, color: c.text }]} value={url} onChangeText={setUrl}
            placeholder="https://example.com/mcp" placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false}
            accessibilityLabel="MCP server address" />
          <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Add server"
            disabled={busy || !url.trim()} onPress={() => add()}>
            <Text style={{ color: c.accent }}>{busy ? '…' : 'Add'}</Text>
          </Pressable>
        </View>
        {mcp.PRESETS.some(p => !servers.some(s => s.url === p.url)) && (
          <View style={{ gap: 6 }}>
            <Text style={[styles.bold, { color: c.text }]}>Suggested (public, no sign-in)</Text>
            {mcp.PRESETS.filter(p => !servers.some(s => s.url === p.url)).map(p => (
              <Pressable key={p.url} style={[styles.card, styles.row, { backgroundColor: c.bubble }]} accessibilityRole="button"
                accessibilityLabel={`Add ${p.name}`} disabled={busy} onPress={() => add(p.url)}>
                <View style={styles.flex}>
                  <Text style={[styles.bold, { color: c.text }]}>{p.name}</Text>
                  <Text style={[styles.small, { color: c.muted }]}>{p.about}</Text>
                </View>
                <Text style={{ color: c.accent }}>＋ Add</Text>
              </Pressable>
            ))}
          </View>
        )}
        {result && (
          <View style={[styles.card, { backgroundColor: c.bubble }]}>
            <Text style={[styles.bold, { color: c.text }]}>{result.title}</Text>
            <Text style={{ color: c.text }} selectable>{result.text}</Text>
            <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Use result in chat"
              onPress={() => onUseText(result.text)}>
              <Text style={{ color: c.accent }}>Use in chat</Text>
            </Pressable>
          </View>
        )}
        {servers.map(s => (
          <View key={s.url} style={[styles.card, { backgroundColor: c.bubble }]}>
            <View style={styles.row}>
              <Text style={[styles.bold, styles.flex, { color: c.text }]}>{s.name}</Text>
              <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Remove ${s.name}`}
                onPress={() => { mcp.removeServer(s.url).then(refresh); }}>
                <Text style={{ color: c.text }}>Remove</Text>
              </Pressable>
            </View>
            <Text style={[styles.small, { color: c.muted }]}>{s.url}</Text>
            {s.tools.length === 0 && <Text style={{ color: c.muted }}>This server offers no tools.</Text>}
            {s.tools.map(t => (
              <View key={t.name} style={{ gap: 4 }}>
                <View style={styles.row}>
                  <Pressable style={[styles.chip, { borderColor: t.enabled ? c.accent : c.border }]} accessibilityRole="switch"
                    accessibilityState={{ checked: t.enabled }} accessibilityLabel={`Allow ${t.name}`}
                    onPress={() => { mcp.setToolEnabled(s.url, t.name, !t.enabled).then(refresh); }}>
                    <Text style={{ color: t.enabled ? c.accent : c.text }}>{t.enabled ? `✓ ${t.name}` : `${t.name} (off)`}</Text>
                  </Pressable>
                </View>
                {!!t.description && <Text style={[styles.small, { color: c.muted }]}>{t.description}</Text>}
                {t.enabled && (
                  <View style={styles.row}>
                    <TextInput style={[styles.input, styles.flex, { borderColor: c.border, color: c.text }]} value={args[`${s.url} ${t.name}`] ?? ''}
                      onChangeText={v => setArgs(a => ({ ...a, [`${s.url} ${t.name}`]: v }))} placeholder='{"arg": "value"}'
                      placeholderTextColor={c.muted} autoCapitalize="none" autoCorrect={false} accessibilityLabel={`Arguments for ${t.name}`} />
                    <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel={`Run ${t.name}`}
                      disabled={busy} onPress={() => run(s, t)}>
                      <Text style={{ color: c.accent }}>Run</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
