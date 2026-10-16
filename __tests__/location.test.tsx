/**
 * Device location for weather (src/location.ts + liveData weather): permission states, single coarse fix with a
 * memory-only cache, place priority (explicit city → device → conversation city → ask), offline/failure answers, and
 * privacy (no coordinates in chat history, memory or learned knowledge). Ported from the original app (M11 carry-over);
 * the in-app tests use this app's chat (no laptop: live questions are answered on the phone, others by the local model).
 * Unit-test mocks: PermissionsAndroid, NativeModules.AiLocation, fetch, RNFS (flag file), llama.rn; real SQL for the store.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { sqliteDb } from '../testUtils/sqliteDb';

const mockFiles: Record<string, string> = {};
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs', CachesDirectoryPath: '/cache',
  exists: jest.fn(async (p: string) => p.endsWith('location_permission.txt') ? p in mockFiles : true),
  readFile: jest.fn(async (p: string) => (p in mockFiles ? mockFiles[p] : require('../src/localModel').MODEL.sha256)),
  writeFile: jest.fn(async (p: string, v: string) => { mockFiles[p] = v; }),
  getFSInfo: jest.fn(async () => ({ freeSpace: 50e9, totalSpace: 128e9 })),
}));
jest.mock('llama.rn', () => ({
  releaseAllLlama: jest.fn(async () => undefined),
  initLlama: jest.fn(async () => ({ androidLib: 'test', gpu: false, completion: async (_r: any, cb: any) => {
    cb({ token: 'model answer' });
    return { text: 'model answer', timings: { predicted_n: 1, predicted_per_second: 5, prompt_ms: 1 } };
  } })),
}));

const native = {
  isLocationEnabled: jest.fn(async () => true),
  currentLocation: jest.fn(async () => ({ latitude: 17.385044, longitude: 78.486671, accuracy: 1200, time: 0 })),
  locality: jest.fn(async () => 'Hyderabad, Telangana, India'),
};
(NativeModules as any).AiLocation = native;
(NativeModules as any).AiDevice = { connectivity: jest.fn(async () => 'online'), keepScreenOn: jest.fn() };
(Platform as any).OS = 'android'; // Jest's RN preset defaults to iOS; location is Android-only

import * as chat from '../src/chatStore';
import * as live from '../src/liveData';
import * as location from '../src/location';
import App from '../App';

const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
const fs = node('fs'), os = node('os'), path = node('path');
let dbFile: string;
const check = jest.spyOn(PermissionsAndroid, 'check');
const request = jest.spyOn(PermissionsAndroid, 'request');

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  location.clearCache();
  live.clearWeatherCache();
  check.mockResolvedValue(false);
  request.mockResolvedValue(PermissionsAndroid.RESULTS.GRANTED as any);
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loc-')), 'chat.db');
  chat.setDb(sqliteDb(dbFile));
});

const FORECAST = { timezone: 'Asia/Kolkata', current: { time: '2026-10-09T09:00', temperature_2m: 27.9, apparent_temperature: 31.2,
  relative_humidity_2m: 80, weather_code: 2, wind_speed_10m: 9.4 },
  daily: { time: ['2026-10-09', '2026-10-10'], weather_code: [2, 61], temperature_2m_min: [22, 21], temperature_2m_max: [31, 29],
    precipitation_probability_max: [10, 70] } };
function weatherFetch(geo: Record<string, any> = {}) {
  const urls: string[] = [];
  const f = jest.fn(async (url: string) => {
    urls.push(url);
    if (url.includes('geocoding-api')) {
      const name = decodeURIComponent(url.split('name=')[1]);
      const g = geo[name];
      return { ok: true, json: async () => ({ results: g ? [g] : [] }) };
    }
    if (url.includes('api.open-meteo.com/v1/forecast')) return { ok: true, json: async () => FORECAST };
    if (url.endsWith('/api/v1/chat')) throw new Error('the laptop must not be asked about weather');
    return { ok: url.endsWith('/tools'), status: 404, json: async () => [] };
  });
  return Object.assign(f, { urls });
}
const CHENNAI = { name: 'Chennai', admin1: 'Tamil Nadu', country: 'India', latitude: 13.08, longitude: 80.27 };
const HYD = { name: 'Hyderabad', admin1: 'Telangana', country: 'India', latitude: 17.38, longitude: 78.46 };
const device = async () => {
  const r = await location.currentPlace();
  return 'place' in r ? r : { problem: r.problem, text: location.problemText(r.problem) };
};

// ---------------------------------------------------------------- permission + location (location.ts)

test('permission: asked once; granted → one coarse fix, rounded to ~1 km, reused from memory for 15 minutes', async () => {
  expect(await location.permissionState()).toBe('not_requested');
  const r1 = await location.currentPlace(1000);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION); // coarse only
  expect(r1).toEqual({ place: { latitude: 17.39, longitude: 78.49, label: 'Hyderabad, Telangana, India' } });
  check.mockResolvedValue(true); // Android now reports it granted
  await location.currentPlace(1000 + 14 * 60e3); // cached: no new fix, no dialog
  expect(native.currentLocation).toHaveBeenCalledTimes(1);
  await location.currentPlace(1000 + 16 * 60e3); // expired: one fresh fix
  expect(native.currentLocation).toHaveBeenCalledTimes(2);
  expect(request).toHaveBeenCalledTimes(1);
});

test('permission denied / blocked: an honest answer and no repeated dialogs', async () => {
  request.mockResolvedValueOnce(PermissionsAndroid.RESULTS.DENIED as any);
  expect(await location.currentPlace()).toEqual({ problem: 'denied' });
  expect(await location.permissionState()).toBe('denied');
  expect(await location.currentPlace()).toEqual({ problem: 'denied' });
  expect(request).toHaveBeenCalledTimes(1); // not asked again on the next weather question
  expect(location.problemText('denied')).toContain('allow location for AI ChatBot in Android Settings');
  expect(location.problemText('denied')).toContain('or tell me a city');
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  request.mockResolvedValueOnce(PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN as any);
  expect(await location.currentPlace()).toEqual({ problem: 'blocked' });
  expect(await location.permissionState()).toBe('blocked');
  expect(native.currentLocation).not.toHaveBeenCalled();
});

test('location off or unavailable: honest problems, nothing guessed', async () => {
  check.mockResolvedValue(true);
  native.currentLocation.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'location_off' }));
  expect(await location.currentPlace()).toEqual({ problem: 'location_off' });
  native.currentLocation.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'timeout' }));
  expect(await location.currentPlace()).toEqual({ problem: 'unavailable' });
  expect(location.problemText('location_off')).toContain("Location setting is off");
});

// ---------------------------------------------------------------- weather place priority (liveData)

test('no city → device location; explicit city wins; "here" means the device; follow-ups keep the chat city', async () => {
  check.mockResolvedValue(true);
  const f = weatherFetch({ Chennai: CHENNAI, Hyderabad: HYD });
  const here = await live.answer("What's today's weather?", true, f, { device });
  expect(here.text).toBe('Based on your current location in Hyderabad, Telangana, India, today (2026-10-09): partly cloudy, 22–31 °C, ' +
    'chance of rain 10%. Right now: partly cloudy, 27.9 °C (feels like 31.2 °C), humidity 80%, wind 9.4 km/h [1].');
  expect(here.sources[0].url).toBe('https://open-meteo.com/'); // no coordinates in the stored source link
  const deviceSpy = jest.fn(device);
  const chennai = await live.answer('Weather in Chennai?', true, f, { device: deviceSpy, contextCity: 'Hyderabad' });
  expect(chennai.text).toContain('Current weather in Chennai, Tamil Nadu, India');
  expect(deviceSpy).not.toHaveBeenCalled(); // explicit city overrides the device
  const rain = await live.answer('Will it rain there tomorrow?', true, f, { device: deviceSpy, contextCity: 'Hyderabad' });
  expect(rain.text).toBe('Tomorrow in Hyderabad, Telangana, India (2026-10-10): light rain, 21–29 °C, chance of rain 70% [1].');
  expect(deviceSpy).not.toHaveBeenCalled(); // "there" = the conversation city, not the device
  const near = await live.answer('How is the weather here?', true, f, { device: deviceSpy, contextCity: 'Chennai' });
  expect(near.text).toMatch(/^Based on your current location in Hyderabad/); // "here" = the phone, not the chat city
  for (const q of ['Is it going to rain?', 'How hot is it today?', 'Weather near me?', "What's the temperature?"]) {
    expect([q, !!live.liveSignal(q), live.plan(q)]).toEqual([q, true, { tool: 'weather', city: null }]); // a lookup, no city
  }
  for (const q of ["I'm cold.", 'Explain how rain forms.', 'Create a weather app']) expect([q, live.liveSignal(q)]).toEqual([q, null]);
});

test('Chennai discussed earlier: only "there"/"that city" reuse it; general questions use the phone location', async () => {
  check.mockResolvedValue(true);
  const f = weatherFetch({ Chennai: CHENNAI, Hyderabad: HYD });
  const ask = (q: string, contextCity: string | null = 'Chennai') => live.answer(q, true, f, { device, contextCity });
  const DEVICE = /^Based on your current location in Hyderabad/;
  expect((await ask("What's the weather in Chennai?", null)).text).toMatch(/Chennai, Tamil Nadu/); // A
  expect((await ask('Will it rain there today?')).text).toMatch(/^Today in Chennai, Tamil Nadu/); // B
  expect((await ask("What's today's weather?")).text).toMatch(DEVICE); // C: not the earlier Chennai
  expect((await ask('Will it rain today?')).text).toMatch(DEVICE); // D
  expect((await ask('Will it rain in Chennai today?', 'Hyderabad')).text).toMatch(/^Today in Chennai, Tamil Nadu/); // E
  expect((await ask("What's the weather near me?")).text).toMatch(DEVICE); // F
  expect((await ask('Is it raining in that city?')).text).toMatch(/Chennai, Tamil Nadu/);
  expect((await ask('Will it rain there today?', null)).text).toBe("Which city do you mean? I won't assume a location.");
});

test('denied permission, provider failure and offline: honest, never invented', async () => {
  request.mockResolvedValueOnce(PermissionsAndroid.RESULTS.DENIED as any);
  const denied = await live.answer("What's today's weather?", true, weatherFetch(), { device });
  expect(denied).toMatchObject({ ok: false, sources: [] });
  expect(denied.text).toContain('I need your location to give you local weather');
  const broken = await live.answer('Weather in Chennai?', true, jest.fn(async () => { throw new TypeError('Network request failed'); }));
  expect(broken.text).toBe("I couldn't retrieve current weather information right now (Network request failed), so I won't guess.");
  expect((await live.answer("What's today's weather?", false, weatherFetch(), { device })).text)
    .toBe("I can't get current weather while you're offline, so I won't guess.");
  check.mockResolvedValue(true);
  await live.answer('Weather in Chennai today?', true, weatherFetch({ Chennai: CHENNAI }), {}, Date.UTC(2026, 9, 9, 4, 0));
  const cached = await live.answer('Weather in Chennai today?', false, weatherFetch(), {}, Date.UTC(2026, 9, 9, 5, 0));
  expect(cached.text).toMatch(/^You're offline, so this is the last weather I fetched \(cached at \d\d:\d\d, may be out of date\): Today in Chennai/);
  expect(cached.ok).toBe(false);
});

// ---------------------------------------------------------------- in the app

async function mount() {
  const f = weatherFetch({ Hyderabad: HYD, Chennai: CHENNAI });
  (globalThis as any).fetch = jest.fn(async (url: string) => {
    if (url.includes('news.google.com')) return { ok: true, text: async () => '<rss><channel><item><title>Chennai news item</title><link>https://example.com/a</link><source>Example</source></item></channel></rss>' };
    return f(url);
  });
  let r!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => { r = ReactTestRenderer.create(<App />); });
  await ReactTestRenderer.act(async () => { await new Promise<void>(res => setTimeout(() => res(), 50)); }); // launch: model load
  const by = (label: string) => r.root.findAll(n => n.props.accessibilityLabel === label && typeof (n.props.onPress ?? n.props.onChangeText) === 'function')[0];
  const say = async (msg: string) => {
    await ReactTestRenderer.act(async () => by('Message').props.onChangeText(msg));
    await ReactTestRenderer.act(async () => by('Send').props.onPress());
    await ReactTestRenderer.act(async () => { await new Promise<void>(res => setTimeout(() => res(), 20)); });
    const [c] = await chat.listConversations(1);
    const rows = await chat.recentMessages(c.id, 1);
    return rows[0].role === 'assistant' ? rows[0].content : '';
  };
  const newChat = () => ReactTestRenderer.act(async () => by('New chat').props.onPress());
  return { say, newChat };
}

test('device weather on the phone, the original question continues after Allow, no coordinates stored anywhere', async () => {
  const a = await mount();
  const reply = await a.say("What's today's weather?");
  expect(request).toHaveBeenCalledTimes(1); // the permission dialog…
  expect(reply).toMatch(/^Based on your current location in Hyderabad, Telangana, India, today/); // …then the answer
  check.mockResolvedValue(true);
  expect(await a.say('Will it rain today?')).toMatch(/^Based on your current location/);
  expect(request).toHaveBeenCalledTimes(1); // asked once
  const raw = sqliteDb(dbFile).raw; // a second connection to this test's phone database
  const everything = ['messages', 'conversations', 'memories', 'learned'].map(t => JSON.stringify(raw.prepare(`SELECT * FROM ${t}`).all())).join(' ');
  expect(everything).not.toMatch(/17\.38|78\.48|17\.39|78\.49/); // no precise or rounded coordinates
  expect(raw.prepare('SELECT COUNT(*) AS n FROM learned').get().n).toBe(0); // location never becomes memory
  expect(raw.prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(0);
});

test('"there" uses the city named earlier in the chat, but a new chat does not inherit it', async () => {
  check.mockResolvedValue(true);
  const a = await mount();
  expect(await a.say('What is the weather in Hyderabad?')).toContain('Current weather in Hyderabad, Telangana, India');
  expect(await a.say('Will it rain there tomorrow?')).toMatch(/^Tomorrow in Hyderabad, Telangana, India/);
  expect(native.currentLocation).not.toHaveBeenCalled();
  // Same chat, a general question: the phone's current place, not the city discussed earlier
  expect(await a.say("What's today's weather?")).toMatch(/^Based on your current location/);
  await a.newChat();
  expect(await a.say('Will it rain tomorrow?')).toMatch(/^Based on your current location/); // fresh chat → the phone's place
});

// ---------------------------------------------------------------- weather follow-ups ("What about Chennai?")

test('follow-ups continue the chat\'s weather question; other intents keep their own routing', () => {
  const r = live.resolveFollowUp;
  expect(r('What about Chennai?', ["What's today's weather?"])).toBe('weather in Chennai today'); // keeps the day
  expect(r('And Chennai?', ["What's today's weather?"])).toBe('weather in Chennai today');
  expect(r('How about Hyderabad?', ["What's the weather in Chennai?"])).toBe('weather in Hyderabad');
  expect(r('What about tomorrow?', ["What's the weather in Chennai?"])).toBe('weather in Chennai tomorrow');
  expect(r('What about tomorrow?', ["What's today's weather?"])).toBe('weather tomorrow'); // still the phone's place
  expect(r('And there?', ["What's the weather in Chennai?"])).toBe('weather there');
  expect(r('What about that city?', ["What's the weather in Chennai?"])).toBe('weather that city');
  // chains: "What about Chennai?" → "What about tomorrow?" stays on Chennai
  expect(r('What about tomorrow?', ["What's today's weather?", 'What about Chennai?'])).toBe('weather in Chennai tomorrow');
  // not weather follow-ups
  for (const q of ['What about Chennai news?', 'What about restaurants in Chennai?', 'And hospitals near me?', 'How about hotels?']) {
    expect([q, r(q, ["What's the weather in Chennai?"])]).toEqual([q, null]);
  }
  expect(r('What about Chennai?', ['Tell me a joke.'])).toBeNull(); // the chat isn't about weather
  expect(r('What about Chennai?', [])).toBeNull();
  expect(r('What about Chennai?', ["What's the weather in Chennai?", 'Tell me a joke.'])).toBeNull(); // only the latest counts
});

test('App: weather follow-ups answered on the phone; news and restaurants are not weather', async () => {
  check.mockResolvedValue(true);
  const a = await mount();
  expect(await a.say("What's today's weather?")).toMatch(/^Based on your current location in Hyderabad/);
  expect(await a.say('What about Chennai?')).toMatch(/^Today in Chennai, Tamil Nadu/);
  expect(await a.say('What about tomorrow?')).toMatch(/^Tomorrow in Chennai, Tamil Nadu/);
  expect(await a.say('How about Hyderabad?')).toMatch(/Hyderabad, Telangana, India/);
  expect(await a.say('Will it rain today?')).toMatch(/^Based on your current location/); // no silent override
  await a.newChat();
  expect(await a.say("What's the weather in Chennai?")).toMatch(/Chennai, Tamil Nadu/);
  expect(await a.say('And there?')).toMatch(/Chennai, Tamil Nadu/);
  expect(await a.say('What about Chennai news?')).toMatch(/news/); // the news lookup, not weather
  expect(await a.say('What about restaurants in Chennai?')).toBe('model answer'); // normal chat: the local model
});
