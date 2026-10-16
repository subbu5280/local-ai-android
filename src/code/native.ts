/**
 * The Android side of project workspaces (android/.../AiWorkspaceModule.kt, Storage Access Framework only) plus the
 * existing bounded text reader (AiDocs.readText, M3). Every document is a content:// URI; there are no file paths.
 * Native errors arrive as { code, message } and are turned into WorkspaceError with a stable code.
 */
import { NativeModules } from 'react-native';

/** A document as the provider describes it; canWrite/canCreate are the provider's flags. */
export type DocInfo = {
  uri: string; name: string; mime: string | null; size: number; modified: number; dir: boolean; canWrite: boolean; canCreate: boolean;
};
/** A picked folder (its root document) or file, with the grant Android gave the app. */
export type Picked = DocInfo & { treeUri: string; granted_write: boolean };

export type WorkspaceErrorCode = 'unavailable' | 'revoked' | 'not_found' | 'unsupported' | 'too_large' | 'stale' | 'exists'
  | 'name_changed' | 'verify_failed' | 'write_failed' | 'read_failed' | 'busy' | 'cancelled' | 'no_activity' | 'pick_failed';

export class WorkspaceError extends Error {
  constructor(public code: WorkspaceErrorCode, message: string) { super(message); }
}

function mod(name: 'AiWorkspace' | 'AiDocs') {
  const m = NativeModules[name];
  if (!m) throw new WorkspaceError('unavailable', 'Project workspaces are not available in this build');
  return m;
}

async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e: any) {
    if (e instanceof WorkspaceError) throw e;
    throw new WorkspaceError(typeof e?.code === 'string' ? e.code : 'read_failed', String(e?.message ?? e));
  }
}

export const pickFolder = (): Promise<Picked | null> => call(() => mod('AiWorkspace').pickFolder());
export const pickFiles = async (): Promise<Picked[]> => (await call(() => mod('AiWorkspace').pickFiles())) ?? [];
export const access = (treeUri: string): Promise<{ read: boolean; write: boolean }> => call(() => mod('AiWorkspace').access(treeUri));
export const list = (dirUri: string): Promise<DocInfo[]> => call(() => mod('AiWorkspace').list(dirUri));
/** Bounded text of a document: {text, bytes, sha256, lossy}; rejects too_large / not_found / read_failed. */
export const readText = (uri: string, maxBytes: number): Promise<{ text: string; bytes: number; sha256: string; lossy: boolean }> =>
  call(() => mod('AiDocs').readText(uri, maxBytes));
/** Replace a document's text if it still hashes to expectedSha (only src/code/apply.ts calls this). */
export const writeText = (uri: string, text: string, expectedSha: string): Promise<{ sha256: string; bytes: number }> =>
  call(() => mod('AiWorkspace').write(uri, text, expectedSha));
/** Create a new file in a folder (only src/code/apply.ts calls this). */
export const createFile = (dirUri: string, name: string, mime: string, text: string): Promise<DocInfo> =>
  call(() => mod('AiWorkspace').create(dirUri, name, mime, text));
export function release(treeUri: string): void {
  try { NativeModules.AiWorkspace?.release(treeUri); } catch {} // best effort: the grant also ends when the files go away
}
