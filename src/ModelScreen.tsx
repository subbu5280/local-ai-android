/**
 * Model choice (M12): the chat models this app knows (src/modelCatalog.json, all under 4B parameters), each with
 * whether it fits THIS phone (free storage with reserve, RAM, predicted speed from the measured baseline) and its
 * license. Switching uses modelManager.replaceModel: download (only after you confirm) → sha256 check → load → a test
 * answer and speed limits → activate → delete the old model. Any failure deletes the new files and keeps the old model.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { styles } from './CodeScreen';
import * as local from './localModel';
import * as mm from './modelManager';
import { connectivity, keepScreenOn } from './device';
import * as voice from './voice';
import type { Colors } from './theme';

type Row = { model: mm.CatalogModel; storage: ReturnType<typeof mm.storagePlan>; ram: ReturnType<typeof mm.ramPlan> | null; speed: number | null; installed: boolean };

export function ModelScreen({ colors: c, focused, onBack, onSwitched }: {
  colors: Colors; focused: boolean; onBack: () => void; onSwitched: () => void;
}) {
  const [active, setActive] = useState<mm.CatalogModel | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const acting = useRef(false);

  const device = useCallback(async (): Promise<mm.Device & { ramKnown: boolean }> => {
    const [s, mem] = await Promise.all([local.storageInfo(), voice.memoryInfo().catch(() => null)]);
    return { platform: 'android', totalRam: mem?.totalBytes ?? 0, availRam: mem?.availBytes ?? 0, freeStorage: s.freeStorage, totalStorage: s.totalStorage, ramKnown: !!mem };
  }, []);

  const load = useCallback(async () => {
    try {
      const [a, st, d] = await Promise.all([local.activeModel(), local.readManagerState(), device()]);
      setActive(a);
      const chat = mm.BUILTIN_CATALOG.filter(m => m.chatCapable && m.supported);
      setRows(await Promise.all(chat.map(async m => ({
        model: m, storage: mm.storagePlan(m, d), ram: d.ramKnown ? mm.ramPlan(m, d) : null,
        speed: mm.predictedTokPerSec(m, st.baseline, a), installed: await local.isInstalled(m).catch(() => false),
      }))));
    } catch (e: any) { setNote(`Could not read the model list: ${String(e?.message ?? e)}`); }
  }, [device]);
  useEffect(() => { if (focused) load(); }, [focused, load]);

  function choose(r: Row) {
    if (!active || acting.current || r.model.id === active.id) return;
    const gb = (r.model.bytes / 1e9).toFixed(2);
    Alert.alert(`Switch to ${r.model.name}?`,
      `${r.model.paramsB}B parameters · ${gb} GB ${r.installed ? '(already downloaded)' : 'download (use Wi-Fi)'} · license ${r.model.license}.\n` +
      'It is checked (sha256), loaded and given a test question before it replaces the current model. If anything fails, ' +
      `the current model (${active.name}) stays. After a switch, the old model file is deleted.`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Switch', onPress: () => { switchTo(r.model).catch(() => undefined); } },
      ]);
  }

  async function switchTo(next: mm.CatalogModel) {
    if (!active || acting.current) return;
    acting.current = true;
    const online = (await connectivity()) !== 'offline';
    keepScreenOn(true);
    try {
      const r = await mm.replaceModel(active, next, {
        device, online: () => online,
        download: async (m, onProgress) => { if (!(await local.isInstalled(m))) await local.download(m, onProgress, online); },
        loadAndBench: async m => {
          const t0 = Date.now();
          await local.load(m);
          const loadMs = Date.now() - t0;
          const g = await local.generate('What is 2 + 2? Answer with one number.', undefined, 16);
          return { loadMs, firstTokenMs: g.firstTokenMs, tokPerSec: g.tokPerSec, text: g.text };
        },
        activate: async (m, prev) => { await local.writeManagerState({ active: m.id, previous: prev.id }); },
        remove: m => local.remove(m),
        reloadPrevious: async m => { await local.load(m); },
      }, (step, detail) => setBusy(`${step}${detail ? ` ${detail}` : ''}…`));
      setNote(r.ok ? `Now using ${next.name}.${r.cleanupError ? ` Note: ${r.cleanupError}` : ''}` : `Not switched: ${r.error}. ${active.name} is still in use.`);
      if (r.ok) onSwitched();
    } finally {
      keepScreenOn(false);
      setBusy(null);
      acting.current = false;
      await load();
    }
  }

  const fmt = (b: number) => `${(b / 1e9).toFixed(2)} GB`;
  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack} disabled={!!busy}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">Model</Text>
      </View>
      <ScrollView contentContainerStyle={styles.pad}>
        <Text style={{ color: c.muted }}>All models run on this phone and are under 4B parameters. Fit is checked against this phone's free storage
          (keeping a reserve) and memory; speed is predicted from this phone's measured speed when available.</Text>
        {rows.map(r => {
          const current = r.model.id === active?.id;
          const fits = r.storage.ok && (r.ram?.ok ?? true);
          return (
            <View key={r.model.id} style={[styles.card, { backgroundColor: c.bubble }]}>
              <Text style={[styles.bold, { color: c.text }]}>{r.model.name}{current ? ' — in use' : ''}</Text>
              <Text style={[styles.small, { color: c.muted }]}>
                {r.model.paramsB}B · {fmt(r.model.bytes)} · license {r.model.license}{r.installed ? ' · downloaded' : ''}
              </Text>
              <Text style={[styles.small, { color: r.storage.ok ? c.muted : c.stop }]}>
                Storage: {r.storage.ok ? 'fits' : `needs ${fmt(r.storage.required)} free`}
                {' · '}Memory: {r.ram ? (r.ram.ok ? 'fits' : `needs about ${fmt(r.ram.needed)} plus system headroom`) : 'unknown on this phone'}
                {r.speed ? ` · about ${r.speed.toFixed(1)} tokens/s predicted` : ''}
              </Text>
              {!current && (
                <Pressable style={[styles.chip, styles.self, { borderColor: fits ? c.accent : c.border }]} accessibilityRole="button"
                  accessibilityLabel={`Use ${r.model.name}`} disabled={!!busy || !fits} onPress={() => choose(r)}>
                  <Text style={{ color: fits && !busy ? c.accent : c.muted }}>{fits ? 'Use this model' : "Doesn't fit this phone"}</Text>
                </Pressable>
              )}
            </View>
          );
        })}
        {busy && <Text style={{ color: c.muted }} accessibilityLiveRegion="polite">Switching: {busy}</Text>}
        {note && <Text style={{ color: c.text }} accessibilityLiveRegion="polite">{note}</Text>}
      </ScrollView>
    </View>
  );
}
