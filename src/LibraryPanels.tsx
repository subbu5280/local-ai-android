/**
 * Skills and workflows lists (tabs of the Agents screen): switch on/off, run, edit or duplicate, export, delete, and
 * import with validation (pasted JSON or a file). Imports are checked first and only saved after the user confirms.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { getTool } from './agents/tools';
import { pickFiles, readText, createTextFile } from './knowledge/native';
import { permissionsFor, type SkillDef, type WorkflowDef } from './skills/format';
import * as store from './skills/skillStore';
import type { Colors } from './theme';

export type DefKind = 'skill' | 'workflow';
type Item = store.Stored<SkillDef | WorkflowDef>;

const LANG_TAGS = (d: SkillDef | WorkflowDef) => Object.keys(d.name).filter(k => k !== 'en').map(k => k.toUpperCase()).join(' ');
/** Tools a definition uses (for display); for workflows through their skills too. */
function toolsShown(kind: DefKind, d: SkillDef | WorkflowDef, skills: store.SkillMap): string[] {
  if (kind === 'skill') return (d as SkillDef).tools;
  return [...new Set((d as WorkflowDef).steps.flatMap(s => ('skill' in s ? skills.get(s.skill)?.def.tools ?? [] : [s.tool])))];
}

/** Export: Android's share sheet (text), or a new .json file the user places. */
export async function exportDef(def: SkillDef | WorkflowDef, how: 'share' | 'file'): Promise<string | null> {
  const json = store.exportDefinition(def);
  if (how === 'share') { await Share.share({ title: def.name.en, message: json }); return null; }
  const saved = await createTextFile(`${def.id}.${def.format === 'localai.skill' ? 'skill' : 'workflow'}.json`, 'application/json', json);
  return saved ? saved.name : null;
}

