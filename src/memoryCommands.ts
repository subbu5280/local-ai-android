/**
 * Phase 15.4: explicit long-term memory commands, owned by the phone ("Remember my name is Nihal", "What is my
 * name?", "Forget my name"). The phone's SQLite (chatStore) is the only place memories are written or read; the
 * laptop is never asked whether something was saved, laptop on or off.
 *
 * Deterministic and conservative, English only (the same rules as the Phase 15.2 backend parser it replaces):
 * - only a message that is clearly a memory command is handled; everything else is normal chat ("My name is Nihal."
 *   or "I like TypeScript." never creates a memory: there is no "remember");
 * - a small set of supported forms; when the key or value can't be determined the user is asked, nothing is guessed;
 * - "project" memories belong to the phone conversation they were said in (the phone has no other project notion);
 * - chatStore.validateMemory is the single validation authority (credentials are refused there);
 * - nothing here logs, and replies never show ids, sources, confidence or schema.
 *
 * classify() only reads (it runs before the user message is stored, so a refused credential can be redacted);
 * execute() performs the write and only reports success after the SQLite write returned.
 */
import * as store from './chatStore';
import { LABEL, preferenceKey } from './topics';
export { LABEL } from './topics';
import type { Learned, Memory, MemoryType } from './chatStore';
import { learnedForUser } from './learning';

const LEAD = String.raw`^\s*(?:(?:ok(?:ay)?|hey|hi|so|and|also|now)[,\s]+)*(?:(?:please|pls|kindly)\s+)?(?:always\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?`;
const REMEMBER = new RegExp(`${LEAD}remember\\b(?!\\s+to\\b)(?:\\s+that\\b)?[\\s:,]*([\\s\\S]*?)[\\s.!?]*$`, 'i');
const FORGET = new RegExp(`${LEAD}(?:forget|don'?t remember|do not remember|stop remembering|no longer remember)\\b` +
  String.raw`(?:\s+(?:about|that)\b)?\s*([\s\S]*?)(?:\s+any\s*more)?[\s.!?]*$`, 'i');
