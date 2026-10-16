/**
 * Retrieval evaluation: the retrieval-v1 corpus is indexed with the app's own chunker and SQLite index (node:sqlite),
 * every query is searched, and the ranked documents are scored against the hand-labelled relevant documents.
 * Keyword search runs always; if LOCALAI_EMBED_URL points at a llama.cpp server with an embedding model, the
 * embedding and hybrid variants are measured too (see eval/README.md).
 *
 * Run: npm run eval -- retrieval   (EVAL_LABEL=name to label the report)
 */
// The native model runtime and file system don't exist in Node; the evaluation embeds through llama-server instead.
jest.mock('llama.rn', () => ({}));
jest.mock('@dr.pogodin/react-native-fs', () => ({ DocumentDirectoryPath: '/docs' }));
import dataset from './datasets/retrieval-v1.json';
import { sqliteDb } from '../testUtils/sqliteDb';
import * as chat from '../src/chatStore';
import * as store from '../src/knowledge/docStore';
import { chunkDocument } from '../src/knowledge/chunker';
import { textFor, detectFormat } from '../src/knowledge/text';
import * as retrieve from '../src/knowledge/retrieve';
import { summarize, summarizeByKind, type RetrievalRun } from '../src/eval/metrics';
import { retrievePassages } from '../src/knowledge/hybrid';
import { buildVectors, E5_SMALL, normalize, semanticSearch, type Embedder } from '../src/knowledge/embeddings';
import { label, table, writeReport } from './report';

type Variant = { name: string; run: (query: string) => Promise<{ passages: retrieve.Passage[]; evidence: boolean }> };

async function indexCorpus() {
  chat.setDb(sqliteDb());
  await store.ensureIndex();
  for (const d of dataset.documents) {
    const format = detectFormat(d.name, null) ?? 'txt';
    await store.createDocument({ id: d.id, name: d.name, format, uri: `eval://${d.id}`, mime: null, size: d.text.length, now: 1 });
    const text = textFor(format as 'txt' | 'md' | 'csv', d.text);
    await store.replaceChunks(d.id, chunkDocument([{ text, page: null }]), { sha256: d.id, size: d.text.length, pageCount: null, charCount: text.length, warning: null, now: 1 });
  }
}

/**
 * The same embedding model as the app, served by llama.cpp's llama-server (build b10256 = the llama.cpp in llama.rn
 * 0.12.9) at LOCALAI_EMBED_URL, e.g. http://127.0.0.1:8091. Same e5 prefixes, mean pooling, unit-length vectors.
 */
