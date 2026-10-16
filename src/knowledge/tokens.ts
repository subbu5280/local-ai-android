/**
 * Search tokens: the words the full-text index stores and queries match. One function is used for indexing and for
 * queries, so both sides always agree.
 *
 * Word characters are listed as explicit Unicode ranges (Latin, Devanagari, Tamil, Telugu, Kannada, Malayalam) rather
 * than \p{L}, so the result is the same in Node (tests) and Hermes (the app). The index stores the tokens joined by
 * spaces, and SQLite's simplest tokenizer (fts5 'ascii' / fts4 'simple') keeps non-ASCII characters inside a token,
 * so Indian-language words are matched exactly, never split at vowel signs.
 *
 * Normalization (same on both sides, never changes the stored passage text):
 * - Unicode NFC and lowercase;
 * - zero-width joiner/non-joiner removed: they are optional spelling marks, so "word" typed with or without one is the
 *   same token (M5);
 * - Malayalam atomic chillu letters (ൺ ൻ ർ ൽ ൾ ൿ) written as consonant + virama, the older encoding of the same
 *   letters, so text from different keyboards matches (M5);
 * - English only: plural "s" removed. No stemming of Indian languages: their word forms are handled at query time by
 *   prefix matching (retrieve.ts), which never rewrites the index.
 */

/** Bump when tokenization changes: stored index rows are rebuilt from the passages (docStore.ensureIndex). */
export const TOKENIZER_VERSION = 2;

// [lo, hi] code point ranges that are part of a word.
const WORD_RANGES: [number, number][] = [
  [0x30, 0x39], [0x61, 0x7a], // digits, a-z (input is lowercased first)
  [0xdf, 0xff], [0x100, 0x24f], // Latin-1 letters and Latin Extended-A/B (é, ñ, ā ...)
  [0x900, 0x963], [0x966, 0x97f], // Devanagari, without the danda punctuation । ॥ (U+0964, U+0965)
  [0xb80, 0xbff], [0xc00, 0xc7f], [0xc80, 0xcff], [0xd00, 0xd7f], // Tamil, Telugu, Kannada, Malayalam
];
const isWordChar = (cp: number) => WORD_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
const isLatin = (t: string) => /^[a-z0-9]+$/.test(t);
/** True for a token written in one of the Indian scripts (Devanagari, Tamil, Telugu, Kannada, Malayalam). */
export const isIndic = (t: string) => /[ऀ-ൿ]/.test(t);

const CHILLU: Record<string, string> = {
  'ൺ': 'ണ്', 'ൻ': 'ന്', 'ർ': 'ര്',
  'ൽ': 'ല്', 'ൾ': 'ള്', 'ൿ': 'ക്',
};

/** The text as search sees it: NFC, lowercase, without zero-width joiners, Malayalam chillus in one encoding. */
export function searchForm(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[‌‍]/g, '').replace(/[ൺ-ൿ]/g, c => CHILLU[c]);
}

/**
 * Light, deterministic English normalization: "refunds" -> "refund", "policy's" was already split at the apostrophe.
 * ponytail: plural "s" only, no real stemmer; "running" and "run" stay different words. Add a stemmer if recall suffers.
 */
function normalizeToken(t: string): string {
  if (isLatin(t) && t.length > 3 && t.endsWith('s') && !t.endsWith('ss') && !/^\d+$/.test(t)) return t.slice(0, -1);
  return t;
}

/** Words of `text` in order, in search form, without punctuation; single Latin letters are dropped. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  const flush = () => {
    if (cur && !(cur.length === 1 && isLatin(cur) && !/\d/.test(cur))) out.push(normalizeToken(cur));
    cur = '';
  };
  for (const ch of searchForm(text)) {
    if (isWordChar(ch.codePointAt(0)!)) cur += ch;
    else flush();
  }
  flush();
  return out;
}

// Words that say nothing about the topic. Removed from queries (never from the index), unless the query has nothing
// else ("to be or not to be" still searches). English, plus question words and postpositions of the five Indian
// languages (M5: they matched unrelated passages, e.g. Hindi "में" / "है"). ponytail: short hand-made lists.
const STOP = new Set([
  ...`a an the and or but if of to in on at by for with from into about as is are was were be been being
do does did have has had it its this that these those there here what which who whom whose when where why how can could
should would will shall may might must i me my we our you your he she they them their his her not no yes so than then
please tell explain describe give show say says said find document documents file files doc docs pdf according
many much some something anything until after before get got`.split(/\s+/),
  // Hindi
  ...'क्या है हैं में के की का को से पर और यह वह एक लिए बारे भी तो ही था थी थे हो कैसे कैसा कौन कब कहाँ कहां बताइए बताओ'.split(' '),
  // Telugu
  ...'ఏమిటి ఎలా ఎంత ఎన్ని ఎక్కడ ఎప్పుడు ఎవరు గురించి లో అంటే మరియు ఈ ఆ ఒక కోసం ఉంది ఉన్నాయి చెప్పండి చెప్పు'.split(' '),
  // Tamil
  ...'என்ன எப்படி எவ்வளவு எங்கே எப்போது யார் எது எந்த பற்றி மற்றும் ஒரு இந்த அந்த சொல்லுங்கள் உள்ளது'.split(' '),
  // Kannada
  ...'ಏನು ಹೇಗೆ ಎಷ್ಟು ಎಲ್ಲಿ ಯಾವಾಗ ಯಾರು ಯಾವ ಬಗ್ಗೆ ಮತ್ತು ಒಂದು ಈ ಆ ಹೇಳಿ ಇದೆ'.split(' '),
  // Malayalam
  ...'എന്ത് എന്താണ് എങ്ങനെ എത്ര എവിടെ എപ്പോൾ ആര് ആരാണ് കുറിച്ച് ഒരു ഈ ആ പറയൂ ഉണ്ട് ആണ്'.split(' '),
].map(w => normalizeToken(searchForm(w))));

/** Query terms: the tokens of `query` without stop words (or all tokens if every one is a stop word), deduplicated. */
export function queryTerms(query: string): string[] {
  const all = tokenize(query);
  const content = all.filter(t => !STOP.has(t));
  return [...new Set(content.length ? content : all)];
}

/**
 * The prefix used to match other forms of an Indian-language query word (M5): the first 60% of its code points, at
 * least 3. "రైతులకు" (to the farmers) -> "రైతుల" finds "రైతులు"; "टिकटों" -> "टिकट". Null for short or Latin words.
 * ponytail: a length heuristic, not a morphological analyser; it can over-match short stems (BM25 and the evidence
 * rule limit the damage). Replace with per-language suffix rules if evaluation shows wrong matches.
 */
export function indicStem(term: string): string | null {
  if (!isIndic(term)) return null;
  const cps = [...term];
  if (cps.length < 5) return null;
  return cps.slice(0, Math.max(3, Math.round(cps.length * 0.6))).join('');
}
