/**
 * Optional meaning ("semantic") search: one vector per passage from a small multilingual embedding model, compared
 * with the question's vector by cosine similarity. Keyword search keeps working without any of this.
 *
 * Model: multilingual-e5-small (Microsoft/intfloat, MIT, 118M parameters, 384 dimensions, trained on ~100 languages
 * including all six of this app's), Q8_0 GGUF converted by TwinSunsLLC. Chosen after testing on llama.cpp b10256, the
 * same llama.cpp build llama.rn 0.12.9 bundles (eval/README.md): of three public conversions, one did not load on that
 * build ("token type count" missing) and one used the wrong tokenizer (BERT WordPiece ids for an XLM-R model); this
 * one loads and tokenizes with the XLM-R vocabulary. It is only downloaded when the user asks, and sha256-checked.
 *
 * Storage: chunk_vectors (schema v6), one row per (passage, model): the vector as base64 float32, plus a hash of the
 * passage text so a passage with identical text reuses a vector. Vectors are deleted with their passages.
 * Similarity: cosine; vectors are L2-normalized, so cosine = dot product.
 */
import { db, open } from '../chatStore';
import * as local from '../localModel';
import type { LocalModel } from '../localModel';
import { initLlama, type LlamaContext } from 'llama.rn';

export type EmbeddingModel = LocalModel & { dims: number; license: string; source: string; prefix: { query: string; passage: string } };

export const E5_SMALL: EmbeddingModel = {
  id: 'multilingual-e5-small-q8_0',
  name: 'multilingual-e5-small (Q8_0)',
  paramsB: 0.118,
  url: 'https://huggingface.co/TwinSunsLLC/multilingual-e5-small-gguf/resolve/main/multilingual-e5-small-q8_0.gguf',
  sha256: 'e011debc1208e31bf7b6aebee2d9fc8bd2ca11694a77ed66ac9d0c9d0a877c93',
  bytes: 132439008,
  chatCapable: false,
  supported: true,
  dims: 384,
  license: 'MIT (intfloat/multilingual-e5-small)',
  source: 'GGUF conversion by TwinSunsLLC of intfloat/multilingual-e5-small',
  prefix: { query: 'query: ', passage: 'passage: ' }, // the input format e5 was trained with
};

/** Turns texts into unit-length vectors. 'query' and 'passage' may be encoded differently (e5 prefixes). */
export interface Embedder {
  readonly modelId: string;
  readonly dims: number;
  embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]>;
}

// ---------------------------------------------------------------- vectors as text (no Buffer / btoa in Hermes)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** A float32 vector as base64 text (4 bytes per number, little-endian). */
export function encodeVector(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

/** The vector stored by encodeVector. */
export function decodeVector(s: string): Float32Array {
  const clean = s.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64_INDEX.get(clean[i])! << 18) | (B64_INDEX.get(clean[i + 1])! << 12) |
      ((B64_INDEX.get(clean[i + 2]) ?? 0) << 6) | (B64_INDEX.get(clean[i + 3]) ?? 0);
    if (o < bytes.length) bytes[o++] = (n >> 16) & 255;
    if (o < bytes.length) bytes[o++] = (n >> 8) & 255;
    if (o < bytes.length) bytes[o++] = n & 255;
  }
  return new Float32Array(bytes.buffer);
}

