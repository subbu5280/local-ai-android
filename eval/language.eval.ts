/**
 * Language evaluation: does detect() pick the language the answer should be in? Deterministic (no model).
 * Run: npm run eval -- language   (EVAL_LABEL=name to label the report)
 */
import dataset from './datasets/language-v1.json';
import { detect, type LangCode } from '../src/core/language';
import { label, table, writeReport } from './report';

test('language evaluation', () => {
  const rows = dataset.cases.map(c => {
    const got = detect(c.input, c.previous as LangCode | null);
    return { id: c.id, input: c.input, previous: c.previous, expect: c.expect, got: got.code, source: got.source, hard: !!(c as any).hard, ok: got.code === c.expect };
  });
  const acc = (xs: typeof rows) => (xs.length ? `${xs.filter(r => r.ok).length}/${xs.length}` : '-');
  const langs = ['en', 'te', 'hi', 'ta', 'kn', 'ml'];
  const md = [
    `# Language evaluation (${label()}, dataset v${dataset.version})`, '',
    `Overall: ${acc(rows)} · hard cases: ${acc(rows.filter(r => r.hard))}`, '',
    table(['expected language', 'correct'], langs.map(l => [l, acc(rows.filter(r => r.expect === l))])), '',
    '## Failures', '',
    rows.some(r => !r.ok) ? table(['id', 'input', 'previous', 'expected', 'got (source)'],
      rows.filter(r => !r.ok).map(r => [r.id, r.input, r.previous ?? '-', r.expect, `${r.got} (${r.source})`])) : 'None.',
  ].join('\n');
  writeReport('language', { label: label(), version: dataset.version, rows }, md);
});
