/**
 * Phase 15.5: learning from normal conversation, and using what was learned only when it is relevant.
 *
 * Three kinds of information, strongest last:
 *   1. conversation context: the recent turns of this chat (chatStore.recentContext, Phase 15.3), temporary;
 *   2. learned knowledge (this file): useful facts noticed in normal chat, without "Remember …";
 *   3. explicit memory: "Remember my name is Nihal" (memoryCommands.ts, Phase 15.4), the strongest.
 *
 * Learning is deterministic and deliberately narrow (no model, works offline):
 * - only first-person, present, affirmative statements of a few useful kinds: name, occupation, preferences, what the
 *   user is learning, tools they use, their current project, a plan (trips expire). "My friend Nihal is learning
 *   Kafka" or "Puneeth prefers Python" teach nothing about the user; "I'm hungry" or "I'm going to the shop" are
 *   temporary and never stored; questions, negations and hypotheticals are skipped;
 * - credential-like text is never learned (the same chatStore validation as explicit memory);
 * - it is quiet: nothing is announced in the chat; "What do you remember about me?" shows it and "Forget …" removes it.
 *
 * Retrieval is deterministic too: an item is used only if the question is about its subject (shared words, or a
 * trigger such as "learn next" for what the user is learning, "book" for a trip). At most MAX_ITEMS items, within
 * KNOWLEDGE_TOKENS, explicit memory first. Unrelated questions ("What is the capital of France?") get nothing.
 */
import * as store from './chatStore';
import type { Learned, LearnedKind, Memory } from './chatStore';
import { preferenceKey, SOFTWARE_WORDS, TECH } from './topics';

export const MAX_ITEMS = 4;
export const KNOWLEDGE_TOKENS = 150; // inside the Phase 15.3 prompt budget (it is counted against it)
export const PLAN_DAYS = 120; // a planned trip stops being relevant after this
const DAY = 24 * 60 * 60 * 1000;

type Fact = { kind: LearnedKind; key: string; value: string; confidence: number; lifetime: store.Lifetime };

const TOOLS = /\b(vs ?code|visual studio|intellij|android studio|xcode|git|github|gitlab|docker|kubernetes|linux|ubuntu|windows|mac ?os|figma|jira|notion|excel|postgres(?:ql)?|mysql|mongodb|redis|aws|azure|gcp|firebase|node(?:\.js)?|npm|ollama|chatgpt|claude)\b/i;
const PROJECT_NOUN = /\b(project|app|application|game|website|site|tool|bot|assistant|system|platform|library|api|startup|product)\b/i;
const OCCUPATION = /\b(developer|engineer|designer|student|teacher|manager|analyst|architect|scientist|consultant|tester|founder|freelancer|doctor|nurse|lawyer|accountant|researcher)\b/i;
const SKIP = /\?\s*$|^(?:what|why|how|when|where|who|which|should|can|could|would|do|does|did|is|are|am|will|shall)\b|\b(?:not|never|don'?t|do not|no longer|didn'?t|won'?t|can'?t|cannot)\b|\b(?:if|maybe|might|perhaps|probably|wish|thinking (?:about|of)|wondering)\b/i;
const FILLER = /^(?:actually|so|also|btw|by the way|well|ok(?:ay)?|hi|hey|hello|now|currently|these days|nowadays|right now|basically)[,\s]+/i;
const PURPOSE = /\s+(?:for|because|since|so that|so i|to get|to become|in order|as part of|at work|these days|nowadays|right now|currently)\b[\s\S]*$/i;
const NAME = /^[A-Za-z][A-Za-z'-]{1,30}(?: [A-Za-z][A-Za-z'-]{1,30}){0,2}$/;

const cleanValue = (v: string) => v.trim().replace(/^(?:a|an|the|my)\s+/i, '').replace(/[\s.,!;:]+$/, '').trim();

