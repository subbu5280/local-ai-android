/**
 * Image requests in chat: "/image a fox in snow", "draw a fox in snow", "generate an image of a fox in snow". These are
 * explicit commands, so a pattern is enough here (unlike open questions, which go through needClassifier).
 * Returns the picture description, or null for ordinary messages ("how do I draw a graph in Excel?" is not one).
 */
const COMMAND = /^\s*\/(?:image|img|draw)\s+(.+)$/is;
const ASK = /^\s*(?:please\s+|can you\s+|could you\s+)?(?:draw|paint|sketch|generate|create|make)\s+(?:me\s+)?(?:an?\s+|the\s+)?(?:image|picture|photo|drawing|painting|illustration|art(?:work)?)\s+of\s+(.+)$/is;
const DRAW = /^\s*(?:please\s+)?(?:draw|paint|sketch)\s+(?:me\s+)?(.+)$/is;
const NOT_ART = /\b(graph|chart|table|diagram|flowchart|conclusion|line|circle|boundary|map in excel|uml)\b|\b(how|why|what|when)\b/i;

export function imageRequest(text: string): string | null {
  const t = text.trim();
  const m = t.match(COMMAND) ?? t.match(ASK) ?? (NOT_ART.test(t) ? null : t.match(DRAW));
  const prompt = m?.[1].trim().replace(/[.!?]+$/, '');
  return prompt && prompt.length >= 3 ? prompt.slice(0, 400) : null;
}
