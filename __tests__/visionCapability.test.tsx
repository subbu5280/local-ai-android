/**
 * Capability-gated camera: the camera opens only when the phone's image model is loaded. visionCapability.ensureReady
 * is tested against a mocked localModel (no real downloads/models), then the App's Camera/Gallery buttons end to end.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Alert, NativeModules } from 'react-native';
(NativeModules as any).AiDevice = { connectivity: jest.fn(async () => 'online'), keepScreenOn: jest.fn() };

jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => ({ DocumentDirectoryPath: '/docs', exists: jest.fn().mockResolvedValue(false) }));
jest.mock('react-native-image-picker', () => ({ launchCamera: jest.fn(), launchImageLibrary: jest.fn() }));

import * as local from '../src/localModel';
import * as vision from '../src/visionCapability';
import App from '../App';

const state = { loaded: false, installed: false };
let downloadVision: jest.SpyInstance;
let loadVision: jest.SpyInstance;

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  state.loaded = false;
  state.installed = false;
  jest.spyOn(local, 'isVisionLoaded').mockImplementation(() => state.loaded);
  jest.spyOn(local, 'isVisionInstalled').mockImplementation(async () => state.installed);
  downloadVision = jest.spyOn(local, 'downloadVision').mockImplementation(async onProgress => {
    onProgress(0.5);
    state.installed = true;
  });
  loadVision = jest.spyOn(local, 'loadVision').mockImplementation(async () => {
    state.loaded = true;
    return { loadMs: 1, lib: 'test', gpu: false } as any;
  });
});

function deps(answer: 'download' | 'later' = 'download', online = true) {
  const reports: string[] = [];
  return {
    reports,
    askDownload: jest.fn(async () => answer),
    online: () => online,
    report: jest.fn((text: string, id?: string) => { reports.push(text); return id ?? 'm1'; }),
  };
}

test('model loaded: ready at once, nothing asked, downloaded or loaded', async () => {
  state.loaded = true;
  const d = deps();
  await expect(vision.ensureReady(d)).resolves.toBe('ready');
  expect(d.askDownload).not.toHaveBeenCalled();
  expect(downloadVision).not.toHaveBeenCalled();
  expect(loadVision).not.toHaveBeenCalled();
});

test('model missing + "Not now": cancelled, nothing downloaded', async () => {
  const d = deps('later');
  await expect(vision.ensureReady(d)).resolves.toBe('cancelled');
  expect(d.askDownload).toHaveBeenCalledTimes(1);
  expect(downloadVision).not.toHaveBeenCalled();
  expect(loadVision).not.toHaveBeenCalled();
});

test('model missing + Download: the existing checked download, then load, then ready', async () => {
  const d = deps('download');
  await expect(vision.ensureReady(d)).resolves.toBe('ready');
  expect(downloadVision).toHaveBeenCalledWith(expect.any(Function), true);
  expect(loadVision).toHaveBeenCalledTimes(1);
  expect(d.reports.some(r => r.includes('50%'))).toBe(true);
  expect(d.reports.some(r => r.includes('verified'))).toBe(true);
});

test.each([
  ['storage', 'Not enough storage for the image model: … Nothing was downloaded'],
  ['sha256', 'checksum mismatch: the file was deleted'],
  ['network', 'Network request failed'],
])('download failure (%s): failed, not loaded, honest message', async (_kind, message) => {
  downloadVision.mockRejectedValueOnce(new Error(message));
  const d = deps('download');
  await expect(vision.ensureReady(d)).resolves.toBe('failed');
  expect(loadVision).not.toHaveBeenCalled();
  expect(d.reports.at(-1)).toBe(`⚠ Vision model download failed. The camera was not opened.\n${message}`);
});

test('downloaded but not loaded: loads without asking, then ready', async () => {
  state.installed = true;
  const d = deps();
  await expect(vision.ensureReady(d)).resolves.toBe('ready');
  expect(d.askDownload).not.toHaveBeenCalled();
  expect(downloadVision).not.toHaveBeenCalled();
  expect(loadVision).toHaveBeenCalledTimes(1);
});

test('load failure: failed with the honest message', async () => {
  state.installed = true;
  loadVision.mockRejectedValueOnce(new Error('out of memory'));
  const d = deps();
  await expect(vision.ensureReady(d)).resolves.toBe('failed');
  expect(d.reports.at(-1)).toBe("⚠ The vision model could not be loaded, so the camera wasn't opened.\nout of memory");
});

test('offline with the model missing: failed, no prompt, no download', async () => {
  const d = deps('download', false);
  await expect(vision.ensureReady(d)).resolves.toBe('failed');
  expect(d.askDownload).not.toHaveBeenCalled();
  expect(downloadVision).not.toHaveBeenCalled();
  expect(d.reports[0]).toMatch(/offline.*camera was not opened/);
});

test('offline with the model downloaded: still loads (no network needed)', async () => {
  state.installed = true;
  await expect(vision.ensureReady(deps('download', false))).resolves.toBe('ready');
});

test('two quick calls share ONE operation (single-flight); a later call starts fresh', async () => {
  const d = deps('download');
  const [a, b] = await Promise.all([vision.ensureReady(d), vision.ensureReady(d)]);
  expect([a, b]).toEqual(['ready', 'ready']);
  expect(d.askDownload).toHaveBeenCalledTimes(1);
  expect(downloadVision).toHaveBeenCalledTimes(1);
  expect(loadVision).toHaveBeenCalledTimes(1);
  expect(vision.isPreparing()).toBe(false);
  state.loaded = false;
  loadVision.mockRejectedValueOnce(new Error('x'));
  await expect(vision.ensureReady(d)).resolves.toBe('failed');
  await expect(vision.ensureReady(d)).resolves.toBe('ready'); // not stuck after a failure
});

// ------------------------------------------------------------------ App: the photo button (camera / gallery)
// This app has no laptop: both camera and gallery need the phone's image model (ported from the original app's camera).

async function mount() {
  (globalThis as any).fetch = jest.fn(async () => { throw new TypeError('Network request failed'); });
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { r = ReactTestRenderer.create(<App />); });
  const press = (label: string) => r.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
  const tap = (label: string) => ReactTestRenderer.act(async () => press(label).props.onPress());
  const texts = () => r.root.findAll(n => typeof n.props.accessibilityLabel === 'string').map(n => n.props.accessibilityLabel);
  return { tap, press, texts };
}
/** Alert mock: the source dialog picks `source`; the download dialog answers `answer`. */
const dialogs = (source: 'Camera' | 'Gallery', answer: 'Download' | 'Not now') => jest.spyOn(Alert, 'alert').mockImplementation((title, _m, buttons) =>
  buttons?.find(x => x.text === (title === 'Add a photo' ? source : answer))?.onPress?.());
