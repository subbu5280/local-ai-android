/**
 * Keyword search over document passages.
 *
 * 1. The query is turned into units: words, "quoted phrases" and prefix* words, using the same tokenizer as the index.
 *    The user's text never reaches SQLite's MATCH syntax directly: every unit is rebuilt from tokens and quoted, so
 *    quotes, brackets, AND/OR/NOT or a stray * can't break the query.
 * 2. The full-text index (FTS5 or FTS4) finds candidate passages containing any unit.
 * 3. Candidates are ranked here, the same way on both engines, by BM25 (k1 1.2, b 0.75; document frequency from the
 *    index, passage length in words) times a coverage factor (0.5 + 0.5 x share of query units the passage contains),
 *    so a passage matching all of the question's words beats one repeating a single word.
 *
 * Interface (`Retriever`) is kept small so a semantic (embedding) retriever can be added and combined later without
 * changing the document library.
 */
import { db } from '../chatStore';
import { ensureIndex, type FtsEngine } from './docStore';
import { indicStem, queryTerms, searchForm, tokenize } from './tokens';

export type Passage = {
  chunkId: number; documentId: string; name: string; ordinal: number; page: number | null;
  text: string; score: number; excerpt: string;
  /** How many of the query's units (words, phrases, prefixes) the passage contains, and that as a share (0..1). */
  matched: number; coverage: number;
  /** Cosine similarity to the question, when meaning search took part (hybrid.ts); absent for keyword-only results. */
  similarity?: number;
};
export type SearchOutcome = { engine: FtsEngine; terms: string[]; passages: Passage[] };
export type SearchOptions = { documentIds?: string[] | null; limit?: number };
export interface Retriever { search(query: string, options?: SearchOptions): Promise<SearchOutcome> }

type Unit = { kind: 'term' | 'prefix' | 'phrase'; tokens: string[] };

const K1 = 1.2;
const B = 0.75;
const CANDIDATES = 300;
const MAX_UNITS = 12;

/** Words, "phrases" and prefix* words of a query, as index tokens. Unusable input gives no units. */
export function parseQuery(query: string): Unit[] {
  const units: Unit[] = [];
  const seen = new Set<string>();
  const add = (u: Unit) => {
    const key = `${u.kind}:${u.tokens.join(' ')}`;
    if (u.tokens.length && !seen.has(key) && units.length < MAX_UNITS) { seen.add(key); units.push(u); }
  };
  const loose: string[] = [];
  for (const m of query.matchAll(/"([^"]*)"?|(\S+)/g)) {
    if (m[1] !== undefined) {
      const toks = tokenize(m[1]);
      add(toks.length > 1 ? { kind: 'phrase', tokens: toks } : { kind: 'term', tokens: toks });
    } else if (/\*$/.test(m[2]) && tokenize(m[2]).length) {
      const toks = tokenize(m[2]);
      toks.slice(0, -1).forEach(t => add({ kind: 'term', tokens: [t] }));
      add({ kind: 'prefix', tokens: [toks[toks.length - 1]] });
    } else {
      loose.push(m[2]);
    }
  }
  // Indian-language words also match their other forms through a prefix (M5, tokens.indicStem); English words exact.
  for (const t of queryTerms(loose.join(' '))) {
    const stem = indicStem(t);
    add(stem ? { kind: 'prefix', tokens: [stem] } : { kind: 'term', tokens: [t] });
  }
  return units;
}

/** The MATCH expression for one unit (tokens never contain quotes, so quoting is always safe). */
function matchUnit(u: Unit, engine: FtsEngine): string {
  if (u.kind === 'prefix') return engine === 'fts5' ? `"${u.tokens[0]}"*` : `"${u.tokens[0]}*"`;
  return `"${u.tokens.join(' ')}"`;
}

/** How often a unit occurs in a passage's tokens. */
function frequency(u: Unit, tokens: string[]): number {
  let n = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (u.kind === 'term') n += tokens[i] === u.tokens[0] ? 1 : 0;
    else if (u.kind === 'prefix') n += tokens[i].startsWith(u.tokens[0]) ? 1 : 0;
    else if (u.tokens.every((t, j) => tokens[i + j] === t)) n++;
  }
  return n;
}

