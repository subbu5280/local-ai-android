/**
 * Phase 14: Local Model Manager rules and the safe replacement / rollback flow (pure logic, injected deps).
 */
import {
  assess, BUILTIN_CATALOG, CATALOG_TTL_MS, findUpgrade, GB, healthCheck, loadCatalog, ramPlan, replaceModel,
  storagePlan, upgradeSummary, validateCatalog, type CatalogModel, type Device, type ReplaceDeps,
} from '../src/modelManager';

const current = BUILTIN_CATALOG.find(m => m.id === 'qwen2.5-1.5b-instruct-q4_k_m')!;
const bigger = BUILTIN_CATALOG.find(m => m.id === 'qwen2.5-3b-instruct-q4_k_m')!;
const phone8: Device = { platform: 'android-arm64', totalRam: 7.5 * GB, availRam: 3 * GB, freeStorage: 60 * GB, totalStorage: 110 * GB };
const fast = { modelId: current.id, loadMs: 5900, firstTokenMs: 500, tokPerSec: 12, correct: true, at: 'x' };

test('catalog: built-in entries are valid and match real Hugging Face metadata of the installed model', () => {
  expect(validateCatalog(BUILTIN_CATALOG).errors).toEqual([]);
  expect(current.sha256).toBe('6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e');
  expect(current.bytes).toBe(1117320736);
});

test('catalog: untrusted refreshed entries are rejected', () => {
  const bad = [
    { ...current, id: 'x1', url: 'http://evil.example/model.gguf' },
    { ...current, id: 'x2', sha256: 'abc' },
    { ...current, id: 'x3', paramsB: 7 },
    { ...current, id: 'x4', capability: 'magic' },
    { ...current, id: 'x5', bytes: 0 },
    'not an object',
  ];
  const r = validateCatalog(bad);
  expect(r.models).toHaveLength(0);
  expect(r.errors).toHaveLength(6);
  expect(validateCatalog({}).models).toEqual([]);
});

test('storage: the stricter of 3 GB and 5 % reserve (15 % refused a 0.5 GB model on the M35)', () => {
  // Free 8 GB, model 3 GB, reserve max(3 GB, 5 % of 20 GB = 1 GB) → requires 6 GB with an in-place .part rename.
  expect(storagePlan({ bytes: 3 * GB }, { freeStorage: 8 * GB, totalStorage: 20 * GB })).toMatchObject({ required: 6 * GB, ok: true });
  // 128 GB phone: 5 % (6.4 GB) is stricter than 3 GB.
  const p = storagePlan({ bytes: 3 * GB }, { freeStorage: 9 * GB, totalStorage: 128 * GB });
  expect(p.reserve).toBeCloseTo(6.4 * GB);
  expect(p.ok).toBe(false);
  // The M35 case: 113 GB phone, 16.8 GB free, 0.5 GB model fits.
  expect(storagePlan({ bytes: 0.49 * GB }, { freeStorage: 16.8 * GB, totalStorage: 113 * GB }).ok).toBe(true);
  expect(storagePlan({ bytes: 3 * GB }, { freeStorage: 5.9 * GB, totalStorage: 16 * GB }).ok).toBe(false);
});

test('RAM: model memory (1.8× file, measured) plus 2.5 GB for the system must fit', () => {
  expect(ramPlan(bigger, { totalRam: 7.5 * GB }).ok).toBe(true);
  expect(ramPlan(bigger, { totalRam: 5.5 * GB }).ok).toBe(false); // 6 GB phone: 3B model would starve the OS
});

test('upgrade: offered only when better, compatible, fitting and fast enough', () => {
  expect(findUpgrade(current, BUILTIN_CATALOG, phone8, fast)?.model.id).toBe('qwen2.5-3b-instruct-q4_k_m');
  const reasons = (id: string, d = phone8, b: any = fast) => assess(current, BUILTIN_CATALOG, d, b).find(a => a.model.id === id)!.reasons;
  expect(reasons('qwen2.5-0.5b-instruct-q4_k_m').join()).toContain('not significantly better'); // smaller is worse
  expect(reasons('qwen3-1.7b-q8_0').join()).toContain('not supported by this app build');
  expect(reasons('gemma-3-1b-it-q4_k_m').join()).toContain('no comparable published quality score');
  // the measured M35 speed (~8 tok/s) predicts ~4 tok/s for the 3B model: too slow, not offered
  expect(reasons('qwen2.5-3b-instruct-q4_k_m', phone8, { ...fast, tokPerSec: 8 }).join()).toContain('below 5');
  expect(findUpgrade(current, BUILTIN_CATALOG, phone8, null)).toBeNull(); // no baseline yet → never guess
  expect(findUpgrade(current, BUILTIN_CATALOG, { ...phone8, totalRam: 5.5 * GB }, fast)).toBeNull();
  expect(findUpgrade(current, BUILTIN_CATALOG, { ...phone8, freeStorage: 4 * GB }, fast)).toBeNull();
  const a = findUpgrade(current, BUILTIN_CATALOG, phone8, fast)!;
  expect(upgradeSummary(a, current.name)).toContain('Current: Qwen2.5 1.5B Instruct');
  expect(upgradeSummary(a, current.name)).toContain('License: Qwen Research License (non-commercial)');
});

