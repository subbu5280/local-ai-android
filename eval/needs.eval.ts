/**
 * Need-classifier evaluation: the app's own classifier prompt and schema (src/needClassifier.ts) on the app's chat
 * model through llama-server, over phrasings the word rules don't catch. Run: scripts/eval-translation.ps1 starts the
 * same server; or set LOCALAI_CHAT_URL yourself. Reports accuracy per label and every miss.
 */
jest.mock('../src/localModel', () => ({})); // the eval calls llama-server directly, not the phone's model
import dataset from './datasets/needs-v1.json';
import { NEEDS, SCHEMA, SYSTEM } from '../src/needClassifier';
import { label, table, writeReport } from './report';

const URL = (globalThis as any).process.env.LOCALAI_CHAT_URL as string | undefined;

async function ask(system: string, q: string, schema: object): Promise<any> {
  const res = await fetch(`${URL}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: q }], temperature: 0, max_tokens: 16,
      response_format: { type: 'json_schema', json_schema: { strict: true, schema } } }),
  });
  try { return JSON.parse((await res.json()).choices[0].message.content); } catch { return {}; }
}

/** The same call as classifyNeed, against llama-server. */
async function classify(q: string): Promise<string> {
  const need = (await ask(SYSTEM, q, SCHEMA)).need;
  return NEEDS.includes(need) ? need : 'invalid';
}

(URL ? test : test.skip)('need classifier evaluation', async () => {
  const rows: { q: string; need: string; got: string }[] = [];
  for (const c of dataset.cases) rows.push({ ...c, got: await classify(c.q) });
  const acc = (xs: typeof rows) => `${xs.filter(r => r.got === r.need).length}/${xs.length}`;
  const md = [
    `# Need classifier (${label()}, dataset v${dataset.version})`, '',
    `Overall: ${acc(rows)}`, '',
    table(['label', 'correct'], NEEDS.map(n => [n, acc(rows.filter(r => r.need === n))])), '',
    '## Misses', '',
    table(['question', 'expected', 'got'], rows.filter(r => r.got !== r.need).map(r => [r.q, r.need, r.got])),
  ].join('\n');
  writeReport('needs', { label: label(), rows }, md);
}, 600_000);

