/**
 * Test helpers for M8 backups: a react-native-fs replacement on a real temporary directory (node:fs), the AiCrypto
 * module implemented with Node's real crypto (PBKDF2-HMAC-SHA256, AES-256-GCM, randomBytes) behaving like
 * AiCryptoModule.kt (same bounds, ciphertext‖tag output, auth_failed errors), and the save/open pickers of
 * AiDocsModule (with switches for cancel, failure and verification mismatch).
 */
const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
const Buf = (globalThis as any).Buffer;

export const fsState = { root: '', free: 50e9, failAppend: false };

/** Use as: jest.mock('@dr.pogodin/react-native-fs', () => require('../testUtils/fakeBackupEnv').fakeFs()). */
export function fakeFs() {
  const fs = node('fs'), os = node('os'), path = node('path');
  fsState.root = fs.mkdtempSync(path.join(os.tmpdir(), 'rnfs-'));
  const docs = path.join(fsState.root, 'docs'), cache = path.join(fsState.root, 'cache');
  fs.mkdirSync(docs); fs.mkdirSync(cache);
  const item = (p: string) => { const s = fs.statSync(p); return { name: path.basename(p), path: p, size: s.size, mtime: s.mtime, isFile: () => s.isFile(), isDirectory: () => s.isDirectory() }; };
  return {
    DocumentDirectoryPath: docs,
    CachesDirectoryPath: cache,
    exists: async (p: string) => fs.existsSync(p),
    mkdir: async (p: string) => { fs.mkdirSync(p, { recursive: true }); },
    writeFile: async (p: string, s: string) => { fs.writeFileSync(p, s, 'utf8'); },
    appendFile: async (p: string, s: string) => {
      if (fsState.failAppend) throw new Error('ENOSPC: no space left on device');
      fs.appendFileSync(p, s, 'utf8');
    },
    readFile: async (p: string) => fs.readFileSync(p, 'utf8'),
    read: async (p: string, length: number, position: number) => {
      const fd = fs.openSync(p, 'r');
      try { const b = Buf.alloc(length); const n = fs.readSync(fd, b, 0, length, position); return b.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
    },
    stat: async (p: string) => item(p),
    unlink: async (p: string) => { fs.rmSync(p, { force: true, recursive: true }); },
    readDir: async (p: string) => fs.readdirSync(p).map((n: string) => item(`${p}/${n}`)), // "/" like Android paths
    moveFile: async (a: string, b: string) => { fs.renameSync(a, b); },
    getFSInfo: async () => ({ freeSpace: fsState.free, totalSpace: 128e9 }),
    hash: async (p: string) => node('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
    downloadFile: () => ({ jobId: 1, promise: Promise.reject(new Error('no network in tests')) }),
    stopDownload: () => undefined,
  };
}

export const cryptoCalls: string[] = [];

/** AiCrypto with Node's crypto (same algorithms and limits as AiCryptoModule.kt). */
export function fakeCrypto() {
  const c = node('crypto');
  const keys = new Map<string, any>();
  const err = (code: string, message: string) => Object.assign(new Error(message), { code });
  return {
    randomHex: async (n: number) => c.randomBytes(n).toString('hex'),
    deriveKey: async (password: string, saltHex: string, iterations: number) => {
      cryptoCalls.push('deriveKey');
      if (iterations < 100_000 || iterations > 10_000_000 || saltHex.length < 32) throw err('invalid', 'unsafe key-derivation parameters');
      const handle = c.randomBytes(16).toString('hex');
      keys.set(handle, c.pbkdf2Sync(Buf.from(password, 'utf8'), Buf.from(saltHex, 'hex'), iterations, 32, 'sha256'));
      return handle;
    },
    seal: async (h: string, nonceHex: string, aad: string, plaintext: string) => {
      const k = keys.get(h); if (!k) throw err('failed', 'no key');
      const ci = c.createCipheriv('aes-256-gcm', k, Buf.from(nonceHex, 'hex'));
      ci.setAAD(Buf.from(aad, 'utf8'));
      return Buf.concat([ci.update(Buf.from(plaintext, 'utf8')), ci.final(), ci.getAuthTag()]).toString('base64');
    },
    open: async (h: string, nonceHex: string, aad: string, sealed: string) => {
      const k = keys.get(h); if (!k) throw err('failed', 'no key');
      const all = Buf.from(sealed, 'base64');
      if (all.length < 16) throw err('auth_failed', 'malformed data');
      try {
        const de = c.createDecipheriv('aes-256-gcm', k, Buf.from(nonceHex, 'hex'));
        de.setAAD(Buf.from(aad, 'utf8'));
        de.setAuthTag(all.subarray(all.length - 16));
        return Buf.concat([de.update(all.subarray(0, all.length - 16)), de.final()]).toString('utf8');
      } catch { throw err('auth_failed', 'authentication failed'); }
    },
    forget: (h: string) => { keys.get(h)?.fill(0); keys.delete(h); },
    keyCount: () => keys.size,
  };
}

export const pickerState = { saveMode: 'ok' as 'ok' | 'cancel' | 'fail' | 'verify', saved: [] as string[], openFrom: '' };

/** AiDocs.saveCopy / openCopy: copy between the private cache and a "user-chosen" directory. */
export function fakeBackupPickers() {
  const fs = node('fs'), path = node('path');
  const dest = path.join(fsState.root, 'user-files');
  fs.mkdirSync(dest, { recursive: true });
  return {
    saveCopy: async (src: string, name: string) => {
      if (pickerState.saveMode === 'cancel') return null;
      if (pickerState.saveMode === 'fail') throw Object.assign(new Error('The backup could not be written there (IOException)'), { code: 'write_failed' });
      if (pickerState.saveMode === 'verify') throw Object.assign(new Error('mismatch'), { code: 'verify_failed' });
      const to = path.join(dest, name);
      fs.copyFileSync(src, to);
      pickerState.saved.push(to);
      return { uri: `content://user/${name}`, name, size: fs.statSync(to).size };
    },
    openCopy: async (to: string, maxBytes: number) => {
      if (!pickerState.openFrom) return null;
      const size = fs.statSync(pickerState.openFrom).size;
      if (size > maxBytes) throw Object.assign(new Error('The file is larger than a backup can be'), { code: 'too_large' });
      fs.copyFileSync(pickerState.openFrom, to);
      return { name: path.basename(pickerState.openFrom), size };
    },
  };
}
