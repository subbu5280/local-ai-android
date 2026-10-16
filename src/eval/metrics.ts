/**
 * Evaluation metrics (pure functions). Used by the developer evaluation runs (eval/*.eval.ts) and unit-tested.
 *
 * Retrieval is judged at document level: a query is answered by a ranked list of document ids (best first, each
 * document once). relevant = [] means the corpus holds no answer and the system should report no evidence.
 */

export type RetrievalCase = { id: string; kind: string; relevant: string[] };
export type RetrievalRun = { caseId: string; ranked: string[]; evidence: boolean; duplicateInTop3?: boolean };

/** 1 if a relevant document is among the first k, else 0. */
export const hitAt = (ranked: string[], relevant: string[], k: number) => (ranked.slice(0, k).some(d => relevant.includes(d)) ? 1 : 0);

/** 1 / rank of the first relevant document within the first k (0 if none). */
export function reciprocalRank(ranked: string[], relevant: string[], k = 10): number {
  const i = ranked.slice(0, k).findIndex(d => relevant.includes(d));
  return i < 0 ? 0 : 1 / (i + 1);
}

export type RetrievalSummary = {
  queries: number; hit1: number; hit3: number; mrr: number;
  noEvidenceQueries: number; falseEvidence: number; missedEvidence: number; duplicateInTop3: number;
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Summary over a set of runs: ranking metrics over queries that have relevant documents; for no-evidence queries the
 * share where evidence was (wrongly) reported; for answerable queries the share where none was reported.
 */
export function summarize(cases: RetrievalCase[], runs: RetrievalRun[]): RetrievalSummary {
  const byId = new Map(runs.map(r => [r.caseId, r]));
  const answerable = cases.filter(c => c.relevant.length && byId.has(c.id));
  const none = cases.filter(c => !c.relevant.length && byId.has(c.id));
  return {
    queries: answerable.length,
    hit1: round(mean(answerable.map(c => hitAt(byId.get(c.id)!.ranked, c.relevant, 1)))),
    hit3: round(mean(answerable.map(c => hitAt(byId.get(c.id)!.ranked, c.relevant, 3)))),
    mrr: round(mean(answerable.map(c => reciprocalRank(byId.get(c.id)!.ranked, c.relevant)))),
    noEvidenceQueries: none.length,
    falseEvidence: round(mean(none.map(c => (byId.get(c.id)!.evidence ? 1 : 0)))),
    missedEvidence: round(mean(answerable.map(c => (byId.get(c.id)!.evidence ? 0 : 1)))),
    duplicateInTop3: round(mean(runs.filter(r => r.duplicateInTop3 !== undefined).map(r => (r.duplicateInTop3 ? 1 : 0)))),
  };
}

/** Summaries per query kind (exact, inflected, paraphrase, synonym, cross_language, mixed, no_evidence, duplicate). */
export function summarizeByKind(cases: RetrievalCase[], runs: RetrievalRun[]): Record<string, RetrievalSummary> {
  const kinds = [...new Set(cases.map(c => c.kind))];
  return Object.fromEntries(kinds.map(k => [k, summarize(cases.filter(c => c.kind === k), runs)]));
}

/** Share of `text`'s letters that are in a script (by code point ranges), ignoring spaces, digits and punctuation. */
export function scriptShare(text: string, ranges: [number, number][]): number {
  let total = 0;
  let inScript = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const letter = (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp >= 0x900;
    if (!letter || (cp >= 0x2000 && cp <= 0x2bff) || cp >= 0x1f000) continue; // punctuation blocks, emoji
    total++;
    if (ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) inScript++;
  }
  return total ? inScript / total : 0;
}
