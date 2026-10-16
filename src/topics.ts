/**
 * Shared topic vocabulary for the phone's memory rules (memoryCommands.ts) and quiet learning (learning.ts):
 * which preference a value is about, and the technology/software words both recognize. No state, no SQL.
 */
export const HUMAN_LANGS = ['english', 'telugu', 'hindi', 'kannada', 'tamil', 'malayalam', 'marathi', 'bengali', 'urdu', 'gujarati'];
export const PROGRAMMING = /(?<![\w#+])(?:python|java(?!script)|kotlin|javascript|\bjs\b|typescript|c#|csharp|c\+\+|swift)(?![\w#+])/i;
export const TECH = /(?<![\w#+])(?:unity\s?3d|unity|unreal|godot|react native|react|flutter|android|kafka|sql|python|java|kotlin|javascript|typescript|swift|c#|c\+\+)(?![\w#+])/i;
export const RESPONSE_WORDS = /\b(answers?|responses?|repl(?:y|ies)|explanations?|explain\w*|tone|format\w*|bullets?|details?|detailed|brief|short|concise|simple|step[- ]by[- ]step|examples?)\b/i;
export const BUDGET_WORDS = /\b(budget|cheap|affordable|low[- ]cost|economical|value for money|inexpensive)\b/i;
export const TRAVEL_WORDS = /\b(travel|trips?|hotels?|flights?|trains?|stays?|tours?|holidays?|vacations?)\b/i;
export const SOFTWARE_WORDS = /\b(software|open[- ]?source|free|tools?|apps?|applications?|editors?|ide|frameworks?|librar(?:y|ies)|stack|linux|windows|mac ?os|cloud|database)\b/i;
// Labels the user sees, and can ask for ("what is my preferred language?").
export const LABEL: Record<string, string> = { preferred_language: 'preferred language', software_preference: 'software preference',
  response_preference: 'response preference', programming_language_preference: 'preferred programming language',
  budget_preference: 'budget preference', travel_preference: 'travel preference' };

/** Which preference "I prefer <value>" is about; null when it can't be told (then nothing is guessed). */
export function preferenceKey(value: string): string | null {
  const low = value.toLowerCase();
  if (HUMAN_LANGS.some(l => new RegExp(`\\b${l}\\b`).test(low))) return 'preferred_language';
  if (RESPONSE_WORDS.test(value)) return 'response_preference';
  if (PROGRAMMING.test(value)) return 'programming_language_preference';
  if (TECH.test(value) || SOFTWARE_WORDS.test(value)) return 'software_preference';
  if (BUDGET_WORDS.test(value)) return 'budget_preference';
  if (TRAVEL_WORDS.test(value)) return 'travel_preference';
  return null;
}
