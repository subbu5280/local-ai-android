/**
 * First-run welcome: three short pages (privacy, what you can do, get the model), shown once. "Get the model" only
 * opens the normal download confirmation; nothing downloads from here directly. Seen state is kept in the meta table.
 */
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as chat from './chatStore';
import type { Colors } from './theme';

const SEEN_KEY = 'welcome_seen';

export async function welcomeSeen(): Promise<boolean> {
  return !!(await chat.db().query('SELECT value FROM meta WHERE key = ?', [SEEN_KEY]))[0];
}
async function markSeen() {
  await chat.db().execute('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [SEEN_KEY, '1']);
}

const PAGES = [
  { icon: '🔒', title: 'Your AI, on your phone',
    lines: ['Answers come from a model running on this phone. What you type, import or say is not uploaded.',
      'The internet is used only when you ask for it: model downloads you confirm, weather, news and prices, and servers you connect.'] },
  { icon: '✨', title: 'What you can do',
    lines: ['💬  Chat in English, తెలుగు, हिन्दी, தமிழ், ಕನ್ನಡ, മലയാളം', '📄  Ask questions about your PDFs, Word and Excel files, even scans',
      '🤖  Run agents that use checked tools', '⌨️  Review and improve code', '🎮  Play games, set reminders, talk by voice'] },
  { icon: '⬇️', title: 'One download to start',
    lines: ['The chat model is 1.1 GB and downloads once. Wi-Fi is best.', 'After that, chat works with no connection at all.'] },
];

export function WelcomeScreen({ colors: c, needsModel, onDone }: { colors: Colors; needsModel: boolean; onDone: (getModel: boolean) => void }) {
  const [page, setPage] = useState(0);
  const p = PAGES[page];
  const last = page === PAGES.length - 1;
  const finish = (getModel: boolean) => { markSeen().catch(() => undefined); onDone(getModel); };
  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <Pressable style={styles.skip} accessibilityRole="button" accessibilityLabel="Skip welcome" onPress={() => finish(false)}>
        <Text style={{ color: c.muted }}>Skip</Text>
      </Pressable>
      <View style={styles.body}>
        <Text style={styles.icon}>{p.icon}</Text>
        <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">{p.title}</Text>
        {p.lines.map(l => <Text key={l} style={[styles.line, { color: c.muted }]}>{l}</Text>)}
      </View>
      <View style={styles.dots}>
        {PAGES.map((_, i) => <View key={i} style={[styles.dot, { backgroundColor: i === page ? c.accent : c.border }]} />)}
      </View>
      {last && needsModel ? (
        <View style={styles.actions}>
          <Pressable style={[styles.primary, { backgroundColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Get the model" onPress={() => finish(true)}>
            <Text style={[styles.primaryText, { color: c.onAccent }]}>Get the model</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Later" onPress={() => finish(false)}>
            <Text style={[styles.secondary, { color: c.muted }]}>Later</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.actions}>
          <Pressable style={[styles.primary, { backgroundColor: c.accent }]} accessibilityRole="button" accessibilityLabel={last ? 'Start' : 'Next'}
            onPress={() => (last ? finish(false) : setPage(page + 1))}>
            <Text style={[styles.primaryText, { color: c.onAccent }]}>{last ? 'Start' : 'Next'}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, padding: 28, justifyContent: 'center', zIndex: 10 },
  skip: { position: 'absolute', top: 48, right: 24, padding: 8 },
  body: { gap: 14 },
  icon: { fontSize: 56 },
  title: { fontSize: 30, fontWeight: '800', letterSpacing: -0.5 },
  line: { fontSize: 17, lineHeight: 25 },
  dots: { flexDirection: 'row', gap: 8, marginTop: 36 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  actions: { marginTop: 28, gap: 14, alignItems: 'flex-start' },
  primary: { borderRadius: 24, paddingHorizontal: 28, paddingVertical: 14 },
  primaryText: { fontSize: 17, fontWeight: '700' },
  secondary: { fontSize: 16, paddingHorizontal: 8 },
});
