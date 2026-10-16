/**
 * Voice, ported from the original app (Phase 14 there): microphone → transcription → message box (never sent
 * automatically), permission handling, Speak/Stop with the answer's language, and unavailable voices. Android's
 * SpeechRecognizer/TextToSpeech are mocks of NativeModules.AiVoice (VoiceModule.kt); the real engines need a phone.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform, Text, ToastAndroid } from 'react-native';
import { sqliteDb } from '../testUtils/sqliteDb';

const mockPrompts: string[] = [];
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs', exists: jest.fn(async () => true),
  readFile: jest.fn(async () => require('../src/localModel').MODEL.sha256), writeFile: jest.fn(async () => undefined),
  getFSInfo: jest.fn(async () => ({ freeSpace: 50e9, totalSpace: 128e9 })),
}));
jest.mock('llama.rn', () => ({
  releaseAllLlama: jest.fn(async () => undefined),
  initLlama: jest.fn(async () => ({ androidLib: 'test', gpu: false, completion: async (req: any) => {
    const last = req.messages[req.messages.length - 1].content as string;
    if (!/three words/.test(last)) mockPrompts.push(last);
    return { text: /three words/.test(last) ? 'Hi there friend' : 'Kafka అనేది ఒక మెసేజింగ్ సిస్టమ్ [1].', timings: { predicted_n: 3, predicted_per_second: 5, prompt_ms: 1 } };
  } })),
}));

const native = {
  startListening: jest.fn(), stopListening: jest.fn(), cancelListening: jest.fn(), recognitionSupport: jest.fn(),
  ttsLanguages: jest.fn(), speak: jest.fn().mockResolvedValue(true), stopSpeaking: jest.fn(),
  memoryInfo: jest.fn().mockResolvedValue({ totalBytes: 8e9, availBytes: 3e9, lowMemory: false, thresholdBytes: 2e8 }),
  addListener: jest.fn(), removeListeners: jest.fn(),
};
(NativeModules as any).AiVoice = native;
(NativeModules as any).AiDevice = { connectivity: jest.fn(async () => 'offline'), keepScreenOn: jest.fn() };
(Platform as any).OS = 'android'; // Jest's RN preset defaults to iOS; voice is Android-only

import * as chat from '../src/chatStore';
import App, { voiceStatus } from '../App';
import { langByCode, LANGS, speechText, voiceError } from '../src/voice';

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
async function mount() {
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { r = ReactTestRenderer.create(<App />); });
  await ReactTestRenderer.act(async () => { await new Promise<void>(res => setTimeout(() => res(), 50)); }); // model load
  const texts = () => r.root.findAllByType(Text).map(t => [].concat(t.props.children).join(''));
  const byLabel = (l: string) => r.root.findAll(n => n.props.accessibilityLabel === l && typeof n.props.onPress === 'function');
  const input = () => r.root.findAll(n => n.props.accessibilityLabel === 'Message' && typeof n.props.onChangeText === 'function')[0];
  const tap = (l: string, i = 0) => ReactTestRenderer.act(async () => byLabel(l)[i].props.onPress());
  const send = async () => { await tap('Send'); await ReactTestRenderer.act(async () => { await new Promise<void>(res => setTimeout(() => res(), 20)); }); };
  const mic = () => r.root.findAll(n => typeof n.props.accessibilityLabel === 'string' && /^(Speak a message|Stop listening)/.test(n.props.accessibilityLabel) && typeof n.props.onPress === 'function')[0];
  return { r, texts, byLabel, input, tap, send, mic };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrompts.length = 0;
  const fs = node('fs'), os = node('os'), path = node('path');
  chat.setDb(sqliteDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-')), 'chat.db')));
  jest.spyOn(ToastAndroid, 'show').mockImplementation(() => undefined);
  jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

test('helpers: speech text drops sources/citations/code/URLs; errors are friendly; languages', () => {
  expect(speechText('Kafka is fast [1][2].\n\nSources:\n[1] doc')).toBe('Kafka is fast .');
  expect(voiceError('no_match', langByCode('te'))).toContain("didn't catch any speech");
  expect(LANGS.map(l => l.code)).toEqual(['en', 'te', 'hi', 'ta', 'kn', 'ml']);
  expect(voiceStatus({ state: 'listening', lang: 'Telugu', partial: 'నాకు' })).toBe('🎙 Listening (Telugu)… tap 🎙 to stop\n“నాకు”');
  expect(voiceStatus({ state: 'idle', lang: 'English' })).toBe('');
});

test('mic: transcription lands in the message box, editable, and is NOT sent until Send', async () => {
  native.startListening.mockResolvedValue('నాకు Kafka గురించి చెప్పండి');
  const ui = await mount();
  await ReactTestRenderer.act(async () => ui.mic().props.onPress());
  expect(native.startListening).toHaveBeenCalledWith('en-IN', false);
  expect(ui.input().props.value).toBe('నాకు Kafka గురించి చెప్పండి');
  expect(ui.texts()).toContain('✓ Transcription ready: edit it if needed, then tap Send');
  expect(mockPrompts).toHaveLength(0); // never auto-sent
  await ReactTestRenderer.act(async () => ui.input().props.onChangeText('నాకు Kafka గురించి సింపుల్‌గా చెప్పండి'));
  await ui.send();
  expect(mockPrompts[0]).toContain('నాకు Kafka గురించి సింపుల్‌గా చెప్పండి');
});

test('mic: permission denied / blocked / retry; no crash; nothing recorded', async () => {
  (PermissionsAndroid.check as jest.Mock).mockResolvedValue(false);
  const req = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValueOnce('denied' as any).mockResolvedValueOnce('never_ask_again' as any).mockResolvedValueOnce('granted' as any);
  native.startListening.mockResolvedValue('hello');
  const ui = await mount();
  await ReactTestRenderer.act(async () => ui.mic().props.onPress());
  expect(ui.texts().join()).toContain('Microphone permission denied');
  expect(native.startListening).not.toHaveBeenCalled();
  await ReactTestRenderer.act(async () => ui.mic().props.onPress());
  expect(ui.texts().join()).toContain('permission is blocked');
  expect(ui.byLabel('Open settings')).toHaveLength(1);
  await ReactTestRenderer.act(async () => ui.mic().props.onPress()); // retry after allowing
  expect(native.startListening).toHaveBeenCalledTimes(1);
  expect(ui.input().props.value).toBe('hello');
  expect(req).toHaveBeenCalledTimes(3); // asked only on taps, never at startup
});

test('mic: empty speech, recognizer failure and cancel are handled', async () => {
  const ui = await mount();
  native.startListening.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'no_match' }));
  await ReactTestRenderer.act(async () => ui.mic().props.onPress());
  expect(ui.texts().join()).toContain("didn't catch any speech");
  native.startListening.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'network' }));
  await ReactTestRenderer.act(async () => ui.mic().props.onPress());
  expect(ui.texts().join()).toContain('needs the internet');
  native.startListening.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'cancelled' }));
  await ReactTestRenderer.act(async () => ui.mic().props.onPress());
  expect(ui.texts().join()).not.toContain('Listening');
  expect(ui.input().props.value).toBe('');
});

test('speak: uses the answer language, reads only the answer, Stop; unavailable voice keeps text', async () => {
  const ui = await mount();
  await ReactTestRenderer.act(async () => ui.input().props.onChangeText('Kafka అంటే ఏమిటి?'));
  await ui.send();
  await ui.tap('Speak this message');
  expect(native.speak).toHaveBeenCalledWith('Kafka అనేది ఒక మెసేజింగ్ సిస్టమ్ .', 'te-IN', expect.any(String));
  expect(native.stopSpeaking).not.toHaveBeenCalled(); // QUEUE_FLUSH replaces speech; no racing stop() first
  expect(ui.byLabel('Stop speaking')).toHaveLength(1);
  const spokenId = native.speak.mock.calls[0][2];
  await ReactTestRenderer.act(async () => DeviceEventEmitter.emit('AiVoiceEvent', { type: 'tts_stop', text: 'an-older-message' }));
  expect(ui.byLabel('Stop speaking')).toHaveLength(1); // a replaced message's late stop doesn't reset this one
  await ReactTestRenderer.act(async () => DeviceEventEmitter.emit('AiVoiceEvent', { type: 'tts_done', text: spokenId }));
  expect(ui.byLabel('Speak this message')).toHaveLength(1);
  await ui.tap('Speak this message');
  await ui.tap('Stop speaking');
  expect(ui.byLabel('Speak this message')).toHaveLength(1);
  native.speak.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'voice_unavailable' }));
  await ui.tap('Speak this message');
  expect(ToastAndroid.show).toHaveBeenCalledWith(expect.stringContaining('No Telugu voice is installed'), ToastAndroid.LONG);
  expect(ui.texts().join()).toContain('Kafka అనేది'); // text answer unaffected
  for (const code of ['tts_failed', 'tts_unavailable']) {
    native.speak.mockRejectedValueOnce(Object.assign(new Error('x'), { code }));
    await ui.tap('Speak this message');
    expect(ui.byLabel('Speak this message')).toHaveLength(1);
    expect(ToastAndroid.show).toHaveBeenCalledWith(`Couldn't speak this message (${code}).`, ToastAndroid.LONG);
  }
});

test('support summary reports online / offline / voice per language honestly', () => {
  const { supportSummary } = require('../src/voice');
  const rec = { available: true, onDeviceAvailable: true, sdk: 35, languages: {
    'en-IN': { online: true, onDeviceInstalled: true, onDeviceSupported: true },
    'te-IN': { online: true, onDeviceInstalled: false, onDeviceSupported: true },
    'hi-IN': { online: true, onDeviceInstalled: false, onDeviceSupported: false },
  } };
  const s = supportSummary(rec, { 'en-IN': 'available', 'te-IN': 'missing_data', 'hi-IN': 'available' });
  expect(s).toContain('English: speech online ✓ · offline ✓ · voice ✓');
  expect(s).toContain('Telugu: speech online ✓ · offline not downloaded · voice ✗');
});

test('the mic follows a certain language (native script) and keeps a saved choice otherwise', async () => {
  const ui = await mount();
  const label = () => ui.mic().props.accessibilityLabel;
  expect(label()).toBe('Speak a message in English');
  await ReactTestRenderer.act(async () => ui.input().props.onChangeText('naa perimeter'));
  await ui.send();
  expect(label()).toBe('Speak a message in English'); // English letters: not certain, no change
  await ReactTestRenderer.act(async () => ui.input().props.onChangeText('Kafka क्या है?'));
  await ui.send();
  expect(label()).toBe('Speak a message in Hindi'); // native script: certain
});
