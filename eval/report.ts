/**
 * Writing evaluation reports to eval/results/<name>-<label>.{json,md}. The label comes from EVAL_LABEL (e.g.
 * "baseline-m4" or "m5"), default "current", so two runs can be compared side by side.
 */
const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);

export const label = (): string => (globalThis as any).process.env.EVAL_LABEL || 'current';

/** Save a report as JSON (full data) and Markdown (the human-readable summary), and print the Markdown. */
export function writeReport(name: string, data: unknown, markdown: string): void {
  const fs = node('fs');
  const path = node('path');
  const dir = path.join((globalThis as any).process.cwd(), 'eval', 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}-${label()}.json`), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(dir, `${name}-${label()}.md`), markdown);
  // eslint-disable-next-line no-console
  console.info(markdown);
}

/** A Markdown table from rows of cells. */
export function table(head: string[], rows: (string | number)[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}
