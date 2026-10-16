/**
 * Encrypted backup and restore (M8). Backup: choose categories (with what each holds and what is never included),
 * see an estimate, set a password twice, create — the app writes, verifies and then asks where to save the file.
 * Restore: pick a backup, enter its password, see what it holds compared with this phone (new, duplicate, conflict,
 * invalid), choose categories and merge or replace, confirm replacements, and read the result per category.
 * Passwords live only in this screen's state while typed and are cleared after use.
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { styles } from './CodeScreen';
import { checkPassword, createBackup, estimate, saveBackup, withRequirements } from './backup/backup';
import { CATEGORIES, EXCLUDED, type CategoryId } from './backup/categories';
import { BackupError } from './backup/format';
import { applyRestore, closePlan, inspect, pickBackup, type Choice, type Plan, type Summary } from './backup/restore';
import * as semantic from './knowledge/semantic';
import type { Colors } from './theme';

const COPYABLE: CategoryId[] = ['chats', 'agents', 'skills'];
const message = (e: unknown) => (e instanceof BackupError ? e.message : `Failed: ${String((e as any)?.message ?? e)}`);

export function BackupScreen({ colors: c, onBack }: { colors: Colors; onBack: () => void }) {
  const [tab, setTab] = useState<'backup' | 'restore'>('backup');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const signal = useRef({ cancelled: false });

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} disabled={!!busy}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">Backup and restore</Text>
      </View>
      <View style={[styles.row, styles.pad]}>
        {(['backup', 'restore'] as const).map(t => (
          <Pressable key={t} style={[styles.chip, { borderColor: tab === t ? c.accent : c.border }]} accessibilityRole="tab" accessibilityState={{ selected: tab === t }}
            accessibilityLabel={t === 'backup' ? 'Back up tab' : 'Restore tab'} disabled={!!busy} onPress={() => { setTab(t); setNote(null); }}>
            <Text style={{ color: tab === t ? c.accent : c.text }}>{t === 'backup' ? 'Back up' : 'Restore'}</Text>
          </Pressable>
        ))}
        {busy && (
          <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => { signal.current.cancelled = true; }}>
            <Text style={{ color: c.stop }}>Cancel</Text>
          </Pressable>
        )}
      </View>
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        {tab === 'backup' ? <BackupPart c={c} busy={busy} setBusy={setBusy} setNote={setNote} signal={signal} />
          : <RestorePart c={c} busy={busy} setBusy={setBusy} setNote={setNote} signal={signal} />}
        {busy && <Text style={{ color: c.muted }} accessibilityLiveRegion="polite">{busy}</Text>}
        {note && <Text style={{ color: c.text }} selectable accessibilityLiveRegion="polite">{note}</Text>}
      </ScrollView>
    </View>
  );
}

type PartProps = { c: Colors; busy: string | null; setBusy: (s: string | null) => void; setNote: (s: string | null) => void; signal: { current: { cancelled: boolean } } };

function BackupPart({ c, busy, setBusy, setNote, signal }: PartProps) {
  const [selected, setSelected] = useState<CategoryId[]>(CATEGORIES.filter(x => x.defaultOn).map(x => x.id));
  const [est, setEst] = useState<{ categories: { id: CategoryId; records: number }[]; bytes: number } | null>(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  useEffect(() => { estimate(selected).then(setEst).catch(() => setEst(null)); }, [selected]);
  const effective = withRequirements(selected);
  const problems = pw || pw2 ? checkPassword(pw, pw2) : [];

  async function create() {
    signal.current = { cancelled: false };
    setNote(null);
    setBusy('Starting…');
    try {
      const b = await createBackup(selected, pw, pw2, { signal: signal.current, onProgress: setBusy });
      setBusy('Choose where to save the backup…');
      const saved = await saveBackup(b.path);
      setNote(saved ? `Saved "${saved.name}" (${(saved.size / 1e6).toFixed(2)} MB). It was checked after writing and after copying. ` +
        `Contains: ${b.manifest.categories.map(x => `${CATEGORIES.find(k => k.id === x.id)!.label} (${x.records})`).join(', ')}. Keep the password safe: without it the backup can't be opened.`
        : 'Not saved: you closed the save dialog. The backup was discarded.');
    } catch (e) {
      setNote(message(e));
    } finally {
      setPw(''); setPw2(''); // M9: cleared after every attempt, successful or not
      setBusy(null);
    }
  }

  return (
    <View style={styles.pad0}>
      <Text style={{ color: c.muted }}>The backup is encrypted with your password (AES-256-GCM, key from PBKDF2-HMAC-SHA256) on this phone and saved where you choose.
        Nothing is uploaded by the app. If you forget the password, the backup can't be restored by anyone, including you.</Text>
      {CATEGORIES.map(k => {
        const on = effective.includes(k.id);
        const forced = on && !selected.includes(k.id);
        return (
          <Pressable key={k.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`Back up ${k.label}`} disabled={!!busy || forced}
            onPress={() => setSelected(s => (s.includes(k.id) ? s.filter(x => x !== k.id) : [...s, k.id]))}>
            <Text style={{ color: c.text }}>{on ? '☑' : '☐'} <Text style={styles.bold}>{k.label}</Text>
              {est?.categories.find(x => x.id === k.id) ? ` · ${est.categories.find(x => x.id === k.id)!.records} records` : ''}{forced ? ' (needed by Document text)' : ''}</Text>
            <Text style={[styles.small, { color: c.muted }]}>{k.description}</Text>
            {k.sensitive && <Text style={[styles.small, { color: c.stop }]}>{k.sensitive}</Text>}
          </Pressable>
        );
      })}
      <Text style={[styles.bold, { color: c.text }]}>Never included</Text>
      {EXCLUDED.map(x => <Text key={x.what} style={[styles.small, { color: c.muted }]}>• {x.what}: {x.why}</Text>)}
      {est && <Text style={{ color: c.text }}>Estimated size: about {Math.max(0.01, est.bytes / 1e6).toFixed(2)} MB (an estimate from the stored text).</Text>}
      <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={pw} onChangeText={setPw} secureTextEntry autoCorrect={false} autoCapitalize="none"
        textContentType="newPassword" placeholder="Backup password (10+ characters)" placeholderTextColor={c.muted} accessibilityLabel="Backup password" editable={!busy} />
      <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={pw2} onChangeText={setPw2} secureTextEntry autoCorrect={false} autoCapitalize="none"
        textContentType="newPassword" placeholder="Repeat the password" placeholderTextColor={c.muted} accessibilityLabel="Repeat backup password" editable={!busy} />
      {problems.map(p => <Text key={p} style={{ color: c.stop }}>{p}</Text>)}
      <Pressable style={[styles.chip, styles.self, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Create backup"
        disabled={!!busy || !selected.length || !pw || problems.length > 0} onPress={create}>
        <Text style={{ color: !busy && selected.length && pw && !problems.length ? c.accent : c.muted }}>Create encrypted backup</Text>
      </Pressable>
    </View>
  );
}

function RestorePart({ c, busy, setBusy, setNote, signal }: PartProps) {
  const [path, setPath] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const planRef = useRef<{ plan: Plan | null; path: string | null }>({ plan: null, path: null });
  planRef.current = { plan, path };
  useEffect(() => () => { closePlan(planRef.current.plan, planRef.current.path ?? undefined).catch(() => undefined); }, []); // leaving: wipe key, delete copy

  async function pick() {
    setNote(null);
    setSummary(null);
    await closePlan(plan, path ?? undefined);
    setPlan(null);
    try { setPath(await pickBackup()); } catch (e) { setNote(message(e)); }
  }

  async function check() {
    if (!path) return;
    signal.current = { cancelled: false };
    setNote(null);
    setBusy('Checking…');
    try {
      const p = await inspect(path, pw, { signal: signal.current, onProgress: setBusy });
      setPlan(p);
      setChoices(p.categories.filter(x => x.inBackup && x.restorable && x.id !== 'codeProposals').map(x => ({ id: x.id, mode: 'merge', onConflict: 'keep' })));
    } catch (e) { setNote(message(e)); } finally {
      setPw(''); // M9: the password never stays in the screen's state after an attempt, right or wrong
      setBusy(null);
    }
  }

  const choice = (id: CategoryId) => choices.find(x => x.id === id);
  const update = (id: CategoryId, patch: Partial<Choice> | null) =>
    setChoices(cs => (patch === null ? cs.filter(x => x.id !== id) : choice(id) ? cs.map(x => (x.id === id ? { ...x, ...patch } : x)) : [...cs, { id, mode: 'merge', onConflict: 'keep', ...patch }]));

  async function run(confirmReplace: boolean) {
    if (!plan) return;
    signal.current = { cancelled: false };
    setBusy('Restoring…');
    try {
      const s = await applyRestore(plan, choices, { confirmReplace, signal: signal.current, onProgress: setBusy });
      setSummary(s);
      if (s.categories.some(x => x.id === 'documents' && x.status === 'done')) semantic.startBuild();
    } catch (e) { setNote(message(e)); } finally { setBusy(null); }
  }

  function confirm() {
    const replacing = choices.filter(x => x.mode === 'replace').map(x => plan!.categories.find(k => k.id === x.id)!.label);
    if (!replacing.length) { run(false); return; }
    Alert.alert('Replace data on this phone?', `ALL current ${replacing.join(', ')} on this phone will be deleted and replaced by the backup's. ` +
      'This can\'t be undone (make a backup first if you may need them). Other categories are merged.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Replace', style: 'destructive', onPress: () => { run(true); } },
    ]);
  }

  return (
    <View style={styles.pad0}>
      <Text style={{ color: c.muted }}>Nothing on this phone changes until you confirm. The whole backup is decrypted and checked first; a wrong password or
        a changed file stops here. Folder access, models and search indexes are not in backups.</Text>
      <Pressable style={[styles.chip, styles.self, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Choose backup file" disabled={!!busy} onPress={pick}>
        <Text style={{ color: c.accent }}>{path ? 'Choose another file' : 'Choose backup file'}</Text>
      </Pressable>
      {path && !plan && (
        <>
          <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={pw} onChangeText={setPw} secureTextEntry autoCorrect={false} autoCapitalize="none"
            textContentType="password" placeholder="Backup password" placeholderTextColor={c.muted} accessibilityLabel="Restore password" editable={!busy} />
          <Pressable style={[styles.chip, styles.self, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Check backup" disabled={!!busy || !pw} onPress={check}>
            <Text style={{ color: pw && !busy ? c.accent : c.muted }}>Check backup</Text>
          </Pressable>
        </>
      )}
      {plan && !summary && (
        <>
          <Text style={{ color: c.text }}>Backup from {new Date(plan.manifest.createdAt).toISOString().slice(0, 16).replace('T', ' ')}. Authenticated and checked.</Text>
          {plan.categories.filter(k => k.inBackup).map(k => {
            const ch = choice(k.id);
            const st = k.stats;
            return (
              <View key={k.id} style={[styles.card, { backgroundColor: c.bubble }]}>
                <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: !!ch, disabled: !k.restorable }} accessibilityLabel={`Restore ${k.label}`}
                  disabled={!k.restorable || !!busy} onPress={() => update(k.id, ch ? null : {})}>
                  <Text style={{ color: k.restorable ? c.text : c.muted }}>{ch ? '☑' : '☐'} <Text style={styles.bold}>{k.label}</Text> · {k.records} records</Text>
                </Pressable>
                {st && <Text style={[styles.small, { color: c.muted }]}>New {st.new} · already here {st.duplicate} · conflicts {st.conflict} · invalid {st.invalid}{st.skipped ? ` · skipped ${st.skipped}` : ''}</Text>}
                {k.sensitive && <Text style={[styles.small, { color: c.stop }]}>{k.sensitive}</Text>}
                {k.errors.map(e => <Text key={e} style={[styles.small, { color: c.stop }]}>{e}</Text>)}
                {k.notes.map(n => <Text key={n} style={[styles.small, { color: c.muted }]}>{n}</Text>)}
                {ch && (
                  <View style={styles.row}>
                    {(['merge', 'replace'] as const).filter(m => m === 'merge' || k.canReplace).map(m => (
                      <Pressable key={m} style={[styles.chip, { borderColor: ch.mode === m ? c.accent : c.border }]} accessibilityRole="radio" accessibilityState={{ selected: ch.mode === m }}
                        accessibilityLabel={`${k.label} ${m}`} onPress={() => update(k.id, { mode: m })}>
                        <Text style={{ color: ch.mode === m ? (m === 'replace' ? c.stop : c.accent) : c.text }}>{m === 'merge' ? 'Merge' : 'Replace'}</Text>
                      </Pressable>
                    ))}
                    {ch.mode === 'merge' && COPYABLE.includes(k.id) && !!st?.conflict && (['keep', 'copy'] as const).map(o => (
                      <Pressable key={o} style={[styles.chip, { borderColor: ch.onConflict === o ? c.accent : c.border }]} accessibilityRole="radio" accessibilityState={{ selected: ch.onConflict === o }}
                        accessibilityLabel={`${k.label} conflicts ${o}`} onPress={() => update(k.id, { onConflict: o })}>
                        <Text style={{ color: ch.onConflict === o ? c.accent : c.text }}>{o === 'keep' ? 'Keep current' : 'Add backup copy'}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
          <Text style={[styles.small, { color: c.muted }]}>Merge adds what is missing and never overwrites what is here; conflicts keep the current version unless you choose
            "Add backup copy". Replace deletes this category's current data first. Each category is restored as one unit.</Text>
          <Pressable style={[styles.chip, styles.self, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Restore selected" disabled={!!busy || !choices.length} onPress={confirm}>
            <Text style={{ color: choices.length && !busy ? c.accent : c.muted }}>Restore {choices.length} categor{choices.length === 1 ? 'y' : 'ies'}</Text>
          </Pressable>
        </>
      )}
      {summary && (
        <View style={[styles.card, { backgroundColor: c.bubble }]} accessibilityLiveRegion="polite">
          <Text style={[styles.bold, { color: summary.status === 'done' ? c.text : c.stop }]}>
            {summary.status === 'done' ? 'Restore finished.' : summary.status === 'partial' ? 'Restore finished only partly.' : 'Nothing was restored.'}</Text>
          {summary.categories.map(r => (
            <Text key={r.id} style={{ color: r.status === 'done' ? c.text : c.stop }} selectable>
              {CATEGORIES.find(k => k.id === r.id)!.label} ({r.mode}): {r.status === 'done' && r.stats ? `added ${r.stats.new + r.stats.copied}, already here ${r.stats.duplicate}, conflicts kept ${r.stats.conflict - r.stats.copied}, invalid ${r.stats.invalid}${r.stats.skipped ? `, skipped ${r.stats.skipped}` : ''}` : r.status === 'done' ? 'done' : r.error}
            </Text>
          ))}
          <Text style={[styles.small, { color: c.muted }]}>Database check: {summary.integrity}</Text>
          {summary.notes.map(n => <Text key={n} style={[styles.small, { color: c.muted }]}>{n}</Text>)}
        </View>
      )}
    </View>
  );
}
