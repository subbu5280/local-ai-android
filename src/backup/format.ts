/**
 * The encrypted backup container, format 1 (see docs/backup-and-restore.md). A text file, written and read line by line:
 *
 *   LOCALAI-BACKUP/1                                       magic and format version
 *   {"format":1,"cipher":"AES-256-GCM","kdf":{...},"nonce":"<16 hex>"}   header (ASCII JSON)
 *   <base64 AES-256-GCM ciphertext+tag of chunk 0>
 *   <... chunk 1 ...>
 *   <... last chunk ...>
 *
 * - Key: PBKDF2-HMAC-SHA256(password, 16-byte random salt, iterations) → 256-bit AES key. A fresh salt per backup means
 *   a fresh key per backup.
 * - Nonce of chunk i: the header's 8-byte random prefix ‖ i as 4 bytes big-endian. Unique for every chunk under a key.
 * - Associated data of chunk i: both header lines, i, and whether it is the last chunk. So the header can't be edited,
 *   chunks can't be reordered, dropped, duplicated or appended, and a truncated file fails authentication.
 * - Plaintext: JSON lines (manifest, rows, end marker), at most MAX_CHUNK_CHARS per chunk. No compression (no
 *   decompression bombs), no file names or paths (nothing is ever extracted to the file system).
 * Every header field is untrusted on reading and checked against fixed bounds before any key is derived.
 */
import * as RNFS from '@dr.pogodin/react-native-fs';
import * as crypto from './crypto';
import { CryptoError } from './crypto';

export const MAGIC = 'LOCALAI-BACKUP/1';
export const FORMAT = 1;
export const CIPHER = 'AES-256-GCM';
export const KDF = 'PBKDF2-HMAC-SHA256';
/** OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256 is 600,000 iterations. */
export const DEFAULT_ITERATIONS = 600_000;
/** Iterations accepted when reading (a file can't make the phone do 10^9 iterations, or accept a weak key). */
export const ITERATION_BOUNDS: [number, number] = [200_000, 2_000_000];
export const LIMITS = {
  maxFileBytes: 512 * 1024 * 1024,
  maxHeaderChars: 1024,
  maxChunkChars: 256 * 1024, // plaintext characters per chunk (≤ ~1 MB of UTF-8)
  maxLineChars: 1_500_000, // one base64 chunk line
  maxChunks: 4096,
};

export type Header = { format: 1; cipher: string; kdf: { name: string; iterations: number; salt: string }; nonce: string };
export type BackupErrorCode = 'not_backup' | 'unsupported_version' | 'bad_header' | 'too_large' | 'auth_failed' | 'truncated'
  | 'malformed' | 'cancelled' | 'storage' | 'unavailable' | 'unsupported' | 'low_storage' | 'password' | 'destination' | 'invalid';

export class BackupError extends Error {
  constructor(public code: BackupErrorCode, message: string) { super(message); }
}
export type Signal = { cancelled: boolean };

const WRONG = 'Wrong password, or the file was changed or damaged. Nothing was restored.';

export const headerText = (h: Header) => `${MAGIC}\n${JSON.stringify(h)}`;
export const nonceFor = (prefix: string, i: number) => prefix + i.toString(16).padStart(8, '0');
export const aadFor = (header: string, i: number, last: boolean) => `${header}\n${i}\n${last ? 1 : 0}`;

