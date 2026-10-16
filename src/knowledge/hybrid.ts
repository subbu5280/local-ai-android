/**
 * Retrieval for questions and the search screen: keyword search always, plus meaning search when an embedder with
 * vectors is available. The result says which one actually ran (`mode`), so the app never calls keyword matching
 * "semantic".
 *
 * Fusion: Reciprocal Rank Fusion. Each passage scores sum(1 / (RRF_K + rank)) over the lists it appears in (keyword
 * rank by BM25, meaning rank by cosine), so neither list's raw scores need calibrating against the other. A passage
 * counts as evidence by its own keyword coverage or by its similarity (retrieve.isEvidence).
 */
import { db } from '../chatStore';
import { semanticSearch, type Embedder } from './embeddings';
import { dedupe, isEvidence, search, type Passage, type SearchOutcome } from './retrieve';
import { tokenize } from './tokens';

export const RRF_K = 60;
const CANDIDATES = 30;

export type RetrievalMode = 'keyword' | 'hybrid';
export type RetrievalResult = SearchOutcome & {
  mode: RetrievalMode;
  /** Highest cosine similarity seen (hybrid only). */
  bestSimilarity: number | null;
  /** Passages that count as evidence (retrieve.isEvidence), best first. Empty = honestly nothing to answer from. */
  evidence: Passage[];
};

/**
 * Search passages for `query`.
 * @param opts.embedder meaning search; when null/undefined, or when no passage has a vector yet, keyword only
 */
/** Weight of query-term coverage in the optional re-rank (M11; see RERANK_DEFAULT for whether the app uses it). */
export const RERANK_COVERAGE_WEIGHT = 0.02;
/** Whether the app re-ranks hybrid results; set from the retrieval evaluation (eval/results/retrieval-m11*.md). */
export const RERANK_DEFAULT = false;

export async function retrievePassages(query: string, opts: { documentIds?: string[] | null; limit?: number; embedder?: Embedder | null; rerank?: boolean } = {}): Promise<RetrievalResult> {
  const limit = opts.limit ?? 20;
  const kw = await search(query, { documentIds: opts.documentIds, limit: CANDIDATES });
  const keywordOnly = (): RetrievalResult => {
    const passages = kw.passages.slice(0, limit);
    return { ...kw, passages, mode: 'keyword', bestSimilarity: null, evidence: passages.filter(isEvidence) };
  };
  if (!opts.embedder || (opts.documentIds && opts.documentIds.length === 0)) return keywordOnly();
  const sem = await semanticSearch(opts.embedder, query, { documentIds: opts.documentIds, limit: CANDIDATES });
  if (!sem.length) return keywordOnly(); // no vectors yet: say "keyword", not "hybrid"

  const fused = new Map<number, { score: number; kw?: Passage; similarity?: number }>();
  kw.passages.forEach((p, i) => fused.set(p.chunkId, { score: 1 / (RRF_K + i + 1), kw: p }));
  sem.forEach((h, i) => {
    const e = fused.get(h.chunkId) ?? { score: 0 };
    fused.set(h.chunkId, { ...e, score: e.score + 1 / (RRF_K + i + 1), similarity: h.similarity });
  });
  // Passage details for meaning-only hits (keyword hits already carry them).
  const missing = [...fused.entries()].filter(([, e]) => !e.kw).map(([id]) => id);
  const details = new Map<number, any>();
  if (missing.length) {
    const rows = await db().query(`SELECT c.id, c.document_id, c.ordinal, c.page, c.text, d.name FROM chunks c JOIN documents d ON d.id = c.document_id
      WHERE d.status = 'ready' AND c.id IN (${missing.map(() => '?').join(', ')})`, missing);
    rows.forEach(r => details.set(Number(r.id), r));
  }
  const ranked: (Passage & { tokens: string[]; similarity?: number })[] = [...fused.entries()].flatMap(([id, e]) => {
    if (e.kw) return [{ ...e.kw, score: e.score, similarity: e.similarity, tokens: tokenize(e.kw.text) }];
    const r = details.get(id);
    if (!r) return []; // removed meanwhile
    return [{ chunkId: id, documentId: r.document_id, name: r.name, ordinal: Number(r.ordinal), page: r.page == null ? null : Number(r.page),
      text: r.text, score: e.score, excerpt: r.text.replace(/\s+/g, ' ').slice(0, 240) + (r.text.length > 240 ? '…' : ''),
      matched: 0, coverage: 0, similarity: e.similarity, tokens: tokenize(r.text) }];
  });
  // M11 optional re-rank: add the fraction of query terms the passage contains, so a passage that matches the meaning
  // AND the words can move above one that only matches the meaning. Evaluated before being switched on.
  if (opts.rerank ?? RERANK_DEFAULT) {
    const q = [...new Set(tokenize(query))];
    for (const p of ranked) { const t = new Set(p.tokens); p.score += RERANK_COVERAGE_WEIGHT * (q.length ? q.filter(x => t.has(x)).length / q.length : 0); }
  }
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.ordinal - b.ordinal);
  const passages = dedupe(ranked).slice(0, limit).map(({ tokens: _, ...p }) => p as Passage);
  return { ...kw, passages, mode: 'hybrid', bestSimilarity: sem[0].similarity, evidence: passages.filter(isEvidence) };
}
