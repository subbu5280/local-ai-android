/**
 * One workspace: browse its folders, search file names or contents, select files, refresh the listing, and start a
 * coding task (ask, debug, review, or propose a change) in a chosen answer language. Past tasks and proposals are
 * listed underneath.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { styles } from './CodeScreen';
import * as assistant from './code/assistant';
import { listProposals } from './code/proposals';
import { searchContent, searchNames, type Hit } from './code/search';
import * as store from './code/workspaceStore';
import { LANG_CODES, NAMES, type LangCode } from './core/language';
import type { Colors } from './theme';

export type TaskMode = assistant.Mode | 'propose';
export const MODE_LABEL: Record<TaskMode, string> = { ask: 'Ask', debug: 'Debug', review: 'Review', propose: 'Propose change' };

export function WorkspaceScreen({ id, colors: c, focused, onBack, onOpenFile, onTask, onProposal }: {
  id: string; colors: Colors; focused: boolean; onBack: () => void; onOpenFile: (path: string, line?: number) => void;
  onTask: (taskId: string, start?: { mode: TaskMode; question: string; errorText: string }) => void; onProposal: (id: string) => void;
}) {
  const [ws, setWs] = useState<store.Workspace | null>(null);
  const [list, setList] = useState<store.Entry[]>([]);
  const [access, setAccess] = useState<{ read: boolean; write: boolean } | null>(null);
  const [folder, setFolder] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [inContents, setInContents] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [mode, setMode] = useState<TaskMode>('ask');
  const [language, setLanguage] = useState<LangCode | null>(null);
  const [question, setQuestion] = useState('');
  const [errorText, setErrorText] = useState('');
  const [tasks, setTasks] = useState<assistant.Task[]>([]);
  const [proposals, setProposals] = useState<{ id: string; title: string; status: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const signal = useRef<store.Signal | null>(null);

  const load = useCallback(async () => {
    try {
      const w = await store.getWorkspace(id);
      setWs(w);
      if (!w) return;
      setList(await store.entries(id));
      setTasks(await assistant.listTasks(id));
      setProposals(await listProposals(id));
      setAccess(await store.checkAccess(w).catch(() => null));
    } catch (e) { setMessage(store.explain(e)); }
  }, [id]);
  useEffect(() => { if (focused) load(); }, [focused, load]);

  async function refresh() {
    if (!ws || busy) return;
    signal.current = { cancelled: false };
    setMessage(null);
    setBusy('Refreshing…');
    try {
      const r = await store.scan(ws, { signal: signal.current, onProgress: p => setBusy(`Refreshing… ${p.listed} items (${p.folder})`) });
      setMessage(`${r.count} items listed${r.truncated ? ' — the listing limit was reached, so some files are not shown' : ''}.`);
      await load();
    } catch (e) { setMessage(store.explain(e)); } finally { setBusy(null); }
  }

  async function search() {
    if (!ws || busy || !query.trim()) return;
    setMessage(null);
    if (!inContents) { setHits(searchNames(list, query).map(e => ({ path: e.path, line: 0, text: e.dir ? 'folder' : '', term: query }))); return; }
    signal.current = { cancelled: false };
    setBusy('Searching…');
    try {
      const r = await searchContent(ws, query, { signal: signal.current, onProgress: (n, total) => setBusy(`Searching… ${n} of ${total} files`) });
      setHits(r.hits);
      setMessage(`${r.hits.length} line${r.hits.length === 1 ? '' : 's'} in ${r.filesRead} files read${r.truncated ? ' (search limit reached)' : ''}${r.failed ? `; ${r.failed} could not be read` : ''}.`);
    } catch (e) { setMessage(store.explain(e)); } finally { setBusy(null); }
  }

  async function start() {
    if (!ws || busy || !question.trim()) return;
    try {
      const task = await assistant.createTask(ws.id, question, selected, language);
      onTask(task.id, { mode, question: question.trim(), errorText: errorText.trim() });
      setQuestion('');
      setErrorText('');
    } catch (e) { setMessage(store.explain(e)); }
  }

  const toggle = (p: string) => setSelected(s => (s.includes(p) ? s.filter(x => x !== p) : s.length >= 20 ? s : [...s, p]));
  const here = list.filter(e => e.path && (e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '') === folder)
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
  if (!ws) return <View style={[styles.flex, { backgroundColor: c.bg }]}><Text style={[styles.pad, { color: c.muted }]}>{message ?? 'Loading…'}</Text></View>;

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header" numberOfLines={1}>{ws.name}</Text>
        {busy ? (
          <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => { if (signal.current) signal.current.cancelled = true; }}>
            <Text style={{ color: c.stop }}>Cancel</Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Refresh workspace" onPress={refresh}>
            <Text style={{ color: c.text }}>Refresh</Text>
          </Pressable>
        )}
      </View>
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        {access && !access.read && <Text style={{ color: c.stop }}>Access to this workspace was removed (for example in Android settings). Remove it and add the folder again.</Text>}
        {access?.read && !access.write && <Text style={{ color: c.muted }}>Read-only access: proposals can be reviewed but not applied.</Text>}
        {!ws.scannedAt && ws.kind === 'folder' && <Text style={{ color: c.muted }}>Not listed yet: tap Refresh.</Text>}
        {busy && <Text style={{ color: c.muted }} accessibilityLiveRegion="polite">{busy}</Text>}
        {message && <Text style={{ color: c.text }} accessibilityLiveRegion="polite">{message}</Text>}

        <Text style={[styles.bold, { color: c.text }]}>Search</Text>
        <View style={styles.row}>
          <TextInput style={[styles.input, styles.flex, { color: c.text, borderColor: c.border }]} value={query} onChangeText={setQuery} onSubmitEditing={search}
            placeholder={inContents ? 'Text in files' : 'File name'} placeholderTextColor={c.muted} accessibilityLabel="Search text" />
          <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="switch" accessibilityState={{ checked: inContents }}
            accessibilityLabel="Search file contents" onPress={() => setInContents(v => !v)}>
            <Text style={{ color: inContents ? c.accent : c.text }}>{inContents ? 'Contents' : 'Names'}</Text>
          </Pressable>
          <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Search" onPress={search}>
            <Text style={{ color: c.accent }}>Search</Text>
          </Pressable>
        </View>
        {hits?.map((h, i) => (
          <Pressable key={`${h.path}:${h.line}:${i}`} accessibilityRole="link" accessibilityLabel={`Open ${h.path}${h.line ? ` line ${h.line}` : ''}`}
            onPress={() => (h.text === 'folder' ? setFolder(h.path) : onOpenFile(h.path, h.line || undefined))}>
            <Text style={[styles.mono, { color: c.accent }]} numberOfLines={2}>{h.path}{h.line ? `:${h.line}` : ''}{h.text && h.text !== 'folder' ? `  ${h.text}` : ''}</Text>
          </Pressable>
        ))}
        {hits?.length === 0 && <Text style={{ color: c.muted }}>No matches.</Text>}

        <Text style={[styles.bold, { color: c.text }]}>Files {folder ? `· ${folder}` : ''}</Text>
        {folder !== '' && (
          <Pressable accessibilityRole="button" accessibilityLabel="Up one folder" onPress={() => setFolder(folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '')}>
            <Text style={{ color: c.accent }}>‹ ..</Text>
          </Pressable>
        )}
        {here.length === 0 && <Text style={{ color: c.muted }}>{list.length ? 'This folder is empty (or only holds skipped folders).' : 'Nothing listed yet.'}</Text>}
        {here.slice(0, 200).map(e => {
          const why = store.unreadableReason(e);
          const name = e.path.slice(e.path.lastIndexOf('/') + 1);
          return e.dir ? (
            <Pressable key={e.path} accessibilityRole="button" accessibilityLabel={`Open folder ${name}`} onPress={() => setFolder(e.path)}>
              <Text style={{ color: c.text }}>📁 {name}</Text>
            </Pressable>
          ) : (
            <View key={e.path} style={styles.row}>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected.includes(e.path), disabled: !!why }} disabled={!!why}
                accessibilityLabel={`Select ${e.path}`} onPress={() => toggle(e.path)}>
                <Text style={{ color: why ? c.muted : c.accent }}>{selected.includes(e.path) ? '☑' : '☐'}</Text>
              </Pressable>
              <Pressable style={styles.flex} accessibilityRole="link" accessibilityLabel={`Open file ${e.path}`} onPress={() => onOpenFile(e.path)}>
                <Text style={{ color: why ? c.muted : c.text }}>{name}{why ? `  (${why})` : ''}</Text>
              </Pressable>
            </View>
          );
        })}
        {here.length > 200 && <Text style={{ color: c.muted }}>Showing 200 of {here.length}; use search to find others.</Text>}

        <Text style={[styles.bold, { color: c.text }]}>New task</Text>
        <Text style={[styles.small, { color: c.muted }]}>
          {selected.length ? `${selected.length} selected file${selected.length === 1 ? '' : 's'}: ${selected.join(', ')}` : 'No files selected: the assistant searches for relevant files (bounded).'}
        </Text>
        <View style={styles.row}>
          {(Object.keys(MODE_LABEL) as TaskMode[]).map(m => (
            <Pressable key={m} style={[styles.chip, { borderColor: mode === m ? c.accent : c.border }]} accessibilityRole="radio" accessibilityState={{ selected: mode === m }}
              accessibilityLabel={`Mode ${MODE_LABEL[m]}`} onPress={() => setMode(m)}>
              <Text style={{ color: mode === m ? c.accent : c.text }}>{MODE_LABEL[m]}</Text>
            </Pressable>
          ))}
        </View>
        <LanguageChips value={language} onChange={setLanguage} colors={c} />
        <TextInput style={[styles.input, { color: c.text, borderColor: c.border, minHeight: 60 }]} value={question} onChangeText={setQuestion} multiline maxLength={2000}
          placeholder={mode === 'propose' ? 'What should change?' : mode === 'debug' ? 'What goes wrong?' : 'Your question'} placeholderTextColor={c.muted} accessibilityLabel="Task question" />
        {mode === 'debug' && (
          <TextInput style={[styles.input, styles.mono, { color: c.text, borderColor: c.border, minHeight: 60 }]} value={errorText} onChangeText={setErrorText} multiline maxLength={4000}
            placeholder="Paste the error message or stack trace" placeholderTextColor={c.muted} accessibilityLabel="Error message" />
        )}
        <Pressable style={[styles.chip, styles.self, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Start task" disabled={!question.trim()} onPress={start}>
          <Text style={{ color: question.trim() ? c.accent : c.muted }}>Start</Text>
        </Pressable>

        {tasks.length > 0 && <Text style={[styles.bold, { color: c.text }]}>Tasks</Text>}
        {tasks.map(t => (
          <Pressable key={t.id} accessibilityRole="link" accessibilityLabel={`Open task ${t.title}`} onPress={() => onTask(t.id)}>
            <Text style={{ color: c.accent }}>{t.title}</Text>
          </Pressable>
        ))}
        {proposals.length > 0 && <Text style={[styles.bold, { color: c.text }]}>Proposals</Text>}
        {proposals.map(p => (
          <Pressable key={p.id} accessibilityRole="link" accessibilityLabel={`Open proposal ${p.title}`} onPress={() => onProposal(p.id)}>
            <Text style={{ color: c.accent }}>{p.title} · {p.status}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/** Answer language: Auto (detected from the question) or one of the six languages. */
export function LanguageChips({ value, onChange, colors: c }: { value: LangCode | null; onChange: (l: LangCode | null) => void; colors: Colors }) {
  return (
    <View style={styles.row}>
      {[null, ...LANG_CODES].map(l => (
        <Pressable key={l ?? 'auto'} style={[styles.chip, { borderColor: value === l ? c.accent : c.border }]} accessibilityRole="radio"
          accessibilityState={{ selected: value === l }} accessibilityLabel={`Answer language ${l ? NAMES[l] : 'Auto'}`} onPress={() => onChange(l)}>
          <Text style={{ color: value === l ? c.accent : c.text }}>{l ? NAMES[l] : 'Auto'}</Text>
        </Pressable>
      ))}
    </View>
  );
}
