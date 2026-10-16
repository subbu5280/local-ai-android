/**
 * The message the on-device model receives for one user turn.
 *
 * Layout: zero to two short guidance lines, a blank line, then the user's text exactly as typed:
 *
 *   Language: Respond in Telugu written in Telugu script. Keep technical terms ...   (language.ts, when needed)
 *   Task: Reply with the translation only.                                           (from intent, when it helps)
 *
 *   <the user's message, unchanged>
 *
 * The user's text is never rewritten, shortened or reordered, so no instruction in it is lost. Guidance lines are
 * added only for failure modes small models are known for (explaining instead of just translating, adding facts to
 * a summary, inventing "today's news", answering only the first of several questions); a plain question gets no
 * extra line. Whether each line helps this app's model has not been measured yet. The general "be concise and helpful" lives once in the system message
 * (localModel.generate), so it is not repeated here. Only the user's text is saved in history, so guidance never
 * piles up in later turns' context.
 */
import { analyze, type Complexity, type Intent } from './intent';
import { detect, instruction, type LangCode } from './language';

export type BuiltPrompt = {
  /** What the model receives as the user turn. */
  prompt: string;
  /** Language of this message (saved with it, so a short reply keeps the conversation's language). */
  lang: LangCode;
  intent: Intent;
  complexity: Complexity;
  /** Why: the words that decided the intent and complexity. */
  signals: string[];
};

/** Task guidance for an intent, or '' when the model needs none. Kept to one short line for the small model. */
function taskLine(intent: Intent, complexity: Complexity): string {
  switch (intent) {
    case 'translation':
      return 'Task: Translate faithfully. Reply with the translation only, unless the user asks for more.';
    case 'summarize':
      return 'Task: Summarize only what the given text says. Do not add facts that are not in it.';
    case 'coding':
      return complexity === 'simple'
        ? 'Task: Put any code in a fenced code block.'
        : 'Task: Put code in fenced code blocks, with a short explanation. Cover every part of the request.';
    case 'current_info':
      return "Task: You have no internet access and no information newer than your training. If the answer depends on " +
        "current information (news, prices, weather, scores, today's date), say you can't check it; answer only what doesn't.";
    case 'greeting':
      return '';
    default: // explain, question, general
      return complexity === 'complex' ? 'Task: Answer every part of the request, in short sections or steps.' : '';
  }
}

/**
 * Build the model's prompt for one user message.
 * @param text the user's message, as typed
 * @param previous the language of the conversation's previous user message (null for a new conversation)
 * @param year the current year, for "needs current information" (defaults to now; injectable for tests)
 */
export function buildPrompt(text: string, previous: LangCode | null, year?: number): BuiltPrompt {
  const lang = detect(text, previous);
  const { intent, complexity, signals } = analyze(text, year);
  const guidance = [instruction(lang, previous), taskLine(intent, complexity)].filter(Boolean);
  return {
    prompt: guidance.length ? `${guidance.join('\n')}\n\n${text}` : text,
    lang: lang.code,
    intent,
    complexity,
    signals,
  };
}

/** The language of the most recent user message, so a short reply ("ok") keeps the conversation's language. */
export function previousLanguage(msgs: { role: string; lang?: LangCode }[]): LangCode | null {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') return msgs[i].lang ?? null;
  return null;
}

// ---------------------------------------------------------------- ambiguity (M12)

const REFERS = /\b(it|this|that|these|those|them|he|she|they|the (?:above|same|previous|last) (?:one|thing|file|code|answer))\b|(?:^|\s)(అది|ఇది|వాటిని|यह|वह|इसे|उसे|இது|அது|ಇದು|ಅದು|ഇത്|അത്)(?:\s|$|[?.!,])/i;
const ACTION = /^\s*(please\s+)?(do|fix|explain|continue|translate|summari[sz]e|shorten|rewrite|change|improve|repeat|correct|check|send|finish|make|tell me (more )?about|what about|how about|and|why)\b/i;

/**
 * A request that can only refer to something earlier ("Fix it", "Explain this", "Translate that") in a chat with no
 * earlier messages: the app asks what is meant instead of letting the model guess. Deliberately narrow (short
 * messages, an action word and a referring word, no history) so ordinary questions are never held back.
 * @returns the clarifying question, or null when the message is clear enough
 */
export function ambiguity(text: string, hasHistory: boolean): string | null {
  const t = text.trim();
  if (hasHistory || !t || t.split(/\s+/).length > 6 || /["“'`]/.test(t)) return null;
  const ref = t.match(REFERS);
  if (!ref || !ACTION.test(t)) return null;
  const word = (ref[1] ?? ref[2]).toLowerCase();
  return `What does "${word}" refer to? This chat has no earlier message, so I'd only be guessing. Paste or describe it and I'll help.`;
}

const INDIC_TARGET = /\b(?:to|into|in)\s+(telugu|hindi|tamil|kannada|malayalam)\b/i;
/**
 * A caution shown under a translation into an Indian language (M13). Measured on the app's 1.5B model
 * (eval/results/translation-m13.md): translations into Telugu, Tamil, Kannada, Malayalam and Hindi score chrF 10-20
 * and are often wrong or repetitive, so the app says so instead of presenting them as reliable. Null otherwise.
 */
export function translationCaution(text: string, intent: string): string | null {
  const target = intent === 'translation' ? text.match(INDIC_TARGET)?.[1] : null;
  if (!target) return null;
  const name = target[0].toUpperCase() + target.slice(1).toLowerCase();
  return `⚠ This small on-device model translates into ${name} poorly (measured), and the result may be wrong. Please check it with someone who reads ${name}.`;
}
