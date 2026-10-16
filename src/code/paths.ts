/**
 * Workspace-relative paths ("src/app/main.ts"). They are only names inside a workspace: the app never turns one into a
 * filesystem path, it resolves it segment by segment against the folder listing the storage provider returned. Paths
 * coming from the model are untrusted, so anything that could mean "somewhere else" is rejected, not repaired.
 */

export const MAX_PATH = 300;
export const MAX_SEGMENT = 120;
export const MAX_DEPTH = 20;

export class PathError extends Error {}

/**
 * The canonical form of a relative path, or a PathError saying why it is not acceptable.
 * Rejects: absolute paths and drive letters, "..", ".", empty segments, backslashes, percent-encoding (e.g. %2e%2e),
 * control characters, Unicode that changes under NFKC (e.g. fullwidth dots or slashes), and names that are too long.
 */
export function normalizePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new PathError('the path must be text');
  const p = raw.trim().replace(/^\.\/+/, ''); // "./src/a.ts" is the same file as "src/a.ts"
  if (!p) throw new PathError('the path is empty');
  if (p.length > MAX_PATH) throw new PathError(`the path is longer than ${MAX_PATH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) throw new PathError('the path contains control characters');
  if (p.includes('\\')) throw new PathError('backslashes are not allowed in paths');
  if (/%[0-9a-f]{2}/i.test(p)) throw new PathError('encoded characters (like %2e) are not allowed in paths');
  if (p.normalize('NFKC') !== p) throw new PathError('the path contains look-alike characters');
  if (p.startsWith('/') || /^[a-z]:/i.test(p) || p.startsWith('~')) throw new PathError('the path must be inside the workspace');
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) throw new PathError('URIs are not paths');
  const parts = p.split('/');
  if (parts.length > MAX_DEPTH) throw new PathError('the path is nested too deeply');
  for (const s of parts) {
    if (!s) throw new PathError('the path has an empty segment');
    if (s === '.' || s === '..') throw new PathError('".." and "." are not allowed in paths');
    if (s.length > MAX_SEGMENT) throw new PathError('a name in the path is too long');
    if (/[<>:"|?*]/.test(s)) throw new PathError('the path contains characters file names can\'t have');
  }
  return parts.join('/');
}

/** "src/a/b.ts" -> "src/a" ("" for the workspace root). */
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
/** "src/a/b.ts" -> "b.ts". */
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** Paths compared the way case-insensitive providers would (two changes to "A.ts" and "a.ts" conflict). */
export const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