// "I'm Subbu" / "This is Subbu" are also how people say their name, but "I'm tired" / "This is great" aren't:
// only a capitalized word that isn't a common word or a technology counts.
const NOT_A_NAME = /^(?:fine|good|great|ok|okay|sure|sorry|ready|here|back|home|busy|tired|happy|sad|new|done|free|hungry|sick|well|glad|interested|from|in|at|on|not|also|just|really|very|so|the|a|an|this|that|it|going|trying|looking|working|learning|planning)$/i;
function introduction(clause: string): RegExpMatchArray | null {
  const m = clause.match(/^(?:[Ii]'?m|[Ii] am|[Tt]his is) ([A-Z][a-z'-]+(?: [A-Z][a-z'-]+)?)[\s.!]*$/);
  return m && !NOT_A_NAME.test(m[1].split(' ')[0]) && !TECH.test(m[1]) ? m : null;
}

/** The useful, first-person facts stated in one clause (usually zero). */
function factsIn(clause: string): Fact[] {
  let c = clause.trim();
  for (let i = 0; i < 3 && FILLER.test(c); i++) c = c.replace(FILLER, '');
  if (!c || SKIP.test(c) || store.looksLikeCredential(c)) return [];
  let m = c.match(/^(?:my name(?: is|'s)?|call me|you can call me|myself) ([\s\S]+)$/i) ?? introduction(c);
  if (m) {
    const name = cleanValue(m[1].replace(/\s+(?:from|and|here|working|living|studying)\b[\s\S]*$/i, ''));
    return NAME.test(name) ? [{ kind: 'personal', key: 'name', value: name, confidence: 0.9, lifetime: 'lasting' }] : [];
  }
  m = c.match(/^(?:i'?m|i am|i've been|i have been|i started|i'?m currently|i am currently) (?:learning|studying|practi[cs]ing|preparing for|taking a course (?:on|in)) ([\s\S]+)$/i);
  if (m) {
    const topic = cleanValue(m[1].replace(PURPOSE, ''));
    return topic && topic.split(' ').length <= 6 ? [{ kind: 'learning', key: `learning ${topic}`, value: topic, confidence: 0.8, lifetime: 'lasting' }] : [];
  }
  m = c.match(/^(?:i (?:prefer|always prefer|usually prefer|mostly prefer|like to use|love using)|(?:i'?m|i am) (?:moving|switching|migrating|shifting) (?:from [\s\S]+? )?to) ([\s\S]+)$/i);
  if (m) {
    const value = cleanValue(m[1].replace(PURPOSE, ''));
    const key = preferenceKey(value);
    return key ? [{ kind: 'preference', key, value, confidence: 0.75, lifetime: 'lasting' }] : [];
  }
  m = c.match(/^i (?:use|mostly use|work with|code in|program in|develop with|work in) ([\s\S]+)$/i);
  if (m) {
    const tool = cleanValue(m[1].replace(PURPOSE, ''));
    // "I use the bus to go to work" is not a tool: only recognized software/technology
    return tool && (TECH.test(tool) || TOOLS.test(tool) || SOFTWARE_WORDS.test(tool)) && tool.split(' ').length <= 5
      ? [{ kind: 'tool', key: `uses ${tool}`, value: tool, confidence: 0.75, lifetime: 'lasting' }] : [];
  }
  m = c.match(/^(?:i (?:work as|am working as)|i'?m working as|(?:i'?m|i am)) (?:a |an )?([\s\S]+)$/i);
  if (m && OCCUPATION.test(m[1]) && m[1].split(' ').length <= 5 && !/\b(?:learning|going|planning|tired|hungry)\b/i.test(m[1])) {
    return [{ kind: 'personal', key: 'occupation', value: cleanValue(m[1].replace(PURPOSE, '')), confidence: 0.75, lifetime: 'lasting' }];
  }
  m = c.match(/^(?:(?:i'?m|i am|we'?re|we are) (?:working on|building|developing|making|creating)|my (?:current )?project is) ([\s\S]+)$/i);
  if (m) {
    const project = cleanValue(m[1].replace(PURPOSE, ''));
    return project && (PROJECT_NOUN.test(project) || TECH.test(project)) && project.split(' ').length <= 8
      ? [{ kind: 'project', key: 'current', value: project, confidence: 0.75, lifetime: 'lasting' }] : [];
  }
  m = c.match(/^(?:i'?m|i am|we'?re|we are) planning (?:a |an |my |our |to (?:visit|go to|travel to) )?([\s\S]+)$/i);
  if (m) {
    const plan = cleanValue(m[1]);
    const trip = /\b(trip|tour|travel|visit|vacation|holiday)\b/i.test(c);
    return plan && plan.split(' ').length <= 12 ? [{ kind: 'plan', key: trip ? 'trip' : 'current', value: plan, confidence: 0.7, lifetime: 'plan' }] : [];
  }
  m = c.match(/^(?:i'?m|i am|we'?re|we are) (?:going|travelling|traveling|flying|heading) to ([A-Z][\s\S]+)$/);
  if (m) {
    const plan = cleanValue(m[1]);
    return plan.split(' ').length <= 10 ? [{ kind: 'plan', key: 'trip', value: `trip to ${plan}`, confidence: 0.7, lifetime: 'plan' }] : [];
  }
  return [];
}

/** All facts in a message: split into sentences, and "… and I'm …" clauses. */
export function extractFacts(message: string): Fact[] {
  const t = message.trim();
  if (!t || t.length > 600) return []; // long pasted text is content, not statements about the user
  const clauses = t.split(/(?<=[.!;])\s+|\n+/).flatMap(s => s.split(/,?\s+(?:and|but)\s+(?=(?:i|i'm|i am|i've|my|we're|we are)\b)/i));
  const out: Fact[] = [];
  for (const c of clauses) {
    for (const f of factsIn(c)) if (!out.some(o => o.kind === f.kind && o.key === f.key)) out.push(f);
  }
  return out;
}

/** Learn quietly from one normal user message. Never throws (a failed learn must not disturb the chat). */
export async function learnFrom(message: string, conversationId: string | null, sourceMessageId: string | null,
  now = Date.now()): Promise<Learned[]> {
  const saved: Learned[] = [];
  for (const f of extractFacts(message)) {
    try {
      saved.push(await store.learnFact(f.kind, f.key, f.value, { conversationId, sourceMessageId, confidence: f.confidence,
        lifetime: f.lifetime, expiresAt: f.lifetime === 'plan' ? now + PLAN_DAYS * DAY : null, now }));
    } catch {} // invalid or credential-like: simply not learned
  }
  return saved;
}

// ---------------------------------------------------------------- relevance

const STOP = new Set(`the and for with that this what which how should could would can you your me my mine about from into
then than have has had will just some any more most very really also next first best good like want need tell show give help
make does did are was were been being its it's i'm im is am an a to of in on at by or if so do be we our us they them it`.split(/\s+/));
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9#+]{3,}/g) ?? []).filter(w => !STOP.has(w))
  .map(w => w.replace(/(?:ing|ed|es|s)$/, '')));

const TRIGGERS: Record<string, RegExp> = {
  learning: /\b(learn|learning|study|studying|practi[cs]e|course|roadmap|career|skills?|next step|interview|certification|prepare|preparing|beginner|advanced)\b/i,
  plan: /\b(book|booking|trip|travel|hotels?|trains?|flights?|visit|itinerary|pack|packing|tickets?|stay|tour|darshan|journey)\b/i,
  tool: /\b(code|coding|editor|ide|setup|install|tools?|debug|terminal|extension|plugin|shortcut)\b/i,
  project: /\b(project|app|game|build|building|feature|bug|implement|architecture|deploy|my work|multiplayer)\b/i,
  occupation: /\b(career|job|work|resume|cv|interview|role|salary|promotion|office)\b/i,
  name: /\b(my name|who am i|call me|what should you call me|about me|introduce me)\b/i,
};
const SUGGEST = /\b(suggest|recommend|recommendation|which (?:one|option|tool|app|language|editor|framework)|what should i (?:use|choose|pick|buy|get)|best (?:option|choice|way)|choose|pick)\b/i;
const TECH_TALK = /\b(software|tools?|apps?|editor|ide|framework|library|code|coding|program|language|stack|os|laptop)\b/i;
const MONEY_TALK = /\b(trip|travel|hotels?|book|buy|price|cost|cheap|budget|stay|food|restaurant|gift|plan)\b/i;

type Item = { text: string; score: number; explicit: boolean; recency: number; dedupe: string; tokens: number };

// Seen on the Galaxy M35: the 3B model read "learning Kafka" as Franz Kafka's novels. A value that is a known software
// technology is named as one, so the model picks the right meaning.
const asTech = (v: string) => (TECH.test(v) ? `${v} (a software technology)` : v);

function learnedLine(l: Learned): string {
  if (l.kind === 'personal') return l.key === 'name' ? `The user's name is ${l.value}.` : `The user's ${l.key} is ${l.value}.`;
  if (l.kind === 'preference') return `The user prefers ${l.value}.`;
  if (l.kind === 'learning') return `The user is learning ${asTech(l.value)}.`;
  if (l.kind === 'tool') return `The user uses ${asTech(l.value)}.`;
  if (l.kind === 'project') return `The user is working on ${l.value}.`;
  return `The user is planning ${l.value}.`;
}
function memoryLine(m: Memory): string {
  if (m.type === 'personal') return `The user's ${m.key} is ${m.value}.`;
  if (m.type === 'preference') return m.key.startsWith('uses ') ? `The user uses ${m.value}.` : `The user prefers ${m.value}.`;
  return m.key.startsWith('uses ') ? `This chat's project uses ${m.value}.` : `This chat's project: ${m.key} ${m.value}.`;
}

/** How relevant an item (its kind/key/value) is to the question: 0 = leave it out. */
function relevance(question: string, qWords: Set<string>, kind: string, key: string, value: string): number {
  let score = 0;
  for (const w of words(`${value} ${key.replace(/_/g, ' ')}`)) if (qWords.has(w)) score += 2;
  if (kind === 'learning' && TRIGGERS.learning.test(question)) score += 2;
  if (kind === 'plan' && TRIGGERS.plan.test(question)) score += 2;
  if (kind === 'tool' && TRIGGERS.tool.test(question)) score += 1;
  if (kind === 'project' && TRIGGERS.project.test(question)) score += 2;
  if (kind === 'personal' && key === 'name' && TRIGGERS.name.test(question)) score += 3;
  if (kind === 'personal' && key === 'occupation' && TRIGGERS.occupation.test(question)) score += 2;
  if (kind === 'preference') {
    if (key === 'response_preference') score += 1; // how to answer applies to any answer
    const domain = key === 'budget_preference' || key === 'travel_preference' ? MONEY_TALK
      : key === 'preferred_language' ? null : TECH_TALK;
    if (SUGGEST.test(question) && (!domain || domain.test(question) || !(TECH_TALK.test(question) || MONEY_TALK.test(question)))) score += 2;
    else if (domain && domain.test(question) && score > 0) score += 1;
  }
  return score;
}

/**
 * The few facts relevant to `question` (explicit memories first, then learned), as one bounded block for the model,
 * or '' when nothing is relevant. `scopeId`: the open chat (its explicit project memories count; others' don't).
 * Facts learned from `excludeMessageId` (the question itself) are left out: they are already in the question.
 */
export async function relevantKnowledge(question: string, scopeId: string | null, excludeMessageId: string | null = null,
  now = Date.now()): Promise<string> {
  const q = question.trim();
  if (!q) return '';
  const qWords = words(q);
  const items: Item[] = [];
  const explicit = [...(await store.listMemories()).filter(m => m.type !== 'project'),
    ...(scopeId ? await store.listMemories({ type: 'project', scopeId }) : [])];
  for (const m of explicit) {
    const score = relevance(q, qWords, m.type === 'project' ? 'project' : m.type === 'personal' && m.key === 'name' ? 'personal' : m.type,
      m.key, m.value);
    const text = memoryLine(m);
    if (score > 0) items.push({ text, score, explicit: true, recency: m.updated_at, dedupe: `${m.type}:${m.key}`, tokens: store.estimateTokens(text) });
  }
  for (const l of await store.listLearned({ now })) {
    if (l.source_message_id && l.source_message_id === excludeMessageId) continue;
    const score = relevance(q, qWords, l.kind, l.key, l.value);
    const text = learnedLine(l);
    if (score > 0) items.push({ text, score, explicit: false, recency: l.updated_at, dedupe: `${l.kind}:${l.key}`, tokens: store.estimateTokens(text) });
  }
  // Explicit memory wins over a learned fact about the same thing.
  const explicitKeys = new Set(items.filter(i => i.explicit).map(i => i.dedupe));
  const ranked = items.filter(i => i.explicit || !explicitKeys.has(i.dedupe))
    .sort((a, b) => b.score - a.score || Number(b.explicit) - Number(a.explicit) || b.recency - a.recency);
  const chosen: string[] = [];
  let used = 0;
  for (const i of ranked) {
    if (chosen.length >= MAX_ITEMS || used + i.tokens > KNOWLEDGE_TOKENS) break;
    chosen.push(i.text);
    used += i.tokens;
  }
  if (!chosen.length) return '';
  return `What you know about the user (use it only where it helps answer this question; don't mention it otherwise):\n${chosen.map(c => `- ${c}`).join('\n')}`;
}

/** Second-person lines for "What do you remember about me?" (learned items, user control). */
export function learnedForUser(l: Learned): string {
  if (l.kind === 'personal') return l.key === 'name' ? `Your name is ${l.value}.` : `Your ${l.key} is ${l.value}.`;
  if (l.kind === 'preference') return `You prefer ${l.value}.`;
  if (l.kind === 'learning') return `You're learning ${l.value}.`;
  if (l.kind === 'tool') return `You use ${l.value}.`;
  if (l.kind === 'project') return `You're working on ${l.value}.`;
  return `You're planning ${l.value}.`;
}
