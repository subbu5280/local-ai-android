/**
 * Test helper: an in-memory document provider behaving like android/.../AiWorkspaceModule.kt (folder listing, guarded
 * write with read-back, create-only) plus AiDocs.readText, so src/code/ runs against realistic provider behavior in
 * Jest. Failure switches simulate what real providers do: revoked grants, deleted files, providers that can't write or
 * create, writes that fail, and writes whose read-back differs.
 */
type Doc = { text: string; canWrite: boolean };

export type FakeProvider = ReturnType<typeof fakeProvider>;

export function fakeProvider(files: Record<string, string>, opts: { grantWrite?: boolean } = {}) {
  const crypto = (globalThis as any).process.getBuiltinModule('crypto');
  const Buffer = (globalThis as any).Buffer; // node's Buffer without @types/node
  const sha = (s: string) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
  const TREE = 'content://fake/tree/root';
  const uriOf = (path: string) => `${TREE}/document/${encodeURIComponent(path)}`;
  const pathOf = (uri: string) => decodeURIComponent(uri.slice(`${TREE}/document/`.length));
  const docs = new Map<string, Doc>(Object.entries(files).map(([p, t]) => [p, { text: t, canWrite: true }]));
  const dirs = new Set<string>(['']);
  const addDirs = (p: string) => { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); };
  docs.forEach((_d, p) => addDirs(p));
  const state = {
    revoked: false, grantWrite: opts.grantWrite ?? true, cantCreate: false, cantWrite: new Set<string>(), failWrite: new Set<string>(),
    corruptWrite: new Set<string>(), largeLimit: Infinity, writes: [] as string[], creates: [] as string[], released: [] as string[],
  };
  const info = (path: string) => {
    const dir = dirs.has(path);
    const d = docs.get(path);
    return { uri: uriOf(path), name: path.split('/').pop() || 'root', mime: dir ? 'vnd.android.document/directory' : 'text/plain',
      size: d ? Buffer.byteLength(d.text) : -1, modified: 1, dir, canWrite: !!d?.canWrite && !state.cantWrite.has(path), canCreate: dir && !state.cantCreate };
  };
  const err = (code: string, message: string) => Object.assign(new Error(message), { code });
  const check = () => { if (state.revoked) throw err('revoked', 'Access to this folder was removed'); };

  const workspace = {
    pickFolder: jest.fn(async () => ({ ...info(''), name: 'project', treeUri: TREE, granted_write: state.grantWrite })),
    pickFiles: jest.fn(async () => [...docs.keys()].slice(0, 2).map(p => ({ ...info(p), treeUri: uriOf(p), granted_write: state.grantWrite }))),
    access: jest.fn(async () => ({ read: !state.revoked, write: !state.revoked && state.grantWrite })),
    list: jest.fn(async (dirUri: string) => {
      check();
      const dir = pathOf(dirUri);
      if (!dirs.has(dir)) throw err('not_found', 'The folder can no longer be opened');
      const kids = [...new Set([...docs.keys(), ...dirs].filter(p => p && (dir ? p.startsWith(`${dir}/`) : true) && !p.slice(dir ? dir.length + 1 : 0).includes('/')))];
      return kids.map(info);
    }),
    write: jest.fn(async (uri: string, text: string, expectedSha: string) => {
      check();
      const p = pathOf(uri);
      const d = docs.get(p);
      if (!d) throw err('not_found', 'The file can no longer be opened');
      if (sha(d.text) !== expectedSha) throw err('stale', 'The file changed since it was checked');
      if (state.cantWrite.has(p) || !state.grantWrite) throw err('unsupported', "This storage provider can't replace the file's contents");
      if (state.failWrite.has(p)) throw err('write_failed', 'IOException');
      if (state.corruptWrite.has(p)) throw err('verify_failed', 'restored'); // the module wrote the original back
      d.text = text;
      state.writes.push(p);
      return { sha256: sha(text), bytes: Buffer.byteLength(text) };
    }),
    create: jest.fn(async (dirUri: string, name: string, _mime: string, text: string) => {
      check();
      const dir = pathOf(dirUri);
      const p = dir ? `${dir}/${name}` : name;
      if (state.cantCreate) throw err('unsupported', "This storage provider can't create files here");
      if (docs.has(p) || dirs.has(p)) throw err('exists', 'A file with this name already exists');
      docs.set(p, { text, canWrite: true });
      state.creates.push(p);
      return info(p);
    }),
    release: jest.fn((u: string) => { state.released.push(u); }),
  };
  const readText = jest.fn(async (uri: string, maxBytes: number) => {
    check();
    const d = docs.get(pathOf(uri));
    if (!d) throw err('not_found', 'The file can no longer be opened');
    const bytes = Buffer.byteLength(d.text);
    if (bytes > Math.min(maxBytes, state.largeLimit)) throw err('too_large', 'The file is larger than the limit');
    return { text: d.text, bytes, sha256: sha(d.text), lossy: d.text.includes('�') };
  });
  return {
    workspace, readText, state, sha, uriOf,
    /** The file's current text in the "provider" (what the user's project now holds). */
    text: (path: string) => docs.get(path)?.text,
    /** Change a file behind the app's back (another editor). */
    edit: (path: string, text: string) => { docs.get(path)!.text = text; },
    remove: (path: string) => { docs.delete(path); },
    paths: () => [...docs.keys()].sort(),
  };
}

/** Install the fake as the native modules (AiDocs keeps its other methods as no-op mocks). */
export function installProvider(p: FakeProvider) {
  const { NativeModules } = require('react-native');
  NativeModules.AiWorkspace = p.workspace;
  NativeModules.AiDocs = { ...(NativeModules.AiDocs ?? {}), readText: p.readText, readPdf: jest.fn(), pick: jest.fn(async () => []), info: jest.fn(), release: jest.fn() };
}
