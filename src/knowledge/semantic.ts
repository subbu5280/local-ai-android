/**
 * Meaning search in the app: whether it is installed and switched on, downloading its model (only when the user
 * asks), building passage vectors in the background, and removing it. Keyword search never depends on this.
 *
 * - The model (~132 MB, E5_SMALL) downloads only after the user confirms; it is sha256-checked like the chat model.
 * - Vectors are built in small batches in the background (embeddings.buildVectors), one build at a time; Stop keeps
 *   finished batches, and the next build continues. New imports are embedded by the next build.
 * - "Active" means: installed, switched on, and at least one passage has a vector. Otherwise retrieval is keyword
 *   only, and the app says so.
 */
import { db, open } from '../chatStore';
import * as local from '../localModel';
import { metric } from '../metrics';
import { buildVectors, dropVectors, E5_SMALL, LlamaEmbedder, vectorStatus, type Embedder, type VectorStatus } from './embeddings';

export type SemanticState = {
  installed: boolean; enabled: boolean; status: VectorStatus;
  building: boolean; downloading: number | null; error: string | null;
};

let makeEmbedder: () => Embedder = () => new LlamaEmbedder(E5_SMALL);
let embedder: Embedder | null = null;
let build: { cancelled: boolean; promise: Promise<void> } | null = null;
let downloading: number | null = null;
let lastError: string | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(l => l());

/** Tests replace the on-device embedder with a fake one. */
export function setEmbedderFactory(f: () => Embedder): void { makeEmbedder = f; embedder = null; }

/** Be told when the state may have changed (download progress, build progress). Returns an unsubscribe function. */
export function subscribe(l: () => void): () => void { listeners.add(l); return () => listeners.delete(l); }

async function enabledFlag(): Promise<boolean> {
  await open();
  return (await db().query("SELECT value FROM meta WHERE key = 'semantic_enabled'"))[0]?.value === '1';
}

export async function getState(): Promise<SemanticState> {
  const installed = await local.isInstalled(E5_SMALL).catch(() => false);
  return { installed, enabled: await enabledFlag(), status: await vectorStatus(E5_SMALL.id), building: !!build, downloading, error: lastError };
}

/** The embedder to search with, or null when meaning search is not installed, switched off or has no vectors yet. */
export async function activeEmbedder(): Promise<Embedder | null> {
  const s = await getState();
  if (!s.installed || !s.enabled || s.status.embedded === 0) return null;
  embedder ??= makeEmbedder();
  return embedder;
}

/** Switch meaning search on (and start building vectors) or off (vectors are kept, but not used). */
export async function setEnabled(on: boolean): Promise<void> {
  await open();
  await db().execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('semantic_enabled', ?)", [on ? '1' : '0']);
  if (on) startBuild(); else stopBuild();
  changed();
}

/** Download the model (after the user confirmed), then switch on and build. Rejects with the download's error. */
export async function download(online: boolean): Promise<void> {
  if (downloading !== null) return;
  downloading = 0;
  lastError = null;
  changed();
  try {
    await local.download(E5_SMALL, f => { downloading = f; changed(); }, online);
    metric('semantic_download', { result: 'ok' });
    downloading = null;
    await setEnabled(true);
  } catch (e: any) {
    lastError = String(e?.message ?? e);
    metric('semantic_download', { result: 'failed', error: lastError.slice(0, 120) });
    throw e;
  } finally {
    downloading = null;
    changed();
  }
}

/** Build missing vectors in the background (no-op if a build runs, or meaning search is off or not installed). */
export function startBuild(): void {
  if (build) return;
  const state = { cancelled: false, promise: Promise.resolve() };
  build = state;
  state.promise = (async () => {
    const s = await getState();
    if (!s.installed || !s.enabled) return;
    const t0 = Date.now();
    embedder ??= makeEmbedder();
    const n = await buildVectors(embedder, { isCancelled: () => state.cancelled, onProgress: () => changed() });
    if (n) metric('semantic_build', { passages: n, ms: Date.now() - t0, stopped: state.cancelled });
  })().catch((e: any) => { lastError = `Building the meaning index failed: ${String(e?.message ?? e).slice(0, 120)}`; })
    .finally(() => { if (build === state) build = null; changed(); });
  changed();
}

/** Stop the background build after its current batch (finished batches are kept). */
export function stopBuild(): void {
  if (build) build.cancelled = true;
}

/** Waits for a running build (tests, and before removing the model). */
export async function settled(): Promise<void> { await build?.promise; }

/** Remove the model file and all its vectors and switch meaning search off. Documents and keyword search stay. */
export async function remove(): Promise<void> {
  stopBuild();
  await settled();
  if (embedder instanceof LlamaEmbedder) await embedder.release();
  embedder = null;
  await dropVectors(E5_SMALL.id);
  await local.remove(E5_SMALL);
  await setEnabled(false);
}
