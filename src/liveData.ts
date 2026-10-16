/**
 * Live reports on the phone itself (no laptop): weather, local time, crypto prices and news headlines.
 *
 * Rules (ported from backend/app/live_research.py and context.live_signal):
 * - the decision "is this live?" and the tool + query are deterministic; no model chooses what to look up;
 * - answers are built from the retrieved data only (no model writes them), so nothing can be invented;
 * - every answer lists its real source URLs; a failed lookup says so ("so I won't guess"), never guesses;
 * - free, keyless HTTPS services only: Open-Meteo (geocoding, weather, UTC offset), CoinGecko (prices),
 *   Google News RSS (headlines). Retrieved text is data: it is shown, never executed or followed.
 */
export type LiveSource = { n: number; title: string; url: string; source?: string; published_at?: string | null };
export type LiveAnswer = { text: string; sources: LiveSource[]; tool: string; ok: boolean };
type Fetch = (url: string, init?: any) => Promise<any>;

const TIMEOUT_MS = 8000;
const UA = { 'User-Agent': 'AI-ChatBot-Android/1.0 (personal assistant)' };

// ---------------------------------------------------------------- is this a live request?

const INDIC_LIVE = ['ఈరోజు', 'ఈ రోజు', 'నేటి', 'వార్తలు', 'వార్త', 'వాతావరణం', 'ధర', 'ధరలు', 'आज', 'ताज़ा', 'ताजा', 'खबर',
  'ख़बर', 'समाचार', 'मौसम', 'कीमत', 'दाम', 'ಇಂದು', 'ಇಂದಿನ', 'ಸುದ್ದಿ', 'ಹವಾಮಾನ', 'ಬೆಲೆ', 'இன்று', 'இன்றைய',
  'செய்தி', 'செய்திகள்', 'வானிலை', 'விலை'];
