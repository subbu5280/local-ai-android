import * as RNFS from '@dr.pogodin/react-native-fs';
import { NativeModules } from 'react-native';
import { initLlama, releaseAllLlama, type LlamaContext } from 'llama.rn';
import { BUILTIN_CATALOG, storagePlan, type CatalogModel } from './modelManager';

export type LocalModel = {
  id: string;
  name: string; // display name
  paramsB: number; // billions; hard limit < 4 (POC_SPEC §3)
  url: string; // download URL
  sha256: string;
  bytes: number; // download size
  chatCapable: boolean;
  supported: boolean; // runtime support on this app build (llama.rn GGUF, arm64)
};

// Phase 9 registry of supported on-device models. The app never auto-installs; the user confirms each download.
export const SUPPORTED_MODELS: LocalModel[] = [
  {
    id: 'qwen2.5-1.5b-instruct-q4_k_m',
    name: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
    paramsB: 1.54,
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    bytes: 1117320736,
    chatCapable: true,
    supported: true,
  },
];
export const MODEL: LocalModel = SUPPORTED_MODELS[0];

// On-device image understanding (camera/gallery questions): Qwen2-VL 2B, apache-2.0, in two files
// (the language model + its vision projector). Sizes and sha256 from the Hugging Face API (LFS oid), 2026-10-08.
// Downloaded only after the user says yes, with the same checked download as the text model.
const VL_REPO = 'https://huggingface.co/ggml-org/Qwen2-VL-2B-Instruct-GGUF/resolve/main';
export const VISION_MODEL: LocalModel = {
  id: 'qwen2-vl-2b-instruct-q4_k_m', name: 'Qwen2-VL 2B Instruct (Q4_K_M)', paramsB: 2.21,
  url: `${VL_REPO}/Qwen2-VL-2B-Instruct-Q4_K_M.gguf`,
  sha256: '5745685d2e607a82a0696c1118e56a2a1ae0901da450fd9cd4f161c6b62867d7', bytes: 986046944,
  chatCapable: true, supported: true,
};
export const VISION_PROJECTOR: LocalModel = {
  id: 'mmproj-qwen2-vl-2b-instruct-q8_0', name: 'Qwen2-VL 2B vision projector (Q8_0)', paramsB: 0.67,
  url: `${VL_REPO}/mmproj-Qwen2-VL-2B-Instruct-Q8_0.gguf`,
  sha256: 'a0ad91f00a7a80dcf84d719a61b00ee2e07b71794f4ee2dfa81a254621a8c418', bytes: 709883360,
  chatCapable: true, supported: true,
};
export const VISION_FILES = [VISION_MODEL, VISION_PROJECTOR];
export const VISION_BYTES = VISION_FILES.reduce((n, f) => n + f.bytes, 0);

/** Free space needed before downloading: the model twice (Android's download lands in the app's external folder and is
 *  copied into private storage, both on the same phone storage), +200 MB for the OS and app. */
export const minimumStorage = (m: LocalModel) => Math.ceil(m.bytes * 2 + 200e6);

