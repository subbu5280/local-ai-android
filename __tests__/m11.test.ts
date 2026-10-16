/**
 * M11 below the UI: Word/Excel import (through the native readOffice contract), exact table analysis (incl. the agent
 * tool and its scope check), named collections (and their cleanup when documents go), contradictory-evidence flags,
 * and the opt-in re-rank. Real SQLite; a fake AiDocs returning what OfficeText.kt returns.
 */
import { NativeModules } from 'react-native';
import { sqliteDb } from '../testUtils/sqliteDb';

jest.mock('llama.rn', () => ({ releaseAllLlama: jest.fn(), initLlama: jest.fn() }));
jest.mock('@dr.pogodin/react-native-fs', () => require('../testUtils/fakeBackupEnv').fakeFs());

import * as chat from '../src/chatStore';
import * as docStore from '../src/knowledge/docStore';
import { importFiles } from '../src/knowledge/indexer';
import { search } from '../src/knowledge/retrieve';
import { analyze, analyzeDocument, toNumber, type Table } from '../src/knowledge/tables';
import * as collections from '../src/knowledge/collections';
import { conflictNote, findConflicts } from '../src/knowledge/knowledgePrompt';
import { getTool } from '../src/agents/tools';

const SHEETS = [{ name: 'Sales', rows: [['Region', 'Month', 'Amount'], ['South', 'Jan', '1,200'], ['North', 'Jan', '800'], ['South', 'Feb', '₹ 300'], ['North', 'Feb', 'n/a']] },
  { name: 'Notes', rows: [['Topic'], ['Refund policy is 30 days']] }];