const FRESH = /\b(today'?s?|tonight|tomorrow'?s?|yesterday'?s?|right now|as of now|at the moment|currently|latest|newest|most recent|recent(ly)?|this (week|month|year|morning|evening|weekend)|breaking|so far)\b/i;
const CURRENT_TOPIC = /\bcurrent ([\w.-]+ )?(price|weather|score|news|version|release|rate|status|standings|ranking|value|temperature|forecast|ceo|president|prime minister)s?\b/i;
const IMPLICIT = /\bweather\b(?!\s+(apps?|application|forecasting|models?|stations?|systems?|api|widgets?|patterns?|data ?sets?))|\b(price|value|rate) of (bitcoin|btc|ethereum|eth|solana|dogecoin|gold|silver|the dollar|the rupee)\b|\b(bitcoin|btc|ethereum|eth|solana|dogecoin|crypto|stock|share)s? price\b|\bexchange rate\b|\blive score\b|\bnews\b|\bheadlines\b|\bsearch (the )?(web|internet|online)\b|\bgoogle\b/i;
const LIVE_TOPIC = /\b(petrol|diesel|fuel|cng|lpg|gold|silver|crude|onion|tomato|share|stock|nifty|sensex)\s+(price|prices|rate|rates|cost|value|today)\b|\b(usd|inr|eur|gbp|dollars?|rupees?|euros?)\s*(to|in|vs|\/)\s*(usd|inr|eur|gbp|dollars?|rupees?|euros?)\b|\b(live )?score(card)?s?\b|\bmatch (result|score|update|highlights)s?\b|\bpoints table\b|\b(ipl|isl|epl|nba|f1|world cup|t20|odi|premier league)\b|\b(running|pnr|flight|train) status\b|\btrending\b|\bwhat time is it\b|\b(current|local) time\b|\btime (now |right now )?in [A-Za-z]/i;
const EXPLAIN = /^\s*(how (does|do|did|is|are|can)|explain|why|define|describe|what is an? |what are the (basics|principles))/i;
// "Write Python code that shows today's weather" or "Create a weather app" is a coding/design request, not a lookup.
const MAKE = /^\s*(please\s+)?(create|build|write|make|design|develop|generate|implement|code|program)\b/i;

/** Why `text` needs live data (the matched word), or null for ordinary chat. */
export function liveSignal(text: string): string | null {
  const t = text.trim();
  if (!t || MAKE.test(t)) return null;
  const indic = INDIC_LIVE.find(w => t.includes(w));
  if (indic) return indic;
  const m = t.match(FRESH) ?? t.match(CURRENT_TOPIC);
  if (m) return m[0].toLowerCase();
  if (!EXPLAIN.test(t)) {
    const k = t.match(IMPLICIT) ?? t.match(LIVE_TOPIC);
    if (k) return k[0].toLowerCase();
    if (isWeatherQuestion(t)) return 'weather';
  }
  return null;
}

// "Will it rain tomorrow?", "How hot is it today?", "Weather near me?": weather words with a question/time/place cue.
// "I'm cold" or "Explain how rain forms" are not weather lookups.
const WEATHER_WORDS = /\b(weather|rain|raining|rainy|temperature|hot|cold|humid|humidity|windy|wind|storm|stormy|sunny|cloudy|forecast|umbrella)\b/i;
const WEATHER_CUE = /\b(today|tonight|tomorrow|now|outside|here|near me|this (?:week|morning|afternoon|evening)|will it|is it|going to|gonna)\b|\?\s*$/i;
const isWeatherQuestion = (t: string) => WEATHER_WORDS.test(t) && WEATHER_CUE.test(t) && !/^\s*(i'?m|i am)\b/i.test(t);

export type When = 'now' | 'today' | 'tomorrow';
/** Which forecast a weather question is about: "tomorrow", "today" (also any rain question), else current conditions. */
export function weatherWhen(text: string): When {
  if (/\btomorrow'?s?\b/i.test(text)) return 'tomorrow';
  if (/\b(today'?s?|tonight|this (?:morning|afternoon|evening))\b|\b(rain|raining|rainy|umbrella)\b/i.test(text)) return 'today';
  return 'now';
}
/** "here", "near me", "outside", "where I am": the user means the phone's current location, even if a city came up earlier. */
export const wantsDeviceLocation = (text: string) => /\b(here|near me|nearby|outside|my (?:current )?location|where i am|around me)\b/i.test(text);
/** "there", "that city": the place already being talked about in this conversation. */
export const meansContextPlace = (text: string) => /\b(there|that (?:city|place|town)|(?:the )?same (?:city|place))\b/i.test(text);

// A short follow-up ("What about Chennai?", "And tomorrow?") continues the chat's weather question, unless it names
// another intent ("What about Chennai news?", "restaurants", "hospitals"): those keep their own routing.
const FOLLOW_UP = /^\s*(?:and|what about|how about)\s+(.{1,40}?)\s*[?.!]*$/i;
const OTHER_INTENT = /\b(news|headlines?|restaurants?|hotels?|hospitals?|clinics?|food|movies?|jobs?|prices?|rates?|scores?|time|traffic|events?|shops?|stores?|schools?|colleges?|places|things to do|population|history)\b/i;
const WHEN_ONLY = /^(?:today|tonight|tomorrow|now|right now|this (?:morning|afternoon|evening|week))$/i;
export const isFollowUp = (text: string) => FOLLOW_UP.test(text);

/**
 * `message` rewritten as the weather question it continues, or null when it isn't a weather follow-up.
 * `earlier`: this chat's previous user messages, oldest first; only the latest one decides whether the chat is
 * about weather. A new place is asked as "weather in X"; a new time keeps the previous place.
 */
export function resolveFollowUp(message: string, earlier: string[], depth = 0): string | null {
  const m = message.match(FOLLOW_UP);
  if (!m || OTHER_INTENT.test(m[1]) || !earlier.length || depth > 5) return null;
  const last = earlier[earlier.length - 1];
  const prev = resolveFollowUp(last, earlier.slice(0, -1), depth + 1) ?? last;
  const p = liveSignal(prev) ? plan(prev) : null;
  if (p?.tool !== 'weather') return null;
  const rest = m[1].trim();
  if (WHEN_ONLY.test(rest)) {
    const place = p.city ? ` in ${p.city}` : meansContextPlace(prev) ? ' there' : '';
    return `weather${place} ${rest}`;
  }
  const day = weatherWhen(prev) === 'now' ? '' : ` ${weatherWhen(prev)}`; // a new place keeps the day asked about
  if (meansContextPlace(rest)) return `weather ${rest}${day}`; // "And there?": the chat's city, resolved by answer()
  return rest.split(/\s+/).length <= 3 ? `weather in ${rest}${day}` : null;
}

// ---------------------------------------------------------------- which tool, which query

const INDIC_WEATHER = ['వాతావరణం', 'मौसम', 'ಹವಾಮಾನ', 'வானிலை'];
const WEATHER_FILLER = new Set(`what what's whats is are the a an todays today's today tonight tomorrow tomorrow's now right current
currently weather report forecast update temperature temp like how hows how's it its it's please tell me show give check in
for at of on this morning evening afternoon outside there my local s will going gonna to be rain raining rainy hot cold
humid humidity wind windy storm stormy sunny cloudy umbrella need do does i should carry take here near me nearby
around location where am much very so degrees sky week`.split(/\s+/));
const TIME_ASK = /\bwhat(?:'s| is)? (?:the )?(?:current |local )?time\b|\bcurrent (?:local )?time\b|\btime (?:now |right now )?(?:in|at)\b|\btime is it\b/i;
const TIME_FILLER = new Set('what what\'s whats is the current local time now right it in at there please tell me today s'.split(' '));
export const COINS: Record<string, string> = { bitcoin: 'bitcoin', btc: 'bitcoin', ethereum: 'ethereum', eth: 'ethereum',
  solana: 'solana', sol: 'solana', dogecoin: 'dogecoin', doge: 'dogecoin', xrp: 'ripple', ripple: 'ripple',
  cardano: 'cardano', ada: 'cardano', litecoin: 'litecoin', ltc: 'litecoin' };

export type Plan = { tool: 'weather' | 'time'; city: string | null } | { tool: 'crypto'; coin: string }
  | { tool: 'news'; query: string; days: 1 | 7 };

const trimPlace = (s: string) => s.trim().replace(/^[\s.']+|[\s.'?!]+$/g, '');

/** The lookup for a live request: deterministic, explainable (same rules as the backend planner). */
export function plan(message: string): Plan {
  const text = message.trim();
  const low = text.toLowerCase();
  if (TIME_ASK.test(text) && !/\b(time zone|timezone) (of|for)\b|\btime complexity\b/.test(low)) {
    const m = text.match(/\b(?:in|at)\s+([A-Za-z][A-Za-z .'-]{1,40}?)\s*(?:now|right now|today)?\s*[?.!]*$/i);
    const rest = (text.match(/[A-Za-z][A-Za-z.'-]*/g) ?? []).filter(w => !TIME_FILLER.has(w.toLowerCase())).join(' ');
    return { tool: 'time', city: m ? trimPlace(m[1]) : rest || null };
  }
  if (/\bweather\b|\btemperature\b|\bforecast (for|in)\b/.test(low) || INDIC_WEATHER.some(w => text.includes(w)) || isWeatherQuestion(text)) {
    const m = text.match(/\b(?:in|for|at|of)\s+([A-Za-z][A-Za-z .'-]{1,40}?)(?:\s+(?:today|tonight|tomorrow|now|right now|this \w+))?\s*[?.!]*$/i);
    let city: string | null = m ? trimPlace(m[1]) : null;
    if (city && ['today', 'tomorrow', 'now', 'the weekend', 'this week'].includes(city.toLowerCase())) city = null;
    if (!city) { // "Hyderabad weather", "weather report hyderabad": the words left over are the place
      const rest: string[] = [];
      for (const w of text.match(/[A-Za-z][A-Za-z.'-]*/g) ?? []) {
        if (!WEATHER_FILLER.has(w.toLowerCase().replace(/[.']+$/, '')) && !rest.some(x => x.toLowerCase() === w.toLowerCase())) rest.push(w);
      }
      city = rest.length > 0 && rest.length <= 3 ? trimPlace(rest.join(' ')) || null : null;
    }
    return { tool: 'weather', city };
  }
  for (const [word, coin] of Object.entries(COINS)) {
    if (new RegExp(`\\b${word}\\b`).test(low) && /\b(price|value|worth|cost|rate|trading)\b/.test(low)) return { tool: 'crypto', coin };
  }
  const day = /\b(today|tonight|right now|breaking|this morning|yesterday)\b/.test(low);
  const query = text.replace(/^\s*(please |can you |could you |tell me |research |find |search for |show me )/i, '').replace(/[?!.]+$/, '');
  return { tool: 'news', query, days: day ? 1 : 7 };
}

// ---------------------------------------------------------------- tools (official free APIs)

async function getJson(fetchImpl: Fetch, url: string): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getText(fetchImpl: Fetch, url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

const why = (e: any) => (e?.name === 'AbortError' ? 'timed out' : String(e?.message ?? e).slice(0, 80));

const WMO: Record<number, string> = { 0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog',
  48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with hail' };

async function geocode(fetchImpl: Fetch, city: string) {
  const g = await getJson(fetchImpl, `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`);
  const pl = (g?.results ?? [])[0];
  if (!pl) return null;
  const place = [pl.name, pl.admin1, pl.country].filter(Boolean).join(', ');
  const url = `https://open-meteo.com/en/docs#latitude=${pl.latitude}&longitude=${pl.longitude}`;
  return { pl, place, url };
}

/** Weather for a named city: now (current conditions), today or tomorrow (daily forecast incl. chance of rain). */
export async function weatherNow(city: string, fetchImpl: Fetch = fetch, when: When = 'now'): Promise<LiveAnswer> {
  try {
    const g = await geocode(fetchImpl, city);
    if (!g) return notFound(city, 'weather');
    return await weatherAt(g.pl.latitude, g.pl.longitude, g.place, g.url, when, false, fetchImpl);
  } catch (e) {
    return failed('weather', `I couldn't retrieve current weather information right now (${why(e)}), so I won't guess.`);
  }
}

/**
 * Weather at the phone's current place (rounded coordinates from location.ts). The answer and its source name the place
 * ("your current location in Hyderabad, …") but never contain coordinates, so nothing precise reaches chat history.
 */
export async function weatherHere(place: { latitude: number; longitude: number; label: string | null }, when: When = 'now',
  fetchImpl: Fetch = fetch): Promise<LiveAnswer> {
  try {
    return await weatherAt(place.latitude, place.longitude, place.label, 'https://open-meteo.com/', when, true, fetchImpl);
  } catch (e) {
    return failed('weather', `I couldn't retrieve current weather information right now (${why(e)}), so I won't guess.`);
  }
}

async function weatherAt(lat: number, lon: number, place: string | null, url: string, when: When, device: boolean,
  fetchImpl: Fetch): Promise<LiveAnswer> {
  const w = await getJson(fetchImpl, `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto` +
    '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=2');
  const c = w.current;
  const where = device ? `your current location${place ? ` in ${place}` : ''}` : place;
  const title = `Open-Meteo ${when === 'now' ? 'current weather' : 'forecast'} - ${device ? place ?? 'your current location' : place}`;
  const sources = [{ n: 1, title, url, source: 'open-meteo.com', published_at: c?.time ?? null }];
  const lead = device ? `Based on ${where}, ` : '';
  const day = (i: number) => {
    const d = w.daily;
    if (!d?.time?.[i]) throw new Error('no forecast in the response');
    const rain = d.precipitation_probability_max?.[i];
    return `${WMO[d.weather_code?.[i]] ?? 'unknown'}, ${d.temperature_2m_min[i]}–${d.temperature_2m_max[i]} °C` +
      `${rain == null ? '' : `, chance of rain ${rain}%`}`;
  };
  const now = `${WMO[c.weather_code] ?? 'unknown'}, ${c.temperature_2m} °C (feels like ${c.apparent_temperature} °C), ` +
    `humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h`;
  let text: string;
  if (when === 'tomorrow') {
    text = `${lead}${device ? 'tomorrow' : `Tomorrow in ${place}`} (${w.daily.time[1]}): ${day(1)} [1].`;
  } else if (when === 'today') {
    text = `${lead}${device ? 'today' : `Today in ${place}`} (${w.daily.time[0]}): ${day(0)}. Right now: ${now} [1].`;
  } else {
    text = device ? `${lead}it's ${now} right now (observed ${c.time}) [1].`
      : `Current weather in ${place} (observed ${c.time} (${w.timezone ?? ''})): ${now} [1].`;
  }
  return { tool: 'weather', ok: true, sources, text: text[0].toUpperCase() + text.slice(1) };
}

export async function localTime(city: string, fetchImpl: Fetch = fetch, now = Date.now()): Promise<LiveAnswer> {
  try {
    const g = await geocode(fetchImpl, city);
    if (!g) return notFound(city, 'time');
    const f = await getJson(fetchImpl, `https://api.open-meteo.com/v1/forecast?latitude=${g.pl.latitude}&longitude=${g.pl.longitude}&timezone=auto&current=temperature_2m`);
    const offset = Number(f.utc_offset_seconds);
    if (!Number.isFinite(offset)) throw new Error('no UTC offset in the response');
    const d = new Date(now + offset * 1000); // read with getUTC*: the place's wall-clock time
    const h = d.getUTCHours(), mi = d.getUTCMinutes();
    const time = `${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const date = `${days[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    const mins = Math.abs(offset) / 60;
    const utc = `UTC${offset >= 0 ? '+' : '-'}${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    return { tool: 'time', ok: true, sources: [{ n: 1, title: `Open-Meteo time zone - ${g.place}`, url: g.url, source: 'open-meteo.com', published_at: null }],
      text: `It's ${time} on ${date} in ${g.place} (${f.timezone ?? g.pl.timezone ?? ''}, ${utc}) [1]. Computed from the place's current UTC offset.` };
  } catch (e) {
    return failed('time', `I couldn't look up the time zone right now (${why(e)}), so I won't guess.`);
  }
}

const grouped = (v: number) => {
  const [i, f] = String(v).split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : '');
};

export async function cryptoPrice(coin: string, fetchImpl: Fetch = fetch): Promise<LiveAnswer> {
  try {
    const d = await getJson(fetchImpl, `https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=usd,inr&include_last_updated_at=true`);
    const row = d?.[coin];
    if (!row || (row.usd == null && row.inr == null)) throw new Error('no price in the response');
    const prices = ['usd', 'inr'].filter(c => row[c] != null).map(c => `${grouped(row[c])} ${c.toUpperCase()}`).join(', ');
    const updated = row.last_updated_at ? new Date(row.last_updated_at * 1000).toISOString().slice(0, 19) : null;
    const name = coin[0].toUpperCase() + coin.slice(1);
    return { tool: 'crypto', ok: true, sources: [{ n: 1, title: `CoinGecko - ${coin} price`, url: `https://www.coingecko.com/en/coins/${coin}`, source: 'coingecko.com', published_at: updated }],
      text: `${name} is trading at ${prices} (CoinGecko${updated ? `, last updated ${updated} UTC` : ''}) [1]. This is market data, not financial advice; prices move quickly.` };
  } catch (e) {
    return failed('crypto', `I couldn't retrieve the current ${coin} price right now (${why(e)}), so I won't guess.`);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === '#'
    ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    : ENTITIES[e.toLowerCase()] ?? m)).trim();
const tag = (item: string, name: string) => decode(item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '');

/** Headlines from the Google News RSS feed (title, link, publisher, date); at most 5, http(s) links only. */
export function parseNews(xml: string, max = 5): { title: string; url: string; source: string; published_at: string | null }[] {
  const out = [];
  for (const item of xml.match(/<item>[\s\S]*?<\/item>/gi) ?? []) {
    const source = tag(item, 'source');
    let title = tag(item, 'title');
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    const url = tag(item, 'link');
    const date = Date.parse(tag(item, 'pubDate'));
    if (!title || !/^https?:\/\//i.test(url)) continue;
    out.push({ title: title.slice(0, 200), url, source, published_at: Number.isFinite(date) ? new Date(date).toISOString() : null });
    if (out.length >= max) break;
  }
  return out;
}

export async function news(query: string, days: 1 | 7, fetchImpl: Fetch = fetch): Promise<LiveAnswer> {
  try {
    const q = encodeURIComponent(`${query} when:${days}d`);
    const items = parseNews(await getText(fetchImpl, `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`));
    if (!items.length) {
      return { tool: 'news', ok: true, sources: [], text: `I couldn't find recent news for "${query}", so I won't guess.` };
    }
    const sources = items.map((s, i) => ({ n: i + 1, ...s }));
    const lines = sources.map(s => `${s.n}. ${s.title}${s.source ? ` (${s.source}` : ''}${s.published_at ? `${s.source ? ', ' : ' ('}${s.published_at.slice(0, 10)}` : ''}${s.source || s.published_at ? ')' : ''} [${s.n}]`);
    return { tool: 'news', ok: true, sources,
      text: `Latest headlines for "${query}" (Google News, past ${days === 1 ? 'day' : 'week'}):\n${lines.join('\n')}\n\nThese are headlines only; open a source for the full story.` };
  } catch (e) {
    return failed('news', `I couldn't retrieve current news right now (${why(e)}), so I can't reliably answer that. I won't guess.`);
  }
}

const notFound = (city: string, tool: string): LiveAnswer => ({ tool, ok: true, sources: [],
  text: `I couldn't find a place called "${city}". Which city did you mean?` });
const failed = (tool: string, text: string): LiveAnswer => ({ tool, ok: false, sources: [], text });

/** Answer a live request on the phone. `online` false -> an honest refusal without any lookup. */
export type DevicePlace = { place: { latitude: number; longitude: number; label: string | null } } | { problem: string; text: string };
export type AnswerOptions = {
  /** The city this conversation was last asking about ("Will it rain tomorrow?" after "Weather in Hyderabad?"). */
  contextCity?: string | null;
  /** The phone's current place (location.ts); asked only when a weather question names no place. */
  device?: () => Promise<DevicePlace>;
};

// The last weather answer per place, in memory only, so an offline question can show it clearly marked as old.
const WEATHER_CACHE_MS = 3 * 60 * 60 * 1000;
const lastWeather = new Map<string, { a: LiveAnswer; at: number }>();
const clock = (t: number) => new Date(t).toTimeString().slice(0, 5);

/**
 * Answer a live request on the phone. Weather place priority: a city named in the message → the device ("here",
 * "near me", or no place at all) → this conversation's city for "there"/follow-ups → ask. `online` false: no lookup
 * (a recent weather answer is shown, marked as cached).
 */
export async function answer(message: string, online: boolean, fetchImpl: Fetch = fetch, opts: AnswerOptions = {},
  now = Date.now()): Promise<LiveAnswer> {
  const p = plan(message);
  if (p.tool === 'weather') return weatherAnswer(message, p.city, online, fetchImpl, opts, now);
  if (!online) {
    return failed(p.tool, "You're offline, so I can't look up live information (weather, prices, news). Nothing was looked up, so I won't guess.");
  }
  if (p.tool === 'crypto') return cryptoPrice(p.coin, fetchImpl);
  if (p.tool === 'news') return news(p.query, p.days, fetchImpl);
  if (!p.city) return { tool: p.tool, ok: true, sources: [], text: "Which city's local time do you want? I won't assume a location." };
  return localTime(p.city, fetchImpl);
}

async function weatherAnswer(message: string, explicitCity: string | null, online: boolean, fetchImpl: Fetch,
  opts: AnswerOptions, now: number): Promise<LiveAnswer> {
  const when = weatherWhen(message);
  const here = wantsDeviceLocation(message);
  // An explicit city always wins. The chat's earlier city is used only when the message points back to it ("there",
  // "that city"); any other question without a city ("Will it rain today?") is about where the phone is now.
  const named = explicitCity && !meansContextPlace(explicitCity) ? explicitCity : null; // "in that city" names no city
  const back = !here && meansContextPlace(message);
  if (back && !named && !opts.contextCity) {
    return { tool: 'weather', ok: true, sources: [], text: "Which city do you mean? I won't assume a location." };
  }
  const city = named && !here ? named : back ? opts.contextCity ?? null : null;
  const key = `${city ?? 'device'}|${when}`;
  if (!online) {
    const hit = lastWeather.get(key);
    if (hit && now - hit.at < WEATHER_CACHE_MS) {
      return { ...hit.a, ok: false, text: `You're offline, so this is the last weather I fetched (cached at ${clock(hit.at)}, may be out of date): ${hit.a.text}` };
    }
    return failed('weather', "I can't get current weather while you're offline, so I won't guess.");
  }
  let a: LiveAnswer;
  if (city) {
    a = await weatherNow(city, fetchImpl, when);
  } else if (opts.device) {
    const d = await opts.device();
    if ('problem' in d) return { tool: 'weather', ok: false, sources: [], text: d.text };
    a = await weatherHere(d.place, when, fetchImpl);
  } else {
    return { tool: 'weather', ok: true, sources: [], text: "Which city do you want the current weather for? I won't assume a location." };
  }
  if (a.ok && a.sources.length) lastWeather.set(key, { a, at: now });
  return a;
}

/** Forget cached weather answers (tests). */
export const clearWeatherCache = () => lastWeather.clear();
