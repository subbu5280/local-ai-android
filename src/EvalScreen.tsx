/**
 * Developer screen: runs the answer-quality evaluation (eval/datasets/answers-v1.json) on this phone's model and shows
 * each answer with its automated checks, for a person to review. Results are also written to the log as
 * LOCALAI_EVAL lines (synthetic test prompts and answers only, never user data) for scripts/device-check.ps1 -Eval.
 */
import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import answers from '../eval/datasets/answers-v1.json';
import retrieval from '../eval/datasets/retrieval-v1.json';
import { runCase, summarizeAnswers, type AnswerCase, type CaseResult } from './eval/answerEval';
import * as local from './localModel';
import type { Colors } from './theme';

const CASES = answers.cases as AnswerCase[];
const log = (kind: string, data: unknown) => console.log(`LOCALAI_EVAL ${JSON.stringify({ kind, version: answers.version, ...(data as object) })}`);

export function EvalScreen({ colors: c, modelReady, onBack }: { colors: Colors; modelReady: boolean; onBack: () => void }) {
  const [results, setResults] = useState<CaseResult[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  useEffect(() => () => { stop.current = true; }, []); // leaving the screen stops after the current case

  async function run() {
    if (running || !modelReady) return;
    setRunning(true);
    stop.current = false;
    setResults([]);
    const t0 = Date.now();
    const done: CaseResult[] = [];
    for (const k of CASES) {
      if (stop.current) break;
      const r = await runCase(k, retrieval.documents, (prompt, history) => local.generate(prompt, undefined, 200, history));
      done.push(r);
      setResults([...done]);
      log('case', r);
    }
    log('done', { cases: done.length, of: CASES.length, ms: Date.now() - t0, summary: summarizeAnswers(done), stopped: stop.current });
    console.log(`LOCALAI_METRIC ${JSON.stringify({ event: 'eval_done', cases: done.length, t: Date.now() })}`);
    setRunning(false);
  }

  const summary = summarizeAnswers(results);
  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">Model evaluation</Text>
      </View>
      <Text style={[styles.pad, { color: c.muted }]}>
        {CASES.length} test prompts (dataset v{answers.version}) in six languages go to the on-device model. Checks are automatic
        and approximate (script, citations, "not found", key facts); judge correctness yourself. Takes several minutes.
      </Text>
      <View style={styles.actions}>
        {running ? (
          <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel="Stop model evaluation"
            onPress={() => { stop.current = true; local.stop().catch(() => undefined); }}>
            <Text style={{ color: c.stop }}>Stop</Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.chip, { borderColor: modelReady ? c.accent : c.border }]} accessibilityRole="button"
            accessibilityLabel="Run model evaluation" disabled={!modelReady} onPress={run}>
            <Text style={{ color: modelReady ? c.accent : c.muted }}>{modelReady ? 'Run evaluation' : 'Model not ready'}</Text>
          </Pressable>
        )}
        <Text style={{ color: c.muted }}>{results.length}/{CASES.length}</Text>
      </View>
      {results.length > 0 && (
        <Text style={[styles.pad, { color: c.text }]}>
          {Object.entries(summary).map(([lang, s]) => `${lang}: ${s.passed}/${s.checks} checks`).join(' · ')}
        </Text>
      )}
      <FlatList
        style={styles.flex}
        data={results}
        keyExtractor={r => r.id}
        renderItem={({ item }) => (
          <View style={[styles.row, { borderColor: c.border }]}>
            <Text style={[styles.bold, { color: c.text }]}>{item.id} · {item.kind} · {Math.round(item.ms / 100) / 10} s · {item.tokPerSec.toFixed(1)} tok/s</Text>
            {item.error ? <Text style={{ color: c.stop }}>Error: {item.error}</Text> : null}
            {item.checks.map(ch => (
              <Text key={ch.name} style={{ color: ch.ok ? c.text : c.stop }}>{ch.ok ? '✓' : '✗'} {ch.name}: {ch.detail}</Text>
            ))}
            <Text selectable style={{ color: c.muted }}>{item.answer}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: '600' },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  pad: { paddingHorizontal: 16, paddingVertical: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
  row: { padding: 12, borderBottomWidth: 1, gap: 4 },
  bold: { fontWeight: '600' },
});
