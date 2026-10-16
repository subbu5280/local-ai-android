/**
 * M8 backup creation: encryption with real AES-256-GCM / PBKDF2 (Node's crypto behind the AiCrypto interface),
 * password rules, unique randomness, no plaintext and no plaintext fallback, low storage, cancellation, write and
 * destination failures, temporary-file cleanup, and no password in logs.
 */
jest.mock('@dr.pogodin/react-native-fs', () => require('../testUtils/fakeBackupEnv').fakeFs());
jest.mock('llama.rn', () => ({ releaseAllLlama: jest.fn(), initLlama: jest.fn() }));

import { NativeModules } from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { checkPassword, cleanupTemp, createBackup, activeTemp, saveBackup, tempDir, estimate } from '../src/backup/backup';
import { DEFAULT_ITERATIONS, MAGIC } from '../src/backup/format';
import { ALL, FAST, freshDb, PW, SECRET_TEXT, seed } from '../testUtils/backupFixture';
import { cryptoCalls, fsState, pickerState } from '../testUtils/fakeBackupEnv';

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
const read = (p: string) => node('fs').readFileSync(p, 'utf8') as string;
const temps = async () => ((await RNFS.exists(tempDir())) ? (await RNFS.readDir(tempDir())).map(f => f.name) : []);

beforeEach(async () => { await freshDb(); await seed(); await RNFS.unlink(tempDir()); activeTemp.clear(); });

test('a backup is encrypted, versioned, verified, saved where the user chose, and its temporary file removed', async () => {
  const b = await createBackup(ALL as any, PW, PW, { iterations: FAST });
  const text = read(b.path);
  const [magic, header, ...chunks] = text.trimEnd().split('\n');
  expect(magic).toBe(MAGIC);
  expect(JSON.parse(header)).toMatchObject({ format: 1, cipher: 'AES-256-GCM', kdf: { name: 'PBKDF2-HMAC-SHA256', iterations: FAST } });
  expect(chunks.length).toBeGreaterThan(0);
  for (const s of [SECRET_TEXT, 'Falcon', 'refunds', 'My helper', 'q9Zr8Xw7', 'Demo']) expect(text).not.toContain(s); // no plaintext anywhere
  expect(b.manifest.categories.map(c => c.id)).toEqual(ALL);
  const saved = await saveBackup(b.path, 'my.laibackup');
  expect(saved).toMatchObject({ name: 'my.laibackup' });
  expect(read(pickerState.saved[0])).toBe(text);
  expect(await temps()).toEqual([]);
});

test('a backup derives its key once (PBKDF2 takes seconds on a phone) and wipes it afterwards', async () => {
  cryptoCalls.length = 0;
  const keysBefore = (NativeModules.AiCrypto as any).keyCount();
  await createBackup(['chats'] as any, PW, PW, { iterations: FAST });
  expect(cryptoCalls.filter(c => c === 'deriveKey')).toHaveLength(1);
  expect((NativeModules.AiCrypto as any).keyCount()).toBe(keysBefore);
});

test('the default key derivation is PBKDF2-HMAC-SHA256 with 600,000 iterations', async () => {
  const b = await createBackup(['settings'] as any, PW, PW);
  expect(JSON.parse(read(b.path).split('\n')[1]).kdf.iterations).toBe(DEFAULT_ITERATIONS);
  expect(DEFAULT_ITERATIONS).toBe(600_000);
});

test('password rules: minimum length and confirmation; nothing is written for a bad password', async () => {
  expect(checkPassword('short', 'short')).toEqual(['Use at least 10 characters.']);
  expect(checkPassword('long enough pw', 'long enough PW')).toEqual(['The two passwords are different.']);
  await expect(createBackup(['chats'] as any, PW, `${PW}!`)).rejects.toMatchObject({ code: 'password' });
  expect(await temps()).toEqual([]);
});

test('every backup gets a fresh salt, nonce prefix and ciphertext', async () => {
  const a = read((await createBackup(['chats'] as any, PW, PW, { iterations: FAST })).path).split('\n');
  const b = read((await createBackup(['chats'] as any, PW, PW, { iterations: FAST })).path).split('\n');
  const ha = JSON.parse(a[1]), hb = JSON.parse(b[1]);
  expect(ha.kdf.salt).not.toBe(hb.kdf.salt);
  expect(ha.nonce).not.toBe(hb.nonce);
  expect(a[2]).not.toBe(b[2]);
  expect(ha.kdf.salt).toMatch(/^[0-9a-f]{32}$/);
});

test('there is no unencrypted fallback: without the crypto module no file is made', async () => {
  const saved = NativeModules.AiCrypto;
  delete NativeModules.AiCrypto;
  try {
    await expect(createBackup(['chats'] as any, PW, PW, { iterations: FAST })).rejects.toMatchObject({ code: 'unavailable' });
  } finally { NativeModules.AiCrypto = saved; }
  expect(await temps()).toEqual([]);
});

test('low storage is refused before writing; running out while writing removes the partial file', async () => {
  fsState.free = 1000;
  await expect(createBackup(['chats'] as any, PW, PW, { iterations: FAST })).rejects.toMatchObject({ code: 'low_storage' });
  expect(await temps()).toEqual([]);
  fsState.free = 50e9;
  fsState.failAppend = true;
  await expect(createBackup(['chats'] as any, PW, PW, { iterations: FAST })).rejects.toMatchObject({ code: 'low_storage' });
  expect(await temps()).toEqual([]);
});

test('a cancelled backup leaves nothing behind', async () => {
  await expect(createBackup(['chats'] as any, PW, PW, { iterations: FAST, signal: { cancelled: true } })).rejects.toMatchObject({ code: 'cancelled' });
  expect(await temps()).toEqual([]);
  expect(activeTemp.size).toBe(0);
});

test('destination failures, mismatching copies and cancelling the picker never report success', async () => {
  for (const mode of ['fail', 'verify'] as const) {
    pickerState.saveMode = mode;
    const b = await createBackup(['chats'] as any, PW, PW, { iterations: FAST });
    await expect(saveBackup(b.path)).rejects.toMatchObject({ code: 'destination' });
    expect(await temps()).toEqual([]);
  }
  pickerState.saveMode = 'cancel';
  const b = await createBackup(['chats'] as any, PW, PW, { iterations: FAST });
  expect(await saveBackup(b.path)).toBeNull();
  expect(await temps()).toEqual([]);
});

test('abandoned temporary files are cleaned up; files in use are kept', async () => {
  await RNFS.mkdir(tempDir());
  const old = `${tempDir()}/b-old.part`, inUse = `${tempDir()}/r-now.bak`;
  await RNFS.writeFile(old, 'x');
  await RNFS.writeFile(inUse, 'x');
  activeTemp.add(inUse);
  try {
    expect(await cleanupTemp(0, Date.now() + 1000)).toMatchObject({ files: 1 });
    expect(await temps()).toEqual(['r-now.bak']);
  } finally { activeTemp.delete(inUse); }
});

test('size estimates are labelled per category and the password never reaches a log', async () => {
  const logs: string[] = [];
  for (const k of ['log', 'warn', 'error', 'info', 'debug'] as const) jest.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  const e = await estimate(['chats', 'documentText'] as any);
  expect(e.categories.map(c => c.id)).toEqual(['documents', 'documentText', 'chats'].sort((a, b) => ALL.indexOf(a) - ALL.indexOf(b)));
  expect(e.bytes).toBeGreaterThan(0);
  const b = await createBackup(ALL as any, PW, PW, { iterations: FAST });
  await saveBackup(b.path);
  expect(logs.join('\n')).not.toContain(PW);
});
