/**
 * Finding the source text a question is about, without loading the project: file-name search over the stored
 * listing, a bounded line search over supported files, file:line references parsed from error messages and stack
 * traces, and the selection of a few excerpts (with real line numbers) that fit the model's small context.
 */
import { estimateTokens } from '../chatStore';
import { quoteSafe } from '../knowledge/knowledgePrompt';
import { LIMITS, PROJECT_FILES } from './files';
import { WorkspaceError } from './native';
import { baseName } from './paths';
import { entries, readFile, unreadableReason, type Entry, type Signal, type SourceFile, type Workspace } from './workspaceStore';

export type Hit = { path: string; line: number; text: string; term: string };
export type Range = { start: number; end: number }; // 1-based, inclusive
export type Excerpt = { path: string; language: string; ranges: (Range & { text: string })[]; reason: string; redactions: number };
export type ContextPack = { excerpts: Excerpt[]; skipped: { path: string; reason: string }[]; truncated: boolean; terms: string[]; filesRead: number };

// ---------------------------------------------------------------- names

/** Listed files whose path contains every word of the query (case-insensitive), file-name matches first. */
export function searchNames(list: Entry[], query: string, limit = 50): Entry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return list.filter(e => e.path && words.every(w => e.path.toLowerCase().includes(w)))
    .map(e => ({ e, score: words.filter(w => baseName(e.path).toLowerCase().includes(w)).length * 10 - e.path.split('/').length }))
    .sort((a, b) => b.score - a.score || a.e.path.localeCompare(b.e.path))
    .slice(0, limit).map(x => x.e);
}

// ---------------------------------------------------------------- contents

/** Readable files of a listing, project files first, then by path (the order bounded searches read them in). */
export function readable(list: Entry[]): Entry[] {
  return list.filter(e => !unreadableReason(e))
    .sort((a, b) => Number(PROJECT_FILES.test(baseName(b.path))) - Number(PROJECT_FILES.test(baseName(a.path))) || a.path.localeCompare(b.path));
}

/**
 * Lines containing `query` (or any of several queries; case-insensitive) in readable files, reading each file once and
 * at most LIMITS.maxSearchFiles files / LIMITS.maxSearchBytes bytes. Text is redacted before matching, so a search
 * can't be used to find secret values.
 */
export async function searchContent(ws: Workspace, query: string | string[], opts: { signal?: Signal; onProgress?: (read: number, total: number) => void; paths?: string[] } = {}):
  Promise<{ hits: Hit[]; filesRead: number; truncated: boolean; failed: number }> {
  const qs = [query].flat().map(q => q.trim()).filter(q => q.length >= 2);
  if (!qs.length) return { hits: [], filesRead: 0, truncated: false, failed: 0 };
  let files = readable(await entries(ws.id));
  if (opts.paths) files = files.filter(f => opts.paths!.includes(f.path));
  const hits: Hit[] = [];
  let bytes = 0, filesRead = 0, failed = 0, truncated = false;
  for (const f of files) {
    if (opts.signal?.cancelled) throw new WorkspaceError('cancelled', 'Search cancelled.');
    if (filesRead >= LIMITS.maxSearchFiles || bytes + Math.max(0, f.size) > LIMITS.maxSearchBytes || hits.length >= LIMITS.maxHits) { truncated = true; break; }
    opts.onProgress?.(filesRead, files.length);
    let src: SourceFile;
    try { src = await readFile(ws, f.path); } catch { failed++; continue; }
    filesRead++;
    bytes += src.bytes;
    src.text.split('\n').forEach((line, i) => {
      const lower = line.toLowerCase();
      const term = qs.find(q => lower.includes(q.toLowerCase()));
      if (term && hits.length < LIMITS.maxHits) hits.push({ path: src.path, line: i + 1, text: line.trim().slice(0, 200), term });
    });
  }
  return { hits, filesRead, truncated, failed };
}

// ---------------------------------------------------------------- error messages and stack traces

const EXT = '(?:tsx?|jsx?|mjs|cjs|py|java|kt|kts|cs|json|ya?ml|xml|html?|css|scss|gradle|go|rs|swift|c|cpp|h|dart|rb|php|vue)';
const TRACE_PATTERNS = [
  new RegExp(`File "([^"]+\\.${EXT})", line (\\d+)`, 'g'), // Python
  new RegExp(`([\\w@./\\\\-]+\\.${EXT}):(\\d+)(?::\\d+)?`, 'g'), // path:line(:col) — JS/TS/Go/Kotlin compiler/most tools
  new RegExp(`\\(([\\w$.-]+\\.${EXT}):(\\d+)\\)`, 'g'), // Java/Kotlin "(Foo.kt:42)"
  new RegExp(`([\\w@./\\\\-]+\\.${EXT})\\((\\d+),\\d+\\)`, 'g'), // C# / tsc "file.ts(12,5)"
];

