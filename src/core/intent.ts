/**
 * What kind of message this is (intent) and how much it asks for (complexity), decided on the phone.
 *
 * Keyword and pattern rules only: they recognize how a request is phrased, not what it means. A message no rule
 * recognizes is 'general'. Every decision records the word that caused it in `signals`, so a wrong classification is
 * a one-line fix to a pattern (the approach of the reference POC's backend/app/context.py, which ran on the laptop).
 *
 * The result only shapes the prompt (src/core/prompt.ts); it never blocks a message or picks a different model.
 */

export type Intent =
  | 'greeting' // the whole message is a greeting, thanks or goodbye
  | 'translation' // asks to translate a text
  | 'summarize' // asks for a summary of a text
  | 'coding' // about code: a programming language, code, errors, debugging
  | 'current_info' // needs information newer than the model (news, prices, weather, scores, this year)
  | 'explain' // asks for an explanation (how / why / explain / describe / define)
  | 'question' // some other question
  | 'general'; // nothing above was recognized

export type Complexity = 'simple' | 'medium' | 'complex';

export type Analysis = { intent: Intent; complexity: Complexity; signals: string[] };

const rx = (...words: string[]) => new RegExp(`\\b(?:${words.join('|')})\\b`, 'i');
/** First match of `pattern` in `text` (lowercased), or null. */
const hit = (pattern: RegExp, text: string) => text.match(pattern)?.[0].toLowerCase() ?? null;
/** First of `words` contained in `text`, for Indian scripts where \b word boundaries don't apply. */
const contains = (words: string[], text: string) => words.find(w => text.includes(w)) ?? null;

// ---------------------------------------------------------------- greeting (whole message only)

const GREETING = /^(?:(?:hi+|hello+|hey+|hiya|yo|namaste|namaskar(?:am)?|vanakkam|good (?:morning|afternoon|evening|night)|thanks?(?: you)?(?: so much| a lot)?|thank u|thx|ty|bye|goodbye|see you|ok(?:ay)?|cool|nice|great)[\s,!.]*)+(?:there|friend|bro|buddy|ai|assistant)?[\s!.😊🙂🙏]*$/i;
const INDIC_GREETING = ['నమస్కారం', 'నమస్తే', 'ధన్యవాదాలు', 'नमस्ते', 'नमस्कार', 'धन्यवाद', 'शुक्रिया', 'வணக்கம்', 'நன்றி',
  'ನಮಸ್ಕಾರ', 'ಧನ್ಯವಾದ', 'നമസ്കാരം', 'നന്ദി'];

function greeting(text: string): string | null {
  if (GREETING.test(text)) return text.toLowerCase().replace(/[^a-z ]/g, '').trim() || 'greeting';
  // Only a short message that is mostly the greeting word: "నమస్కారం! Kafka గురించి చెప్పు" is a question.
  const w = contains(INDIC_GREETING, text);
  return w && text.replace(/[\s!.,🙏]/g, '').length <= w.length + 4 ? w : null;
}

// ---------------------------------------------------------------- translation