class HttpEmbedder implements Embedder {
  readonly modelId = E5_SMALL.id;
  readonly dims = E5_SMALL.dims;
  constructor(private url: string) {}
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const http = (globalThis as any).process.getBuiltinModule('http');
    const body = JSON.stringify({ input: texts.map(t => `${E5_SMALL.prefix[kind]}${t}`) });
    return new Promise((resolve, reject) => {
      const req = http.request(`${this.url}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res: any) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data).data.map((d: any) => normalize(d.embedding))); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
}

const embedUrl = (): string | undefined => (globalThis as any).process.env.LOCALAI_EMBED_URL;
const bestSimilarity = new Map<string, number>(); // query id -> best cosine (to calibrate SEMANTIC_EVIDENCE)

const variants = (embedder: Embedder | null): Variant[] => {
  const v: Variant[] = [{ name: 'keyword', run: async q => { const r = await retrievePassages(q, { limit: 10 }); return { passages: r.passages, evidence: r.evidence.length > 0 }; } }];
  if (!embedder) return v;
  return [...v,
    { name: 'semantic only', run: async q => {
      const hits = await semanticSearch(embedder, q, { limit: 10 });
      const r = await retrievePassages(q, { limit: 30, embedder }); // for passage details of the hits
      const byId = new Map(r.passages.map(p => [p.chunkId, p]));
      const passages = hits.map(h => byId.get(h.chunkId)).filter(Boolean) as retrieve.Passage[];
      return { passages, evidence: (hits[0]?.similarity ?? 0) >= retrieve.SEMANTIC_EVIDENCE };
    } },
    { name: 'hybrid', run: async q => { const r = await retrievePassages(q, { limit: 10, embedder }); return { passages: r.passages, evidence: r.evidence.length > 0 }; } },
    { name: 'hybrid + rerank', run: async q => { const r = await retrievePassages(q, { limit: 10, embedder, rerank: true }); return { passages: r.passages, evidence: r.evidence.length > 0 }; } },
  ];
};

test('retrieval evaluation', async () => {
  await indexCorpus();
  const url = embedUrl();
  const embedder = url ? new HttpEmbedder(url) : null;
  if (embedder) {
    const t0 = Date.now();
    const n = await buildVectors(embedder);
    const ms = Date.now() - t0;
    for (const q of dataset.queries) bestSimilarity.set(q.id, (await semanticSearch(embedder, q.query, { limit: 1 }))[0]?.similarity ?? 0);
    (globalThis as any).__embedStats = { passages: n, ms };
  }
  const report: Record<string, unknown> = { label: label(), version: dataset.version };
  const mdParts: string[] = [`# Retrieval evaluation (${label()}, dataset v${dataset.version})`, ''];
  for (const variant of variants(embedder)) {
    const runs: (RetrievalRun & { ms: number; top: string[] })[] = [];
    for (const q of dataset.queries) {
      const t0 = Date.now();
      const r = await variant.run(q.query);
      const ranked = [...new Set(r.passages.map(p => p.documentId))];
      const top3 = r.passages.slice(0, 3);
      // The two refund documents differ only in their title line: compare passages without it, whitespace-normalized.
      const body = (t: string) => t.replace(/\(2024 copy\)/, '').replace(/\s+/g, ' ').trim();
      const dup = q.kind === 'duplicate' ? top3.some(a => top3.some(b => a !== b && a.documentId !== b.documentId && body(a.text) === body(b.text))) : undefined;
      runs.push({ caseId: q.id, ranked, evidence: r.evidence, duplicateInTop3: dup, ms: Date.now() - t0, top: ranked.slice(0, 3) });
    }
    const all = summarize(dataset.queries, runs);
    const byKind = summarizeByKind(dataset.queries, runs);
    report[variant.name] = { all, byKind, runs };
    mdParts.push(`## ${variant.name}`, '',
      `Answerable queries ${all.queries}: hit@1 ${all.hit1}, hit@3 ${all.hit3}, MRR ${all.mrr}, no evidence reported ${all.missedEvidence}. ` +
      `No-evidence queries ${all.noEvidenceQueries}: evidence wrongly reported ${all.falseEvidence}. Duplicate pair in top 3: ${all.duplicateInTop3}. ` +
      `Mean laptop latency ${Math.round(runs.reduce((n, r) => n + r.ms, 0) / runs.length)} ms/query.`, '',
      table(['kind', 'queries', 'hit@1', 'hit@3', 'MRR', 'false evidence'], Object.entries(byKind).map(([k, s]) =>
        [k, k === 'no_evidence' ? s.noEvidenceQueries : s.queries, s.queries ? s.hit1 : '-', s.queries ? s.hit3 : '-', s.queries ? s.mrr : '-',
          s.noEvidenceQueries ? s.falseEvidence : '-'])), '',
      '<details><summary>Per query</summary>', '',
      table(['query', 'kind', 'relevant', 'top 3 documents', 'evidence'], dataset.queries.map(q => {
        const r = runs.find(x => x.caseId === q.id)!;
        return [q.id, q.kind, q.relevant.join(', ') || '(none)', r.top.join(', ') || '(none)', r.evidence ? 'yes' : 'no'];
      })), '', '</details>', '');
  }
  if (embedder) {
    const stats = (globalThis as any).__embedStats;
    const sims = dataset.queries.map(q => ({ id: q.id, kind: q.kind, answerable: q.relevant.length > 0, best: Math.round((bestSimilarity.get(q.id) ?? 0) * 1000) / 1000 }));
    report.embedding = { model: E5_SMALL.id, server: url, indexed: stats, bestSimilarity: sims, threshold: retrieve.SEMANTIC_EVIDENCE };
    const ans = sims.filter(s => s.answerable).map(s => s.best).sort((a, b) => a - b);
    const none = sims.filter(s => !s.answerable).map(s => s.best).sort((a, b) => a - b);
    mdParts.push('## Embedding details', '',
      `Model ${E5_SMALL.id} via ${url}. Indexed ${stats.passages} passages in ${stats.ms} ms on the laptop (not a phone measurement).`,
      `Best cosine per query: answerable min ${ans[0]} / median ${ans[Math.floor(ans.length / 2)]}; no-evidence max ${none[none.length - 1]} / median ${none[Math.floor(none.length / 2)]}. ` +
      `Evidence threshold in use: ${retrieve.SEMANTIC_EVIDENCE}.`, '',
      table(['query', 'kind', 'answerable', 'best cosine'], sims.map(s => [s.id, s.kind, s.answerable ? 'yes' : 'no', s.best])), '');
  }
  writeReport('retrieval', report, mdParts.join('\n'));
}, 600000);
