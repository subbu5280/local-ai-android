/**
 * Answer-quality evaluation (answers-v1.json), run on the phone with the real model (EvalScreen, or
 * scripts/device-check.ps1 -Eval). Each case goes through the app's own prompt code (chat: core/prompt; docs: the
 * Docs-mode prompt with fixed passages) and the answer gets deterministic checks:
 *
 * - language: share of letters in the expected script (>= 0.5; English: >= 0.8 Latin);
 * - citations: every [n] refers to a given source, and docs cases cite at least one;
 * - not found: insufficient-evidence cases say the documents don't contain it (phrase lists: heuristic);
 * - mentions: required facts appear (keyword alternatives: heuristic, misses paraphrases and other numerals).
 *
 * These checks are approximate signals, not proof of quality; correctness and faithfulness are left to a reviewer,
 * who gets the answer text next to the expectations. Nothing here treats a generated answer as ground truth.
 */
import { buildPrompt } from '../core/prompt';
import type { LangCode } from '../core/language';
import { buildKnowledgePrompt, selectPassages } from '../knowledge/knowledgePrompt';
import type { Passage } from '../knowledge/retrieve';
import { scriptShare } from './metrics';

export type AnswerCase = {
  id: string; lang: LangCode; kind: string; mode: 'chat' | 'docs'; input: string;
  history?: { role: 'user' | 'assistant'; content: string; lang?: LangCode }[];
  passages?: string[]; mustCite?: boolean; expectNotFound?: boolean; mustMention?: string[][];
};
export type CorpusDoc = { id: string; name: string; text: string };
export type Generate = (prompt: string, history: { role: 'user' | 'assistant'; content: string }[]) =>
  Promise<{ text: string; totalMs: number; tokPerSec: number; firstTokenMs: number }>;

export type Check = { name: string; ok: boolean; detail: string };
export type CaseResult = { id: string; lang: LangCode; kind: string; answer: string; checks: Check[]; ms: number; tokPerSec: number; firstTokenMs: number; error?: string };

export const SCRIPT_RANGES: Record<LangCode, [number, number][]> = {
  en: [[0x41, 0x5a], [0x61, 0x7a]], hi: [[0x900, 0x97f]], te: [[0xc00, 0xc7f]], ta: [[0xb80, 0xbff]], kn: [[0xc80, 0xcff]], ml: [[0xd00, 0xd7f]],
};

/** Phrases that say "the documents don't contain this" (approximate; models phrase it many ways). */
const NOT_FOUND: RegExp[] = [
  /\b(do(es)?n['’]?t|do(es)? not|don't) (say|mention|contain|include|specify|provide)|\bnot (mentioned|stated|specified|provided|found|available)|\bno (information|mention)/i,
  /नहीं (बताया|दिया|है|मिल|लिखा)|जानकारी नहीं|उल्लेख नहीं/, /చెప్పలేదు|లేదు|సమాచారం లేదు|పేర్కొనలేదు/,
  /இல்லை|குறிப்பிடப்படவில்லை|தெரிவிக்கவில்லை/, /ಇಲ್ಲ|ಹೇಳಿಲ್ಲ|ಮಾಹಿತಿ ಇಲ್ಲ/, /ഇല്ല|പറയുന്നില്ല|പരാമർശിക്കുന്നില്ല/,
];

/** The deterministic checks for one answer. */
export function checkAnswer(c: AnswerCase, answer: string, sourceCount: number): Check[] {
  const checks: Check[] = [];
  const share = scriptShare(answer, SCRIPT_RANGES[c.lang]);
  const need = c.lang === 'en' ? 0.8 : 0.5;
  checks.push({ name: 'language', ok: share >= need, detail: `${Math.round(share * 100)}% of letters in the ${c.lang} script (need ${need * 100}%)` });
  if (c.mode === 'docs') {
    const cited = [...answer.matchAll(/\[(\d{1,2})\]/g)].map(m => Number(m[1]));
    const invalid = cited.filter(n => n < 1 || n > sourceCount);
    checks.push({ name: 'citations valid', ok: invalid.length === 0, detail: invalid.length ? `cites missing source(s) ${invalid.join(', ')}` : `${cited.length} citation(s)` });
    if (c.mustCite) checks.push({ name: 'cites a source', ok: cited.length > invalid.length, detail: cited.length ? 'yes' : 'no citation' });
  }
  if (c.expectNotFound) {
    const said = NOT_FOUND.some(rx => rx.test(answer));
    checks.push({ name: 'says not found', ok: said, detail: said ? 'states the documents do not contain it' : 'no "not found" phrase detected (heuristic)' });
  }
  for (const alts of c.mustMention ?? []) {
    const hit = alts.find(a => answer.toLowerCase().includes(a.toLowerCase()));
    checks.push({ name: `mentions ${alts[0]}`, ok: !!hit, detail: hit ? `found "${hit}"` : `none of: ${alts.join(' / ')} (heuristic)` });
  }
  return checks;
}

/** Passages for a docs case: each listed corpus document as one passage (fixed input, no retrieval). */
function passagesFor(c: AnswerCase, corpus: CorpusDoc[]): Passage[] {
  return (c.passages ?? []).map((id, i) => {
    const d = corpus.find(x => x.id === id);
    if (!d) throw new Error(`unknown corpus document ${id}`);
    return { chunkId: -(i + 1), documentId: d.id, name: d.name, ordinal: 0, page: null, text: d.text, score: 1, excerpt: '', matched: 1, coverage: 1 };
  });
}

/** Run one case through the app's prompt code and the given model; never throws (errors become a failed result). */
export async function runCase(c: AnswerCase, corpus: CorpusDoc[], generate: Generate): Promise<CaseResult> {
  try {
    let prompt: string;
    let sources = 0;
    const previous = [...(c.history ?? [])].reverse().find(h => h.role === 'user')?.lang ?? null;
    if (c.mode === 'docs') {
      const chosen = selectPassages(passagesFor(c, corpus));
      const kp = buildKnowledgePrompt(c.input, chosen, previous);
      prompt = kp.prompt;
      sources = kp.sources.length;
    } else {
      prompt = buildPrompt(c.input, previous).prompt;
    }
    const history = c.mode === 'chat' ? (c.history ?? []).map(h => ({ role: h.role, content: h.content })) : [];
    const r = await generate(prompt, history);
    const answer = r.text.trim();
    return { id: c.id, lang: c.lang, kind: c.kind, answer, checks: checkAnswer(c, answer, sources), ms: r.totalMs, tokPerSec: r.tokPerSec, firstTokenMs: r.firstTokenMs };
  } catch (e: any) {
    return { id: c.id, lang: c.lang, kind: c.kind, answer: '', checks: [], ms: 0, tokPerSec: 0, firstTokenMs: 0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Passed-check counts per language (for the summary line). */
export function summarizeAnswers(results: CaseResult[]): Record<string, { cases: number; checks: number; passed: number; errors: number }> {
  const out: Record<string, { cases: number; checks: number; passed: number; errors: number }> = {};
  for (const r of results) {
    const s = (out[r.lang] ??= { cases: 0, checks: 0, passed: 0, errors: 0 });
    s.cases++;
    s.checks += r.checks.length;
    s.passed += r.checks.filter(c => c.ok).length;
    if (r.error) s.errors++;
  }
  return out;
}