export function DefinitionList({ kind, colors: c, focused, onEdit, onRun, onDraft }: {
  kind: DefKind; colors: Colors; focused: boolean;
  onEdit: (id: string | null, initial?: string) => void; onRun: (id: string) => void; onDraft?: () => void;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [skills, setSkills] = useState<store.SkillMap>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const busy = useRef(false);

  const load = useCallback(async () => {
    try {
      setItems(kind === 'skill' ? await store.listSkills() : await store.listWorkflows());
      setSkills(await store.skillMap());
      setError(null);
    } catch (e: any) {
      setItems([]);
      setError(`Couldn't read ${kind}s (${e?.message ?? e}).`);
    }
  }, [kind]);
  useEffect(() => { if (focused) load(); }, [focused, load]);

  async function act(work: () => Promise<unknown>) {
    if (busy.current) return;
    busy.current = true;
    try { await work(); setError(null); } catch (e: any) { setError(e?.errors?.join('; ') ?? String(e?.message ?? e)); } finally { busy.current = false; await load(); }
  }

  const remove = (it: Item) => Alert.alert(`Delete this ${kind}?`, `"${it.def?.name.en ?? it.id}" is deleted from this phone. Its run history, your chats, ` +
    'documents and models stay.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => act(() => store.deleteDefinition(kind, it.id)) }]);

  return (
    <View style={styles.flex}>
      <View style={styles.actions}>
        <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel={`New ${kind}`} onPress={() => onEdit(null)}>
          <Text style={{ color: c.accent }}>New</Text>
        </Pressable>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Import ${kind}`} onPress={() => setImporting(v => !v)}>
          <Text style={{ color: c.text }}>Import</Text>
        </Pressable>
        {onDraft && (
          <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Describe a workflow" onPress={onDraft}>
            <Text style={{ color: c.text }}>Describe one</Text>
          </Pressable>
        )}
      </View>
      {importing && <ImportBox kind={kind} colors={c} onDone={async () => { setImporting(false); await load(); }} />}
      {error && <Text style={[styles.pad, { color: c.stop }]}>{error}</Text>}
      {(items ?? []).length === 0 && items && <Text style={[styles.pad, { color: c.muted }]}>No {kind}s yet.</Text>}
      {(items ?? []).map(it => {
        const d = it.def;
        const tools = d ? toolsShown(kind, d, skills) : [];
        const runnable = !!d && it.enabled;
        return (
          <View key={it.id} style={[styles.row, { borderColor: c.border }]}>
            <View style={styles.titleRow}>
              <Text style={[styles.bold, styles.flex, { color: it.enabled && d ? c.text : c.muted }]} numberOfLines={1}>
                {d?.name.en ?? it.id}{d && LANG_TAGS(d) ? ` · ${LANG_TAGS(d)}` : ''}
              </Text>
              <Switch value={it.enabled} accessibilityLabel={`Enable ${kind} ${it.id}`} onValueChange={v => act(() => store.setEnabled(kind, it.id, v))} />
            </View>
            <Text style={[styles.small, { color: c.muted }]}>
              {it.id} v{it.version}{it.builtin ? ' · built-in' : ''}{!d ? ' · INVALID' : ''}{!it.enabled ? ' · off' : ''}
            </Text>
            {d && <Text style={[styles.small, { color: c.muted }]}>
              Tools: {tools.map(t => getTool(t)?.name ?? t).join(', ')} · Permissions: {permissionsFor(tools).join(', ') || 'none'}
            </Text>}
            {it.errors.map(e => <Text key={e} style={[styles.small, { color: c.stop }]}>• {e}</Text>)}
            <View style={styles.actions}>
              <Pressable style={[styles.chip, { borderColor: runnable ? c.accent : c.border }]} accessibilityRole="button"
                accessibilityLabel={`Run ${kind} ${it.id}`} disabled={!runnable} onPress={() => onRun(it.id)}>
                <Text style={{ color: runnable ? c.accent : c.muted }}>Run</Text>
              </Pressable>
              {it.builtin || !d ? null : (
                <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Edit ${kind} ${it.id}`} onPress={() => onEdit(it.id)}>
                  <Text style={{ color: c.text }}>Edit</Text>
                </Pressable>
              )}
              {d && (
                <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Duplicate ${kind} ${it.id}`}
                  onPress={() => act(async () => { const copy = await store.duplicateDefinition(kind, d); onEdit(copy.id); })}>
                  <Text style={{ color: c.text }}>Duplicate</Text>
                </Pressable>
              )}
              {d && (
                <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Export ${kind} ${it.id}`}
                  onPress={() => Alert.alert('Export', `"${d.name.en}" as JSON.`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Share', onPress: () => { exportDef(d, 'share').catch(e => setError(String(e?.message ?? e))); } },
                    { text: 'Save file', onPress: () => { exportDef(d, 'file').catch(e => setError(String(e?.message ?? e))); } },
                  ])}>
                  <Text style={{ color: c.text }}>Export</Text>
                </Pressable>
              )}
              {!it.builtin && (
                <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel={`Delete ${kind} ${it.id}`} onPress={() => remove(it)}>
                  <Text style={{ color: c.stop }}>Delete</Text>
                </Pressable>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** Paste or pick a definition, see whether it is valid and what it needs, then import (or replace, or copy). */
function ImportBox({ kind, colors: c, onDone }: { kind: DefKind; colors: Colors; onDone: () => void }) {
  const [text, setText] = useState('');
  const [check, setCheck] = useState<Awaited<ReturnType<typeof store.parseImport>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  async function fromFile() {
    try {
      const [f] = await pickFiles();
      if (!f) return;
      const t = await readText(f.uri, 64_000);
      setText(t.text);
      setCheck(await store.parseImport(t.text));
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }
  async function save(mode: 'create' | 'replace' | 'copy') {
    if (!check?.def || !check.kind || busy.current) return;
    busy.current = true;
    try {
      if (mode === 'copy') await store.duplicateDefinition(check.kind, check.def);
      else await store.saveDefinition(check.kind, check.def, mode);
      onDone();
    } catch (e: any) { setError(e?.errors?.join('; ') ?? String(e?.message ?? e)); } finally { busy.current = false; }
  }
  const d = check?.def;
  const tools = d ? (check!.kind === 'skill' ? (d as SkillDef).tools : Object.keys((d as WorkflowDef).compatibility.tools)) : [];
  return (
    <View style={[styles.box, { borderColor: c.border }]}>
      <Text style={{ color: c.text }}>Paste a {kind} (or workflow/skill) definition, or pick a .json file. It is checked before anything is saved.</Text>
      <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={text} onChangeText={t => { setText(t); setCheck(null); }}
        multiline placeholder='{"format": "localai.skill", ...}' placeholderTextColor={c.muted} accessibilityLabel="Definition JSON" />
      <View style={styles.actions}>
        <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Check definition"
          onPress={async () => setCheck(await store.parseImport(text))}>
          <Text style={{ color: c.accent }}>Check</Text>
        </Pressable>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Import from file" onPress={fromFile}>
          <Text style={{ color: c.text }}>From file</Text>
        </Pressable>
      </View>
      {check && !d && check.errors.map(e => <Text key={e} style={[styles.small, { color: c.stop }]}>• {e}</Text>)}
      {d && (
        <View>
          <Text style={{ color: c.text }}>Valid {check!.kind}: {d.name.en} ({d.id} v{d.version})</Text>
          <Text style={[styles.small, { color: c.muted }]}>Needs tools: {tools.join(', ')} · permissions: {permissionsFor(tools).join(', ') || 'none'}</Text>
          {check!.exists && <Text style={[styles.small, { color: c.stop }]}>A {check!.kind} with this id already exists.</Text>}
          <View style={styles.actions}>
            {!check!.exists && (
              <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Confirm import" onPress={() => save('create')}>
                <Text style={{ color: c.accent }}>Import</Text>
              </Pressable>
            )}
            {check!.exists && (
              <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel="Replace existing" onPress={() => save('replace')}>
                <Text style={{ color: c.stop }}>Replace existing</Text>
              </Pressable>
            )}
            {check!.exists && (
              <Pressable style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel="Import as a copy" onPress={() => save('copy')}>
                <Text style={{ color: c.accent }}>Import as a copy</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
      {error && <Text style={{ color: c.stop }}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  row: { paddingVertical: 10, borderBottomWidth: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  box: { margin: 12, padding: 12, borderWidth: 1, borderRadius: 10, gap: 8 },
  input: { borderWidth: 1, borderRadius: 8, padding: 8, minHeight: 80, maxHeight: 200 },
  pad: { padding: 16 },
  small: { fontSize: 12, paddingHorizontal: 16 },
  bold: { fontWeight: '600' },
});