const fakeDocs = {
  readOffice: jest.fn(async (uri: string, kind: string) => (kind === 'docx'
    ? { text: 'Leave policy\nEmployees get 24 days of paid leave.\tతెలుగు', bytes: 100, sha256: `sha-${uri}` }
    : { sheets: SHEETS, bytes: 200, sha256: `sha-${uri}` })),
  readText: jest.fn(async () => ({ text: 'Region,Amount\nEast,5\nWest,7\n', bytes: 30, sha256: 'sha-csv', lossy: false })),
  readPdf: jest.fn(), pick: jest.fn(), info: jest.fn(), release: jest.fn(),
};
const node = (name: string) => (globalThis as any).process.getBuiltinModule(name);
beforeEach(async () => {
  const fs = node('fs'), os = node('os'), path = node('path');
  chat.setDb(sqliteDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm11-')), 'chat.db')));
  NativeModules.AiDocs = fakeDocs;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
const imp = (name: string) => importFiles([{ uri: `content://d/${name}`, name, mime: null, size: 100 }]);

test('Word and Excel files are imported, searchable, and Excel sheets keep their names as the page', async () => {
  expect((await imp('leave.docx'))[0]).toMatchObject({ status: 'indexed' });
  expect((await imp('sales.xlsx'))[0]).toMatchObject({ status: 'indexed' });
  const docs = await docStore.listDocuments();
  expect(docs.map(d => d.format).sort()).toEqual(['docx', 'xlsx']);
  expect((await search('paid leave')).passages[0]).toMatchObject({ name: 'leave.docx' });
  const hit = (await search('South Feb')).passages[0];
  expect(hit).toMatchObject({ name: 'sales.xlsx', page: 1 });
  expect(hit.text).toContain('Sheet: Sales');
  expect(hit.text).toContain('Region: South; Month: Feb; Amount: ₹ 300');
});

test('table analysis is exact, reports skipped cells, and never treats text as zero', () => {
  const t: Table = { name: 'Sales', header: SHEETS[0].rows[0], rows: SHEETS[0].rows.slice(1) };
  expect(analyze(t, 'sum', { column: 'Amount' }).groups[0]).toMatchObject({ value: 2300, skipped: 1 });
  expect(analyze(t, 'sum', { column: 'amount', groupBy: 'Region' }).groups).toEqual([
    { key: 'South', value: 1500, rows: 2, skipped: 0 }, { key: 'North', value: 800, rows: 2, skipped: 1 }]);
  expect(analyze(t, 'average', { column: 'Amount', where: { column: 'Month', equals: 'jan' } }).groups[0].value).toBe(1000);
  expect(analyze(t, 'count', {}).groups[0].value).toBe(4);
  expect(analyze(t, 'max', { column: 'Amount' }).text).toMatch(/1200[\s\S]*1 non-numeric cell skipped[\s\S]*Calculated exactly by the app/);
  expect(() => analyze(t, 'sum', { column: 'Profit' })).toThrow(/No column "Profit"/);
  expect(() => analyze(t, 'sum', { column: 'Month' })).toThrow(/has no numbers/);
  expect([toNumber('1,20,000'), toNumber('(50)'), toNumber('12%'), toNumber('abc'), toNumber('')]).toEqual([120000, -50, 12, null, null]);
});

test('the table tool reads CSV and Excel files again, stays in scope, and computes without the model', async () => {
  await imp('sales.xlsx');
  await imp('east-west.csv');
  const [xlsx, csv] = (await docStore.listDocuments()).sort((a, b) => a.name.localeCompare(b.name)).reverse();
  expect((await analyzeDocument(csv.id, 'sum', { column: 'Amount' })).groups[0].value).toBe(12);
  const tool = getTool('table.analyze')!;
  const ctx = (scope: string[]) => ({ scope, previous: null, isCancelled: () => false, onCancel: () => undefined });
  const out = await tool.run({ documentId: xlsx.id, operation: 'sum', column: 'Amount', groupBy: 'Region' }, ctx([xlsx.id]));
  expect(out.text).toContain('South: 1500');
  await expect(tool.run({ documentId: xlsx.id, operation: 'sum', column: 'Amount' }, ctx([]))).rejects.toMatchObject({ code: 'out_of_scope' });
  expect(tool).toMatchObject({ risk: 'read', needsModel: false, permission: 'documents.read' });
});

test('collections save a named set of documents; deleting a document or a collection keeps the rest', async () => {
  await imp('leave.docx');
  await imp('sales.xlsx');
  const ids = (await docStore.listDocuments()).map(d => d.id);
  const col = await collections.saveCollection('  HR  files ', [...ids, 'no-such-doc']);
  expect(col).toMatchObject({ name: 'HR files' });
  expect(col.documentIds.sort()).toEqual([...ids].sort()); // unknown ids are dropped
  await collections.saveCollection('hr FILES', [ids[0]]); // same name (any case) replaces the set
  expect((await collections.listCollections()).map(c => [c.name, c.documentIds.length])).toEqual([['hr FILES', 1]]);
  await docStore.deleteDocument(ids[0]);
  expect((await collections.listCollections())[0].documentIds).toEqual([]);
  await collections.deleteCollection(col.id);
  expect(await collections.listCollections()).toEqual([]);
  expect((await docStore.listDocuments()).map(d => d.id)).toEqual([ids[1]]);
  await expect(collections.saveCollection('', ids)).rejects.toThrow(/name/);
});

test('different documents giving different amounts are flagged; one document or agreeing documents are not', () => {
  const p = (documentId: string, text: string) => ({ passage: { documentId } as any, text });
  const src = (n: number) => ({ n, documentId: '', name: '', page: null, ordinal: 0, chunkId: n });
  const two = [p('a', 'Refunds within 30 days of purchase.'), p('b', 'Refunds are accepted for 14 days.')];
  const c = findConflicts(two, [src(1), src(2)]);
  expect(conflictNote(c)).toBe('Sources may disagree: 30 days [1] vs 14 days [2]. Check them.');
  expect(findConflicts([p('a', '30 days'), p('b', 'within 30 days')], [src(1), src(2)])).toEqual([]); // they agree
  expect(findConflicts([p('a', '30 days, or 14 days for sale items')], [src(1)])).toEqual([]); // one document
  expect(findConflicts([p('a', 'Fee 5%'), p('b', 'fee of 7 percent')], [src(1), src(2)])[0].unit).toBe('%');
});