export type InstallState = 'not_installed' | 'downloading' | 'verifying' | 'installed' | 'failed' | 'unsupported';
let state: InstallState = 'not_installed';
let stateDetail = '';
let activeJob: number | null = null;
const listeners = new Set<(s: InstallState, detail: string) => void>();
function setState(s: InstallState, detail = '') {
  state = s;
  stateDetail = detail;
  listeners.forEach(l => l(s, detail));
}
export const getState = () => ({ state, detail: stateDetail });
export function onState(l: (s: InstallState, detail: string) => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

// Exynos 1380 = 4x A78 + 4x A55; 4 threads keeps work on the big cores. Tune per device.
export const N_THREADS = 4;
const N_CTX = 2048;

const dir = `${RNFS.DocumentDirectoryPath}/models`;
const file = (m: LocalModel) => `${dir}/${m.id}.gguf`;
/** Where a model file lives once downloaded (app-private storage). */
export const modelPath = file;
const marker = (m: LocalModel) => `${file(m)}.verified`;

export function assertUnder4B(m: LocalModel) {
  if (!(m.paramsB > 0 && m.paramsB < 4)) {
    throw new Error(`Refusing ${m.name}: ${m.paramsB}B params (limit is < 4B)`);
  }
}

/** Verified = file present and its sha256 matched once (marker written after check). */
export async function isInstalled(m = MODEL): Promise<boolean> {
  return (
    (await RNFS.exists(marker(m))) &&
    (await RNFS.exists(file(m))) &&
    (await RNFS.readFile(marker(m), 'utf8')).trim() === m.sha256
  );
}

/** Sync the install state with what is actually on disk (call once at startup; never downloads). */
export async function refreshState(m = MODEL): Promise<InstallState> {
  if (!m.supported || !m.chatCapable) setState('unsupported', 'model not supported by this app build');
  else if (state !== 'downloading' && state !== 'verifying') {
    setState((await isInstalled(m)) ? 'installed' : 'not_installed');
  }
  return state;
}

export async function freeBytes(): Promise<number> {
  return (await RNFS.getFSInfo()).freeSpace;
}

/** Download to .part, verify sha256, then atomically move into place. Only after the user confirmed.
 *  `online` comes from the app's NetInfo state: no download is ever started offline. */
export async function download(
  m: LocalModel,
  onProgress: (fraction: number) => void,
  online = true,
): Promise<void> {
  assertUnder4B(m);
  // Any supported model file (chat, image or embedding model); whether it can chat is the caller's concern.
  if (!m.supported) throw new Error(`${m.name} is not supported on this device`);
  if (state === 'downloading' || state === 'verifying') throw new Error('A model download is already in progress');
  if (!online) throw new Error("You're offline: connect to Wi-Fi to download the model");
  const need = minimumStorage(m);
  if ((await freeBytes()) < need) {
    throw new Error(`Not enough storage to install this model (needs ${(need / 1e9).toFixed(1)} GB free)`);
  }
  await RNFS.mkdir(dir);
  const part = `${file(m)}.part`;
  const fail = async (msg: string) => {
    await RNFS.unlink(part).catch(() => {});
    activeJob = null;
    setState('failed', msg);
    return new Error(msg);
  };
  if (await RNFS.exists(part)) await RNFS.unlink(part); // stale partial from an interrupted run
  setState('downloading', '0%');
  const progress = (f: number) => { setState('downloading', `${Math.floor(f * 100)}%`); onProgress(f); };
  let got: string;
  try {
    got = NativeModules.AiDevice?.startDownload ? await systemDownload(m, progress) : await rnfsDownload(m, part, progress);
  } catch (e: any) {
    if (state === 'not_installed') {
      // cancelDownload(): remove the partial file and stay not_installed (a cancel is not a failure)
      await RNFS.unlink(part).catch(() => {});
      activeJob = null;
      setState('not_installed', 'cancelled');
      throw new Error('Download cancelled');
    }
    throw await fail(String(e?.message ?? e)); // network drop, HTTP error, storage full mid-write...
  }
  activeJob = null;
  setState('verifying');
  const sha = (await RNFS.hash(got, 'sha256')).toLowerCase();
  if (sha !== m.sha256) {
    await RNFS.unlink(got).catch(() => {});
    throw await fail(`Integrity check failed (sha256 ${sha.slice(0, 12)}…); file deleted`);
  }
  if (await RNFS.exists(file(m))) await RNFS.unlink(file(m));
  if (got === part) await RNFS.moveFile(part, file(m));
  else { await RNFS.copyFile(got, file(m)); await RNFS.unlink(got).catch(() => {}); } // external folder → private storage
  await RNFS.writeFile(marker(m), m.sha256, 'utf8'); // marker last: "installed" only after verification
  setState('installed');
}

/** In-app download (tests, and builds without AiDevice): stops if the app's connection is cut. Resolves the file path. */
async function rnfsDownload(m: LocalModel, part: string, progress: (f: number) => void): Promise<string> {
  const job = RNFS.downloadFile({
    fromUrl: m.url, toFile: part, progressInterval: 500,
    progress: r => progress(r.bytesWritten / (r.contentLength || m.bytes)),
  });
  activeJob = job.jobId;
  const res = await job.promise.catch((e: any) => { throw new Error(`Download interrupted: ${e?.message ?? e}`); });
  if (res.statusCode !== 200) throw new Error(`Download failed: HTTP ${res.statusCode}`);
  return part;
}

let systemJob: number | null = null;
/** Android's DownloadManager: notification with progress; survives screen-off, battery saver and closing the app. */
async function systemDownload(m: LocalModel, progress: (f: number) => void): Promise<string> {
  const dev = NativeModules.AiDevice;
  systemJob = await dev.startDownload(m.url, `${m.id}.gguf`, `${m.name}`);
  try {
    for (;;) {
      await new Promise<void>(r => setTimeout(() => r(), 1000));
      if (state === 'not_installed') throw new Error('cancelled');
      const s = await dev.downloadStatus(systemJob);
      if (s.status === 'done' && s.path) return s.path;
      if (s.status === 'failed') throw new Error(`Download failed (Android download error ${s.reason})`);
      if (s.bytes > 0) progress(s.bytes / (s.total > 0 ? s.total : m.bytes));
    }
  } finally {
    systemJob = null;
  }
}

/** Cancel an in-flight download; the partial file is removed by download()'s failure path. */
export function cancelDownload() {
  if (activeJob !== null || systemJob !== null) {
    setState('not_installed', 'cancelled');
    if (activeJob !== null) RNFS.stopDownload(activeJob);
    if (systemJob !== null) NativeModules.AiDevice?.cancelDownload(systemJob);
  }
}

export async function remove(m = MODEL) {
  for (const p of [file(m), marker(m), `${file(m)}.part`]) {
    if (await RNFS.exists(p)) await RNFS.unlink(p);
  }
}

let ctx: LlamaContext | null = null;

// One llama.rn operation at a time (load, text answer, image answer). Seen on the Galaxy M35: a chat message sent
// while the launch-time load was still running its test answer started a second completion on the same context,
// and the native call failed ("Exception in HostFunction"). Queued work runs in order; a failure doesn't block the queue.
let llamaQueue: Promise<unknown> = Promise.resolve();
/** Run llama.rn work in the shared one-at-a-time queue (also used by the embedding model, src/knowledge/embeddings). */
export const runExclusive = <T>(work: () => Promise<T>): Promise<T> => exclusive(work);

// Called before every releaseAllLlama(): other llama.rn contexts (the embedding model) are released with it.
const releaseHooks = new Set<() => void>();
/** Be told when all llama.rn contexts are about to be released; returns an unsubscribe function. */
export function onReleaseAll(hook: () => void): () => void {
  releaseHooks.add(hook);
  return () => releaseHooks.delete(hook);
}
async function releaseAll(): Promise<void> {
  releaseHooks.forEach(h => { try { h(); } catch {} });
  await releaseAllLlama();
}

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = llamaQueue.then(work, work);
  llamaQueue = run.catch(() => undefined);
  return run;
}

