/**
 * The Android side of documents (android/.../AiDocsModule.kt): the system file picker and text extraction.
 * Native errors arrive as { code, message }; ExtractFailure carries both to the indexer.
 */
import { NativeModules } from 'react-native';

export type PickedFile = { uri: string; name: string; mime: string | null; size: number }; // size -1 = unknown
export type TextFile = { text: string; bytes: number; sha256: string; lossy: boolean };
export type PdfFile = { pages: string[]; bytes: number; sha256: string };

export class ExtractFailure extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function module() {
  const m = NativeModules.AiDocs;
  if (!m) throw new ExtractFailure('unavailable', 'Document import is not available in this build');
  return m;
}

/** Turn a native rejection into ExtractFailure (code kept; a generic code when the error has none). */
async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e: any) {
    if (e instanceof ExtractFailure) throw e;
    throw new ExtractFailure(typeof e?.code === 'string' ? e.code : 'read_failed', String(e?.message ?? e));
  }
}

export const pickFiles = (): Promise<PickedFile[]> => call(() => module().pick());
export const fileInfo = (uri: string): Promise<PickedFile> => call(() => module().info(uri));
export const readText = (uri: string, maxBytes: number): Promise<TextFile> => call(() => module().readText(uri, maxBytes));
/** Text of a .docx ({text}) or sheets of a .xlsx ({sheets}), read and parsed natively with ZIP/XML limits (M11). */
export type OfficeFile = { text?: string; sheets?: { name: string; rows: string[][] }[]; bytes: number; sha256: string };
export const readOffice = (uri: string, kind: 'docx' | 'xlsx', maxBytes: number): Promise<OfficeFile> => call(() => module().readOffice(uri, kind, maxBytes));
export const readPdf = (uri: string, maxBytes: number): Promise<PdfFile> => call(() => module().readPdf(uri, maxBytes));
/** Save text as a new file the user names and places (Android's save picker); null when the user cancels. */
export const createTextFile = (name: string, mime: string, text: string): Promise<PickedFile | null> =>
  call(() => module().createTextFile(name, mime, text));
/** Give up the kept read access to a removed document; never touches the file. */
export function releaseFile(uri: string): void {
  try { NativeModules.AiDocs?.release(uri); } catch {} // best effort: access also ends when the file goes away
}
