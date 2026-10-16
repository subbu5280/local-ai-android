/**
 * The camera is an AI feature: it opens only when the phone's own image model can actually look at the photo.
 *
 * ensureReady() is the single gate. It reuses localModel's existing pieces (no second downloader): the explicit
 * Download approval, the Phase 14 storage check, the checked download with sha256 verification (a bad or partial file
 * is deleted), and loadVision(), which keeps one large model in RAM and runs in localModel's one-at-a-time queue.
 *
 * States: ready (model loaded) | cancelled (the user chose "Not now") | failed (offline, storage, download, checksum or
 * load problem; the reason was already reported). Two quick taps share ONE operation (single-flight).
 */
import * as local from './localModel';

export type VisionReady = 'ready' | 'cancelled' | 'failed';
export type VisionDeps = {
  /** Ask the user to download the image model (Download / Not now). */
  askDownload: () => Promise<'download' | 'later'>;
  online: () => boolean;
  /** Tell the user what is happening or why the camera did not open (progress messages update in place). */
  report: (text: string, id?: string) => string;
};

let inFlight: Promise<VisionReady> | null = null;

/** Resolves 'ready' only when the image model is loaded and usable; never opens anything itself. */
export function ensureReady(deps: VisionDeps): Promise<VisionReady> {
  inFlight ??= prepare(deps).finally(() => { inFlight = null; });
  return inFlight;
}

/** True while ensureReady() is downloading or loading (other download offers must wait). */
export const isPreparing = () => inFlight !== null;

async function prepare(deps: VisionDeps): Promise<VisionReady> {
  if (local.isVisionLoaded()) return 'ready'; // state A: camera right away
  if (!(await local.isVisionInstalled().catch(() => false))) {
    if (!deps.online()) {
      deps.report("⚠ The camera needs this phone's image model, which isn't downloaded, and you're offline, so it can't be downloaded now. The camera was not opened.");
      return 'failed';
    }
    if ((await deps.askDownload()) !== 'download') return 'cancelled'; // state B, "Not now": camera stays closed
    const id = deps.report('⬇ Downloading the image model 0%… (keep the app open)');
    try {
      await local.downloadVision(f => deps.report(`⬇ Downloading the image model ${Math.floor(f * 100)}%… (keep the app open)`, id), deps.online());
    } catch (e: any) {
      // Storage, network or sha256 failures: localModel already removed any partial/invalid file.
      deps.report(`⚠ Vision model download failed. The camera was not opened.
${e?.message ?? e}`, id);
      return 'failed';
    }
    deps.report('✓ Image model downloaded and verified. Starting it…', id);
  }
  try {
    await local.loadVision(); // state C (downloaded, not loaded) and after a fresh download
  } catch (e: any) {
    deps.report(`⚠ The vision model could not be loaded, so the camera wasn't opened.
${e?.message ?? e}`);
    return 'failed';
  }
  return local.isVisionLoaded() ? 'ready' : 'failed';
}