test('catalog refresh at most once per interval; failures fall back to cache, then built-in', async () => {
  const remote = jest.fn().mockResolvedValue(BUILTIN_CATALOG);
  const fresh = await loadCatalog({ fetchedAt: 1000, models: [current] }, 1000 + CATALOG_TTL_MS - 1, remote);
  expect(fresh.source).toBe('cache');
  expect(remote).not.toHaveBeenCalled();
  const stale = await loadCatalog({ fetchedAt: 1000, models: [current] }, 1000 + CATALOG_TTL_MS + 1, remote);
  expect(stale.source).toBe('remote');
  expect(stale.refreshed?.models).toHaveLength(BUILTIN_CATALOG.length);
  const down = await loadCatalog(null, 0, () => Promise.reject(new Error('offline')));
  expect(down.source).toBe('builtin');
  expect(down.errors[0]).toContain('refresh failed');
});

function deps(over: Partial<ReplaceDeps> = {}) {
  const log: string[] = [];
  const d: ReplaceDeps = {
    device: async () => phone8,
    online: () => true,
    download: async m => { log.push(`download ${m.id}`); },
    loadAndBench: async m => { log.push(`load ${m.id}`); return { loadMs: 9000, firstTokenMs: 900, tokPerSec: 6.5, text: '2 + 2 equals 4.' }; },
    activate: async (m, prev) => { log.push(`activate ${m.id} prev=${prev.id}`); },
    remove: async m => { log.push(`remove ${m.id}`); },
    reloadPrevious: async m => { log.push(`reload ${m.id}`); },
    ...over,
  };
  return { d, log };
}

test('replace: correct order, old model deleted only after the new one passed', async () => {
  const { d, log } = deps();
  const r = await replaceModel(current, bigger, d);
  expect(r.ok).toBe(true);
  expect(log).toEqual([
    `download ${bigger.id}`, `load ${bigger.id}`, `activate ${bigger.id} prev=${current.id}`, `remove ${current.id}`,
  ]);
});

test.each([
  ['checksum/download failure', { download: async () => { throw new Error('Integrity check failed'); } }, 'download'],
  ['wrong test answer', { loadAndBench: async () => ({ loadMs: 1, firstTokenMs: 1, tokPerSec: 9, text: 'five' }) }, 'test'],
  ['too slow', { loadAndBench: async () => ({ loadMs: 1, firstTokenMs: 1, tokPerSec: 2.1, text: '4' }) }, 'test'],
  ['slow first token', { loadAndBench: async () => ({ loadMs: 1, firstTokenMs: 9000, tokPerSec: 9, text: '4' }) }, 'test'],
  ['load crash', { loadAndBench: async () => { throw new Error('OOM'); } }, 'load'],
  ['activation failure', { activate: async () => { throw new Error('state write failed'); } }, 'activate'],
])('replace failure keeps the old model and deletes the new files: %s', async (_name, over, step) => {
  const { d, log } = deps(over as Partial<ReplaceDeps>);
  const r = await replaceModel(current, bigger, d);
  expect(r).toMatchObject({ ok: false, step });
  expect(log).toContain(`remove ${bigger.id}`); // incomplete / rejected download removed
  expect(log).toContain(`reload ${current.id}`); // user keeps a working model
  expect(log).not.toContain(`remove ${current.id}`);
  expect(log.some(l => l.startsWith('activate'))).toBe(false);
});

test('replace: old-model cleanup failure AFTER activation never rolls back; the new model stays active', async () => {
  const disk = new Set([current.id, bigger.id]);
  let active = current.id;
  const steps: string[] = [];
  const { d, log } = deps({
    activate: async m => { active = m.id; },
    remove: async m => {
      if (m.id === current.id) throw new Error('EBUSY: unlink failed'); // old model's delete fails half-way
      disk.delete(m.id);
    },
    reloadPrevious: async m => { active = m.id; },
  });
  const r = await replaceModel(current, bigger, d, (s, detail) => steps.push(`${s}${detail ? `: ${detail}` : ''}`));
  expect(r.ok).toBe(true);
  expect(active).toBe(bigger.id); // new model remains active
  expect(disk.has(bigger.id)).toBe(true); // and on disk
  expect(log).not.toContain(`reload ${current.id}`); // no rollback
  expect(steps).not.toContain('rolled_back');
  expect(r.cleanupError).toContain('could not be fully deleted: EBUSY'); // honest warning, not "removed"
  expect(steps[steps.length - 1]).toContain('done: the old model');
});

test('replace refuses before downloading when offline or storage is short', async () => {
  const off = deps({ online: () => false });
  expect((await replaceModel(current, bigger, off.d)).ok).toBe(false);
  expect(off.log).toEqual([]);
  const full = deps({ device: async () => ({ ...phone8, freeStorage: 4 * GB }) });
  const r = await replaceModel(current, bigger, full.d);
  expect(r.error).toContain('Not enough storage');
  expect(full.log).toEqual([]);
});

test('health check rolls back to the previous model only if it is still installed', async () => {
  const loads: string[] = [];
  const activated: string[] = [];
  const mk = (installed: boolean) => ({
    load: async (m: CatalogModel) => { loads.push(m.id); if (m.id === bigger.id) throw new Error('corrupt'); },
    isInstalled: async () => installed,
    activate: async (m: CatalogModel) => { activated.push(m.id); },
  });
  const r = await healthCheck(bigger, current, mk(true));
  expect(r).toMatchObject({ rolledBack: true, active: current });
  expect(activated).toEqual([current.id]);
  const r2 = await healthCheck(bigger, current, mk(false));
  expect(r2).toMatchObject({ rolledBack: false, error: 'corrupt' });
  const ok = await healthCheck(current, null, mk(true));
  expect(ok).toMatchObject({ rolledBack: false, active: current });
});