export type LoadInfo = { loadMs: number; lib?: string; gpu: boolean };

export function load(m = MODEL): Promise<LoadInfo> {
  return exclusive(() => loadNow(m));
}

async function loadNow(m: LocalModel): Promise<LoadInfo> {
  assertUnder4B(m);
  if (!(await isInstalled(m))) throw new Error('Model not installed/verified');
  // releaseAll, not ctx.release: after a JS reload `ctx` is gone but the native context isn't (seen on device).
  // It also releases the image model: only one model is in RAM at a time (2 + 2 GB would crowd an 8 GB phone).
  ctx = null;
  visionCtx = null;
  await releaseAll();
  const t0 = Date.now();
  const c = await initLlama({
    model: `file://${file(m)}`,
    n_ctx: N_CTX,
    n_threads: N_THREADS,
    n_gpu_layers: 0, // CPU: llama.cpp GPU paths target Adreno/Apple, not Mali
    use_mlock: false,
  });
  ctx = c;
  return { loadMs: Date.now() - t0, lib: c.androidLib, gpu: c.gpu };
}

export const isLoaded = () => ctx !== null;

/**
 * Stop the text answer being generated now, if any; generate() then resolves with the text produced so far.
 * Deliberately not queued with exclusive(): queued, it would only run after the answer it is meant to stop.
 */
export async function stop(): Promise<void> {
  await ctx?.stopCompletion();
}

// ---------------------------------------------------------------- on-device image understanding

let visionCtx: LlamaContext | null = null;

/** Both image-model files are downloaded and sha256-verified. */
export async function isVisionInstalled(): Promise<boolean> {
  for (const f of VISION_FILES) if (!(await isInstalled(f))) return false;
  return true;
}

