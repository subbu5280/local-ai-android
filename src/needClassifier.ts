/**
 * What a question needs in order to be answered truthfully, decided by the on-device model when the word rules
 * (deviceInfo.deviceAsk, liveData.liveSignal) don't recognise it. So "Where am I right now?", "Is it raining
 * outside?" or "Any big news today?" reach the phone's clock, location or a live service however they are worded.
 *
 * The model only chooses a label from a fixed list (enforced by a JSON schema); it never writes the answer. The app
 * then gets the real answer from the clock, the location (asking permission first) or a live service. If the model is
 * not loaded or anything fails, the answer is "none" and the question goes to the model as before.
 */
import * as local from './localModel';

export const NEEDS = ['none', 'time', 'date', 'location', 'weather', 'news', 'price'] as const;
export type Need = (typeof NEEDS)[number];

// Measured with eval/needs.eval.ts on the app's model (eval/results/needs-*.md): this plain prompt found every live
// question (15/15) but also sent 4 of 9 general questions live ("capital of France" -> location). Longer prompts with
// examples (v2: 18/24), descriptive labels (v3: 13/24), a yes/no confirmation (v4: 10/24) and nearest-example matching
// with e5 (17/24) all did worse, so a guessed route offers "Ask the model instead" in the app rather than more rules.
export const SYSTEM = "Classify what the question needs. time: the current time. date: today's date or weekday. location: where " +
  'the user is now. weather: current or forecast weather. news: recent events. price: a current price. none: anything ' +
  'answerable from general knowledge (explanations, how-to, coding, maths, history, stories).';
export const SCHEMA = { type: 'object', properties: { need: { type: 'string', enum: NEEDS } }, required: ['need'], additionalProperties: false };

/** A short question worth classifying (long texts and commands are ordinary chat). */
export function worthClassifying(text: string): boolean {
  const t = text.trim();
  const words = t.split(/\s+/).length;
  return words >= 2 && words <= 20 && !/```|\n/.test(t)
    && (/\?\s*$/.test(t) || /^(what|where|when|which|who|how|is|are|will|does|do|can|any|tell me|show me)\b/i.test(t) || /[ऀ-ൿ]/.test(t));
}

export async function classifyNeed(text: string): Promise<Need> {
  if (!local.isLoaded()) return 'none';
  try {
    const need = JSON.parse(await local.completeJson(SYSTEM, text, SCHEMA, 16))?.need;
    return (NEEDS as readonly string[]).includes(need) ? need : 'none';
  } catch {
    return 'none';
  }
}
