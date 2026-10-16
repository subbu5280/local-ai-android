/**
 * Splitting a document into passages (chunks) for the index and for the model's context.
 *
 * Sizes are in estimated model tokens (chatStore.estimateTokens: ~4 Latin characters or ~1 Indian-script character
 * per token), so a Telugu passage is as safe for the 2048-token context as an English one. Passages follow
 * paragraph, then sentence boundaries; a little text from the end of one passage is repeated at the start of the next
 * (overlap), so a fact split across a boundary is still found whole. Passages never cross PDF pages, so every passage
 * has an exact page reference.
 */
import { estimateTokens } from '../chatStore';

export const CHUNK_TOKENS = 220; // a few of these fit the model's context next to the question and the answer
export const OVERLAP_TOKENS = 40;
export const MAX_CHUNKS = 4000; // per document (about 600 pages of text)

export type Segment = { text: string; page: number | null }; // page: 1-based PDF page, null for other formats
export type Chunk = { ordinal: number; page: number | null; text: string; tokens: number };

/** Sentences of a paragraph (end punctuation kept). No lookbehind regex: not every JS engine version supports it. */
const sentences = (p: string) => p.replace(/([.!?।॥])\s+/g, '$1\u0000').split('\u0000');

/** Pieces of `text` no bigger than `max` tokens: paragraphs, else sentences, else hard cuts by characters. */
function pieces(text: string, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (estimateTokens(p) <= max) { out.push(p); continue; }
    for (const sentence of sentences(p)) {
      let s = sentence.trim();
      while (s && estimateTokens(s) > max) {
        // A sentence longer than a whole passage: cut at the last space within the budget (or hard, if none).
        let cut = Math.max(1, Math.floor(s.length * (max / estimateTokens(s))));
        const space = s.lastIndexOf(' ', cut);
        if (space > cut / 2) cut = space;
        out.push(s.slice(0, cut).trim());
        s = s.slice(cut).trim();
      }
      if (s) out.push(s);
    }
  }
  return out;
}

/** The end of `text` worth about `tokens` tokens (same estimate as estimateTokens), starting at a word boundary. */
function tail(text: string, tokens: number): string {
  if (tokens <= 0) return '';
  // One pass from the end: an ASCII character costs 1/4 token, any other character 1 (estimateTokens' rule).
  let start = text.length;
  let cost = 0;
  while (start > 0) {
    const next = cost + (text.charCodeAt(start - 1) < 128 ? 0.25 : 1);
    if (next > tokens) break;
    cost = next;
    start--;
  }
  const space = text.indexOf(' ', start);
  return (space >= 0 && space < text.length - 1 ? text.slice(space + 1) : text.slice(start)).trim();
}

/**
 * Passages for a document.
 * @param segments the document text, one segment per PDF page (or a single segment for other formats)
 * @returns passages in reading order; ordinal is the passage number within the document (0-based)
 * @throws Error when the document would need more than MAX_CHUNKS passages
 */
export function chunkDocument(segments: Segment[], maxTokens = CHUNK_TOKENS, overlap = OVERLAP_TOKENS): Chunk[] {
  const chunks: Chunk[] = [];
  for (const seg of segments) {
    let current = '';
    const emit = () => {
      const text = current.trim();
      if (!text) return;
      if (chunks.length >= MAX_CHUNKS) throw new Error(`too many passages (more than ${MAX_CHUNKS})`);
      chunks.push({ ordinal: chunks.length, page: seg.page, text, tokens: estimateTokens(text) });
    };
    for (const piece of pieces(seg.text, maxTokens - overlap)) {
      const joined = current ? `${current}\n\n${piece}` : piece;
      if (current && estimateTokens(joined) > maxTokens) {
        emit();
        const carry = tail(current, overlap);
        // The overlap is dropped when it and the next piece don't fit together (rounding can add a token).
        current = carry && estimateTokens(`${carry}\n\n${piece}`) <= maxTokens ? `${carry}\n\n${piece}` : piece;
      } else {
        current = joined;
      }
    }
    emit();
  }
  return chunks;
}