/** file + line references in an error message or stack trace, as written (paths may be absolute or partial). */
export function traceRefs(text: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  for (const re of TRACE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const ref = { file: m[1].replace(/\\/g, '/'), line: Number(m[2]) };
      if (ref.line > 0 && !out.some(o => o.file === ref.file && o.line === ref.line)) out.push(ref);
    }
  }
  return out.slice(0, 12);
}

/** The listed file a trace reference means: the longest path suffix match (e.g. "/home/x/app/src/a.ts" -> "src/a.ts"). */
export function matchRef(list: Entry[], file: string): Entry | null {
  const parts = file.split('/').filter(Boolean);
  for (let k = parts.length; k >= 1; k--) {
    const tail = parts.slice(-k).join('/').toLowerCase();
    const found = list.filter(e => !e.dir && (e.path.toLowerCase() === tail || e.path.toLowerCase().endsWith(`/${tail}`)));
    if (found.length === 1) return found[0];
    if (found.length > 1 && k === parts.length) return found.sort((a, b) => a.path.length - b.path.length)[0];
  }
  return null;
}

const STOP = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'what', 'where', 'when', 'which', 'does', 'how', 'why', 'into',
  'file', 'files', 'code', 'function', 'method', 'class', 'error', 'explain', 'find', 'used', 'uses', 'use', 'show', 'tell', 'about',
  'project', 'are', 'there', 'can', 'not', 'cannot', 'undefined', 'null', 'line', 'please', 'fix', 'bug', 'make', 'add', 'all', 'have', 'has',
  'test', 'tests', 'should', 'would', 'could', 'read', 'reading', 'properties', 'property', 'type', 'value', 'between', 'interact', 'work', 'works']);