/** A ~240-character window of `text` around the first query word it contains, cut at word boundaries. */
export function excerpt(text: string, units: Unit[], width = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = searchForm(flat); // same normalization as the tokens (joiners removed, so positions can shift slightly)
  const hits = units.map(u => lower.indexOf(u.tokens[0])).filter(i => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  let start = Math.max(0, at - Math.floor(width / 3));
  let end = Math.min(flat.length, start + width);
  if (start > 0) { const s = flat.indexOf(' ', start); if (s >= 0 && s < at) start = s + 1; }
  if (end < flat.length) { const e = flat.lastIndexOf(' ', end); if (e > at) end = e; }
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Search passages of ready documents.
 * @param query what the user typed (any text; it is never passed to SQLite as syntax)
 * @param options.documentIds limit to these documents (null/undefined = whole library)
 * @param options.limit most passages returned (default 20)
 */
export async function search(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
  const engine = await ensureIndex();
  const units = parseQuery(query);
  const terms = units.map(u => u.tokens.join(' '));
  if (engine === 'none' || units.length === 0) return { engine, terms, passages: [] };
  if (options.documentIds && options.documentIds.length === 0) return { engine, terms, passages: [] };
  const scope = options.documentIds?.length ? ` AND d.id IN (${options.documentIds.map(() => '?').join(', ')})` : '';
  const expr = units.map(u => matchUnit(u, engine)).join(' OR ');
  const rows = await db().query(
    `SELECT c.id, c.document_id, c.ordinal, c.page, c.text, c.word_count, d.name, f.tokens
     FROM chunks_fts f JOIN chunks c ON c.id = f.rowid JOIN documents d ON d.id = c.document_id
     WHERE chunks_fts MATCH ? AND d.status = 'ready'${scope} LIMIT ${CANDIDATES}`,
    [expr, ...(options.documentIds ?? [])]);
  if (rows.length === 0) return { engine, terms, passages: [] };

  // Corpus statistics for BM25: number of indexed passages, their mean length, and each unit's document frequency.
  const stats = (await db().query("SELECT COUNT(*) AS n, AVG(word_count) AS avg FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.status = 'ready'"))[0];
  const n = Math.max(1, Number(stats?.n ?? 1));
  const avg = Math.max(1, Number(stats?.avg ?? 1));
  const idf: number[] = [];
  for (const u of units) {
    const df = Number((await db().query('SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?', [matchUnit(u, engine)]))[0]?.n ?? 0);
    idf.push(Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  const passages = rows.map(r => {
    const tokens = String(r.tokens).split(' ');
    const dl = Number(r.word_count) || tokens.length;
    let bm25 = 0;
    let matched = 0;
    units.forEach((u, i) => {
      const tf = frequency(u, tokens);
      if (tf === 0) return;
      matched++;
      bm25 += idf[i] * (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / avg));
    });
    const coverage = matched / units.length;
    const score = bm25 * (0.5 + 0.5 * coverage);
    return {
      chunkId: Number(r.id), documentId: r.document_id, name: r.name, ordinal: Number(r.ordinal),
      page: r.page == null ? null : Number(r.page), text: r.text, score, excerpt: excerpt(r.text, units),
      matched, coverage, tokens,
    };
  }).filter(p => p.score > 0);
  passages.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.ordinal - b.ordinal);
  return { engine, terms, passages: dedupe(passages).slice(0, options.limit ?? 20).map(({ tokens: _, ...p }) => p) };
}

/** Token-set similarity (Jaccard) above which two passages count as the same text (repeated or copied content). */
export const DUPLICATE_SIMILARITY = 0.85;

/**
 * Ranked passages without near-duplicates: a passage whose words are almost the same as a better-ranked one (a copy
 * of a document, repeated boilerplate) is dropped, so the few passages the model sees are not the same text twice.
 */
export function dedupe<T extends { tokens: string[] }>(ranked: T[]): T[] {
  const kept: { item: T; set: Set<string> }[] = [];
  for (const item of ranked) {
    const set = new Set(item.tokens);
    const dup = kept.some(k => {
      let common = 0;
      for (const t of set) if (k.set.has(t)) common++;
      return common / (set.size + k.set.size - common || 1) >= DUPLICATE_SIMILARITY;
    });
    if (!dup) kept.push({ item, set });
  }
  return kept.map(k => k.item);
}

/**
 * Cosine similarity from which a passage counts as evidence by meaning alone (multilingual-e5-small; calibrated on the
 * retrieval evaluation set, eval/README.md). e5 similarities sit in a narrow high band, so this is model-specific.
 */
export const SEMANTIC_EVIDENCE = 0.77;

/**
 * Whether one passage is evidence worth answering from (M5): it contains at least half of the query's units or at
 * least two of them, or (with meaning search) its similarity reaches SEMANTIC_EVIDENCE. One shared common word
 * ("days", "open") is not evidence. This says the passage matches the question, never that it answers it correctly.
 */
export const isEvidence = (p: Pick<Passage, 'coverage' | 'matched' | 'similarity'>) =>
  p.coverage >= 0.5 || p.matched >= 2 || (p.similarity ?? 0) >= SEMANTIC_EVIDENCE;

/** Whether a search found any evidence passage (see isEvidence). */
export function hasEvidence(outcome: Pick<SearchOutcome, 'passages'>): boolean {
  return outcome.passages.some(isEvidence);
}

/** The keyword retriever, as a Retriever (the shape a future hybrid retriever will share). */
export const keywordRetriever: Retriever = { search };
