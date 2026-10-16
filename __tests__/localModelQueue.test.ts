/**
 * Regression (Galaxy M35, Phase 15.5 verification): a chat message sent while the launch-time load was still running
 * its test answer started a second completion on the same llama.rn context ("Exception in HostFunction").
 * llama.rn work must run one operation at a time. Unit-test mocks of RNFS and llama.rn (no real model).
 */
const mockActive = { now: 0, max: 0 };
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => true),
  readFile: jest.fn(async () => require('../src/localModel').MODEL.sha256),
}));
jest.mock('llama.rn', () => {
  const busy = async (ms: number) => {
    mockActive.now++;
    mockActive.max = Math.max(mockActive.max, mockActive.now);
    await new Promise<void>(r => setTimeout(() => r(), ms));
    mockActive.now--;
  };
  return {
    releaseAllLlama: jest.fn(async () => undefined),
    initLlama: jest.fn(async () => {
      await busy(30);
      return { androidLib: 'test', gpu: false, completion: async (_req: any, onToken: any) => {
        await busy(20);
        onToken({ token: 'ok' });
        return { text: 'ok', timings: { predicted_n: 1, predicted_per_second: 5, prompt_ms: 1 } };
      } };
    }),
  };
});

import * as local from '../src/localModel';

test('load and answers never overlap: they run one at a time, in order, and a failure does not block the queue', async () => {
  await local.load();
  const order: string[] = [];
  const test = local.generate('Say hi in three words.').then(() => order.push('launch test'));
  const chatAnswer = local.generate('What am I learning?').then(() => order.push('chat answer'));
  const reload = local.load().then(() => order.push('reload'));
  const afterReload = local.generate('next').then(() => order.push('after reload'));
  await Promise.all([test, chatAnswer, reload, afterReload]);
  expect(mockActive.max).toBe(1); // never two llama.rn operations at once
  expect(order).toEqual(['launch test', 'chat answer', 'reload', 'after reload']);
  require('llama.rn').initLlama.mockImplementationOnce(async () => { throw new Error('load failed'); });
  await expect(local.load()).rejects.toThrow('load failed');
  await expect(local.load()).resolves.toMatchObject({ lib: 'test' }); // the queue isn't stuck after a failure
  await expect(local.generate('still works')).resolves.toMatchObject({ text: 'ok' });
});