const RECALL_ALL = /^\s*(?:please\s+)?(?:what (?:do|did|else do) you (?:remember|recall)(?: about me)?|what do you know about me|what have you (?:remembered|saved|stored)(?: about me)?|show(?: me)? (?:what you (?:remember|know)(?: about me)?|my (?:saved )?memories)|(?:list|show) (?:my )?(?:saved )?memories)[\s.!?]*$/i;
const RECALL_PREFS = /^\s*what are my (?:saved )?preferences[\s.!?]*$/i;
const RECALL_KEY = /^\s*(what(?:'s| is) my|do you (?:remember|know) my|tell me my) ([a-z][a-z ]{0,40}?)[\s.!?]*$/i;
// Polite forms ("Can you tell me my name?") are the same question; "Who am I?" asks for the name.
const POLITE = /^\s*(?:(?:can|could|would|will) you (?:please )?|please )/i;
const askedAs = (t: string) => (/^\s*who am i[\s.!?]*$/i.test(t) ? 'what is my name' : t.replace(POLITE, ''));
const RECALL_PROJECT = /^\s*(?:what (?:technolog(?:y|ies)|tech(?: stack)?|stack|frameworks?|tools) (?:does|do|is) (?:this|the|our|my) (?:project|app) (?:use|using|built with)|what does (?:this|the|our|my) (?:project|app) use|what do you (?:remember|know) about (?:this|the|our|my) (?:project|app))[\s.!?]*$/i;

const PRONOUN_ONLY = /^(?:this|that|it|these|those|them|that one|this one|something|the above)?$/i;
const BY_LABEL: Record<string, string> = Object.fromEntries(Object.entries(LABEL).map(([k, v]) => [v, k]));

export const SUPPORTED = 'I can save your name and other "my … is …" facts, preferences ("Remember I prefer free software"), ' +
  'tools you use ("Remember I use React Native") and facts about the project this chat is about ("Remember this project ' +
  'uses Kafka"). Could you say it that way?';
export const CREDENTIAL_REPLY = "I can't save passwords, PINs, OTPs, API keys, tokens or other credentials, so nothing was saved. " +
  'Please keep those in a password manager.';
export const REDACTED = '[a credential was typed here; it was not saved]';
const ASK_WHAT = 'What would you like me to remember?';

export type Command = {
  action: 'remember' | 'forget' | 'recall' | 'reply';
  type?: MemoryType; key?: string; value?: string; scopeId?: string;
  targets?: Memory[]; // memories a forget/recall refers to (or the existing one a remember updates)
  learned?: Learned[]; // Phase 15.5: learned facts a recall shows or a forget removes
  view?: 'all' | 'key' | 'preferences' | 'project'; askedKey?: string;
  reply?: string;
  credential?: boolean; // the message contained a refused credential: store it redacted
};

const clean = (v: string) => v.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim().replace(/[.!?,;]+$/, '').trim();
const reply = (text: string, credential = false): Command => ({ action: 'reply', reply: text, credential });


type Form = [RegExp, MemoryType, string | null];
const FORMS: Form[] = [ // key null = "my <key> is <value>"; 'uses' / 'prefers' / 'prefer' are resolved below
  [/^my name(?: is|'s) ([\s\S]+)$/i, 'personal', 'name'],
  [/^(?:i am|i'm) called ([\s\S]+)$/i, 'personal', 'name'],
  [/^call me ([\s\S]+)$/i, 'personal', 'name'],
  [/^my preferred language is ([\s\S]+)$/i, 'preference', 'preferred_language'],
  [/^my ([a-z][a-z ]{0,40}?) (?:is|are) ([\s\S]+)$/i, 'personal', null],
  [/^i (?:use|work with|code in|program in|develop with) ([\s\S]+)$/i, 'preference', 'uses'],
  [/^i (?:prefer|like|love|favou?r|want) ([\s\S]+)$/i, 'preference', 'prefer'],
  [/^(?:this|the|our|my) (?:project|app) (?:uses|is using|is built (?:with|on|using)|runs on) ([\s\S]+)$/i, 'project', 'uses'],
  [/^(?:this|the|our|my) (?:project|app)(?:'s| has an?) architecture (?:is )?([\s\S]+)$/i, 'project', 'architecture'],
  [/^(?:this|the|our|my) (?:project|app) (?:should|must|prefers?) ([\s\S]+)$/i, 'project', 'prefers'],
];

/** "my name is Nihal" -> remember(personal, name, Nihal). Unsupported or unclear -> a clarifying reply. */
export function parseFact(body: string, scopeId: string | null): Command {
  const b = clean(body);
  if (PRONOUN_ONLY.test(b)) return reply(ASK_WHAT);
  for (const [rx, type, key] of FORMS) {
    const m = b.match(rx);
    if (!m) continue;
    const value = clean(key === null ? m[2] : m[1]);
    if (PRONOUN_ONLY.test(value)) return reply(ASK_WHAT);
    if (/\b(?:and|also|,) (?:i|i'm|my|me|this project)\b/i.test(value)) {
      return reply('Please tell me one thing at a time, for example "Remember my name is Nihal", then "Remember I prefer free software".');
    }
    let k: string;
    if (key === null) k = m[1].trim().toLowerCase();
    else if (key === 'uses' || key === 'prefers') k = `${key} ${value}`;
    else if (key === 'prefer') {
      const p = preferenceKey(value);
      if (!p) return reply(`I'm not sure what kind of preference that is. ${SUPPORTED}`);
      k = p;
    } else k = key;
    if (type === 'project' && !scopeId) return reply("Which project is this about? Start or open the chat for that project first, so I didn't save it.");
    return { action: 'remember', type, key: k, value, scopeId: type === 'project' ? scopeId! : '' };
  }
  return reply(`I'm not sure what to remember from that. ${SUPPORTED}`);
}

/** How a memory is said back: "your name is Nihal", "you use React Native", "this project uses Kafka". */
export function phrase(m: Pick<Memory, 'type' | 'key' | 'value'>): string {
  if (m.type === 'project') {
    if (m.key.startsWith('uses ')) return `this project uses ${m.value}`;
    if (m.key.startsWith('prefers ')) return `this project should ${m.value}`;
    return `this project's ${m.key} is ${m.value}`;
  }
  if (m.type === 'preference') return m.key.startsWith('uses ') ? `you use ${m.value}` : `you prefer ${m.value}`;
  return `your ${m.key} is ${m.value}`;
}
const sentence = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}.`;

/** Memories visible in this chat: personal + preferences, and only this chat's project memories. */
async function visible(scopeId: string | null): Promise<Memory[]> {
  const own = (await store.listMemories()).filter(m => m.type !== 'project');
  return scopeId ? [...own, ...(await store.listMemories({ type: 'project', scopeId }))] : own;
}

async function activeKey(type: MemoryType, key: string, scopeId = ''): Promise<Memory[]> {
  const m = await store.findMemory(type, key, scopeId);
  return m && m.active ? [m] : [];
}

/** (memories a forget request points at, whether the request clearly names a memory). */
/** The "same thing" a memory or learned fact is about, so "Forget my name" removes both copies of the name. */
const groupOf = (kindOrType: string, key: string) => `${kindOrType}:${key}`;

/** Learned facts (not superseded or forgotten) that aren't already covered by an explicit memory. */
async function learnedBeyond(explicit: Memory[]): Promise<Learned[]> {
  const covered = new Set(explicit.map(m => groupOf(m.type, m.key)));
  return (await store.listLearned()).filter(l => !covered.has(groupOf(l.kind, l.key)));
}

const wordsOf = (v: string) => v.toLowerCase().split(/[^a-z0-9#+]+/).filter(Boolean);
/** "free software" finds "free/open-source software": the phrase, or every one of its words, in the saved value. */
function valueMatches(saved: string, wanted: string): boolean {
  const v = saved.toLowerCase();
  const want = wanted.toLowerCase();
  const w = wordsOf(want);
  return v.includes(want) || (w.length > 0 && w.every(x => wordsOf(v).includes(x)));
}

/** (memories, learned facts, whether the request clearly names something remembered) for a forget request. */
async function forgetTargets(body: string, scopeId: string | null): Promise<[Memory[], Learned[], boolean]> {
  const b = clean(body);
  const all = await visible(scopeId);
  const learned = await store.listLearned();
  let m = b.match(/^(?:my preference for|(?:that )?i (?:prefer|like|love)) ([\s\S]+)$/i);
  if (m) {
    const want = clean(m[1]);
    return [all.filter(x => x.type === 'preference' && valueMatches(x.value, want)),
      learned.filter(l => l.kind === 'preference' && valueMatches(l.value, want)), true];
  }
  m = b.match(/^(?:that )?i (?:use|work with|code in|program in|develop with) ([\s\S]+)$/i);
  if (m) {
    const key = store.normalizeMemoryKey(`uses ${clean(m[1])}`);
    return [await activeKey('preference', key), learned.filter(l => l.kind === 'tool' && l.key === key), true];
  }
  m = b.match(/^(?:that )?(?:this|the|our|my) (?:project|app) (?:uses|is using|is built with|runs on) ([\s\S]+)$/i);
  if (m) return [scopeId ? await activeKey('project', `uses ${clean(m[1])}`, scopeId) : [], [], true];
  m = b.match(/^(?:that )?i(?:'?m| am) (learning|studying|working on|building|planning) ([\s\S]+)$/i);
  if (m) {
    const kind = /learn|study/i.test(m[1]) ? 'learning' : /plan/i.test(m[1]) ? 'plan' : 'project';
    const want = clean(m[2]).replace(/^(?:a|an|the|my)\s+/i, '');
    return [[], learned.filter(l => l.kind === kind && valueMatches(l.value, want)), true];
  }
  m = b.match(/^(?:that )?my ([a-z][a-z ]{0,40}?)(?: (?:is|are) [\s\S]*)?$/i);
  if (m) {
    const asked = m[1].trim().toLowerCase();
    const k = BY_LABEL[asked] ?? asked;
    return [all.filter(x => x.key === k || LABEL[x.key] === k),
      learned.filter(l => l.key === k || (k === 'trip' && l.kind === 'plan')), true];
  }
  if (!b || PRONOUN_ONLY.test(b)) return [[], [], false]; // "Forget it." usually means "never mind": not a memory command
  const low = b.toLowerCase();
  const near = (v: string) => v.toLowerCase() === low || (low.length >= 4 && v.toLowerCase().includes(low));
  const hits = all.filter(x => near(x.value));
  const lHits = learned.filter(l => near(l.value));
  return [hits, lHits, hits.length + lHits.length > 0];
}

export const UNAVAILABLE_REPLY = "Saved memory isn't available on this phone right now (its database couldn't be opened), " +
  'so nothing was saved or looked up.';

/** Pattern-only check (no database): does `text` look like a memory command? Used when the phone database fails,
 *  so such a message gets an honest answer instead of reaching a model that might pretend it saved something. */
export function looksLikeMemoryCommand(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 500) return false;
  return REMEMBER.test(t) || RECALL_ALL.test(t) || RECALL_PREFS.test(t) || RECALL_PROJECT.test(t) ||
    /^\s*(what(?:'s| is) my name|do you (?:remember|know) my |tell me my )/i.test(askedAs(t)) ||
    (FORGET.test(t) && /\b(my|i|this project|that i)\b/i.test(t.replace(FORGET, '$1')));
}

/** classify() for the app: a database failure never lets a memory command through as normal chat. */
export async function classifySafely(text: string, scopeId: string | null): Promise<Command | null> {
  try {
    return await classify(text, scopeId);
  } catch {
    return looksLikeMemoryCommand(text) ? reply(UNAVAILABLE_REPLY, store.looksLikeCredential(text)) : null;
  }
}

/**
 * The memory command in `text`, or null when it isn't one (then it is normal chat). Read-only.
 * `scopeId`: the phone conversation this message is in (project memories belong to it).
 */
export async function classify(text: string, scopeId: string | null): Promise<Command | null> {
  const t = text.trim();
  if (!t || t.length > 500 || t.includes('\n\n')) return null; // a long message that mentions "remember" is normal chat
  if (RECALL_ALL.test(t)) {
    const targets = await visible(scopeId);
    return { action: 'recall', view: 'all', targets, learned: await learnedBeyond(targets) };
  }
  if (RECALL_PREFS.test(t)) {
    const targets = (await visible(scopeId)).filter(m => m.type === 'preference');
    return { action: 'recall', view: 'preferences', targets, learned: (await learnedBeyond(targets)).filter(l => l.kind === 'preference') };
  }
  if (RECALL_PROJECT.test(t)) {
    if (!scopeId) return reply("I'm not sure which project you mean: start or open the chat for that project first.");
    return { action: 'recall', view: 'project', targets: await store.listMemories({ type: 'project', scopeId }) };
  }
  let m = askedAs(t).match(RECALL_KEY);
  if (m) {
    const asked = m[2].trim().toLowerCase();
    const key = BY_LABEL[asked] ?? asked;
    const hits = (await visible(scopeId)).filter(x => x.type !== 'project' && x.key === key);
    const explicit = /^(do you|tell me)/i.test(m[1]);
    // Not saved explicitly? Something the user said in chat ("My name is Nihal.") still answers it.
    const learned = hits.length ? [] : (await store.listLearned()).filter(l => (l.kind === 'personal' || l.kind === 'preference') && l.key === key);
    if (hits.length || learned.length || explicit || key === 'name') return { action: 'recall', view: 'key', askedKey: asked, targets: hits, learned };
    return null; // "What is my IP address?": not something saved; normal chat answers it
  }
  m = t.match(REMEMBER);
  if (m) {
    const cmd = parseFact(m[1], scopeId);
    if (cmd.action === 'remember') {
      try {
        const v = store.validateMemory(cmd.type!, cmd.key, cmd.value, cmd.scopeId);
        cmd.key = v.key;
        cmd.value = v.value;
      } catch (e: any) {
        if (e instanceof store.CredentialRejected) return reply(CREDENTIAL_REPLY, true);
        return reply(`I couldn't save that (${e?.message ?? e}). Nothing was saved.`);
      }
      cmd.targets = await activeKey(cmd.type!, cmd.key!, cmd.scopeId); // a forgotten one counts as new again
    } else if (store.looksLikeCredential(m[1])) {
      return reply(CREDENTIAL_REPLY, true);
    }
    return cmd;
  }
  m = t.match(FORGET);
  if (m) {
    const [targets, learned, named] = await forgetTargets(m[1], scopeId);
    if (!named) return null; // "Forget the previous design, start again": a normal request
    // One thing (possibly saved explicitly AND noticed in chat, e.g. the name): forget every copy of it.
    const groups = new Set([...targets.map(x => groupOf(x.type, x.key)), ...learned.map(l => groupOf(l.kind, l.key))]);
    if (groups.size === 1) return { action: 'forget', targets, learned };
    if (!targets.length && !learned.length) {
      return reply('I couldn\'t find a saved memory matching that, so nothing was changed. Ask "What do you remember about me?" to see what is saved.');
    }
    const lines = [...targets.map(x => `- ${sentence(phrase(x))}`), ...learned.map(l => `- ${learnedForUser(l)}`)];
    return reply(`That matches more than one saved memory:\n${lines.join('\n')}\nWhich one should I forget?`);
  }
  return null;
}

/** Carry out `cmd` on the phone's SQLite and return the reply. Rejects if SQLite fails (then nothing is claimed). */
export async function execute(cmd: Command, sourceMessageId: string | null): Promise<string> {
  if (cmd.action === 'reply') return cmd.reply!;
  if (cmd.action === 'remember') {
    const before = cmd.targets?.[0];
    const saved = await store.createMemory(cmd.type!, cmd.key!, cmd.value!, { scopeId: cmd.scopeId, sourceMessageId });
    if (!before) return `Got it. I'll remember that ${phrase(saved)}.`;
    if (before.value === saved.value) return `I already remember that ${phrase(saved)}.`;
    const label = LABEL[saved.key] ?? saved.key;
    return `I've updated ${saved.type === 'project' ? "this project's" : 'your'} ${label} to ${saved.value}.`;
  }
  if (cmd.action === 'forget') {
    for (const m of cmd.targets ?? []) await store.deactivateMemory(m.id);
    for (const l of cmd.learned ?? []) await store.forgetLearned(l.id);
    return "Okay, I won't use that saved memory anymore.";
  }
  const targets = cmd.targets ?? [];
  const learned = cmd.learned ?? [];
  if (cmd.view === 'key') {
    if (targets.length) return sentence(phrase(targets[0]));
    if (learned.length) return learnedForUser(learned[0]);
    return cmd.askedKey === 'name'
      ? `I don't know your name yet. Tell me "My name is …" and I'll remember it.`
      : `I don't have your ${cmd.askedKey} saved yet.`;
  }
  const kindOrder = store.LEARNED_KINDS as readonly string[]; // personal, preference, learning, tool, project, plan
  const learnedShown = [...learned].sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.created_at - b.created_at || a.key.localeCompare(b.key));
  const noted = learned.length ? `From our chats, I've noted:\n${learnedShown.map(l => `- ${learnedForUser(l)}`).join('\n')}` : '';
  if (!targets.length && noted) return noted;
  if (!targets.length) {
    if (cmd.view === 'project') return "I don't have anything saved for this project yet.";
    if (cmd.view === 'preferences') return "I don't have any of your preferences saved yet.";
    return 'I don\'t have anything saved about you yet. You can say, for example, "Remember my name is …".';
  }
  const order: Record<MemoryType, number> = { personal: 0, preference: 1, project: 2 }; // then oldest first
  const shown = [...targets].sort((a, b) => order[a.type] - order[b.type] || a.created_at - b.created_at || a.key.localeCompare(b.key));
  const remembered = `I remember:\n${shown.map(m => `- ${sentence(phrase(m))}`).join('\n')}`;
  return noted ? `${remembered}\n\n${noted.replace("I've noted", "I've also noted")}` : remembered;
}