const photo = { assets: [{ uri: 'content://x', type: 'image/jpeg', base64: 'AAAA', width: 10, height: 10 }] };

test('App: photo with the model missing asks; "Not now" keeps the camera closed and downloads nothing', async () => {
  const { launchCamera } = require('react-native-image-picker');
  const alert = dialogs('Camera', 'Not now');
  const ui = await mount();
  await ui.tap('Add a photo');
  expect(alert).toHaveBeenCalledWith('Photos need the image model', expect.stringContaining('1.70 GB'), expect.any(Array), expect.any(Object));
  expect(launchCamera).not.toHaveBeenCalled();
  expect(downloadVision).not.toHaveBeenCalled();
});

test('App: Download → verified download → load → the camera opens once, and the photo is attached', async () => {
  const { launchCamera } = require('react-native-image-picker');
  (launchCamera as jest.Mock).mockResolvedValue(photo);
  dialogs('Camera', 'Download');
  const ui = await mount();
  await ui.tap('Add a photo');
  expect(downloadVision).toHaveBeenCalledTimes(1);
  expect(loadVision).toHaveBeenCalledTimes(1);
  expect(launchCamera).toHaveBeenCalledTimes(1);
  expect(loadVision.mock.invocationCallOrder[0]).toBeLessThan((launchCamera as jest.Mock).mock.invocationCallOrder[0]);
  expect(ui.texts()).toContain('Attached photo');
});

test('App: model ready → the gallery opens immediately; a download failure keeps it closed', async () => {
  const { launchImageLibrary } = require('react-native-image-picker');
  (launchImageLibrary as jest.Mock).mockResolvedValue(photo);
  state.loaded = true;
  dialogs('Gallery', 'Download');
  let ui = await mount();
  await ui.tap('Add a photo');
  expect(launchImageLibrary).toHaveBeenCalledTimes(1);
  expect(downloadVision).not.toHaveBeenCalled();
  state.loaded = false;
  (launchImageLibrary as jest.Mock).mockClear();
  downloadVision.mockRejectedValueOnce(new Error('checksum mismatch'));
  ui = await mount();
  await ui.tap('Add a photo');
  expect(loadVision).not.toHaveBeenCalled();
  expect(launchImageLibrary).not.toHaveBeenCalled();
});
