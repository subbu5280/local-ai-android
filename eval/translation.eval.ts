/**
 * Translation evaluation (M13): the app's own model (Qwen2.5 1.5B Q4_K_M) through the app's own prompt (buildPrompt +
 * the chat system message, temperature 0.2) on llama-server, English <-> Telugu/Hindi/Tamil/Kannada/Malayalam.
 * Scores: chrF (character 6-gram F-score, 0-100) against one reference, and whether the reply is in the target script.
 * Run: scripts/eval-translation.ps1 (starts llama-server; needs LOCALAI_CHAT_URL).
 */
import dataset from './datasets/translation-v1.json';
import { buildPrompt } from '../src/core/prompt';
import { label, table, writeReport } from './report';

const URL = (globalThis as any).process.env.LOCALAI_CHAT_URL as string | undefined;
const NAMES: Record<string, string> = { te: 'Telugu', hi: 'Hindi', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', en: 'English' };
const SCRIPT: Record<string, RegExp> = { te: /[ఀ-౿]/g, hi: /[ऀ-ॿ]/g, ta: /[஀-௿]/g, kn: /[ಀ-೿]/g, ml: /[ഀ-ൿ]/g, en: /[A-Za-z]/g };

/** chrF (n = 1..6, beta = 2, spaces removed), as in sacrebleu's default. */
export function chrF(hyp: string, ref: string): number {
  const h = hyp.replace(/\s+/g, ''), r = ref.replace(/\s+/g, '');
  let p = 0, rc = 0, n = 0;
  for (let k = 1; k <= 6; k++) {
    const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i + k <= s.length; i++) m.set(s.slice(i, i + k), (m.get(s.slice(i, i + k)) ?? 0) + 1); return m; };
    const hg = grams(h), rg = grams(r);
    const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    if (!total(hg) || !total(rg)) continue;
    let match = 0; for (const [g, c] of hg) match += Math.min(c, rg.get(g) ?? 0);
    p += match / total(hg); rc += match / total(rg); n++;
  }
  if (!n) return 0;
  p /= n; rc /= n;
  return p + rc ? (100 * 5 * p * rc) / (4 * p + rc) : 0;
}

async function ask(text: string): Promise<string> {
  const { prompt } = buildPrompt(text, null);
  const res = await fetch(`${URL}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'system', content: 'You are a concise, helpful assistant.' }, { role: 'user', content: prompt }],
      temperature: 0.2, seed: 1, max_tokens: 120 }),
  });
  return ((await res.json()).choices[0].message.content as string).trim();
}

const inScript = (text: string, lang: string) => {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '').length;
  return letters > 0 && (text.match(SCRIPT[lang]) ?? []).length / letters >= 0.8;
};

test('chrF sanity', () => {
  expect(chrF('abc def', 'abc def')).toBeCloseTo(100);
  expect(chrF('xyz', 'abc')).toBe(0);
});

(URL ? test : test.skip)('translation evaluation', async () => {
  const rows: { id: string; dir: string; source: string; reference: string; output: string; chrf: number; script: boolean }[] = [];
  for (const c of dataset.cases as Record<string, string>[]) {
    for (const lang of ['te', 'hi', 'ta', 'kn', 'ml']) {
      for (const [from, to] of [['en', lang], [lang, 'en']]) {
        const output = await ask(`Translate to ${NAMES[to]}: "${c[from]}"`);
        rows.push({ id: c.id, dir: `${from}→${to}`, source: c[from], reference: c[to], output, chrf: Math.round(chrF(output, c[to])), script: inScript(output, to) });
      }
    }
  }
  const mean = (xs: typeof rows) => (xs.reduce((a, r) => a + r.chrf, 0) / xs.length).toFixed(1);
  const scriptOk = (xs: typeof rows) => `${xs.filter(r => r.script).length}/${xs.length}`;
  const dirs = [...new Set(rows.map(r => r.dir))];
  const md = [
    `# Translation evaluation (${label()}, dataset v${dataset.version})`, '',
    'Model: Qwen2.5 1.5B Instruct Q4_K_M (the app\'s chat model), app prompt, temperature 0.2. chrF 0–100 against one reference.', '',
    table(['direction', 'mean chrF', 'reply in target script'], dirs.map(d => [d, mean(rows.filter(r => r.dir === d)), scriptOk(rows.filter(r => r.dir === d))])), '',
    '## All outputs', '',
    table(['id', 'direction', 'output', 'reference', 'chrF'], rows.map(r => [r.id, r.dir, r.output.replace(/\n/g, ' ').replace(/\|/g, '/'), r.reference, r.chrf])),
  ].join('\n');
  writeReport('translation', { label: label(), rows }, md);
}, 1_800_000);
