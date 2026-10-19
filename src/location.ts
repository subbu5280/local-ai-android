/**
 * Device location for local questions (today: weather; later: nearby places, sunrise, local time…).
 *
 * The phone owns location. Rules:
 * - approximate location only (ACCESS_COARSE_LOCATION); one fix when a local question needs it; no tracking, no
 *   background location, nothing periodic;
 * - permission is asked at most once by the app: a "Don't allow" is remembered (a tiny on-phone flag), so the user is
 *   never asked on every message; after that they can allow it in Android Settings or name a city;
 * - coordinates live only in memory (CACHE_MS) and are rounded to ~1 km before leaving this module; they are never put
 *   in chat history, memory, learned knowledge, model prompts, the laptop request or logs. Callers get a place label
 *   ("Hyderabad, Telangana, India") for display and rounded coordinates only for the weather service.
 */
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

export type PermissionState = 'not_requested' | 'granted' | 'denied' | 'blocked';
export type Place = { latitude: number; longitude: number; label: string | null };
export type Problem = 'denied' | 'blocked' | 'location_off' | 'unavailable' | 'unsupported';
export type PlaceResult = { place: Place } | { problem: Problem };

/** Weather and other local questions don't need more than ~1 km: 2 decimals of a degree. */
export const ROUND_DECIMALS = 2;
/**
 * 15 minutes: weather data itself updates about every 15 minutes, and a phone rarely moves to another weather area
 * between consecutive messages; a stale fix is replaced on the next local question. Memory only, never stored.
 */
export const CACHE_MS = 15 * 60 * 1000;
export const FIX_TIMEOUT_MS = 15000;

const P = PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION;
const native = (): any => NativeModules.AiLocation;
const FLAG_FILE = () => `${require('@dr.pogodin/react-native-fs').DocumentDirectoryPath}/location_permission.txt`;

let cache: { place: Place; at: number } | null = null;

export const round = (v: number) => Math.round(v * 10 ** ROUND_DECIMALS) / 10 ** ROUND_DECIMALS;

async function readFlag(): Promise<string> {
  try {
    const RNFS = require('@dr.pogodin/react-native-fs');
    return (await RNFS.exists(FLAG_FILE())) ? (await RNFS.readFile(FLAG_FILE(), 'utf8')).trim() : '';
  } catch {
    return '';
  }
}
async function writeFlag(v: string) {
  try {
    await require('@dr.pogodin/react-native-fs').writeFile(FLAG_FILE(), v, 'utf8');
  } catch {} // not remembering a denial only means asking once more later
}

/** Current permission state, without asking. */
export async function permissionState(): Promise<PermissionState> {
  if (Platform.OS !== 'android') return 'denied';
  if (await PermissionsAndroid.check(P)) return 'granted';
  const flag = await readFlag();
  return flag === 'blocked' ? 'blocked' : flag === 'denied' ? 'denied' : 'not_requested';
}

/**
 * Make sure the app may use approximate location. Shows Android's dialog only when it was never asked before
 * (`ask` false: never shows it). Returns the resulting state; the caller continues the original question afterwards.
 */
export async function ensurePermission(ask = true): Promise<PermissionState> {
  const state = await permissionState();
  if (state !== 'not_requested' || !ask) return state;
  const r = await PermissionsAndroid.request(P, {
    title: 'Location',
    message: 'Allow approximate location (about 1 km) so I can answer "where am I" and give the weather where you are. It is used only when you ask, and never stored.',
    buttonPositive: 'Allow',
    buttonNegative: 'Not now',
  });
  if (r === PermissionsAndroid.RESULTS.GRANTED) {
    await writeFlag('');
    return 'granted';
  }
  const result: PermissionState = r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied';
  await writeFlag(result);
  return result;
}

/**
 * The device's approximate place: from the memory cache when fresh, else one new fix (asking for permission only if it
 * was never asked). Never throws.
 */
export async function currentPlace(now = Date.now(), ask = true): Promise<PlaceResult> {
  if (!native()) return { problem: 'unsupported' };
  if (cache && now - cache.at < CACHE_MS) return { place: cache.place };
  const perm = await ensurePermission(ask);
  if (perm !== 'granted') return { problem: perm === 'blocked' ? 'blocked' : 'denied' };
  try {
    const fix = await native().currentLocation(FIX_TIMEOUT_MS);
    const latitude = round(fix.latitude), longitude = round(fix.longitude);
    const label = await native().locality(fix.latitude, fix.longitude).catch(() => null);
    const place = { latitude, longitude, label };
    cache = { place, at: now };
    return { place };
  } catch (e: any) {
    const code = e?.code;
    return { problem: code === 'location_off' ? 'location_off' : code === 'no_permission' ? 'denied' : 'unavailable' };
  }
}

/** Forget the cached fix (tests; or when permission changes). */
export function clearCache() {
  cache = null;
}

/** What to tell the user when the device location can't be used (they can always name a city). */
export function problemText(p: Problem, purpose: 'weather' | 'location' = 'weather'): string {
  const fallback = purpose === 'weather' ? 'or tell me a city.' : 'or tell me where you are.';
  if (p === 'location_off') return `Your phone's Location setting is off, so I can't tell where you are. Turn it on, ${fallback}`;
  if (p === 'unavailable') return `I couldn't get your location right now. Try again in a moment, ${fallback}`;
  if (p === 'unsupported') return `Location is not available on this device. ${purpose === 'weather' ? 'Tell me a city and I can give its weather.' : ''}`.trim();
  return `I need your location ${purpose === 'weather' ? 'to give you local weather' : 'to tell you where you are'}. You can allow location for Local AI in Android Settings → Apps → Local AI → Permissions, ${fallback}`;
}
