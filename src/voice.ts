/**
 * Phase 14: voice input/output using Android's own engines (android/.../VoiceModule.kt). No extra npm package,
 * no paid API.
 *
 * - Speech-to-text: tap 🎙 → Android SpeechRecognizer → text goes into the composer (never auto-sent).
 *   The microphone permission is requested only on that tap; audio is not stored or logged.
 * - Text-to-speech: Android TextToSpeech, using only voices that are actually installed.
 */
import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

export type Lang = { code: string; bcp47: string; label: string; name: string };
export const LANGS: Lang[] = [
  { code: 'en', bcp47: 'en-IN', label: 'EN', name: 'English' },
  { code: 'te', bcp47: 'te-IN', label: 'తె', name: 'Telugu' },
  { code: 'hi', bcp47: 'hi-IN', label: 'हि', name: 'Hindi' },
  { code: 'ta', bcp47: 'ta-IN', label: 'த', name: 'Tamil' },
  { code: 'kn', bcp47: 'kn-IN', label: 'ಕ', name: 'Kannada' },
  // Malayalam added in this app (the original app had five voice languages); same order as core/language LANG_CODES.
  { code: 'ml', bcp47: 'ml-IN', label: 'മ', name: 'Malayalam' },
];
export const langByCode = (code?: string | null) => LANGS.find(l => l.code === code) ?? LANGS[0];
export const langByTag = (tag?: string | null) => LANGS.find(l => l.bcp47 === tag) ?? LANGS[0];

const native = (): any => NativeModules.AiVoice; // looked up at call time
export const voiceAvailable = () => Platform.OS === 'android' && !!native();

export type MicPermission = 'granted' | 'denied' | 'never_ask_again';

/** Ask for the microphone only now (the user tapped 🎙). */
export async function ensureMicPermission(): Promise<MicPermission> {
  const p = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(p)) return 'granted';
  const r = await PermissionsAndroid.request(p, {
    title: 'Microphone',
    message: 'Local AI uses the microphone only after you tap 🎙, for that one question. Audio is not saved.',
    buttonPositive: 'Allow',
    buttonNegative: 'Not now',
  });
  return r === PermissionsAndroid.RESULTS.GRANTED ? 'granted'
    : r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'never_ask_again' : 'denied';
}

export type VoiceEvent = { type: string; text?: string };
let emitter: NativeEventEmitter | null = null;
/** Subscribe to recognizer/TTS events (ready, speech, partial, processing, tts_start, tts_done, ...). */
export function onVoiceEvent(cb: (e: VoiceEvent) => void): () => void {
  if (!voiceAvailable()) return () => undefined;
  emitter = emitter ?? new NativeEventEmitter(native());
  const sub = emitter.addListener('AiVoiceEvent', (e: any) => cb(e as VoiceEvent));
  return () => sub.remove();
}

/** Listen once in `lang`; resolves with the transcript. Rejects with an Error whose `code` is an error name. */
export async function listen(lang: Lang, preferOffline = false): Promise<string> {
  if (!voiceAvailable()) throw Object.assign(new Error('Voice input is not available'), { code: 'unavailable' });
  return native().startListening(lang.bcp47, preferOffline);
}
export const stopListening = () => voiceAvailable() && native().stopListening();
export const cancelListening = () => voiceAvailable() && native().cancelListening();

export type RecognitionSupport = {
  available: boolean;
  onDeviceAvailable: boolean;
  sdk: number;
  languages: Record<string, { online?: boolean; onDeviceInstalled?: boolean; onDeviceSupported?: boolean; error?: string }>;
};
export async function recognitionSupport(langs = LANGS): Promise<RecognitionSupport> {
  return native().recognitionSupport(langs.map(l => l.bcp47));
}

export type TtsSupport = Record<string, 'available' | 'missing_data' | 'not_supported' | string>;
export async function ttsLanguages(langs = LANGS): Promise<TtsSupport> {
  return native().ttsLanguages(langs.map(l => l.bcp47));
}
export async function speak(text: string, lang: Lang, id: string): Promise<void> {
  await native().speak(text, lang.bcp47, id);
}
export const stopSpeaking = () => voiceAvailable() && native().stopSpeaking();