/** Check an untrusted header line strictly; returns the header or throws BackupError. */
export function parseHeader(magic: string, json: string): Header {
  if (magic !== MAGIC) {
    if (/^LOCALAI-BACKUP\/\d+$/.test(magic)) throw new BackupError('unsupported_version', `This backup uses format ${magic.split('/')[1]}, which this version of the app can't read.`);
    throw new BackupError('not_backup', 'This file is not a Local AI backup.');
  }
  if (json.length > LIMITS.maxHeaderChars) throw new BackupError('bad_header', 'The backup header is too long.');
  let h: any;
  try { h = JSON.parse(json); } catch { throw new BackupError('bad_header', 'The backup header is damaged.'); }
  const keys = (o: any, k: string[]) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).sort().join() === [...k].sort().join();
  if (!keys(h, ['format', 'cipher', 'kdf', 'nonce']) || !keys(h.kdf, ['name', 'iterations', 'salt'])) throw new BackupError('bad_header', 'The backup header has unexpected fields.');
  if (h.format !== FORMAT) throw new BackupError('unsupported_version', `Backup format ${String(h.format)} is not supported.`);
  if (h.cipher !== CIPHER || h.kdf.name !== KDF) throw new BackupError('bad_header', 'The backup uses an unsupported cipher or key derivation.');
  if (!Number.isInteger(h.kdf.iterations) || h.kdf.iterations < ITERATION_BOUNDS[0] || h.kdf.iterations > ITERATION_BOUNDS[1]) {
    throw new BackupError('bad_header', 'The backup\'s key-derivation settings are outside the safe range.');
  }
  if (typeof h.kdf.salt !== 'string' || !/^[0-9a-f]{32}$/.test(h.kdf.salt) || typeof h.nonce !== 'string' || !/^[0-9a-f]{16}$/.test(h.nonce)) {
    throw new BackupError('bad_header', 'The backup header is damaged.');
  }
  return h as Header;
}

// ---------------------------------------------------------------- writing

/**
 * Writes one container to a private file, one chunk at a time (only one chunk of plaintext in memory). The last chunk
 * is held back until finish(), so it can be sealed as "last".
 */
export class ContainerWriter {
  private pending: string | null = null;
  private index = 0;
  private constructor(public path: string, private key: string, public header: Header, private text: string) {}

  static async create(path: string, password: string, iterations = DEFAULT_ITERATIONS): Promise<ContainerWriter> {
    const header: Header = { format: FORMAT, cipher: CIPHER, kdf: { name: KDF, iterations, salt: await crypto.randomHex(16) }, nonce: await crypto.randomHex(8) };
    const key = await crypto.deriveKey(password, header.kdf.salt, iterations);
    const w = new ContainerWriter(path, key, header, headerText(header));
    try { await RNFS.writeFile(path, `${w.text}\n`, 'utf8'); } catch (e: any) { crypto.forget(key); throw storageError(e); }
    return w;
  }

  /** Add one chunk of plaintext (≤ LIMITS.maxChunkChars characters). */
  async add(chunk: string): Promise<void> {
    if (chunk.length > LIMITS.maxChunkChars) throw new BackupError('invalid', 'chunk too large');
    if (this.pending !== null) await this.seal(this.pending, false);
    this.pending = chunk;
  }

  /** Seal the last chunk. The key stays available for verifying the finished file (opened()) until close(). */
  async finish(): Promise<void> {
    if (this.pending === null) throw new BackupError('invalid', 'empty backup');
    await this.seal(this.pending, true);
    this.pending = null;
  }

  /** The header and key, to read this backup back without deriving the key a second time (PBKDF2 takes seconds). */
  opened(): Opened { return { header: this.header, key: this.key }; }

  /** Wipe the key (after verification, or on failure). */
  close(): void { crypto.forget(this.key); }

  private async seal(chunk: string, last: boolean) {
    if (this.index >= LIMITS.maxChunks) throw new BackupError('too_large', 'The backup has too many parts; back up fewer categories at a time.');
    const sealed = await crypto.seal(this.key, nonceFor(this.header.nonce, this.index), aadFor(this.text, this.index, last), chunk);
    try { await RNFS.appendFile(this.path, `${sealed}\n`, 'utf8'); } catch (e: any) { throw storageError(e); }
    this.index++;
  }
}

const storageError = (e: any) => new BackupError(/ENOSPC|space/i.test(String(e?.message)) ? 'low_storage' : 'storage',
  /ENOSPC|space/i.test(String(e?.message)) ? 'The phone ran out of storage while writing the backup.' : 'The backup file could not be written.');

