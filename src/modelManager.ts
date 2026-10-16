/**
 * Phase 14: Local Model Manager for the phone's on-device models (extends the Phase 9 registry in localModel.ts).
 *
 * Rules (all deterministic; nothing is downloaded without the user's approval):
 * - A catalog entry is a candidate only if it is valid (https Hugging Face URL, sha256, size, params < 4B), has the
 *   same capability (text), runs on this platform, has a comparable published quality score, fits storage and RAM,
 *   is predicted fast enough, and is significantly better (QUALITY_MARGIN) than the active model.
 * - Storage: free space must cover the download plus a reserve of max(3 GB, 5 % of total storage).
 * - Replacement keeps the working model until the new one is downloaded, sha256-verified, loaded, answers a test
 *   prompt correctly and meets the speed limits; only then is it activated and the old one deleted.
 *   Any failure before activation deletes the incomplete new files and keeps (re-loads) the old model. After
 *   activation nothing is rolled back: if deleting the old model fails, the new one stays active and the result
 *   carries `cleanupError`.
 */
import type { LocalModel } from './localModel';
import builtinCatalog from './modelCatalog.json';

export type Capability = 'text' | 'vision' | 'embedding' | 'speech' | 'tts';

export type CatalogModel = LocalModel & {
  provider: 'llama.rn';
  capability: Capability;
  family: string;
  architecture: string;
  version: string;
  quantization: string;
  contextLength: number;
  platforms: string[]; // e.g. ["android-arm64"]
  license: string;
  languages: Record<string, 'good' | 'fair' | 'poor' | 'unknown'>;
  /** Mean of the vendor-published MMLU-redux, MATH, GSM8K, HumanEval and IFEval scores; null = not comparable. */
  qualityScore: number | null;
  qualitySource: string;
  notes?: string;
};

export const CATALOG_VERSION = '2026-10-07';
// Sizes and sha256 come from the Hugging Face API (LFS oid); quality scores from https://qwenlm.github.io/blog/qwen2.5-llm/
// ("Qwen2.5-0.5B/1.5B-Instruct Performance", "Qwen2.5-3B-Instruct" tables). Other families publish different suites,
// so they get qualityScore null and are never offered automatically.
export const BUILTIN_CATALOG: CatalogModel[] = builtinCatalog as CatalogModel[]; // src/modelCatalog.json

// ---------------------------------------------------------------- validation

const HEX64 = /^[0-9a-f]{64}$/;
/** Keep only well-formed entries (a refreshed catalog is untrusted input). Returns the valid ones and why others failed. */
export function validateCatalog(raw: unknown): { models: CatalogModel[]; errors: string[] } {
  const errors: string[] = [];
  const models: CatalogModel[] = [];
  for (const m of Array.isArray(raw) ? raw : []) {
    const why =
      typeof m?.id !== 'string' || !/^[a-z0-9._-]{3,80}$/.test(m.id) ? 'bad id'
      : typeof m.url !== 'string' || !m.url.startsWith('https://huggingface.co/') || !m.url.endsWith('.gguf') ? 'url must be an https huggingface.co .gguf'
      : typeof m.sha256 !== 'string' || !HEX64.test(m.sha256) ? 'sha256 missing/invalid'
      : !(Number.isFinite(m.bytes) && m.bytes > 50e6) ? 'size missing'
      : !(m.paramsB > 0 && m.paramsB < 4) ? 'params must be < 4B'
      : !['text', 'vision', 'embedding', 'speech', 'tts'].includes(m.capability) ? 'unknown capability'
      : !Array.isArray(m.platforms) ? 'platforms missing'
      : null;
    if (why) errors.push(`${m?.id ?? '?'}: ${why}`);
    else models.push(m as CatalogModel);
  }
  return { models, errors };
}

// ---------------------------------------------------------------- device fit

export type Device = { platform: string; totalRam: number; availRam: number; freeStorage: number; totalStorage: number };
export const GB = 1e9;
// Storage: never leave the phone short. Android warns at ~10 % free; apps, the OS and photos need room to grow.
export const STORAGE_RESERVE_MIN = 3 * GB;
// 5 %, not the original app's 15 %: on a 113 GB Galaxy M35 with 16.8 GB free, 15 % (17 GB) refused even a 0.5 GB model.
export const STORAGE_RESERVE_FRACTION = 0.05;
// RAM: measured on the M35, the 1.1 GB Qwen2.5-1.5B file used 2.0 GB of app memory after load (≈1.8× file size).
export const RAM_FACTOR = 1.8;
export const RAM_SYSTEM_HEADROOM = 2.5 * GB; // OS + launcher + the user's other apps must keep running
// Speed: below ~5 tokens/s streaming text is slower than reading speed; first token must come within 5 s.
export const MIN_TOK_PER_SEC = 5;
export const MAX_FIRST_TOKEN_MS = 5000;
export const MAX_LOAD_MS = 30000;
export const QUALITY_MARGIN = 10; // points of the 5-benchmark mean: "significantly better"