export type MemoryInfo = { totalBytes: number; availBytes: number; lowMemory: boolean; thresholdBytes: number };
export async function memoryInfo(): Promise<MemoryInfo | null> {
  return voiceAvailable() ? native().memoryInfo() : null;
}

// The speech language the user picked survives app restarts (it used to reset to English, so Telugu speech was
// transcribed by the English recognizer as "naa peru Amity" and answered in English).
const LANG_FILE = () => `${require('@dr.pogodin/react-native-fs').DocumentDirectoryPath}/voice_lang.txt`;
export async function loadVoiceLang(): Promise<Lang | null> {
  try {
    const RNFS = require('@dr.pogodin/react-native-fs');
    if (!(await RNFS.exists(LANG_FILE()))) return null;
    const code = (await RNFS.readFile(LANG_FILE(), 'utf8')).trim();
    return LANGS.find(l => l.code === code) ?? null;
  } catch {
    return null;
  }
}
export async function saveVoiceLang(l: Lang): Promise<void> {
  try {
    await require('@dr.pogodin/react-native-fs').writeFile(LANG_FILE(), l.code, 'utf8');
  } catch {} // a failed save only means the choice isn't remembered next launch
}

/** One line per language: speech recognition online / on-device, and whether a TTS voice is installed. */
export function supportSummary(rec: RecognitionSupport | null, tts: TtsSupport | null, langs = LANGS): string {
  const yn = (v: boolean | undefined) => (v === undefined ? '?' : v ? '✓' : '✗');
  if (rec && !rec.available) return 'Speech recognition is not available on this phone.';
  return langs.map(l => {
    const r = rec?.languages?.[l.bcp47];
    const v = `voice ${tts ? (tts[l.bcp47] === 'available' ? '✓' : '✗') : '?'}`;
    // The Galaxy M35's recognizer doesn't answer the support query (seen on device): say "not reported", never ✗.
    if (!r || r.error) return `${l.name}: speech support not reported by this phone (try it) · ${v}`;
    const off = r.onDeviceInstalled ? '✓' : r.onDeviceSupported ? 'not downloaded' : '✗';
    return `${l.name}: speech online ${yn(r.online)} · offline ${off} · ${v}`;
  }).join('\n');
}

/** What should be read aloud: the answer only (no Sources list, [n] citations, URLs, code or markdown marks). */
export function speechText(text: string): string {
  return text
    .replace(/\n\s*Sources:\s*\n[\s\S]*$/i, '')
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/\[\d+(?:,\s*\d+)*\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>`|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A short, useful message for a recognizer error code (never a crash). */
export function voiceError(code: string | undefined, lang: Lang): string {
  switch (code) {
    case 'permission':
      return 'Microphone permission is off. Allow it in Settings → Apps → Local AI → Permissions.';
    case 'no_speech':
    case 'no_match':
      return "I didn't catch any speech. Tap 🎙 and try again.";
    case 'network':
    case 'server':
    case 'server_disconnected':
      return `Speech recognition needs the internet for ${lang.name} right now (no offline ${lang.name} pack installed).`;
    case 'language_not_supported':
      return `${lang.name} speech recognition isn't available on this phone. Try another language (long-press 🎙).`;
    case 'language_unavailable':
      // Android error 13 = "not available right now": seen on the Galaxy M35 with Wi-Fi/data off and no offline pack.
      return `${lang.name} speech recognition isn't available right now: it needs the internet (no offline ${lang.name} pack installed).`;
    case 'busy':
      return 'The speech recognizer is busy. Try again in a moment.';
    case 'cancelled':
      return 'Listening cancelled.';
    case 'unavailable':
      return 'Speech recognition is not available on this phone.';
    default:
      return `Speech recognition failed (${code ?? 'unknown'}). You can still type.`;
  }
}
