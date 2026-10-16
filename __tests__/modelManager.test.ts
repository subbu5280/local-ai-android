/**
 * Phase 9 model manager. RNFS and llama.rn are unit-test mocks: no real download, no real 1.1 GB file.
 */
const mockFiles = new Map<string, string>();
let mockFree = 10e9;
let mockHash = '';
let mockBehaviour: 'ok' | 'http500' | 'network' | 'hang' = 'ok';
let mockRejectHang: ((e: Error) => void) | null = null;
const mockStop = jest.fn((_id: number) => mockRejectHang?.(new Error('aborted')));

jest.mock('llama.rn', () => ({ initLlama: jest.fn(), releaseAllLlama: jest.fn() }));
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async (p: string) => mockFiles.has(p)),
  unlink: jest.fn(async (p: string) => void mockFiles.delete(p)),
  mkdir: jest.fn(async () => {}),
  readFile: jest.fn(async (p: string) => mockFiles.get(p) ?? ''),
  writeFile: jest.fn(async (p: string, d: string) => void mockFiles.set(p, d)),
  moveFile: jest.fn(async (a: string, b: string) => {
    mockFiles.set(b, mockFiles.get(a) ?? '');
    mockFiles.delete(a);
  }),
  getFSInfo: jest.fn(async () => ({ freeSpace: mockFree })),
  hash: jest.fn(async () => mockHash),
  stopDownload: (id: number) => mockStop(id),
  downloadFile: jest.fn(({ toFile, progress }: any) => ({
    jobId: 7,
    promise: new Promise((resolve, reject) => {
      if (mockBehaviour === 'hang') {
        mockFiles.set(toFile, 'partial');
        mockRejectHang = reject;
        return;
      }
      if (mockBehaviour === 'network') return reject(new Error('Network request failed'));
      mockFiles.set(toFile, 'bytes');
      progress?.({ bytesWritten: 50, contentLength: 100 });
      resolve({ statusCode: mockBehaviour === 'http500' ? 500 : 200, bytesWritten: 100 });
    }),
  })),
}));

const mm = () => require('../src/localModel');
const GGUF = '/docs/models/qwen2.5-1.5b-instruct-q4_k_m.gguf';

beforeEach(() => {
  jest.resetModules();
  mockFiles.clear();
  mockFree = 10e9;
  mockBehaviour = 'ok';
  mockRejectHang = null;
  mockHash = mm().MODEL.sha256;
});

test('registry keeps the < 4B on-device model with its checksum and metadata', () => {
  const { SUPPORTED_MODELS, MODEL, minimumStorage, assertUnder4B } = mm();
  expect(SUPPORTED_MODELS).toHaveLength(1);
  expect(MODEL).toMatchObject({ paramsB: 1.54, chatCapable: true, supported: true, bytes: 1117320736 });
  expect(MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(minimumStorage(MODEL)).toBeGreaterThan(MODEL.bytes * 1.2);
  expect(() => assertUnder4B({ ...MODEL, paramsB: 7 })).toThrow('limit is < 4B');
});

test('download → verify → installed (marker only after checksum)', async () => {
  const m = mm();
  const states: string[] = [];
  m.onState((s: string) => states.push(s));
  expect(await m.refreshState()).toBe('not_installed');
  await m.download(m.MODEL, () => {}, true);
  expect(m.getState().state).toBe('installed');
  expect(await m.isInstalled()).toBe(true);
  expect(mockFiles.has(`${GGUF}.part`)).toBe(false); // atomically moved
  expect(states).toEqual(expect.arrayContaining(['downloading', 'verifying', 'installed']));
});

test('checksum mismatch: rejected, file deleted, never marked installed', async () => {
  const m = mm();
  mockHash = 'f'.repeat(64);
  await expect(m.download(m.MODEL, () => {}, true)).rejects.toThrow('Integrity check failed');
  expect(m.getState().state).toBe('failed');
  expect(mockFiles.has(`${GGUF}.part`) || mockFiles.has(GGUF)).toBe(false);
  expect(await m.isInstalled()).toBe(false);
});

test('offline: no download is started', async () => {
  const m = mm();
  const RNFS = require('@dr.pogodin/react-native-fs');
  await expect(m.download(m.MODEL, () => {}, false)).rejects.toThrow("You're offline");
  expect(RNFS.downloadFile).not.toHaveBeenCalled();
});

test('insufficient storage: clear message, no download', async () => {
  const m = mm();
  mockFree = 1e9;
  await expect(m.download(m.MODEL, () => {}, true)).rejects.toThrow('Not enough storage to install this model');
  expect(m.getState().state).toBe('not_installed');
});

test('network interruption and HTTP errors leave nothing installed', async () => {
  const m = mm();
  mockBehaviour = 'network';
  await expect(m.download(m.MODEL, () => {}, true)).rejects.toThrow('Download interrupted');
  expect(m.getState().state).toBe('failed');
  mockBehaviour = 'http500';
  await expect(m.download(m.MODEL, () => {}, true)).rejects.toThrow('HTTP 500');
  expect(mockFiles.size).toBe(0);
});

test('duplicate download is refused; cancel removes the partial file and resets state', async () => {
  const m = mm();
  mockBehaviour = 'hang';
  const first = m.download(m.MODEL, () => {}, true);
  for (let i = 0; i < 100 && m.getState().state !== 'downloading'; i++) {
    await new Promise<void>(r => setTimeout(() => r(), 1)); // wait until the download really started
  }
  expect(m.getState().state).toBe('downloading');
  await expect(m.download(m.MODEL, () => {}, true)).rejects.toThrow('already in progress');
  m.cancelDownload();
  await expect(first).rejects.toThrow('Download cancelled');
  expect(m.getState()).toEqual({ state: 'not_installed', detail: 'cancelled' });
  expect(mockFiles.has(`${GGUF}.part`)).toBe(false);
});

test('a marker without the model file is not "installed"', async () => {
  const m = mm();
  mockFiles.set(`${GGUF}.verified`, m.MODEL.sha256);
  expect(await m.isInstalled()).toBe(false);
  expect(await m.refreshState()).toBe('not_installed');
});
