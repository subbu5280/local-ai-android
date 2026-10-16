/**
 * Live reports on the phone (src/liveData.ts): detection, planning, the four tools and honest failures.
 * All network calls go to a unit-test fake `fetch` (no real requests).
 */
import { answer, cryptoPrice, liveSignal, localTime, parseNews, plan, weatherNow } from '../src/liveData';

type Route = [RegExp, any];
function fakeFetch(routes: Route[]) {
  const calls: string[] = [];
  const f = jest.fn(async (url: string) => {
    calls.push(url);
    const hit = routes.find(([rx]) => rx.test(url));
    if (!hit) throw new TypeError('Network request failed');
    const body = hit[1];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body, text: async () => body };
  });
  return Object.assign(f, { calls });
}
const HYD = { results: [{ name: 'Hyderabad', admin1: 'Telangana', country: 'India', latitude: 17.38, longitude: 78.46, timezone: 'Asia/Kolkata' }] };
const WEATHER = { timezone: 'Asia/Kolkata', utc_offset_seconds: 19800, current: { time: '2026-10-08T21:00', temperature_2m: 27.9,
  apparent_temperature: 31.2, relative_humidity_2m: 80, weather_code: 2, wind_speed_10m: 9.4 } };

test('live detection: live questions yes; knowledge, coding and design requests no', () => {
  for (const q of ['Weather in Hyderabad', "What's today's news?", 'bitcoin price', 'USD to INR rate', 'What time is it in London?',
    'IPL score', 'Latest Unity release', 'హైదరాబాద్ వాతావరణం ఎలా ఉంది?', 'आज की खबर']) expect(liveSignal(q)).not.toBeNull();
  for (const q of ['What is Kafka?', 'How does weather forecasting work?', 'Create a weather app', 'Hi',
    "Write Python code that shows today's weather", 'What is Bitcoin?']) {
    expect(liveSignal(q)).toBeNull();
  }
});

test('planning is deterministic: tool and place/coin/query', () => {
  expect(plan('What is the weather in New Delhi today?')).toEqual({ tool: 'weather', city: 'New Delhi' });
  expect(plan('Hyderabad weather')).toEqual({ tool: 'weather', city: 'Hyderabad' });
  expect(plan("what's the weather like")).toEqual({ tool: 'weather', city: null });
  expect(plan('What time is it in Tokyo?')).toEqual({ tool: 'time', city: 'Tokyo' });
  expect(plan('ETH price right now')).toEqual({ tool: 'crypto', coin: 'ethereum' });
  expect(plan("Tell me today's cricket news")).toEqual({ tool: 'news', query: "today's cricket news", days: 1 });
  expect(plan('Latest Unity release')).toEqual({ tool: 'news', query: 'Latest Unity release', days: 7 });
});

test('weather: real fields, real source URL; unknown place and API failure are honest', async () => {
  const f = fakeFetch([[/geocoding.*Hyderabad/, HYD], [/api\.open-meteo\.com\/v1\/forecast/, WEATHER]]);
  const a = await weatherNow('Hyderabad', f);
  expect(a.text).toBe('Current weather in Hyderabad, Telangana, India (observed 2026-10-08T21:00 (Asia/Kolkata)): partly cloudy, ' +
    '27.9 °C (feels like 31.2 °C), humidity 80%, wind 9.4 km/h [1].');
  expect(a.sources).toEqual([{ n: 1, title: 'Open-Meteo current weather - Hyderabad, Telangana, India',
    url: 'https://open-meteo.com/en/docs#latitude=17.38&longitude=78.46', source: 'open-meteo.com', published_at: '2026-10-08T21:00' }]);
  expect((await weatherNow('Atlantis', fakeFetch([[/geocoding/, { results: [] }]]))).text).toContain(`couldn't find a place called "Atlantis"`);
  const down = await weatherNow('Hyderabad', fakeFetch([]));
  expect(down).toMatchObject({ ok: false, sources: [] });
  expect(down.text).toBe("I couldn't retrieve current weather information right now (Network request failed), so I won't guess.");
});

test('local time comes from the place UTC offset (no device time zone assumptions)', async () => {
  const f = fakeFetch([[/geocoding/, HYD], [/forecast/, WEATHER]]);
  const a = await localTime('Hyderabad', f, Date.UTC(2026, 9, 8, 15, 42)); // 15:42 UTC + 5:30
  expect(a.text).toBe("It's 9:12 PM on Thursday, 08 October 2026 in Hyderabad, Telangana, India (Asia/Kolkata, UTC+05:30) [1]. " +
    "Computed from the place's current UTC offset.");
});

test('crypto: CoinGecko numbers as given, with the update time and a not-advice note', async () => {
  const f = fakeFetch([[/coingecko.*ids=bitcoin/, { bitcoin: { usd: 62034.5, inr: 5210887, last_updated_at: 1791480000 } }]]);
  const a = await cryptoPrice('bitcoin', f);
  expect(a.text).toBe('Bitcoin is trading at 62,034.5 USD, 5,210,887 INR (CoinGecko, last updated 2026-10-08T17:20:00 UTC) [1]. ' +
    'This is market data, not financial advice; prices move quickly.');
  expect((await cryptoPrice('bitcoin', fakeFetch([[/coingecko/, {}]]))).ok).toBe(false);
});

test('news: Google News RSS parsed safely (entities, CDATA, publisher suffix, only http(s) links)', async () => {
  const rss = `<rss><channel>
    <item><title>India win the final &amp; lift the cup - The Hindu</title><link>https://news.google.com/a1</link>
      <pubDate>Thu, 08 Oct 2026 10:00:00 GMT</pubDate><source url="https://thehindu.com">The Hindu</source></item>
    <item><title><![CDATA[Rain alert for Hyderabad - NDTV]]></title><link>https://news.google.com/a2</link>
      <pubDate>Thu, 08 Oct 2026 09:00:00 GMT</pubDate><source url="https://ndtv.com">NDTV</source></item>
    <item><title>Evil</title><link>javascript:alert(1)</link></item>
  </channel></rss>`;
  expect(parseNews(rss)).toEqual([
    { title: 'India win the final & lift the cup', url: 'https://news.google.com/a1', source: 'The Hindu', published_at: '2026-10-08T10:00:00.000Z' },
    { title: 'Rain alert for Hyderabad', url: 'https://news.google.com/a2', source: 'NDTV', published_at: '2026-10-08T09:00:00.000Z' },
  ]);
  const f = fakeFetch([[/news\.google\.com\/rss\/search\?q=cricket%20news%20today%20when%3A1d&hl=en-IN/, rss]]);
  const a = await answer('cricket news today', true, f);
  expect(a.text).toContain('Latest headlines for "cricket news today" (Google News, past day):\n1. India win the final & lift the cup (The Hindu, 2026-10-08) [1]');
  expect(a.sources.map(s => s.n)).toEqual([1, 2]);
  expect((await answer('cricket news today', true, fakeFetch([[/news\.google/, '<rss></rss>']]))).text)
    .toBe('I couldn\'t find recent news for "cricket news today", so I won\'t guess.');
});

test('offline or no city: nothing is looked up and nothing is guessed', async () => {
  const f = fakeFetch([]);
  const off = await answer('Weather in Hyderabad', false, f);
  expect(off.text).toContain("I can't get current weather while you're offline"); // weather has its own offline answer
  expect(f).not.toHaveBeenCalled();
  expect((await answer("what's the weather like", true, f)).text).toBe("Which city do you want the current weather for? I won't assume a location.");
  expect(f).not.toHaveBeenCalled();
});