export function storagePlan(m: Pick<CatalogModel, 'bytes'>, d: Pick<Device, 'freeStorage' | 'totalStorage'>) {
  const reserve = Math.max(STORAGE_RESERVE_MIN, STORAGE_RESERVE_FRACTION * d.totalStorage);
  // The download is written to <file>.part and renamed on the same disk, so it needs its size once; the old model is
  // already on disk (counted as used) and is only deleted after the new one is accepted.
  const required = m.bytes + reserve;
  return { required, reserve, ok: d.freeStorage >= required, freeAfter: d.freeStorage - m.bytes };
}

export function ramPlan(m: Pick<CatalogModel, 'bytes'>, d: Pick<Device, 'totalRam'>) {
  const needed = m.bytes * RAM_FACTOR;
  return { needed, ok: d.totalRam >= needed + RAM_SYSTEM_HEADROOM };
}

/** Speed estimate from the measured baseline: llama.cpp decode speed scales roughly with 1 / parameters. */
export function predictedTokPerSec(m: Pick<CatalogModel, 'paramsB'>, baseline: Baseline | null, active: Pick<CatalogModel, 'paramsB'>) {
  return baseline ? baseline.tokPerSec * (active.paramsB / m.paramsB) : null;
}

export type Baseline = { modelId: string; loadMs: number; firstTokenMs: number; tokPerSec: number; correct: boolean; at: string };

export type Assessment = { model: CatalogModel; ok: boolean; reasons: string[]; storage: ReturnType<typeof storagePlan>; predictedTokPerSec: number | null };

/** Why each catalog model is / isn't a better replacement for `active` on this device. */
export function assess(active: CatalogModel, catalog: CatalogModel[], d: Device, baseline: Baseline | null): Assessment[] {
  return catalog.filter(m => m.id !== active.id).map(m => {
    const reasons: string[] = [];
    const storage = storagePlan(m, d);
    const tps = predictedTokPerSec(m, baseline, active);
    if (m.capability !== active.capability) reasons.push(`different capability (${m.capability})`);
    if (!m.supported || !m.chatCapable) reasons.push('not supported by this app build');
    if (!m.platforms.includes(d.platform)) reasons.push(`not built for ${d.platform}`);
    if (m.qualityScore == null || active.qualityScore == null) reasons.push('no comparable published quality score');
    else if (m.qualityScore < active.qualityScore + QUALITY_MARGIN) reasons.push(`not significantly better (${m.qualityScore} vs ${active.qualityScore})`);
    if (!storage.ok) reasons.push(`needs ${(storage.required / GB).toFixed(1)} GB free (download + ${(storage.reserve / GB).toFixed(1)} GB reserve)`);
    if (!ramPlan(m, d).ok) reasons.push(`needs ${((ramPlan(m, d).needed + RAM_SYSTEM_HEADROOM) / GB).toFixed(1)} GB RAM`);
    if (tps == null) reasons.push('no on-device speed baseline yet (run Benchmark)');
    else if (tps < MIN_TOK_PER_SEC) reasons.push(`predicted ${tps.toFixed(1)} tok/s, below ${MIN_TOK_PER_SEC}`);
    return { model: m, ok: reasons.length === 0, reasons, storage, predictedTokPerSec: tps };
  });
}

/** The best acceptable upgrade (highest quality score), or null. */
export function findUpgrade(active: CatalogModel, catalog: CatalogModel[], d: Device, baseline: Baseline | null): Assessment | null {
  const ok = assess(active, catalog, d, baseline).filter(a => a.ok);
  return ok.sort((a, b) => (b.model.qualityScore ?? 0) - (a.model.qualityScore ?? 0))[0] ?? null;
}

