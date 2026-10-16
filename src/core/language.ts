/**
 * Language of the user's message and the language the model should answer in.
 *
 * Ported from the reference POC's backend/app/language.py (Phase 14, verified there by tests/test_phase14.py), which
 * only ran on the laptop. Here it runs on the phone, so offline chat gets the same language handling. Malayalam is
 * added (script + explicit request); the POC covered only en/te/hi/kn/ta.
 *
 * Deterministic, explainable rules (no model call), first match wins:
 *   1. an explicit request: "Explain this in English", "answer in Telugu", "తెలుగులో చెప్పు";
 *   2. native script: Telugu / Kannada / Tamil / Malayalam / Devanagari (Hindi), even mixed with English terms, when
 *      it is at least a third of the words (or already the conversation's language) [M5];
 *   3. romanized Telugu, Hindi, Tamil, Kannada or Malayalam ("Naaku Kafka gurinchi cheyyi"): >= 2 marker words [ta/kn/ml: M5];
 *   4. otherwise English, except a short message with no language signal ("ok", "2 + 2") keeps the conversation's
 *      current language, so a Telugu chat stays Telugu without "answer in Telugu" every turn.
 */

export type LangCode = 'en' | 'te' | 'hi' | 'ta' | 'kn' | 'ml';
/** The supported languages, in a fixed order (M6: skill and workflow texts may be given in any of them). */
export const LANG_CODES: readonly LangCode[] = ['en', 'te', 'hi', 'ta', 'kn', 'ml'];
export type LangSource = 'explicit' | 'script' | 'romanized' | 'english' | 'conversation';
export type Language = {
  code: LangCode;
  name: string;
  source: LangSource;
  /** The message mixes the language with English (e.g. technical terms in Latin letters). */
  mixed: boolean;
  explicit: boolean;
  /** BCP-47 tag for Android speech recognition / text-to-speech. */
  bcp47: string;
};

export const NAMES: Record<LangCode, string> = {
  en: 'English', te: 'Telugu', hi: 'Hindi', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam',
};

// Unicode blocks. Order matters only for ties (same as the POC: the first listed wins).
const SCRIPTS: [LangCode, number, number][] = [
  ['te', 0x0c00, 0x0c7f], ['kn', 0x0c80, 0x0cff], ['ta', 0x0b80, 0x0bff], ['hi', 0x0900, 0x097f], ['ml', 0x0d00, 0x0d7f],
];

// Romanized markers: common function words that are not English words (so "Kafka gurinchi" is Telugu). A message
// needs at least two markers of one language. The lists are disjoint (no word is in two lists) and avoid English
// words and abbreviations (e.g. Kannada "ide" is left out: "IDE"). ponytail: hand-made lists of everyday words; a
// romanized message using none of them stays English. Grow the lists from real messages.
const ROMAN: [LangCode, Set<string>][] = [
  ['te', new Set(`naaku naku nenu meeru miru nuvvu gurinchi cheyyi cheyandi cheppu cheppandi cheppara chesi chestunna
    enti emiti ela ekkada eppudu enduku kavali undi unnayi ledu leda ante antey ayithe kada kuda baaga
    bagundi chala chaala inka inkaa matladu chudu choodu ivvu ichi telugulo
    naa nenu peru perenti mata maata matlu emi emiti entha enthaa andi garu meeku mee nannu nee neeku
    nuvvu ledhu undhi unnava unnaru cheyyandi chesthanu chestanu telusu teliyadu ivvandi ekkadiki
    vellali vastanu vachanu cheppu chepandi chepu bagunnara bagunnava`.split(/\s+/))],
  ['hi', new Set(`mujhe mujhko mera meri tum aap hum kya kaise kyun kyon kahan kab nahi nahin hai hain tha thi batao
    bataiye samjhao samjhaiye samjha karo kijiye chahiye accha acha bhai yaar zara thoda bahut hindi
    mein`.split(/\s+/))],
  ['ta', new Set(`pathi patthi konjam sollunga sollu solla enna epdi eppadi enga naan unga ungal theriyuma theriyum
    puriyala puriyuthu romba venum vendum irukku iruku illai pannunga pannu kudunga edhu yaaru seri tamizh`.split(/\s+/))],
  ['kn', new Set(`bagge swalpa heli helu helri yenu enu hege hegide nanu neevu nimma beku beda gottu gottilla maadi madi
    kodi aagide alli yaake yavaga yelli`.split(/\s+/))],
  ['ml', new Set(`kurichu onnu parayu parayamo enthu enthanu engane enganeya njan ningal ningalude ariyamo ariyilla venam
    cheyyanam kollam undo aanu alle ithu athu evide`.split(/\s+/))],
];

