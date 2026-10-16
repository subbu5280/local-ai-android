/**
 * M12 below and at the UI: the ambiguity rule (what it must catch and, more importantly, what it must not), and the
 * model screen (fit per model, a failed switch keeps the current model, a successful one activates the new model).
 */
import ReactTestRenderer from 'react-test-renderer';
import { Alert, NativeModules, Platform, Text } from 'react-native';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => require('../testUtils/fakeBackupEnv').fakeFs());
jest.mock('llama.rn', () => ({ releaseAllLlama: jest.fn(async () => undefined), initLlama: jest.fn() }));

import { ambiguity } from '../src/core/prompt';
import * as local from '../src/localModel';
import { BUILTIN_CATALOG } from '../src/modelManager';
import { ModelScreen } from '../src/ModelScreen';
import { lightColors } from '../src/theme';

test('ambiguity: short references with nothing earlier are asked about; ordinary questions never are', () => {
  for (const t of ['Fix it', 'Explain this', 'Translate that please', 'summarize these', 'Why is it slow?', 'దీన్ని అది చేయి', 'इसे सही करो']) {
    if (/[a-z]/i.test(t)) expect([t, ambiguity(t, false)]).toEqual([t, expect.stringMatching(/^What does ".+" refer to\?/)]);
  }
  for (const t of ['Fix it', 'Explain this']) expect(ambiguity(t, true)).toBeNull(); // there is an earlier message
  for (const t of ['What is Kafka?', 'Explain how Kafka partitions work', 'Is it going to rain in Chennai today and tomorrow?',
    'Fix "it" typo in my sentence', 'Hello', 'What is this year?', 'Tell me a joke', 'It is raining']) {
    expect([t, ambiguity(t, false)]).toEqual([t, null]);
  }
});

function setup(over: Partial<{ installed: boolean; testAnswer: string; ram: number }> = {}) {
  const o = { installed: false, testAnswer: '4', ram: 8e9, ...over };
  jest.restoreAllMocks();
  (Platform as any).OS = 'android'; // memory is read through the Android voice module
  NativeModules.AiDevice = { connectivity: jest.fn(async () => 'online'), keepScreenOn: jest.fn() };
  NativeModules.AiVoice = { memoryInfo: jest.fn(async () => ({ totalBytes: o.ram, availBytes: o.ram / 2, lowMemory: false, thresholdBytes: 1 })) };
  jest.spyOn(local, 'storageInfo').mockResolvedValue({ freeStorage: 40e9, totalStorage: 128e9 });
  jest.spyOn(local, 'isInstalled').mockResolvedValue(o.installed);
  const download = jest.spyOn(local, 'download').mockResolvedValue(undefined);
  const load = jest.spyOn(local, 'load').mockResolvedValue({ loadMs: 5, gpu: false } as any);
  jest.spyOn(local, 'generate').mockResolvedValue({ text: o.testAnswer, firstTokenMs: 100, totalMs: 200, tokens: 2, tokPerSec: 12, promptMs: 10 });
  const write = jest.spyOn(local, 'writeManagerState').mockResolvedValue(undefined as any);
  const remove = jest.spyOn(local, 'remove').mockResolvedValue(undefined);
  jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.find(b => b.text === 'Switch')?.onPress?.());
  return { download, load, write, remove };
}
async function screen(onSwitched = jest.fn()) {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { r = ReactTestRenderer.create(<ModelScreen colors={lightColors} focused onBack={() => undefined} onSwitched={onSwitched} />); });
  await ReactTestRenderer.act(async () => { await new Promise<void>(res => setTimeout(() => res(), 30)); });
  const text = () => r.root.findAllByType(Text).map(t => [].concat(t.props.children).flat().join('')).join('\n');
  const tap = async (label: string) => {
    await ReactTestRenderer.act(async () => r.root.findAll(n => n.props.accessibilityLabel === label && n.props.onPress)[0].props.onPress());
    await ReactTestRenderer.act(async () => { await new Promise<void>(res => setTimeout(() => res(), 30)); });
  };
  return { r, text, tap };
}
const small = BUILTIN_CATALOG.find(m => m.paramsB < 1)!;
const big = BUILTIN_CATALOG.find(m => m.paramsB > 3)!;

test('model screen: each model shows whether it fits this phone; a model that does not fit cannot be chosen', async () => {
  setup({ ram: 4e9 }); // a 4 GB phone
  const s = await screen();
  expect(s.text()).toContain('— in use');
  expect(s.text()).toMatch(/Memory: needs about/); // the 3B model needs more memory than this phone has
  const bigButton = s.r.root.findAll(n => n.props.accessibilityLabel === `Use ${big.name}` && n.props.onPress)[0];
  expect(bigButton.props.disabled).toBe(true);
});

test('model screen: a failed test answer keeps the current model; a good one activates the new model', async () => {
  let m = setup({ testAnswer: 'banana' });
  let s = await screen();
  await s.tap(`Use ${small.name}`);
  expect(s.text()).toMatch(/Not switched: test answer was wrong[\s\S]*is still in use/);
  expect(m.write).not.toHaveBeenCalled();
  expect(m.remove).toHaveBeenCalledWith(expect.objectContaining({ id: small.id })); // the rejected download is deleted
  m = setup({ testAnswer: '4' });
  const onSwitched = jest.fn();
  s = await screen(onSwitched);
  await s.tap(`Use ${small.name}`);
  expect(m.download).toHaveBeenCalledTimes(1);
  expect(m.write).toHaveBeenCalledWith(expect.objectContaining({ active: small.id }));
  expect(s.text()).toContain(`Now using ${small.name}.`);
  expect(onSwitched).toHaveBeenCalled();
});

test('translation caution (M13): only for translations into an Indian language', () => {
  const { translationCaution } = require('../src/core/prompt');
  expect(translationCaution('Translate "thank you" to Telugu', 'translation')).toMatch(/into Telugu poorly/);
  expect(translationCaution('Translate this into hindi: good morning', 'translation')).toMatch(/Hindi/);
  expect(translationCaution('Translate "ధన్యవాదాలు" to English', 'translation')).toBeNull();
  expect(translationCaution('Explain Kafka in Telugu', 'explain')).toBeNull();
});