const TRANSLATE = /\b(?:translate|translation|translating)\b|\bhow (?:do|would|can) (?:you|i|we) say\b|\bwhat(?:'s| is) the (?:telugu|hindi|tamil|kannada|malayalam|english) (?:word|meaning|for)\b/i;
const INDIC_TRANSLATE = ['అనువదించు', 'అనువాదం', 'అనువదించండి', 'अनुवाद', 'மொழிபெயர்', 'ಅನುವಾದ', 'വിവർത്തനം', 'പരിഭാഷ'];
// "'thank you' in Hindi": quoted text plus a target language is a translation; "Explain Kafka in Telugu" is not
// (that is only a language request, handled by language.ts).
const QUOTED_IN_LANG = /["'“‘][^"'”’]{1,80}["'”’]\s+in\s+(?:english|telugu|hindi|tamil|kannada|malayalam)\b/i;

// ---------------------------------------------------------------- summarize (reference: context.SUMMARIZE + a few)

const SUMMARIZE = /\b(?:summari[sz]e|summary|tl;?dr|sum up|key points|main points|in short)\b/i;
const INDIC_SUMMARIZE = ['సారాంశం', 'सारांश', 'சுருக்கம்', 'ಸಾರಾಂಶ', 'സംഗ്രഹം', 'ചുരുക്കം'];

// ---------------------------------------------------------------- coding (reference: context.CATEGORY.coding, tightened)
// Bare "error", "bug", "function", "exception" are left out: "the function of the liver" and "a stomach bug" are not
// code. They count only in code-shaped forms (TypeError, NullPointerException, "write a function").

// Names that are also ordinary English words (react, swift, rust, ruby, flutter, script) count only in a code form.
const CODE_LANG = rx('python', 'kotlin', 'java', 'javascript', 'typescript', 'react ?native', 'react ?js',
  'react (?:hooks?|components?)', 'node\\.?js', 'sql', 'html', 'css', 'bash', 'shell script', 'powershell', 'golang', 'php',
  'gradle', 'jetpack compose', 'android studio', 'adb', 'git', 'github', 'docker', 'json', 'yaml', 'regex', 'fastapi',
  'django', 'swiftui');
const CODE_WORD = rx('code', 'coding', 'program(?:ming)?', 'debug\\w*', 'refactor\\w*', 'compile[sdr]?', 'compiler', 'algorithm',
  'stack ?trace', 'syntax error', 'null pointer', 'api', 'sdk', 'unit tests?',
  '(?:write|create|implement|fix) (?:a|an|the|this|my)? ?(?:function|method|class|component|program|loop|query)');
// Declarations need "(", "=" or ":" right after the name, so "let me know" or "import duties" don't count.
const CODE_SHAPE = /```|\b\w+(?:Error|Exception)\b|c\+\+|c#|=>|\b(?:def|fun|function|const|var|let)\s+\w+\s*[(=:]/;

// ---------------------------------------------------------------- current information (reference: context.live_signal)
// The model has no internet and no knowledge after its training, so these get an "I can't check that" hint.

const FRESH = /\b(?:today'?s?|tonight|tomorrow'?s?|yesterday'?s?|right now|as of now|at the moment|latest|newest|most recent|this (?:week|month|morning|evening|weekend)|breaking)\b/i;
const CURRENT_TOPIC = /\bcurrent (?:[\w.-]+ )?(?:price|weather|score|news|version|release|rate|status|standings|ranking|value|temperature|forecast|ceo|president|prime minister)s?\b/i;
// Live by nature even without "today": weather (not "weather app"), prices and rates, news, scores, live status.
const LIVE_TOPIC = /\bweather\b(?!\s+(?:apps?|application|forecasting|models?|stations?|systems?|api|widgets?|patterns?|data ?sets?))|\b(?:bitcoin|btc|ethereum|crypto|stock|share|gold|silver|petrol|diesel|fuel)s? (?:price|rate)s?\b|\b(?:price|rate|value) of (?:bitcoin|btc|ethereum|gold|silver|petrol|diesel|the dollar|the rupee)\b|\bexchange rate\b|\bnews\b|\bheadlines\b|\b(?:live )?scores?\b|\bpoints table\b|\b(?:running|pnr|flight|train) status\b|\btrending\b|\bstock market\b|\bwhat time is it\b|\bwhat(?:'s| is) the (?:date|time) (?:today|now)\b/i;
// Today / news / weather / price in Telugu, Hindi, Kannada, Tamil (reference INDIC_LIVE) and Malayalam (new).
const INDIC_LIVE = ['ఈరోజు', 'ఈ రోజు', 'నేటి', 'వార్తలు', 'వార్త', 'వాతావరణం', 'ధర', 'ధరలు',
  'आज', 'ताज़ा', 'ताजा', 'खबर', 'ख़बर', 'समाचार', 'मौसम', 'कीमत', 'दाम',
  'ಇಂದು', 'ಇಂದಿನ', 'ಸುದ್ದಿ', 'ಹವಾಮಾನ', 'ಬೆಲೆ',
  'இன்று', 'இன்றைய', 'செய்தி', 'செய்திகள்', 'வானிலை', 'விலை',
  'ഇന്ന്', 'വാർത്ത', 'കാലാവസ്ഥ'];
const EXPLAIN_START = /^\s*(?:how (?:does|do|did|is|are|can)|explain|why|define|describe|what is an? |what are the (?:basics|principles))/i;

/** The word that makes this need information newer than the model, or null. */
function currentInfo(text: string, year: number): string | null {
  const indic = contains(INDIC_LIVE, text);
  if (indic) return indic;
  const fresh = hit(FRESH, text) ?? hit(CURRENT_TOPIC, text);
  if (fresh) return fresh;
  // "How does weather forecasting work?" / "Explain the stock market" are knowledge questions.
  if (!EXPLAIN_START.test(text)) {
    const topic = hit(LIVE_TOPIC, text);
    if (topic) return topic;
  }
  // A question about this year or later is past what the model was trained on ("When is Diwali 2026?").
  const y = text.match(/\b(20[2-9]\d)\b/);
  if (y && Number(y[1]) >= year && /\?|\b(?:when|what|who|where|which|how|is|are|will|date|schedule|list)\b/i.test(text)) {
    return y[1];
  }
  return null;
}

// ---------------------------------------------------------------- explanation and questions

const EXPLAIN = /\bexplain\w*\b|\bdescribe\b|\bdefine\b|\bdefinition of\b|\bwhat does .{1,40} mean\b|\bdifference between\b|\btell me (?:about|more about)\b|^\s*(?:how (?:does|do|did|is|are|can|to)|why|what is an? |what are the (?:basics|principles))/i;
const INDIC_EXPLAIN = ['వివరించు', 'వివరించండి', 'వివరంగా', 'గురించి చెప్ప', 'समझाइए', 'समझाओ', 'समझाएं', 'के बारे में',
  'விளக்க', 'பற்றி சொல்', 'ವಿವರಿಸ', 'ಬಗ್ಗೆ ಹೇಳ', 'വിശദീകരി', 'കുറിച്ച് പറ'];
const QUESTION = /\?\s*$|^\s*(?:what|who|whom|whose|when|where|which|why|how|is|are|am|was|were|can|could|should|would|will|do|does|did|has|have|shall)\b/i;
const INDIC_QUESTION = ['ఏమిటి', 'ఎందుకు', 'ఎలా', 'ఎవరు', 'ఎక్కడ', 'ఎప్పుడు', 'क्या', 'क्यों', 'कैसे', 'कौन', 'कहाँ', 'कब',
  'என்ன', 'ஏன்', 'எப்படி', 'யார்', 'எங்கே', 'ಏನು', 'ಏಕೆ', 'ಹೇಗೆ', 'ಯಾರು', 'എന്ത്', 'എന്താണ്', 'എന്തുകൊണ്ട്', 'എങ്ങനെ', 'ആര്'];

// ---------------------------------------------------------------- complexity

const DEPTH = /\b(?:in detail|detailed|step by step|step-by-step|compare|comparison|pros and cons|trade-?offs?|architecture|end-to-end|complete|full|thorough(?:ly)?)\b/i;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+\S/gm;
/** Words in any script (split on spaces); Indian-language text has spaces between words too. */
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * How much the message asks for, from visible signals only: length, number of separate asks, and words asking for
 * depth. It does not measure how hard the question is for the model.
 */
function complexityOf(text: string, intent: Intent, signals: string[]): Complexity {
  if (intent === 'greeting') return 'simple';
  const words = wordCount(text);
  const asks = (text.match(/\?/g) ?? []).length + (text.match(LIST_ITEM) ?? []).length;
  const depth = hit(DEPTH, text);
  // A summary or translation of a long pasted text is one task, however long the text is.
  const oneTask = intent === 'summarize' || intent === 'translation';
  let level = 0;
  if (words > 60 && !oneTask) { level = 1; signals.push(`long:${words} words`); }
  if (words > 200 && !oneTask) level = 2;
  if (asks >= 2) { level = Math.max(level, asks >= 3 ? 2 : 1); signals.push(`asks:${asks}`); }
  if (depth) { level = level === 0 ? 1 : 2; signals.push(`depth:${depth}`); } // depth on top of length/asks: complex
  return (['simple', 'medium', 'complex'] as const)[Math.min(level, 2)];
}

/**
 * Classify one message.
 * @param message the user's message, as typed
 * @param year the current year (a question about this year or later needs current information); defaults to now
 * @returns the intent, the complexity estimate, and the words that caused each decision
 */
export function analyze(message: string, year = new Date().getFullYear()): Analysis {
  const text = message.trim();
  const signals: string[] = [];
  const done = (intent: Intent): Analysis => ({ intent, complexity: complexityOf(text, intent, signals), signals });
  if (!text) return { intent: 'general', complexity: 'simple', signals };

  const greet = greeting(text);
  if (greet) { signals.push(`greeting:${greet}`); return done('greeting'); }
  // Order matters: an explicit task verb (translate, summarize) beats the topic of the text it applies to.
  const translate = hit(TRANSLATE, text) ?? contains(INDIC_TRANSLATE, text) ?? (QUOTED_IN_LANG.test(text) ? 'quoted-in-language' : null);
  if (translate) { signals.push(`translation:${translate}`); return done('translation'); }
  const summary = hit(SUMMARIZE, text) ?? contains(INDIC_SUMMARIZE, text);
  if (summary) { signals.push(`summarize:${summary}`); return done('summarize'); }
  const code = hit(CODE_SHAPE, text) ?? hit(CODE_LANG, text) ?? hit(CODE_WORD, text);
  if (code) { signals.push(`coding:${code}`); return done('coding'); }
  const live = currentInfo(text, year);
  if (live) { signals.push(`current:${live}`); return done('current_info'); }
  const explain = hit(EXPLAIN, text) ?? contains(INDIC_EXPLAIN, text);
  if (explain) { signals.push(`explain:${explain.trim()}`); return done('explain'); }
  const question = hit(QUESTION, text) ?? contains(INDIC_QUESTION, text);
  if (question) { signals.push(`question:${question.trim() || '?'}`); return done('question'); }
  return done('general');
}
