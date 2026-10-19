/**
 * Questions about the phone itself, answered from the phone and never by the model: the current time and date (the
 * phone's clock, works offline) and "where am I" (approximate location, about 1 km, via src/location.ts; asks for
 * permission the first time and is never stored). Before this, "What is the time now?" and "Where am I?" went to the
 * model, which cannot know either and made answers up (found on the Galaxy M35).
 */
import { describeNow } from './agents/tools';
import * as location from './location';

export type DeviceAsk = 'time' | 'date' | 'location';

// "time in Tokyo" stays a live world-clock lookup (liveData); only the phone's own time is answered here.
const ELSEWHERE = /\b(in|at)\s+[A-Za-z]{3,}/i;
const TIME = /\b(what(?:'s| is)? the (?:current )?time|what(?:'s| is)? time (?:now|right now|is it)|what time is it|time now|current time|tell me the time)\b|ఇప్పుడు సమయం|సమయం ఎంత|अभी कितने बजे|कितने बजे|समय क्या|மணி என்ன|ಸಮಯ ಎಷ್ಟು|സമയം എത്ര/i;
const DATE = /\b(what(?:'s| is)? (?:the |today'?s )?date(?: today)?|today'?s date|what day is (?:it|today)|which day is today|current date)\b|ఈరోజు తేదీ|आज की तारीख|आज कौन सा दिन|இன்று தேதி|ಇಂದಿನ ದಿನಾಂಕ|ഇന്നത്തെ തീയതി/i;
const WHERE = /\b(where am i|where i am|my (?:current )?location|which (?:city|place|area|town|state) am i in|what(?:'s| is) my location|current location)\b|నేను ఎక్కడ ఉన్నాను|मैं कहाँ हूँ|நான் எங்கே இருக்கிறேன்|ನಾನು ಎಲ್ಲಿದ್ದೇನೆ|ഞാൻ എവിടെ/i;

/** Which phone question `text` is, or null. Weather near me is not one: that stays a live weather lookup. */
export function deviceAsk(text: string): DeviceAsk | null {
  const t = text.trim();
  if (t.length > 80 || /\bweather|temperature|rain|forecast\b/i.test(t)) return null;
  if (WHERE.test(t)) return 'location';
  if (ELSEWHERE.test(t.replace(/\b(in|at)\s+(the\s+)?(moment|now)\b/gi, ''))) return null;
  if (TIME.test(t)) return 'time';
  if (DATE.test(t)) return 'date';
  return null;
}

/** The answer text. `now` is injectable for tests. */
export async function deviceAnswer(ask: DeviceAsk, now = new Date()): Promise<string> {
  if (ask === 'time' || ask === 'date') return `It's ${describeNow(now)}, from this phone's clock.`;
  const r = await location.currentPlace();
  if ('problem' in r) return location.problemText(r.problem, 'location');
  const { latitude, longitude, label } = r.place;
  return label
    ? `You're near ${label} (approximate, about 1 km; ${latitude}, ${longitude}). Your location isn't stored.`
    : `You're at about ${latitude}, ${longitude} (approximate, about 1 km). I couldn't look up the place name. Your location isn't stored.`;
}