/** Download the image model (both files, one after the other). Only after the user said yes. */
export async function downloadVision(onProgress: (fraction: number) => void, online = true): Promise<void> {
  // Phase 14 storage rule (modelManager.storagePlan: download + max(3 GB, 5 % of storage) reserve), checked before
  // anything starts; download() still adds its own per-file check.
  const missing = [];
  for (const f of VISION_FILES) if (!(await isInstalled(f))) missing.push(f);
  const bytes = missing.reduce((n, f) => n + f.bytes, 0);
  if (bytes > 0) {
    const fs = await RNFS.getFSInfo();
    const plan = storagePlan({ bytes }, { freeStorage: fs.freeSpace, totalStorage: fs.totalSpace });
    if (!plan.ok) {
      throw new Error(
        `Not enough storage for the image model: it needs ${(plan.required / 1e9).toFixed(1)} GB free ` +
          `(${(bytes / 1e9).toFixed(2)} GB download + ${(plan.reserve / 1e9).toFixed(1)} GB kept free for the phone), ` +
          `and ${(fs.freeSpace / 1e9).toFixed(1)} GB is free. Nothing was downloaded`,
      );
    }
  }
  let done = 0;
  for (const f of VISION_FILES) {
    if (!(await isInstalled(f))) await download(f, p => onProgress((done + p * f.bytes) / VISION_BYTES), online);
    done += f.bytes;
  }
}

/** Load the image model (this releases the text model; reload it with load() afterwards). */
export function loadVision(): Promise<LoadInfo> {
  return exclusive(loadVisionNow);
}

async function loadVisionNow(): Promise<LoadInfo> {
  if (!(await isVisionInstalled())) throw new Error('Image model not installed/verified');
  ctx = null;
  visionCtx = null;
  await releaseAll();
  const t0 = Date.now();
  const c = await initLlama({
    model: `file://${file(VISION_MODEL)}`,
    n_ctx: 4096, // an image alone is several hundred tokens
    n_threads: N_THREADS,
    n_gpu_layers: 0,
    use_mlock: false,
    ctx_shift: false, // required by llama.rn for multimodal: media tokens must keep their positions
  });
  if (!(await c.initMultimodal({ path: file(VISION_PROJECTOR), use_gpu: false }))) {
    await releaseAll();
    throw new Error('The image model loaded but its vision part could not start');
  }
  visionCtx = c;
  return { loadMs: Date.now() - t0, lib: c.androidLib, gpu: c.gpu };
}

export const isVisionLoaded = () => visionCtx !== null;

/** Answer `question` about the image (a data: URI or file:// path) with the on-device image model. */
export async function describeImage(question: string, image: string, onText?: (soFar: string) => void): Promise<GenResult> {
  if (!visionCtx) throw new Error('Image model not loaded');
  let t0 = Date.now();
  let first = 0;
  let soFar = '';
  const r = await exclusive(() => {
    if (!visionCtx) throw new Error('Image model not loaded'); // released while this waited its turn
    t0 = Date.now();
    return visionCtx.completion({
      messages: [
        { role: 'system', content: 'Describe only what is actually visible. If text is unreadable or something is uncertain, say so instead of guessing. Be concise.' },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: question }] as any },
      ],
      n_predict: 256,
      temperature: 0.1,
    },
    d => {
      if (!first) first = Date.now() - t0;
      soFar += d.token;
      onText?.(soFar);
    });
  });
  return {
    text: r.text.trim(), firstTokenMs: first, totalMs: Date.now() - t0, tokens: r.timings.predicted_n,
    tokPerSec: r.timings.predicted_per_second, promptMs: r.timings.prompt_ms,
  };
}

export type GenResult = {
  text: string;
  firstTokenMs: number;
  totalMs: number;
  tokens: number;
  tokPerSec: number;
  promptMs: number;
};

/** The user's own standing instructions ("custom instructions"), added to every chat's system message. Kept short
 *  (MAX_INSTRUCTIONS) so they never crowd out the conversation in the 2,048-token context. */
export const MAX_INSTRUCTIONS = 600;
let instructions = '';
export function setInstructions(text: string) { instructions = text.trim().slice(0, MAX_INSTRUCTIONS); }

/** `history`: earlier turns of this conversation (already bounded by chatStore.recentContext), oldest first.
 *  `knowledge`: relevant facts about the user (learning.relevantKnowledge, bounded), added to the system message. */
