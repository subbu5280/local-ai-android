/**
 * M5: language rules, Unicode normalization, Indian-language word forms, evidence, duplicates, tokenizer upgrade,
 * hybrid retrieval with a fake embedder (missing/stale vectors, reuse, delete, cancel/resume), meaning-search state,
 * passage diversity, answer checks and evaluation metrics. Real SQLite (node:sqlite); no real model.
 */
import { sqliteDb } from '../testUtils/sqliteDb';

const mockFs = { e5Installed: false };
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async (p: string) => (p.includes('multilingual-e5') ? mockFs.e5Installed : false)),
  readFile: jest.fn(async () => require('../src/knowledge/embeddings').E5_SMALL.sha256),
  unlink: jest.fn(async () => undefined),
}));
jest.mock('llama.rn', () => ({ releaseAllLlama: jest.fn(async () => undefined) }));

import * as chat from '../src/chatStore';
import { detect } from '../src/core/language';
import * as store from '../src/knowledge/docStore';
import { chunkDocument } from '../src/knowledge/chunker';
import { indicStem, queryTerms, searchForm, tokenize, TOKENIZER_VERSION } from '../src/knowledge/tokens';
import { hasEvidence, isEvidence, search, SEMANTIC_EVIDENCE } from '../src/knowledge/retrieve';
import { retrievePassages } from '../src/knowledge/hybrid';
import { buildVectors, decodeVector, dropVectors, E5_SMALL, encodeVector, normalize, semanticSearch, textHash, vectorStatus, type Embedder } from '../src/knowledge/embeddings';
import * as semantic from '../src/knowledge/semantic';
import { selectPassages } from '../src/knowledge/knowledgePrompt';
import { checkAnswer, runCase } from '../src/eval/answerEval';
import { hitAt, reciprocalRank, scriptShare, summarize } from '../src/eval/metrics';

/**
 * A fake multilingual embedder: words map to "concepts" across languages, the vector counts concepts. Texts sharing a
 * concept are similar, in any language. Deterministic, so tests can assert exact rankings.
 */
