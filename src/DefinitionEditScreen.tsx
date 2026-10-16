/**
 * Create or edit a skill or workflow with a form. The form keeps a working draft; the declared tools, permissions,
 * compatibility and output are derived from the steps (so they can't disagree), and the result is validated with the
 * same validator as imports (format.validateSkill / validateWorkflow) before Save is possible. Texts can be written
 * in any of the six languages; ids, tool names and parameters are never translated.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { LANG_CODES, NAMES, type LangCode } from './core/language';
import { getTool, TOOLS } from './agents/tools';
import { LIMIT_BOUNDS, type Limits } from './agents/types';
import { LIMIT_LABEL } from './agents/policy';
import { permissionsFor, validateSkill, validateWorkflow, type InputDef, type SkillDef, type SkillStepDef, type TemplateValue, type ToolStepDef, type WorkflowDef } from './skills/format';
import * as store from './skills/skillStore';
import type { DefKind } from './LibraryPanels';
import type { Colors } from './theme';

type Step = ToolStepDef | SkillStepDef;
type Work = { id: string; version: number; name: Record<string, string>; text: Record<string, string>; instructions: Record<string, string>;
  inputs: InputDef[]; limits: Limits; steps: Step[] };

const blank = (): Work => ({ id: '', version: 1, name: { en: '' }, text: { en: '' }, instructions: { en: '' }, inputs: [], limits: { maxSteps: 4, maxRetries: 1, stepTimeoutSec: 90 }, steps: [] });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

/** The full definition the validator sees, with derived tools, permissions, compatibility and output. */
export function toRaw(kind: DefKind, w: Work, skills: store.SkillMap): unknown {
  const base = { formatVersion: 1, id: w.id, version: w.version, name: w.name, inputs: w.inputs, limits: w.limits };
  const toolSteps = w.steps.filter((s): s is ToolStepDef => 'tool' in s);
  if (kind === 'skill') {
    const tools = [...new Set(toolSteps.map(s => s.tool))];
    const last = toolSteps[toolSteps.length - 1];
    return { ...base, format: 'localai.skill', description: w.text, instructions: w.instructions, tools, permissions: permissionsFor(tools),
      output: last ? getTool(last.tool)?.produces : undefined, compatibility: { tools: Object.fromEntries(tools.map(t => [t, getTool(t)?.version ?? 0])) }, steps: w.steps };
  }
  return { ...base, format: 'localai.workflow', purpose: w.text,
    compatibility: { tools: Object.fromEntries(toolSteps.map(s => [s.tool, getTool(s.tool)?.version ?? 0])),
      skills: Object.fromEntries(w.steps.filter((s): s is SkillStepDef => 'skill' in s).map(s => [s.skill, skills.get(s.skill)?.def.version ?? 0])) },
    steps: w.steps };
}

/** A working draft from a stored or imported definition. */
export function fromDef(d: SkillDef | WorkflowDef): Work {
  return { id: d.id, version: d.version, name: { ...d.name }, text: { ...('description' in d ? d.description : d.purpose) },
    instructions: { ...('instructions' in d ? d.instructions : { en: '' }) }, inputs: d.inputs.map(i => ({ ...i, label: { ...i.label } })),
    limits: { ...d.limits }, steps: JSON.parse(JSON.stringify(d.steps)) };
}

/** A tool step without its fromStep reference. */
const withoutFrom = (s: ToolStepDef): ToolStepDef => ({ tool: s.tool, input: s.input, ...(s.purpose ? { purpose: s.purpose } : {}) });

/** Move step i by +1/-1, keeping fromStep references pointing at the same steps. */
export function moveStep(steps: Step[], i: number, dir: 1 | -1): Step[] {
  const j = i + dir;
  if (j < 0 || j >= steps.length) return steps;
  const out = steps.map(s => ({ ...s }));
  [out[i], out[j]] = [out[j], out[i]];
  return out.map(s => ('fromStep' in s && s.fromStep ? { ...s, fromStep: s.fromStep === i + 1 ? j + 1 : s.fromStep === j + 1 ? i + 1 : s.fromStep } : s));
}

/** Remove step i; references to it are cleared (validation then says what is missing), later ones shift down. */
export function removeStep(steps: Step[], i: number): Step[] {
  return steps.filter((_, k) => k !== i).map(s => {
    if (!('fromStep' in s) || !s.fromStep) return s;
    if (s.fromStep === i + 1) return withoutFrom(s as ToolStepDef);
    return s.fromStep > i + 1 ? { ...s, fromStep: s.fromStep - 1 } : s;
  });
}

