/**
 * Text recognition (OCR) language data and the bridge to android/.../AiOcrModule.kt (M13).
 *
 * Each language is a tessdata_fast 4.1.0 file, pinned by size and sha256 (computed 2026-10-16). A language is
 * downloaded only when the user asks for it (the caller confirms first), to a `.part` file that is verified before it
 * is moved into place, so a half-downloaded or altered file is never used. Recognition itself is fully offline.
 */
import { NativeModules } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';

export type OcrLanguage = { code: string; name: string; bytes: number; sha256: string };

const BASE = 'https://github.com/tesseract-ocr/tessdata_fast/raw/4.1.0/';
export const OCR_LANGUAGES: OcrLanguage[] = [
  { code: 'eng', name: 'English', bytes: 4113088, sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2' },
  { code: 'tel', name: 'Telugu', bytes: 2769654, sha256: 'd10691fddd5b67802e1c12800ebb321d3b8bcd8d24a2ac3ff206f93188c04ab5' },
  { code: 'hin', name: 'Hindi', bytes: 1122751, sha256: '4c73ffc59d497c186b19d1e90f5d721d678ea6b2e277b719bee4e2af12271825' },
  { code: 'tam', name: 'Tamil', bytes: 3237963, sha256: 'd02fbec24be4b07e32e80d0ccfc3b6b67a3c5d61c9d0a7c8532677990912c6ec' },
  { code: 'kan', name: 'Kannada', bytes: 3608331, sha256: 'bd31e6b6ae93271e3bcf5383d306d8eefbb91542937cd6d735a5930c970e61d8' },
  { code: 'mal', name: 'Malayalam', bytes: 5275996, sha256: 'bd05cbf1b197e7810d2903419aedb06f9ef77bfedf50b358673c1d18d707cdb4' },
];

/** Most PDF pages recognized per document (a scanned page takes seconds on a phone). */
export const OCR_MAX_PAGES = 50;

function module() {
  const m = NativeModules.AiOcr;
  if (!m) throw Object.assign(new Error('Text recognition is not available in this build'), { code: 'unavailable' });
  return m;
}

/** Codes of the languages whose data is installed and verified, in catalog order. */
export async function installedLanguages(): Promise<string[]> {
  if (!NativeModules.AiOcr) return [];
  const present: string[] = await module().languages();
  return OCR_LANGUAGES.map(l => l.code).filter(c => present.includes(c));
}

/**
 * Download one language's data. Call only after the user confirmed. Throws on offline, HTTP error or a hash mismatch
 * (the partial file is deleted in every failure case).
 */
export async function downloadLanguage(code: string, online: boolean): Promise<void> {
  const lang = OCR_LANGUAGES.find(l => l.code === code);
  if (!lang) throw new Error(`Unknown language ${code}`);
  if (!online) throw new Error("You're offline: connect to download text recognition data");
  const dir: string = await module().dataPath();
  const target = `${dir}/${code}.traineddata`;
  const part = `${target}.part`;
  try {
    const res = await RNFS.downloadFile({ fromUrl: BASE + `${code}.traineddata`, toFile: part }).promise;
    if (res.statusCode !== 200) throw new Error(`Download failed: HTTP ${res.statusCode}`);
    const sha = (await RNFS.hash(part, 'sha256')).toLowerCase();
    if (sha !== lang.sha256) throw new Error('Integrity check failed; the file was deleted');
    if (await RNFS.exists(target)) await RNFS.unlink(target);
    await RNFS.moveFile(part, target);
  } finally {
    await RNFS.unlink(part).catch(() => {}); // gone already after a successful move
  }
}

export async function removeLanguage(code: string): Promise<void> {
  if (!OCR_LANGUAGES.some(l => l.code === code)) return;
  const target = `${await module().dataPath()}/${code}.traineddata`;
  if (await RNFS.exists(target)) await RNFS.unlink(target);
}

/** Tesseract language list ("eng+tel"), or null when nothing is installed. */
export async function languageList(): Promise<string | null> {
  const codes = await installedLanguages();
  return codes.length ? codes.join('+') : null;
}

export type OcrPage = { text: string; confidence: number };
export const recognizeImage = (uri: string, langs: string): Promise<OcrPage & { bytes: number; sha256: string }> =>
  module().recognizeImage(uri, false, langs);
export const recognizePdf = (uri: string, langs: string): Promise<{ pages: OcrPage[]; pageCount: number }> =>
  module().recognizePdf(uri, langs, OCR_MAX_PAGES);
export const cancelOcr = () => NativeModules.AiOcr?.cancel();