const CONCEPTS: Record<string, string[]> = {
  money: ['refund', 'money', 'reimbursement', 'డబ్బు', 'पैसा', 'रिफंड'],
  rice: ['rice', 'paddy', 'వరి', 'harvest', 'కోతకు'],
  library: ['library', 'book', 'ಗ್ರಂಥಾಲಯದ', 'ಪುಸ್ತಕಗಳನ್ನು', 'fine', 'ದಂಡ'],
  kafka: ['kafka', 'topic', 'partition', 'consumer'],
};
class FakeEmbedder implements Embedder {
  readonly modelId = E5_SMALL.id;
  readonly dims = 5;
  calls = 0;
  embed(texts: string[]): Promise<Float32Array[]> {
    this.calls += texts.length;
    return Promise.resolve(texts.map(t => {
      const toks = tokenize(t);
      const v = Object.values(CONCEPTS).map(words => toks.filter(x => words.some(w => x.startsWith(tokenize(w)[0] ?? w))).length);
      return normalize([...v, 0.3]); // a small constant dimension: unrelated texts are not exactly orthogonal
    }));
  }
}

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
let file: string;
beforeEach(async () => {
  const fs = node('fs'), os = node('os'), path = node('path');
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm5-')), 'chat.db');
  chat.setDb(sqliteDb(file));
  mockFs.e5Installed = false;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

async function addDoc(id: string, text: string, name = `${id}.txt`) {
  await store.ensureIndex();
  await store.createDocument({ id, name, format: 'txt', uri: `test://${id}`, mime: null, size: text.length, now: 1 });
  await store.replaceChunks(id, chunkDocument([{ text, page: null }]), { sha256: id, size: text.length, pageCount: null, charCount: text.length, warning: null, now: 1 });
}

// ---------------------------------------------------------------- language (M5 rules)

test('one Indian-script word in an English sentence keeps English; a real share of the script switches', () => {
  expect(detect('What does the word హైదరాబాద్ mean?').code).toBe('en');
  expect(detect('ఈ Kafka architecture ని simple గా explain చేయండి').code).toBe('te');
  expect(detect('What does the word హైదరాబాద్ mean?', 'te').code).toBe('te'); // a Telugu chat stays Telugu
});

test('romanized Tamil, Kannada and Malayalam need two marker words; English words are not markers', () => {
  expect(detect('Kafka pathi konjam sollunga').code).toBe('ta');
  expect(detect('Kafka bagge swalpa heli').code).toBe('kn');
  expect(detect('Kafka ne kurichu onnu parayu').code).toBe('ml');
  expect(detect('Which IDE should I use for Kotlin?').code).toBe('en'); // "ide" is not a Kannada marker
  expect(detect('Alli is my friend from school').code).toBe('en'); // one marker is not enough
  expect(detect('Tamil la sollu', 'en').code).toBe('ta');
  expect(detect('kannada alli heli', 'en').code).toBe('kn');
  expect(detect('malayalam il parayu', 'en').code).toBe('ml');
});

// ---------------------------------------------------------------- normalization and word forms

test('zero-width joiners and the two Malayalam chillu encodings give the same tokens', () => {
  expect(tokenize('హైదరాబాద్‌లో')).toEqual(tokenize('హైదరాబాద్లో'));
  expect(tokenize('അവൻ')).toEqual(tokenize('അവന്‍')); // atomic chillu vs older consonant+virama+ZWJ
  expect(searchForm('Kafka')).toBe('kafka');
  expect(tokenize('Refunds are paid')).toEqual(['refund', 'are', 'paid']); // English plural rule unchanged
});

test('Indian-language query words match other forms through a prefix; the index text is never changed', () => {
  expect(indicStem('రైతులకు')).toBe('రైతు'); // 60% of 7 code points; still matches రైతులు
  expect(indicStem('टिकटों')).toBe('टिकट');
  expect(indicStem('kafka')).toBeNull(); // English: exact words
  expect(indicStem('వరి')).toBeNull(); // short words: exact
  expect(queryTerms('दिल्ली में आज मौसम कैसा है?')).toEqual(['दिल्ली', 'आज', 'मौसम']); // Hindi function words dropped
});

test('word-form tolerance finds inflected Telugu and Kannada queries', async () => {
  await addDoc('rice', 'వర్షాకాలంలో రైతులు వరి నాట్లు వేస్తారు.');
  await addDoc('lib', 'ಗ್ರಂಥಾಲಯದ ನಿಯಮಗಳು. ಪುಸ್ತಕಗಳನ್ನು ಹದಿನಾಲ್ಕು ದಿನಗಳಲ್ಲಿ ಹಿಂತಿರುಗಿಸಬೇಕು.');
  expect((await search('రైతులకు సలహా')).passages[0]?.documentId).toBe('rice');
  expect((await search('ಗ್ರಂಥಾಲಯಕ್ಕೆ ಪುಸ್ತಕ ಹಿಂತಿರುಗಿಸುವುದು')).passages[0]?.documentId).toBe('lib');
});

// ---------------------------------------------------------------- evidence and duplicates

test('one shared common word is not evidence; half the query words or two of them is', async () => {
  await addDoc('refund', 'Customers can request a refund within 30 days of purchase.');
  const museum = await search('Which days is the museum open?');
  expect(museum.passages.length).toBeGreaterThan(0); // the word "days" matches...
  expect(hasEvidence(museum)).toBe(false); // ...but that is not evidence
  expect(hasEvidence(await search('How many days to request a refund?'))).toBe(true);
  expect(isEvidence({ coverage: 0.1, matched: 1, similarity: SEMANTIC_EVIDENCE })).toBe(true); // meaning evidence
});

test('near-duplicate passages (a copied document) are shown once', async () => {
  await addDoc('a', 'Refund policy. Customers can request a refund within 30 days of purchase.');
  await addDoc('b', 'Refund policy (copy). Customers can request a refund within 30 days of purchase.');
  await addDoc('c', 'Shipping takes two days and refunds are handled by support.');
  const r = await search('refund within 30 days');
  const ids = r.passages.map(p => p.documentId);
  expect(ids.filter(id => id === 'a' || id === 'b')).toHaveLength(1);
  expect(ids).toContain('c');
});

test('documents indexed by an older tokenizer are re-indexed at the next start', async () => {
  await addDoc('ml', 'അവൻ വന്നു');
  // Simulate an index written before M5: old version number and tokens with the old chillu form.
  await chat.db().execute("UPDATE meta SET value = '1' WHERE key = 'tokenizer_version'");
  await chat.db().execute("UPDATE chunks_fts SET tokens = 'അവൻ വന്നു'");
  chat.setDb(sqliteDb(file)); // next launch
  await store.ensureIndex();
  expect((await chat.db().query("SELECT value FROM meta WHERE key = 'tokenizer_version'"))[0].value).toBe(String(TOKENIZER_VERSION));
  expect((await search('അവന്‍')).passages[0]?.documentId).toBe('ml');
  const c = await store.counts();
  expect(c.indexRows).toBe(c.chunks);
});

// ---------------------------------------------------------------- vectors and hybrid retrieval

test('vector text encoding round-trips and hashes are stable', () => {
  const v = normalize([0.1, -2, 3.5, 0, 7]);
  expect(Array.from(decodeVector(encodeVector(v)))).toEqual(Array.from(v));
  expect(textHash('abc')).toBe(textHash('abc'));
  expect(textHash('abc')).not.toBe(textHash('abd'));
});

test('without vectors (or without an embedder) retrieval is keyword-only and says so', async () => {
  await addDoc('refund', 'Customers can request a refund within 30 days.');
  const e = new FakeEmbedder();
  expect((await retrievePassages('refund', {})).mode).toBe('keyword');
  expect((await retrievePassages('refund', { embedder: e })).mode).toBe('keyword'); // no vectors built yet
  await buildVectors(e);
  expect((await retrievePassages('refund', { embedder: e })).mode).toBe('hybrid');
});

test('hybrid retrieval finds a cross-language and a synonym match that keywords miss', async () => {
  await addDoc('refund', 'Customers can request a refund within 30 days of purchase.');
  await addDoc('rice', 'వర్షాకాలంలో రైతులు వరి నాట్లు వేస్తారు. నాలుగు నెలలకు కోతకు వస్తుంది.');
  await addDoc('lib', 'ತಡವಾದರೆ ದಿನಕ್ಕೆ ಐದು ರೂಪಾಯಿ ದಂಡ. ಗ್ರಂಥಾಲಯದ ನಿಯಮ.');
  const e = new FakeEmbedder();
  await buildVectors(e);
  expect((await retrievePassages('How long until the rice harvest?', {})).evidence).toEqual([]); // keyword: nothing
  const rice = await retrievePassages('How long until the rice harvest?', { embedder: e });
  expect(rice.evidence[0].documentId).toBe('rice');
  expect(rice.evidence[0].similarity).toBeGreaterThanOrEqual(SEMANTIC_EVIDENCE);
  expect((await retrievePassages('What is the reimbursement window?', { embedder: e })).evidence[0].documentId).toBe('refund');
  expect((await retrievePassages('What is the late fine at the library?', { embedder: e })).evidence[0].documentId).toBe('lib');
  const none = await retrievePassages('What is the boiling point of mercury?', { embedder: e });
  expect(none.evidence).toEqual([]); // unrelated: below the similarity threshold, no keyword match
});

test('reciprocal rank fusion: a passage high in both lists beats one high in only one', async () => {
  await addDoc('kafka', 'Kafka topic partition consumer basics.');
  await addDoc('money', 'Refund money policy.');
  const e = new FakeEmbedder();
  await buildVectors(e);
  const r = await retrievePassages('kafka partition', { embedder: e });
  expect(r.passages[0].documentId).toBe('kafka');
  expect(r.passages[0].score).toBeCloseTo(2 / 61, 5); // rank 1 in both lists: 1/61 + 1/61
});

test('vectors: only missing ones are built, identical text reuses a vector, delete and re-import keep the index consistent', async () => {
  await addDoc('a', 'Refund money rules.');
  await addDoc('b', 'Refund money rules.'); // same text, different document
  const e = new FakeEmbedder();
  expect(await buildVectors(e)).toBe(2);
  expect(e.calls).toBe(1); // the second passage reused the first one's vector
  expect(await buildVectors(e)).toBe(0); // nothing missing
  await store.replaceChunks('a', chunkDocument([{ text: 'Kafka topic notes.', page: null }]), { sha256: 'a2', size: 1, pageCount: null, charCount: 1, warning: null, now: 2 });
  expect(await vectorStatus(e.modelId)).toEqual({ model: e.modelId, passages: 2, embedded: 1 }); // the changed document's vector is gone
  await buildVectors(e);
  await store.deleteDocument('b');
  expect(Number((await chat.db().query('SELECT COUNT(*) AS n FROM chunk_vectors'))[0].n)).toBe(1);
  expect((await semanticSearch(e, 'refund')).map(h => h.documentId)).toEqual(['a']); // no stale hit for the deleted one
});

test('building vectors can be stopped after a batch and continues later; switching models drops the old vectors', async () => {
  for (let i = 0; i < 40; i++) await addDoc(`d${i}`, `Kafka topic number ${i} consumer partition ${i * 7}.`);
  const e = new FakeEmbedder();
  let batches = 0;
  const first = await buildVectors(e, { isCancelled: () => batches > 0, onProgress: () => { batches++; } });
  expect(first).toBe(16); // one batch, then stopped
  expect((await vectorStatus(e.modelId)).embedded).toBe(16);
  expect(await buildVectors(e)).toBe(24); // the rest
  await dropVectors(e.modelId);
  expect((await vectorStatus(e.modelId)).embedded).toBe(0);
  expect((await retrievePassages('kafka', { embedder: e })).mode).toBe('keyword');
});

test('meaning search is active only when installed, switched on and built', async () => {
  await addDoc('refund', 'Refund money rules.');
  const e = new FakeEmbedder();
  semantic.setEmbedderFactory(() => e);
  expect(await semantic.activeEmbedder()).toBeNull(); // not installed
  mockFs.e5Installed = true;
  await semantic.setEnabled(true); // starts a build
  await semantic.settled();
  expect(await semantic.activeEmbedder()).toBe(e);
  expect((await semantic.getState()).status).toEqual({ model: E5_SMALL.id, passages: 1, embedded: 1 });
  await semantic.setEnabled(false);
  expect(await semantic.activeEmbedder()).toBeNull(); // switched off: keyword only, vectors kept
  expect((await vectorStatus(E5_SMALL.id)).embedded).toBe(1);
  await semantic.remove();
  expect((await vectorStatus(E5_SMALL.id)).embedded).toBe(0);
});

// ---------------------------------------------------------------- passages for the model

test('passage selection lets several documents be heard before one document gets more', () => {
  const p = (id: number, doc: string) => ({ chunkId: id, documentId: doc, name: `${doc}.txt`, ordinal: id, page: null, text: `text ${id}`,
    score: 10 - id, excerpt: '', matched: 1, coverage: 1 });
  const chosen = selectPassages([p(1, 'a'), p(2, 'a'), p(3, 'a'), p(4, 'b'), p(5, 'a')]);
  expect(chosen.map(c => c.passage.chunkId)).toEqual([1, 2, 3, 4]); // b's passage included; ranks kept
  expect(chosen.filter(c => c.passage.documentId === 'a')).toHaveLength(3); // a got its third only in the second pass
});

// ---------------------------------------------------------------- evaluation helpers

test('answer checks: script share, citations, not-found phrases, required facts', () => {
  const docs = { id: 'x', lang: 'te' as const, kind: 'docs', mode: 'docs' as const, input: 'q', mustCite: true, mustMention: [['నాలుగు', '4']] };
  expect(checkAnswer(docs, 'పంట నాలుగు నెలలకు వస్తుంది [1].', 1).every(c => c.ok)).toBe(true);
  const bad = checkAnswer(docs, 'The crop is ready soon [3].', 1);
  expect(bad.filter(c => !c.ok).map(c => c.name)).toEqual(['language', 'citations valid', 'cites a source', 'mentions నాలుగు']);
  const nf = { id: 'y', lang: 'en' as const, kind: 'insufficient', mode: 'docs' as const, input: 'q', expectNotFound: true };
  expect(checkAnswer(nf, "The documents don't say who approves it.", 2).find(c => c.name === 'says not found')?.ok).toBe(true);
  expect(checkAnswer(nf, 'The manager approves it.', 2).find(c => c.name === 'says not found')?.ok).toBe(false);
});

test('answer cases go through the app prompts: chat keeps the language, docs get fenced passages', async () => {
  const prompts: string[] = [];
  const gen = async (prompt: string) => { prompts.push(prompt); return { text: 'ok [1]', totalMs: 5, tokPerSec: 9, firstTokenMs: 1 }; };
  const corpus = [{ id: 'refund-en', name: 'refund-policy.txt', text: 'Refunds within 30 days.' }];
  await runCase({ id: 'f', lang: 'te', kind: 'follow_up', mode: 'chat', input: 'ok', history: [{ role: 'user', content: 'కాఫ్కా', lang: 'te' }] }, corpus, gen);
  expect(prompts[0]).toMatch(/^Language: Respond in Telugu/);
  const r = await runCase({ id: 'd', lang: 'en', kind: 'docs', mode: 'docs', input: 'How many days?', passages: ['refund-en'], mustCite: true }, corpus, gen);
  expect(prompts[1]).toContain('<<<SOURCES\n[1] (refund-policy.txt, passage 1)\nRefunds within 30 days.');
  expect(r.checks.find(c => c.name === 'citations valid')?.ok).toBe(true);
  expect((await runCase({ id: 'e', lang: 'en', kind: 'docs', mode: 'docs', input: 'q', passages: ['missing'] }, corpus, gen)).error).toMatch(/unknown corpus document/);
});

test('retrieval metrics: hit@k, reciprocal rank, false evidence', () => {
  expect(hitAt(['b', 'a'], ['a'], 1)).toBe(0);
  expect(hitAt(['b', 'a'], ['a'], 3)).toBe(1);
  expect(reciprocalRank(['c', 'b', 'a'], ['a'])).toBeCloseTo(1 / 3);
  const s = summarize([{ id: 'q1', kind: 'exact', relevant: ['a'] }, { id: 'q2', kind: 'no_evidence', relevant: [] }],
    [{ caseId: 'q1', ranked: ['a'], evidence: true }, { caseId: 'q2', ranked: ['x'], evidence: true }]);
  expect(s).toMatchObject({ queries: 1, hit1: 1, falseEvidence: 1, missedEvidence: 0 });
  expect(scriptShare('నమస్కారం hello', [[0xc00, 0xc7f]])).toBeCloseTo(8 / 13, 2);
});