/** Words worth searching for: identifiers (fooBar, foo_bar, Foo.bar), quoted strings and file names, most specific first. */
export function searchTerms(text: string): string[] {
  const quoted = [...text.matchAll(/[`'"]([^`'"\n]{3,60})[`'"]/g)].map(m => m[1].trim());
  const words = [...text.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)].map(m => m[0])
    .flatMap(w => (w.includes('.') && !/\.\w{1,5}$/.test(w) ? [w, ...w.split('.')] : [w]))
    .filter(w => w.length >= 3 && !STOP.has(w.toLowerCase()));
  const score = (w: string) => (/[a-z][A-Z]|_|\./.test(w) ? 3 : /^[A-Z]/.test(w) ? 2 : 1) + (quoted.includes(w) ? 2 : 0);
  return [...new Set([...quoted, ...words])].sort((a, b) => score(b) - score(a)).slice(0, 8);
}

// ---------------------------------------------------------------- context selection

type Candidate = { entry: Entry; score: number; reason: string; best: number; lines: number[] };

/** Merge line windows around `lines` (±pad) into sorted, non-overlapping ranges inside 1..total. */
export function windows(lines: number[], pad: number, total: number): Range[] {
  const sorted = [...new Set(lines)].filter(l => l >= 1 && l <= total).sort((a, b) => a - b);
  const out: Range[] = [];
  for (const l of sorted) {
    const r = { start: Math.max(1, l - pad), end: Math.min(total, l + pad) };
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/**
 * Choose excerpts for a question within `budget` tokens: the user's selected files, files named in an error/stack trace
 * (around the reported lines), files whose names or contents match the question's terms (around the matching lines),
 * and for broad questions the project's descriptive files. Each file is read once and appears once; line numbers are
 * the file's real ones. Source text is redacted (files.ts) and fenced as data later (assistant.ts).
 */
export async function selectContext(ws: Workspace, question: string, opts: {
  selected?: string[]; earlier?: string[]; errorText?: string; budget?: number; signal?: Signal; onProgress?: (note: string) => void;
} = {}): Promise<ContextPack> {
  const budget = opts.budget ?? LIMITS.contextTokens;
  const list = await entries(ws.id);
  const files = list.filter(e => !e.dir);
  const all = `${question}\n${opts.errorText ?? ''}`;
  const terms = searchTerms(all);
  const skipped: ContextPack['skipped'] = [];
  const cands = new Map<string, Candidate>();
  const add = (e: Entry, score: number, reason: string, lines: number[] = []) => {
    const why = unreadableReason(e);
    if (why) { if (!skipped.some(s => s.path === e.path)) skipped.push({ path: e.path, reason: why }); return; }
    const c = cands.get(e.path) ?? { entry: e, score: 0, reason, best: 0, lines: [] };
    c.score += score;
    c.lines.push(...lines);
    if (score > c.best) { c.best = score; c.reason = reason; } // the strongest reason is shown
    cands.set(e.path, c);
  };
  for (const p of opts.selected ?? []) { const e = files.find(f => f.path === p); if (e) add(e, 100, 'selected by you'); }
  for (const ref of traceRefs(all)) { const e = matchRef(files, ref.file); if (e) add(e, 90, `named in the error (line ${ref.line})`, [ref.line]); }
  for (const t of terms) {
    for (const e of files.filter(f => baseName(f.path).toLowerCase().split('.')[0] === t.toLowerCase() || baseName(f.path).toLowerCase() === t.toLowerCase())) add(e, 60, 'its name matches the question');
  }
  for (const p of opts.earlier ?? []) { const e = files.find(f => f.path === p); if (e) add(e, 15, 'inspected earlier in this task'); }
  const broad = !terms.length || /architect|structure|overview|summar|dependenc|project|set ?up|build|config/i.test(question);
  if (broad) for (const e of files.filter(f => PROJECT_FILES.test(baseName(f.path))).slice(0, 6)) add(e, 30, 'describes the project');

  // One bounded content search for the most specific terms (each file read once).
  const texts = new Map<string, SourceFile>();
  let truncated = false;
  let filesRead = 0;
  if (terms.length) {
    opts.onProgress?.(`Searching for ${terms.slice(0, 3).map(t => `"${t}"`).join(', ')}…`);
    const found = await searchContent(ws, terms.slice(0, 3), { signal: opts.signal });
    filesRead = found.filesRead;
    truncated = found.truncated;
    const byFile = new Map<string, Hit[]>();
    found.hits.forEach(h => byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]));
    for (const [path, hs] of byFile) {
      const e = files.find(f => f.path === path);
      const distinct = [...new Set(hs.map(h => h.term))];
      if (e) add(e, 10 * distinct.length + Math.min(20, hs.length * 3), `contains ${distinct.map(t => `"${t}"`).join(', ')}`, hs.map(h => h.line));
    }
  }

  // Fill the budget, best candidates first; every excerpt is real text with real line numbers.
  const excerpts: Excerpt[] = [];
  let used = 0;
  for (const c of [...cands.values()].sort((a, b) => b.score - a.score).slice(0, 8)) {
    if (opts.signal?.cancelled) throw new WorkspaceError('cancelled', 'Cancelled.');
    if (used >= budget - 40) { truncated = true; break; }
    let src = texts.get(c.entry.path);
    if (!src) {
      try { src = await readFile(ws, c.entry.path); } catch (e: any) { skipped.push({ path: c.entry.path, reason: e?.message ?? 'could not be read' }); continue; }
      texts.set(c.entry.path, src);
    }
    const lines = src.text.split('\n');
    // A short file the question is clearly about is given whole; otherwise windows around the relevant lines.
    const whole = c.score >= 50 && lines.length <= LIMITS.maxExcerptLines;
    const ranges = whole ? [{ start: 1, end: lines.length }]
      : c.lines.length ? windows(c.lines, 6, lines.length) : [{ start: 1, end: Math.min(lines.length, 40) }];
    const kept: Excerpt['ranges'] = [];
    for (const r of ranges) {
      const end = Math.min(r.end, r.start + LIMITS.maxExcerptLines - 1);
      // Take lines while they fit the remaining budget (12 tokens for the excerpt's header).
      let take = r.start - 1;
      let cost = 12;
      for (let l = r.start; l <= end; l++) {
        const lineCost = estimateTokens(numbered(lines, l, l)) + 1;
        if (used + cost + lineCost > budget) break;
        cost += lineCost;
        take = l;
      }
      if (take < r.start) { truncated = true; continue; }
      used += cost;
      kept.push({ start: r.start, end: take, text: numbered(lines, r.start, take) });
      if (take < r.end) truncated = true;
    }
    if (kept.length) excerpts.push({ path: src.path, language: src.language, ranges: kept, reason: c.reason, redactions: src.redactions });
  }
  return { excerpts, skipped: skipped.slice(0, 20), truncated, terms, filesRead: Math.max(filesRead, texts.size) };
}

/** Lines start..end with their real numbers ("12| code"), made safe to put between prompt markers. */
export function numbered(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).map((l, i) => `${start + i}| ${quoteSafe(l.length > 300 ? `${l.slice(0, 300)}…` : l)}`).join('\n');
}