/** Unit length (cosine then equals the dot product). A zero vector stays zero. */
export function normalize(v: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const n = Math.sqrt(sum) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

export const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** A short fingerprint of passage text (FNV-1a, two 32-bit lanes), to reuse vectors of identical text. */
export function textHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- building the vector index

export const EMBED_BATCH = 16;

export type VectorStatus = { model: string; passages: number; embedded: number };

/** How many passages of ready documents exist, and how many have a vector from `modelId`. */
export async function vectorStatus(modelId: string): Promise<VectorStatus> {
  await open();
  const r = (await db().query(`SELECT COUNT(*) AS n, COUNT(v.chunk_id) AS e FROM chunks c JOIN documents d ON d.id = c.document_id
    LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.model = ? WHERE d.status = 'ready'`, [modelId]))[0];
  return { model: modelId, passages: Number(r?.n ?? 0), embedded: Number(r?.e ?? 0) };
}

/**
 * Embed the passages of ready documents that have no vector from this model yet, EMBED_BATCH at a time. Each batch is
 * written in one transaction, so stopping (cancel, app closed) keeps the finished batches and the next run continues
 * where this one stopped. A passage whose exact text already has a vector (a copied document) reuses it.
 * @returns how many passages got a vector in this run
 */
export async function buildVectors(embedder: Embedder, opts: { isCancelled?: () => boolean; onProgress?: (s: VectorStatus) => void; now?: () => number } = {}): Promise<number> {
  await open();
  let done = 0;
  for (;;) {
    if (opts.isCancelled?.()) break;
    const rows = await db().query(`SELECT c.id, c.text FROM chunks c JOIN documents d ON d.id = c.document_id
      LEFT JOIN chunk_vectors v ON v.chunk_id = c.id AND v.model = ? WHERE d.status = 'ready' AND v.chunk_id IS NULL
      ORDER BY c.id LIMIT ${EMBED_BATCH}`, [embedder.modelId]);
    if (!rows.length) break;
    const hashes = rows.map(r => textHash(r.text));
    const reused = new Map<string, string>();
    for (const h of new Set(hashes)) {
      const hit = (await db().query('SELECT vector FROM chunk_vectors WHERE model = ? AND text_hash = ? LIMIT 1', [embedder.modelId, h]))[0];
      if (hit) reused.set(h, hit.vector);
    }
    // Each distinct text is embedded once, also within this batch (identical passages share the vector).
    const fresh = [...new Map(rows.map((r, i) => [hashes[i], r.text] as const)).entries()].filter(([h]) => !reused.has(h));
    const vectors = fresh.length ? await embedder.embed(fresh.map(([, t]) => t), 'passage') : [];
    fresh.forEach(([h], k) => reused.set(h, encodeVector(vectors[k])));
    if (opts.isCancelled?.()) break; // don't write a batch that finished after Stop
    const now = opts.now?.() ?? Date.now();
    await db().batch(rows.map((r, i) => ({
      sql: 'INSERT OR REPLACE INTO chunk_vectors (chunk_id, model, text_hash, vector, created_at) VALUES (?, ?, ?, ?, ?)',
      params: [Number(r.id), embedder.modelId, hashes[i], reused.get(hashes[i])!, now],
    })));
    done += rows.length;
    opts.onProgress?.(await vectorStatus(embedder.modelId));
  }
  return done;
}

/** Remove every vector of a model (e.g. before switching models). Passages and keyword search are not affected. */
export async function dropVectors(modelId: string): Promise<void> {
  await open();
  await db().execute('DELETE FROM chunk_vectors WHERE model = ?', [modelId]);
}

// ---------------------------------------------------------------- searching by meaning

type CachedVectors = { signature: string; rows: { chunkId: number; documentId: string; vector: Float32Array }[] };
const cache = new Map<string, CachedVectors>();
const PAGE = 500;

/** The ready passages' vectors for a model, read page by page and kept in memory until the vectors change. */
async function loadVectors(modelId: string): Promise<CachedVectors['rows']> {
  const sig = (await db().query(`SELECT COUNT(*) AS n, MAX(v.rowid) AS m, COUNT(d.id) AS r FROM chunk_vectors v
    JOIN chunks c ON c.id = v.chunk_id LEFT JOIN documents d ON d.id = c.document_id AND d.status = 'ready' WHERE v.model = ?`, [modelId]))[0];
  const signature = `${sig?.n}:${sig?.m}:${sig?.r}`;
  const hit = cache.get(modelId);
  if (hit && hit.signature === signature) return hit.rows;
  const rows: CachedVectors['rows'] = [];
  for (let after = -1; ;) {
    const page = await db().query(`SELECT v.chunk_id, c.document_id, v.vector FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id
      JOIN documents d ON d.id = c.document_id WHERE v.model = ? AND d.status = 'ready' AND v.chunk_id > ? ORDER BY v.chunk_id LIMIT ${PAGE}`, [modelId, after]);
    if (!page.length) break;
    for (const r of page) rows.push({ chunkId: Number(r.chunk_id), documentId: r.document_id, vector: decodeVector(r.vector) });
    after = Number(page[page.length - 1].chunk_id);
  }
  cache.set(modelId, { signature, rows });
  return rows;
}

export type SemanticHit = { chunkId: number; documentId: string; similarity: number };

/** Passages most similar in meaning to `query` (cosine, best first), limited to `documentIds` when given. */
export async function semanticSearch(embedder: Embedder, query: string, opts: { documentIds?: string[] | null; limit?: number } = {}): Promise<SemanticHit[]> {
  await open();
  const rows = await loadVectors(embedder.modelId);
  if (!rows.length) return [];
  const [q] = await embedder.embed([query], 'query');
  const scope = opts.documentIds?.length ? new Set(opts.documentIds) : null;
  return rows.filter(r => !scope || scope.has(r.documentId))
    .map(r => ({ chunkId: r.chunkId, documentId: r.documentId, similarity: dot(q, r.vector) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, opts.limit ?? 20);
}

// ---------------------------------------------------------------- the on-device embedder (llama.rn)

/**
 * The embedding model running in llama.rn (a second, small context next to the chat model; about 130 MB on disk).
 * Loaded on first use and released together with the chat model's contexts. Calls share the chat model's queue, so
 * the two never run native work at the same time.
 * Unverified on a phone so far: load time, speed and memory (see eval/README.md).
 */
export class LlamaEmbedder implements Embedder {
  readonly modelId: string;
  readonly dims: number;
  private ctx: LlamaContext | null = null;
  private loading: Promise<LlamaContext> | null = null;
  private unsubscribe: () => void;

  constructor(private model: EmbeddingModel = E5_SMALL) {
    this.modelId = model.id;
    this.dims = model.dims;
    this.unsubscribe = local.onReleaseAll(() => { this.ctx = null; this.loading = null; });
  }

  private context(): Promise<LlamaContext> {
    if (this.ctx) return Promise.resolve(this.ctx);
    this.loading ??= (async () => {
      if (!(await local.isInstalled(this.model))) throw new Error('The meaning-search model is not downloaded');
      const c = await initLlama({ model: `file://${local.modelPath(this.model)}`, embedding: true, pooling_type: 'mean',
        n_ctx: 512, n_threads: local.N_THREADS, n_gpu_layers: 0, use_mlock: false });
      this.ctx = c;
      return c;
    })().finally(() => { this.loading = null; });
    return this.loading;
  }

  async embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array[]> {
    const c = await this.context();
    return local.runExclusive(async () => {
      const out: Float32Array[] = [];
      for (const t of texts) {
        const r = await c.embedding(`${this.model.prefix[kind]}${t}`, { embd_normalize: 2 });
        out.push(normalize(r.embedding));
      }
      return out;
    });
  }

  /** Free the context (it is created again on the next use). */
  async release(): Promise<void> {
    const c = this.ctx;
    this.ctx = null;
    await c?.release().catch(() => undefined);
  }

  dispose(): void { this.unsubscribe(); }
}