/** A typed field value from the form: "$name" refers to an input, digits become a number for number fields. */
const parseValue = (raw: string, numeric: boolean): TemplateValue =>
  /^\$[a-z][a-z0-9_]*$/.test(raw.trim()) ? { $input: raw.trim().slice(1) } : numeric && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
const showValue = (v: TemplateValue | undefined) => (v === undefined ? '' : typeof v === 'object' ? `$${v.$input}` : String(v));

export function DefinitionEditScreen({ kind, id, initial, colors: c, onBack, onSaved, onTest }: {
  kind: DefKind; id: string | null; initial?: string; colors: Colors; onBack: () => void; onSaved: (id: string) => void; onTest: (id: string) => void;
}) {
  const [w, setW] = useState<Work>(blank());
  const [lang, setLang] = useState<LangCode>('en');
  const [skills, setSkills] = useState<store.SkillMap>(new Map());
  const [savedId, setSavedId] = useState<string | null>(id);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const saving = useRef(false);

  useEffect(() => {
    (async () => {
      setSkills(await store.skillMap());
      if (id) {
        const list = kind === 'skill' ? await store.listSkills() : await store.listWorkflows();
        const it = list.find(x => x.id === id);
        if (it?.def) setW(fromDef(it.def));
      } else if (initial) {
        const v = kind === 'skill' ? validateSkill(JSON.parse(initial)) : validateWorkflow(JSON.parse(initial), await store.skillMap());
        if (v.def) setW(fromDef(v.def));
      }
    })().catch(e => setMessage(String(e?.message ?? e)));
  }, [id, initial, kind]);

  const raw = useMemo(() => toRaw(kind, { ...w, id: w.id || slug(w.name.en) }, skills), [kind, w, skills]);
  const errors = useMemo(() => (kind === 'skill' ? validateSkill(raw) : validateWorkflow(raw, skills)).errors, [kind, raw, skills]);
  const set = (patch: Partial<Work>) => { setW(prev => ({ ...prev, ...patch })); setMessage(null); };
  const setStep = (i: number, s: Step) => set({ steps: w.steps.map((x, k) => (k === i ? s : x)) });

  async function save() {
    if (saving.current || errors.length) return;
    saving.current = true;
    try {
      const def = await store.saveDefinition(kind, raw, savedId ? 'update' : 'create');
      setSavedId(def.id);
      setW(fromDef(def));
      setMessage(`Saved ${def.id} v${def.version}.`);
      onSaved(def.id);
    } catch (e: any) {
      setMessage(e?.errors?.join('; ') ?? String(e?.message ?? e));
    } finally { saving.current = false; }
  }

  const textField = (label: string, value: Record<string, string>, key: 'name' | 'text' | 'instructions', multiline = false) => (
    <View>
      <Text style={[styles.label, { color: c.text }]}>{label} ({NAMES[lang]})</Text>
      <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={value[lang] ?? ''} multiline={multiline}
        accessibilityLabel={`${label} in ${NAMES[lang]}`} onChangeText={t => set({ [key]: { ...value, [lang]: t } } as Partial<Work>)} />
    </View>
  );

  return (
    <View style={[styles.flex, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { borderColor: c.border }]}>
        <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Back" onPress={onBack}>
          <Text style={{ color: c.text }}>‹ Back</Text>
        </Pressable>
        <Text style={[styles.title, styles.flex, { color: c.text }]} accessibilityRole="header">{savedId ? `Edit ${kind}` : `New ${kind}`}</Text>
        <Pressable style={[styles.chip, { borderColor: errors.length ? c.border : c.accent }]} accessibilityRole="button" accessibilityLabel={`Save ${kind}`}
          disabled={!!errors.length} onPress={save}>
          <Text style={{ color: errors.length ? c.muted : c.accent }}>Save</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
        <View style={styles.actions}>
          {LANG_CODES.map(l => (
            <Pressable key={l} style={[styles.chip, { borderColor: l === lang ? c.accent : c.border }]} accessibilityRole="button"
              accessibilityLabel={`Edit texts in ${NAMES[l]}`} onPress={() => setLang(l)}>
              <Text style={{ color: l === lang ? c.accent : c.text }}>{l.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={[styles.label, { color: c.text }]}>Id (stable, not translated)</Text>
        <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={w.id} editable={!savedId} placeholder={slug(w.name.en) || 'my-skill'}
          placeholderTextColor={c.muted} autoCapitalize="none" accessibilityLabel="Definition id" onChangeText={t => set({ id: t.toLowerCase() })} />
        {textField('Name', w.name, 'name')}
        {textField(kind === 'skill' ? 'Description' : 'Purpose', w.text, 'text', true)}
        {kind === 'skill' && textField('Instructions for users', w.instructions, 'instructions', true)}

        <Text style={[styles.label, { color: c.text }]}>Inputs (use them in steps as {'{{name}}'} or $name)</Text>
        {w.inputs.map((inp, i) => (
          <View key={i} style={[styles.card, { borderColor: c.border }]}>
            <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={inp.name} autoCapitalize="none" accessibilityLabel={`Input ${i + 1} name`}
              onChangeText={t => set({ inputs: w.inputs.map((x, k) => (k === i ? { ...x, name: t } : x)) })} />
            <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={inp.label[lang] ?? ''} placeholder={`Label (${NAMES[lang]})`}
              placeholderTextColor={c.muted} accessibilityLabel={`Input ${i + 1} label`}
              onChangeText={t => set({ inputs: w.inputs.map((x, k) => (k === i ? { ...x, label: { ...x.label, [lang]: t } } : x)) })} />
            <View style={styles.actions}>
              <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Input ${i + 1} type`}
                onPress={() => set({ inputs: w.inputs.map((x, k) => (k === i ? { ...x, type: x.type === 'text' ? 'number' : 'text' } : x)) })}>
                <Text style={{ color: c.text }}>{inp.type}</Text>
              </Pressable>
              <Text style={{ color: c.text }}>required</Text>
              <Switch value={inp.required} accessibilityLabel={`Input ${i + 1} required`} onValueChange={v => set({ inputs: w.inputs.map((x, k) => (k === i ? { ...x, required: v } : x)) })} />
              <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel={`Remove input ${i + 1}`}
                onPress={() => set({ inputs: w.inputs.filter((_, k) => k !== i) })}>
                <Text style={{ color: c.stop }}>Remove</Text>
              </Pressable>
            </View>
          </View>
        ))}
        <Pressable style={[styles.chip, styles.self, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Add input"
          onPress={() => set({ inputs: [...w.inputs, { name: `input${w.inputs.length + 1}`, label: { en: `Input ${w.inputs.length + 1}` }, type: 'text', required: true }] })}>
          <Text style={{ color: c.text }}>+ Input</Text>
        </Pressable>

        <Text style={[styles.label, { color: c.text }]}>Steps (run in order)</Text>
        {w.steps.map((s, i) => {
          const tool = 'tool' in s ? getTool(s.tool) : undefined;
          const sk = 'skill' in s ? skills.get(s.skill) : undefined;
          return (
            <View key={i} style={[styles.card, { borderColor: c.border }]}>
              <Text style={[styles.bold, { color: c.text }]}>{i + 1}. {tool ? `${tool.name} (${tool.id} v${tool.version})` : sk ? `Skill: ${sk.def.name.en} (${sk.def.id} v${sk.def.version})` : 'Unknown step'}</Text>
              {tool && Object.entries(tool.input.fields).map(([f, spec]) => (
                <View key={f}>
                  <Text style={[styles.small, { color: c.muted }]}>{f}{spec.required ? ' (required)' : ''}: {spec.description}</Text>
                  <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={showValue((s as ToolStepDef).input[f])} autoCapitalize="none"
                    accessibilityLabel={`Step ${i + 1} ${f}`} onChangeText={t => {
                      const input = { ...(s as ToolStepDef).input };
                      if (t === '') delete input[f]; else input[f] = parseValue(t, spec.type === 'integer');
                      setStep(i, { ...(s as ToolStepDef), input });
                    }} />
                </View>
              ))}
              {sk && sk.def.inputs.map(si => (
                <View key={si.name}>
                  <Text style={[styles.small, { color: c.muted }]}>{si.name}{si.required ? ' (required)' : ''}</Text>
                  <TextInput style={[styles.input, { color: c.text, borderColor: c.border }]} value={showValue((s as SkillStepDef).inputs[si.name])} autoCapitalize="none"
                    accessibilityLabel={`Step ${i + 1} ${si.name}`} onChangeText={t => {
                      const inputs = { ...(s as SkillStepDef).inputs };
                      if (t === '') delete inputs[si.name]; else inputs[si.name] = parseValue(t, si.type === 'number');
                      setStep(i, { ...(s as SkillStepDef), inputs });
                    }} />
                </View>
              ))}
              {tool?.consumes && (
                <View style={styles.actions}>
                  <Text style={[styles.small, { color: c.muted }]}>Uses result of:</Text>
                  {[0, ...Array.from({ length: i }, (_, k) => k + 1)].map(n => (
                    <Pressable key={n} style={[styles.chip, { borderColor: ((s as ToolStepDef).fromStep ?? 0) === n ? c.accent : c.border }]} accessibilityRole="button"
                      accessibilityLabel={`Step ${i + 1} uses ${n ? `step ${n}` : 'no step'}`}
                      onPress={() => { const rest = withoutFrom(s as ToolStepDef); setStep(i, n ? { ...rest, fromStep: n } : rest); }}>
                      <Text style={{ color: c.text }}>{n ? `step ${n}` : 'none'}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              <View style={styles.actions}>
                <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Move step ${i + 1} up`} onPress={() => set({ steps: moveStep(w.steps, i, -1) })}>
                  <Text style={{ color: c.text }}>↑</Text>
                </Pressable>
                <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Move step ${i + 1} down`} onPress={() => set({ steps: moveStep(w.steps, i, 1) })}>
                  <Text style={{ color: c.text }}>↓</Text>
                </Pressable>
                <Pressable style={[styles.chip, { borderColor: c.stop }]} accessibilityRole="button" accessibilityLabel={`Remove step ${i + 1}`} onPress={() => set({ steps: removeStep(w.steps, i) })}>
                  <Text style={{ color: c.stop }}>Remove</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
        <Pressable style={[styles.chip, styles.self, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel="Add step" onPress={() => setAdding(v => !v)}>
          <Text style={{ color: c.text }}>+ Step</Text>
        </Pressable>
        {adding && (
          <View style={styles.actions}>
            {TOOLS.map(t => (
              <Pressable key={t.id} style={[styles.chip, { borderColor: t.risk === 'write' ? c.stop : c.border }]} accessibilityRole="button" accessibilityLabel={`Add tool ${t.id}`}
                onPress={() => { set({ steps: [...w.steps, { tool: t.id, input: {} }] }); setAdding(false); }}>
                <Text style={{ color: c.text }}>{t.name}</Text>
              </Pressable>
            ))}
            {kind === 'workflow' && [...skills.values()].filter(s => s.enabled).map(s => (
              <Pressable key={s.def.id} style={[styles.chip, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel={`Add skill ${s.def.id}`}
                onPress={() => { set({ steps: [...w.steps, { skill: s.def.id, skillVersion: s.def.version, inputs: {} }] }); setAdding(false); }}>
                <Text style={{ color: c.accent }}>Skill: {s.def.name.en}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <Text style={[styles.label, { color: c.text }]}>Limits (inside app bounds)</Text>
        {(Object.keys(LIMIT_BOUNDS) as (keyof Limits)[]).map(k => (
          <View key={k} style={styles.actions}>
            <Text style={[styles.flex, { color: c.text }]}>{LIMIT_LABEL[k]}</Text>
            <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Decrease ${LIMIT_LABEL[k]}`}
              onPress={() => set({ limits: { ...w.limits, [k]: Math.max(LIMIT_BOUNDS[k][0], w.limits[k] - (k === 'stepTimeoutSec' ? 15 : 1)) } })}>
              <Text style={{ color: c.text }}>−</Text>
            </Pressable>
            <Text style={{ color: c.text }}>{w.limits[k]}</Text>
            <Pressable style={[styles.chip, { borderColor: c.border }]} accessibilityRole="button" accessibilityLabel={`Increase ${LIMIT_LABEL[k]}`}
              onPress={() => set({ limits: { ...w.limits, [k]: Math.min(LIMIT_BOUNDS[k][1], w.limits[k] + (k === 'stepTimeoutSec' ? 15 : 1)) } })}>
              <Text style={{ color: c.text }}>+</Text>
            </Pressable>
          </View>
        ))}

        {kind === 'skill' && (
          <Text style={[styles.small, { color: c.muted }]}>
            Requires tools: {((raw as any).tools as string[]).join(', ') || '(none yet)'} · permissions: {((raw as any).permissions as string[]).join(', ') || 'none'}
          </Text>
        )}
        {errors.length > 0 && (
          <View style={[styles.card, { backgroundColor: c.errorBg, borderColor: c.errorBg }]} accessibilityLiveRegion="polite">
            {errors.map(e => <Text key={e} style={{ color: c.text }}>• {e}</Text>)}
          </View>
        )}
        {message && <Text style={{ color: c.text }} accessibilityLiveRegion="polite">{message}</Text>}
        {savedId && !errors.length && (
          <Pressable style={[styles.chip, styles.self, { borderColor: c.accent }]} accessibilityRole="button" accessibilityLabel={`Test ${kind}`} onPress={() => onTest(savedId)}>
            <Text style={{ color: c.accent }}>Test on a sample</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  title: { fontSize: 18, fontWeight: '600' },
  chip: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, minHeight: 36, justifyContent: 'center' },
  self: { alignSelf: 'flex-start' },
  pad: { padding: 16, gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  card: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 6 },
  label: { fontWeight: '600', marginTop: 10 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  small: { fontSize: 12 },
  bold: { fontWeight: '600' },
});