export async function generate(
  prompt: string,
  onText?: (soFar: string) => void,
  nPredict = 128,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
  knowledge = '',
): Promise<GenResult> {
  if (!ctx) throw new Error('Local model not loaded');
  let t0 = Date.now();
  let first = 0;
  let soFar = '';
  const r = await exclusive(() => {
    if (!ctx) throw new Error('Local model not loaded'); // released (e.g. image model loaded) while this waited
    t0 = Date.now();
    return ctx.completion(
      {
        messages: [
          { role: 'system', content: `You are a concise, helpful assistant.${instructions ? `\n\nThe user's standing instructions: ${instructions}` : ''}${knowledge ? `\n\n${knowledge}` : ''}` },
          ...history,
          { role: 'user', content: prompt },
        ],
        n_predict: nPredict,
        temperature: 0.2,
      },
      d => {
        if (!first) first = Date.now() - t0;
        soFar += d.token;
        onText?.(soFar);
      },
    );
  });
  return {
    text: r.text.trim(),
    firstTokenMs: first,
    totalMs: Date.now() - t0,
    tokens: r.timings.predicted_n,
    tokPerSec: r.timings.predicted_per_second,
    promptMs: r.timings.prompt_ms,
  };
}

/**
 * A JSON answer constrained by `schema` (llama.rn turns the schema into a grammar, so the output is always
 * syntactically valid JSON of that shape; whether its content makes sense is for the caller to check).
 * Used by the agent planner (src/agents/planner.ts). Runs in the same one-at-a-time queue as generate().
 * @throws Error when the model is not loaded
 */
export async function completeJson(system: string, user: string, schema: object, nPredict = 320): Promise<string> {
  if (!ctx) throw new Error('Local model not loaded');
  const r = await exclusive(() => {
    if (!ctx) throw new Error('Local model not loaded');
    return ctx.completion({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      n_predict: nPredict,
      temperature: 0,
      // jinja off: llama.rn then turns the schema into a strict grammar. With its template engine on (the default),
      // the grammar came from the chat template and stayed lazy on the M35: the model wrote
      // '<|im_start|>assistant ```json …' and every JSON answer (agent plans, the need classifier) failed to parse.
      jinja: false,
      response_format: { type: 'json_schema', json_schema: { strict: true, schema } },
    });
  });
  return r.text.trim();
}

export const BENCH_PROMPTS = [
  'Hello',
  'Explain what an Android Activity is in one sentence.',
  'What is 2 + 2?',
  'Classify this request. Reply with only one word from: general, coding, ui_design, research.\nRequest: "Create an Android login screen in Figma."',
];

// ---------------------------------------------------------------- Phase 14: model-manager state on disk

/** Persisted in models/state.json (small JSON; never contains model data or user text). */
export type ManagerState = {
  active: string; // model id in use for on-device text
  previous: string | null; // kept only until the new model is accepted (rollback window)
  baseline: import('./modelManager').Baseline | null; // measured on this phone (Benchmark)
  catalog: import('./modelManager').CachedCatalog | null;
  dismissed: string[]; // upgrade offers the user answered "Keep Current" to
  visionDeclined?: boolean; // "Don't ask again" for the on-device image model offer
};
const stateFile = `${dir}/state.json`;
export const DEFAULT_STATE: ManagerState = { active: MODEL.id, previous: null, baseline: null, catalog: null, dismissed: [] };

export async function readManagerState(): Promise<ManagerState> {
  try {
    if (!(await RNFS.exists(stateFile))) return { ...DEFAULT_STATE };
    return { ...DEFAULT_STATE, ...JSON.parse(await RNFS.readFile(stateFile, 'utf8')) };
  } catch {
    return { ...DEFAULT_STATE }; // unreadable state never blocks the working default model
  }
}

export async function writeManagerState(patch: Partial<ManagerState>): Promise<ManagerState> {
  const next = { ...(await readManagerState()), ...patch };
  await RNFS.mkdir(dir);
  await RNFS.writeFile(`${stateFile}.tmp`, JSON.stringify(next), 'utf8');
  if (await RNFS.exists(stateFile)) await RNFS.unlink(stateFile);
  await RNFS.moveFile(`${stateFile}.tmp`, stateFile); // write-then-rename: a crash never leaves half a file
  return next;
}

/** The model the manager marked active (falls back to the Phase 2 default if the state names an unknown one). */
export async function activeModel(): Promise<CatalogModel> {
  const st = await readManagerState();
  const known = [...BUILTIN_CATALOG, ...(st.catalog?.models ?? [])];
  return known.find(m => m.id === st.active && m.supported && m.chatCapable) ?? BUILTIN_CATALOG[0];
}

/** Model files present in models/ (ids), e.g. to delete obsolete ones after a successful replacement. */
export async function installedIds(): Promise<string[]> {
  if (!(await RNFS.exists(dir))) return [];
  return (await RNFS.readDir(dir)).filter(f => f.name.endsWith('.gguf')).map(f => f.name.replace(/\.gguf$/, ''));
}

/** Disk space for the model manager's storage rule. */
export async function storageInfo(): Promise<{ freeStorage: number; totalStorage: number }> {
  const i = await RNFS.getFSInfo();
  return { freeStorage: i.freeSpace, totalStorage: i.totalSpace };
}