/** Banner text: current vs new, size, benefit, predicted speed, required free space, license. */
export function upgradeSummary(a: Assessment, currentName: string): string {
  const m = a.model;
  return [
    `Current: ${currentName}`,
    `New: ${m.name}`,
    `Size: ${(m.bytes / GB).toFixed(2)} GB · needs ${(a.storage.required / GB).toFixed(1)} GB free`,
    `Benefit: higher published scores (${m.qualityScore} vs current; mean of MMLU-redux, MATH, GSM8K, HumanEval, IFEval)`,
    a.predictedTokPerSec != null ? `Speed on this phone: about ${a.predictedTokPerSec.toFixed(1)} tokens/s (predicted)` : '',
    `License: ${m.license}`,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- catalog refresh (at most once per interval)

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export type CachedCatalog = { fetchedAt: number; models: CatalogModel[] };

/** Use the cache when fresh; otherwise try `fetchRemote` once and validate it; fall back to cache, then built-in. */
export async function loadCatalog(
  cache: CachedCatalog | null, now: number, fetchRemote: () => Promise<unknown>,
): Promise<{ models: CatalogModel[]; source: 'cache' | 'remote' | 'builtin'; refreshed: CachedCatalog | null; errors: string[] }> {
  if (cache && now - cache.fetchedAt < CATALOG_TTL_MS) return { models: cache.models, source: 'cache', refreshed: null, errors: [] };
  try {
    const { models, errors } = validateCatalog(await fetchRemote());
    if (models.length) return { models, source: 'remote', refreshed: { fetchedAt: now, models }, errors };
    return { models: cache?.models ?? BUILTIN_CATALOG, source: cache ? 'cache' : 'builtin', refreshed: null, errors: ['remote catalog empty', ...errors] };
  } catch (e: any) {
    return { models: cache?.models ?? BUILTIN_CATALOG, source: cache ? 'cache' : 'builtin', refreshed: null, errors: [`refresh failed: ${e?.message ?? e}`] };
  }
}

// ---------------------------------------------------------------- safe replacement + rollback

export type BenchResult = { loadMs: number; firstTokenMs: number; tokPerSec: number; text: string };
export type ReplaceDeps = {
  device: () => Promise<Device>;
  online: () => boolean;
  download: (m: CatalogModel, onProgress: (f: number) => void) => Promise<void>; // includes sha256 verification
  loadAndBench: (m: CatalogModel) => Promise<BenchResult>; // load + "What is 2 + 2?" test
  activate: (m: CatalogModel, previous: CatalogModel) => Promise<void>; // persist active (+ previous for rollback)
  remove: (m: CatalogModel) => Promise<void>; // delete files of a model (also partial downloads)
  reloadPrevious: (m: CatalogModel) => Promise<void>;
};
export type Step = 'check' | 'download' | 'verify' | 'load' | 'test' | 'activate' | 'cleanup' | 'done' | 'rolled_back';

/** Download → verify → load → test → activate → delete old. On any failure: delete new files, keep the old model. */
export async function replaceModel(
  current: CatalogModel, next: CatalogModel, deps: ReplaceDeps, onStep: (s: Step, detail?: string) => void = () => undefined,
): Promise<{ ok: boolean; step: Step; error?: string; bench?: BenchResult; cleanupError?: string }> {
  let step: Step = 'check';
  let bench: BenchResult;
  const fail = async (error: string) => {
    onStep('rolled_back', error);
    await deps.remove(next).catch(() => undefined); // incomplete/rejected new model never stays on the phone
    await deps.reloadPrevious(current).catch(() => undefined); // the user keeps a working local model
    return { ok: false, step, error };
  };
  try {
    onStep(step);
    if (!deps.online()) return { ok: false, step, error: "You're offline; nothing was downloaded" };
    const plan = storagePlan(next, await deps.device());
    if (!plan.ok) return { ok: false, step, error: `Not enough storage: needs ${(plan.required / GB).toFixed(1)} GB free` };
    step = 'download';
    onStep(step);
    await deps.download(next, f => onStep('download', `${Math.floor(f * 100)}%`));
    step = 'load';
    onStep(step);
    bench = await deps.loadAndBench(next);
    step = 'test';
    onStep(step);
    if (!/\b4\b|four/i.test(bench.text)) return await fail(`test answer was wrong ("${bench.text.slice(0, 40)}")`);
    if (bench.loadMs > MAX_LOAD_MS) return await fail(`load took ${bench.loadMs} ms (limit ${MAX_LOAD_MS})`);
    if (bench.firstTokenMs > MAX_FIRST_TOKEN_MS) return await fail(`first token after ${bench.firstTokenMs} ms (limit ${MAX_FIRST_TOKEN_MS})`);
    if (bench.tokPerSec < MIN_TOK_PER_SEC) return await fail(`${bench.tokPerSec.toFixed(1)} tok/s (minimum ${MIN_TOK_PER_SEC})`);
    step = 'activate';
    onStep(step);
    await deps.activate(next, current);
  } catch (e: any) {
    return fail(`${step} failed: ${e?.message ?? e}`);
  }
  // Activated: the new model stays from here on. A failed delete of the old one is only reported; rolling back now
  // would delete the active model while the old one may already be half-deleted.
  onStep('cleanup');
  try {
    await deps.remove(current); // only now: the new model passed every check
  } catch (e: any) {
    const cleanupError = `the old model (${current.name}) could not be fully deleted: ${e?.message ?? e}`;
    onStep('done', cleanupError);
    return { ok: true, step: 'done', bench, cleanupError };
  }
  onStep('done');
  return { ok: true, step: 'done', bench };
}

/** Startup health check: if the active model can't load and the previous one is still installed, switch back. */
export async function healthCheck(
  active: CatalogModel, previous: CatalogModel | null,
  deps: { load: (m: CatalogModel) => Promise<void>; isInstalled: (m: CatalogModel) => Promise<boolean>; activate: (m: CatalogModel, prev: CatalogModel | null) => Promise<void> },
): Promise<{ active: CatalogModel; rolledBack: boolean; error?: string }> {
  try {
    await deps.load(active);
    return { active, rolledBack: false };
  } catch (e: any) {
    if (previous && (await deps.isInstalled(previous))) {
      await deps.activate(previous, null);
      await deps.load(previous);
      return { active: previous, rolledBack: true, error: String(e?.message ?? e) };
    }
    return { active, rolledBack: false, error: String(e?.message ?? e) };
  }
}