// ---------------------------------------------------------------- reading

/** Call `onLine` for each line of a private file, reading 1 MB at a time (never the whole file). */
async function forEachLine(path: string, onLine: (line: string) => Promise<void>, signal?: Signal): Promise<boolean> {
  const size = Number((await RNFS.stat(path)).size);
  if (size > LIMITS.maxFileBytes) throw new BackupError('too_large', 'This file is larger than a backup can be.');
  let pos = 0, rest = '';
  while (pos < size) {
    if (signal?.cancelled) throw new BackupError('cancelled', 'Cancelled.');
    const n = Math.min(1 << 20, size - pos);
    rest += await RNFS.read(path, n, pos, 'utf8');
    pos += n;
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      await onLine(line);
    }
    if (rest.length > LIMITS.maxLineChars) throw new BackupError('malformed', 'The backup contains a part that is too large.');
  }
  return rest.length === 0; // false: the file did not end with a complete line
}

export type Opened = { header: Header; key: string };

/** Read and strictly check a file's two header lines (no key needed). */
export async function readHeader(path: string): Promise<Header> {
  const first: string[] = [];
  const stop = new Error('stop');
  try {
    await forEachLine(path, async l => { first.push(l); if (first.length === 2) throw stop; });
  } catch (e) { if (e !== stop) throw e; }
  if (first.length < 2) throw new BackupError('not_backup', 'This file is not a Local AI backup.');
  return parseHeader(first[0], first[1]);
}

/** Read and check the header, then derive the key (slow, by design). The caller must forget(key) when done. */
export async function openContainer(path: string, password: string): Promise<Opened> {
  const header = await readHeader(path);
  if (!password) throw new BackupError('password', 'Enter the backup password.');
  try {
    return { header, key: await crypto.deriveKey(password, header.kdf.salt, header.kdf.iterations) };
  } catch (e) {
    if (e instanceof CryptoError && e.code === 'unavailable') throw new BackupError('unavailable', e.message);
    if (e instanceof CryptoError && e.code === 'unsupported') throw new BackupError('unsupported', e.message);
    throw e;
  }
}

/**
 * Decrypt and authenticate every chunk in order, calling `onChunk` with each plaintext only after it authenticated.
 * One chunk is held back so the last one can be checked as "last". Any change, reordering, truncation or extra data
 * fails with BackupError('auth_failed' / 'truncated').
 * @returns the number of chunks
 */
export async function readChunks(path: string, opened: Opened, onChunk: (text: string, index: number) => Promise<void>, signal?: Signal): Promise<number> {
  const text = headerText(opened.header);
  let lineNo = 0, index = 0;
  let held: string | null = null;
  const openOne = async (sealed: string, last: boolean) => {
    if (!/^[A-Za-z0-9+/]+=*$/.test(sealed)) throw new BackupError('malformed', 'The backup is damaged.');
    let plain: string;
    try { plain = await crypto.open(opened.key, nonceFor(opened.header.nonce, index), aadFor(text, index, last), sealed); } catch (e) {
      if (e instanceof CryptoError && e.code === 'auth_failed') throw new BackupError(index === 0 ? 'auth_failed' : last ? 'truncated' : 'auth_failed', index === 0 ? WRONG : 'The backup was changed, damaged or cut short. Nothing was restored.');
      throw e;
    }
    await onChunk(plain, index);
    index++;
  };
  const complete = await forEachLine(path, async line => {
    lineNo++;
    if (lineNo <= 2) return;
    if (lineNo - 2 > LIMITS.maxChunks) throw new BackupError('too_large', 'The backup has too many parts.');
    if (held !== null) await openOne(held, false);
    held = line;
  }, signal);
  if (!complete || held === null) throw new BackupError('truncated', 'The backup is incomplete (cut short). Nothing was restored.');
  await openOne(held, true);
  return index;
}
