/**
 * Privacy and data (M8): one place for backup and restore, storage usage, cleanup, proposal retention, the database
 * check, and plain explanations of what stays on the phone. Deleting chats, documents and workspaces opens the
 * existing screens (their own delete flows), so there is one implementation of each deletion.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { styles } from './CodeScreen';
import { dismissRestore, listRestores, type JournalEntry } from './backup/restore';
import { CATEGORIES } from './backup/categories';
import * as storage from './storage';
import type { Colors } from './theme';

const MB = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 2 : 0)} MB`;

export const PRIVACY_POINTS = [
  'Chats, documents, coding tasks and models stay in this app\'s private storage on the phone. Android\'s cloud backup and device-to-device transfer are switched off for this app.',
  'The internet is used only to download a model you confirmed (verified by its SHA-256 before use). Answers, documents, code and backups are never uploaded by the app.',
  'Encrypted backups include only the categories you choose, encrypted with your password. Lose the password and the backup can\'t be opened.',
  'Restores never overwrite current data unless you choose Replace and confirm it; conflicts keep what is on the phone unless you choose to add a copy.',
  'Deleting removes the data from the app\'s database and files. It is not a secure erase: the storage chip may keep traces until reused. Android\'s own device encryption protects data at rest while the phone is locked.',
  'Anyone who can use your unlocked phone can open the app and see its data. Code proposals may contain secrets from your source files; delete them when you no longer need them.',
];

export function DataScreen({ colors: c, focused, onBack, onBackup, onHistory, onDocuments, onCode }: {
  colors: Colors; focused: boolean; onBack: () => void; onBackup: () => void; onHistory: () => void; onDocuments: () => void; onCode: () => void;
}) {
  const [report, setReport] = useState<storage.Report | null>(null);
  const [restores, setRestores] = useState<JournalEntry[]>([]);
  const [retention, setRetention] = useState<storage.Retention>('off');
  const [check, setCheck] = useState<Awaited<ReturnType<typeof storage.checkDatabase>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await storage.storageReport());
      setRestores(await listRestores(5));
      setRetention(await storage.getProposalRetention());
    } catch (e: any) { setNote(`Could not read storage: ${String(e?.message ?? e)}`); }
  }, []);
  useEffect(() => { if (focused) load(); }, [focused, load]);

  function action(title: string, explain: string, work: () => Promise<string>) {
    Alert.alert(title, explain, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Continue', onPress: async () => {
        setBusy(true);
        try { setNote(await work()); } catch (e: any) { setNote(String(e?.message ?? e)); } finally { setBusy(false); await load(); }
      } },
    ]);
  }

  const link = (label: string, onPress: () => void) => (
    <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={busy}>
      <Text style={{ color: c.text }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">Privacy and data</Text>
      </View>
      <ScrollView contentContainerStyle={styles.pad}>
        <Pressable style={[styles.chip, styles.self, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Backup and restore" onPress={onBackup} disabled={busy}>
          <Text style={{ color: c.accent }}>Backup and restore…</Text>
        </Pressable>
        {restores.filter(r => r.status !== 'done').map(r => (
          <View key={r.id} style={[styles.card, { backgroundColor: c.errorBg }]}>
            <Text style={{ color: c.text }}>Restore of {new Date(r.createdAt).toISOString().slice(0, 16).replace('T', ' ')}: {r.status}.{' '}
              {Object.entries(r.progress).map(([k, v]) => `${CATEGORIES.find(x => x.id === k)?.label ?? k}: ${v}`).join(', ') || 'No category finished.'}</Text>
            {r.error && <Text style={[styles.small, { color: c.text }]}>{r.error}</Text>}
            <Text style={[styles.small, { color: c.muted }]}>Categories not marked done were not changed. To finish, restore them again with Merge (already restored records are skipped).</Text>
            <Pressable style={styles.self} accessibilityRole="button" accessibilityLabel="Dismiss restore notice" onPress={() => dismissRestore(r.id).then(load)}>
              <Text style={{ color: c.accent }}>Dismiss</Text>
            </Pressable>
          </View>
        ))}

        <Text style={[styles.bold, { color: c.text }]}>Storage</Text>
        {report && (
          <View style={styles.pad0}>
            <Text style={{ color: c.text }}>Phone: {MB(report.device.free)} free of {MB(report.device.total)}. App database: {MB(report.databaseBytes)} (measured).</Text>
            {report.items.map(i => (
              <Text key={i.id} style={[styles.small, { color: c.text }]}>{i.label}: {i.records} · ≈ {MB(i.chars)} of text (estimate){i.note ? ` — ${i.note}` : ''}</Text>
            ))}
            {report.models.map(m => (
              <Text key={m.name} style={[styles.small, { color: c.text }]}>Model file {m.name}: {MB(m.bytes)}{m.kind === 'incomplete' ? (report.downloading ? ' (downloading now)' : ' (incomplete download)') : ''}</Text>
            ))}
            <Text style={[styles.small, { color: c.text }]}>Temporary backup files: {report.temp.files} ({MB(report.temp.bytes)})</Text>
          </View>
        )}

        <Text style={[styles.bold, { color: c.text }]}>Clean up</Text>
        <View style={styles.row}>
          {link('Remove meaning-search vectors', () => action('Remove meaning-search vectors?', 'Removes the vectors used by meaning search. Documents and keyword search are not affected. If meaning search is on, the vectors are rebuilt in the background (this takes time and battery).',
            async () => `Removed ${await storage.removeVectors()} vectors.`))}
          {link('Rebuild keyword index', () => action('Rebuild the keyword index?', 'Re-creates the search index from the stored document text. Nothing is lost.',
            async () => ((await storage.rebuildKeywordIndex()) ? 'Keyword index rebuilt.' : 'This phone has no full-text search engine.')))}
          {link('Remove temporary files', () => action('Remove temporary files?', 'Removes leftover backup and restore files from the app\'s cache. Files in use are kept. Your saved backups are elsewhere and not touched.',
            async () => { const r = await storage.removeTempFiles(); return `Removed ${r.files} file(s), ${MB(r.bytes)}.`; }))}
          {link('Remove incomplete downloads', () => action('Remove incomplete model downloads?', 'Removes partly downloaded model files. Verified models are kept. Not possible while a download is running.',
            async () => `Removed ${await storage.removeIncompleteDownloads()} file(s).`))}
          {link('Delete finished proposals', () => action('Delete finished code proposals?', 'Deletes applied, failed, stale, rejected and interrupted proposals with their saved original and proposed file texts (so "Restore original" is no longer possible for them). Proposals waiting for review are kept. Project files are not touched. This can\'t be undone.',
            async () => `Deleted ${await storage.deleteFinishedProposals()} proposal(s).`))}
          {link('Delete coding tasks', () => action('Delete all coding tasks?', 'Deletes the questions and answers of every coding task. Workspaces, proposals and project files stay. This can\'t be undone.',
            async () => `Deleted ${await storage.deleteAllCodingHistory()} task(s).`))}
        </View>
        <Text style={[styles.small, { color: c.muted }]}>Delete individual chats, documents or workspaces from their own screens:</Text>
        <View style={styles.row}>
          {link('Chats', onHistory)}
          {link('Documents', onDocuments)}
          {link('Code workspaces', onCode)}
        </View>

        <Text style={[styles.bold, { color: c.text }]}>Keep finished code proposals</Text>
        <View style={styles.row}>
          {(['off', '30', '7'] as const).map(r => (
            <Pressable key={r} style={[styles.chip, { borderColor: retention === r ? c.accent : c.border }]} accessibilityRole="radio" accessibilityState={{ selected: retention === r }}
              accessibilityLabel={`Keep proposals ${r === 'off' ? 'until deleted' : `${r} days`}`} onPress={() => storage.setProposalRetention(r).then(() => setRetention(r))}>
              <Text style={{ color: retention === r ? c.accent : c.text }}>{r === 'off' ? 'Until I delete them' : `${r} days`}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.small, { color: c.muted }]}>With a limit, finished proposals older than it are deleted when the app starts. Proposals waiting for review are never deleted automatically.</Text>

        <Text style={[styles.bold, { color: c.text }]}>Database check</Text>
        <Pressable style={[styles.chip, styles.self, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Check database" disabled={busy}
          onPress={() => { setBusy(true); storage.checkDatabase().then(setCheck).catch(e => setNote(String(e?.message ?? e))).finally(() => setBusy(false)); }}>
          <Text style={{ color: c.text }}>Check</Text>
        </Pressable>
        {check && (
          <View style={styles.pad0}>
            <Text style={{ color: check.sqlite === 'ok' ? c.text : c.stop }}>SQLite: {check.sqlite === 'ok' ? 'no problems found' : check.sqlite}</Text>
            {check.sqlite !== 'ok' && <Text style={[styles.small, { color: c.text }]}>Nothing was changed. Make an encrypted backup of what you need before anything else.</Text>}
            {check.orphans.map(o => <Text key={o.label} style={[styles.small, { color: c.text }]}>{o.count} {o.label}</Text>)}
            {check.orphans.length > 0 && link('Remove unreachable records', () => action('Remove unreachable records?', 'Removes records that point at something that no longer exists (they can\'t be opened in the app).',
              async () => { const n = await storage.removeOrphans(); setCheck(null); return `Removed ${n} record(s).`; }))}
            {check.sqlite === 'ok' && !check.orphans.length && <Text style={[styles.small, { color: c.muted }]}>No unreachable records.</Text>}
          </View>
        )}

        <Text style={[styles.bold, { color: c.text }]}>What stays on this phone</Text>
        {PRIVACY_POINTS.map(p => <Text key={p} style={[styles.small, { color: c.text }]}>• {p}</Text>)}
        {note && <Text style={{ color: c.text }} accessibilityLiveRegion="polite">{note}</Text>}
      </ScrollView>
    </View>
  );
}