/** Explicit language requests, in English or in the language itself. */
export const REQUEST: [LangCode, RegExp][] = [
  ['en', /\b(in|into|to) english\b|\benglish (lo|me|mein|il)\b|\bswitch to english\b/i],
  ['te', /\b(in|into|to) telugu\b|\btelugu ?lo\b|తెలుగులో/i],
  ['hi', /\b(in|into|to) hindi\b|\bhindi (me|mein)\b|हिंदी में|हिन्दी में/i],
  ['kn', /\b(in|into|to) kannada\b|\bkannada ?(da)?lli\b|\bkannada alli\b|ಕನ್ನಡದಲ್ಲಿ/i],
  ['ta', /\b(in|into|to) tamil\b|\btamil ?(il|la|le)\b|\btamizh ?(il|la|le)\b|தமிழில்/i],
  ['ml', /\b(in|into|to) malayalam\b|\bmalayalath?il\b|\bmalayalam (il|thil)\b|മലയാളത്തിൽ/i],
];

const WORD = /[A-Za-z]+/g;

/** A Language chosen by the user or a workflow (not detected), e.g. the answer language picked for a run. */
// English needs no instruction line (all prompt text is English), so choosing English adds none.
export const chosenLanguage = (code: LangCode): Language => language(code, code === 'en' ? 'english' : 'explicit');

const language = (code: LangCode, source: LangSource, mixed = false): Language => ({
  code, name: NAMES[code], source, mixed, explicit: source === 'explicit', bcp47: `${code}-IN`,
});

/** Words (space-separated) containing at least one letter of the given Indic script. */
function scriptWords(text: string, code: LangCode): number {
  const [, lo, hi] = SCRIPTS.find(([c]) => c === code)!;
  return text.split(/\s+/).filter(w => [...w].some(ch => { const cp = ch.codePointAt(0)!; return cp >= lo && cp <= hi; })).length;
}

/** The most frequent Indic script in `text` and how many of its letters were seen (null when there are none). */
function dominantScript(text: string): [LangCode | null, number] {
  const counts = new Map<LangCode, number>(SCRIPTS.map(([code]) => [code, 0]));
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const hit = SCRIPTS.find(([, lo, hi]) => cp >= lo && cp <= hi);
    if (hit) counts.set(hit[0], counts.get(hit[0])! + 1);
  }
  let best: LangCode | null = null;
  let bestCount = 0;
  for (const [code, n] of counts) if (n > bestCount) [best, bestCount] = [code, n];
  return [best, bestCount];
}

/**
 * Decide the language of one message.
 * @param text the user's message
 * @param previous the conversation's current answer language (from the previous user turn), if any
 * @returns the language to answer in and why it was chosen
 */
export function detect(text: string, previous: LangCode | null = null): Language {
  for (const [code, rx] of REQUEST) if (rx.test(text)) return language(code, 'explicit');
  const words = (text.match(WORD) ?? []).map(w => w.toLowerCase());
  const [script, count] = dominantScript(text);
  // Two letters, not one: a single stray character (a pasted symbol) shouldn't switch the answer language. And the
  // script must carry a real share of the message (at least a third of its words), unless the conversation is already
  // in that language: "What does the word హైదరాబాద్ mean?" is an English question about a Telugu word.
  if (script && count >= 2 && (previous === script || scriptWords(text, script) * 2 >= words.length)) {
    return language(script, 'script', words.length > 0);
  }
  let best: [LangCode, number] | null = null;
  for (const [code, markers] of ROMAN) {
    const n = words.filter(w => markers.has(w)).length;
    if (n >= 2 && (!best || n > best[1])) best = [code, n];
  }
  if (best) return language(best[0], 'romanized', true);
  if (previous && previous !== 'en' && words.length < 3) return language(previous, 'conversation');
  return language('en', 'english');
}

/**
 * The single line the model gets about language, or '' when nothing needs saying (plain English chat).
 * @param lang the result of detect() for this message
 * @param previous the conversation's answer language before this message, if any
 */
export function instruction(lang: Language, previous: LangCode | null = null): string {
  if (lang.code === 'en') return (previous && previous !== 'en') || lang.explicit ? 'Respond in English.' : '';
  const style = lang.mixed && lang.source === 'romanized'
    ? `The user wrote ${lang.name} in English letters, mixed with English words. Answer the question directly ` +
      `(don't ask what they mean) in simple ${lang.name} written in ${lang.name} script.`
    : `Respond in ${lang.name} written in ${lang.name} script.`;
  return `Language: ${style} Keep technical terms and names such as Kafka, React Native, Android, Python unchanged. ` +
    'Use English only if the user asks for it.';
}
