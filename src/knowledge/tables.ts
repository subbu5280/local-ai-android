/**
 * Exact table analysis for CSV and Excel documents (M11): count, sum, average, min and max of a column, optionally
 * filtered by one column's value and grouped by another. The arithmetic is done here, never by the language model;
 * the model may only explain a result afterwards. Tables are read again from the original file (the app keeps read
 * access to imported files), bounded by the import size limits.
 */
import { getDocument, type Doc } from './docStore';
import * as native from './native';
import { MAX_BYTES, parseCsv } from './text';

export type Operation = 'count' | 'sum' | 'average' | 'min' | 'max';
export const OPERATIONS: Operation[] = ['count', 'sum', 'average', 'min', 'max'];
export type Table = { name: string; header: string[]; rows: string[][] };
export type Analysis = { table: string; operation: Operation; column: string | null; groups: { key: string; value: number; rows: number; skipped: number }[]; text: string };

export class TableError extends Error {
  constructor(public code: 'not_table' | 'not_found' | 'bad_column' | 'no_numbers', message: string) { super(message); }
}

/** The tables of a CSV (one) or Excel (one per sheet) document; the first row of each is its header. */
export async function readTables(doc: Doc): Promise<Table[]> {
  let raw: { name: string; rows: string[][] }[];
  if (doc.format === 'csv') raw = [{ name: doc.name, rows: parseCsv((await native.readText(doc.uri, MAX_BYTES.csv)).text.replace(/^﻿/, '')) }];
  else if (doc.format === 'xlsx') raw = (await native.readOffice(doc.uri, 'xlsx', MAX_BYTES.xlsx)).sheets ?? [];
  else throw new TableError('not_table', `"${doc.name}" is not a CSV or Excel file.`);
  return raw.filter(t => t.rows.length).map(t => ({ name: t.name, header: t.rows[0].map((h, i) => h.trim() || `column ${i + 1}`), rows: t.rows.slice(1) }));
}

/** "1,234.50", "₹ 1,200", "12%" → number; anything else → null (never guessed). */
export function toNumber(v: string): number | null {
  const s = v.trim().replace(/^[₹$€£]\s*|\s*(%|rs\.?|inr)$/gi, '').replace(/,(?=\d{2,3}\b)/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const col = (t: Table, name: string) => {
  const i = t.header.findIndex(h => h.trim().toLowerCase() === name.trim().toLowerCase());
  if (i < 0) throw new TableError('bad_column', `No column "${name}" in ${t.name}. Columns: ${t.header.join(', ')}.`);
  return i;
};
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));

/**
 * Compute an operation over one table. Non-numeric cells are skipped and counted (reported, never treated as 0).
 * @throws TableError for unknown columns or when a numeric operation finds no numbers
 */
export function analyze(t: Table, op: Operation, opts: { column?: string; groupBy?: string; where?: { column: string; equals: string } } = {}): Analysis {
  const c = op === 'count' ? (opts.column ? col(t, opts.column) : -1) : col(t, opts.column ?? '');
  const g = opts.groupBy ? col(t, opts.groupBy) : -1;
  const w = opts.where ? col(t, opts.where.column) : -1;
  const groups = new Map<string, { nums: number[]; rows: number; skipped: number }>();
  for (const r of t.rows) {
    if (w >= 0 && (r[w] ?? '').trim().toLowerCase() !== opts.where!.equals.trim().toLowerCase()) continue;
    const key = g >= 0 ? (r[g] ?? '').trim() || '(empty)' : 'all rows';
    const e = groups.get(key) ?? { nums: [], rows: 0, skipped: 0 };
    e.rows++;
    if (c >= 0) { const n = toNumber(r[c] ?? ''); if (n === null) e.skipped++; else e.nums.push(n); }
    groups.set(key, e);
  }
  const out = [...groups.entries()].map(([key, e]) => {
    const n = e.nums;
    const value = op === 'count' ? (c >= 0 ? n.length : e.rows) : op === 'sum' ? n.reduce((a, b) => a + b, 0)
      : op === 'average' ? (n.length ? n.reduce((a, b) => a + b, 0) / n.length : NaN) : op === 'min' ? Math.min(...n) : Math.max(...n);
    return { key, value, rows: e.rows, skipped: e.skipped, empty: op !== 'count' && !n.length };
  });
  if (op !== 'count' && out.every(o => o.empty)) throw new TableError('no_numbers', `Column "${opts.column}" has no numbers${opts.where ? ' in the matching rows' : ''}.`);
  const label = `${op}${opts.column ? ` of ${t.header[c] ?? opts.column}` : ' of rows'}${opts.where ? ` where ${opts.where.column} = ${opts.where.equals}` : ''}`;
  const lines = out.map(o => `${g >= 0 ? `${o.key}: ` : ''}${o.empty ? 'no numbers' : fmt(o.value)}${o.skipped ? ` (${o.skipped} non-numeric cell${o.skipped === 1 ? '' : 's'} skipped)` : ''}`);
  return {
    table: t.name, operation: op, column: opts.column ?? null,
    groups: out.filter(o => !o.empty).map(({ key, value, rows, skipped }) => ({ key, value, rows, skipped })),
    text: `${t.name} — ${label}${g >= 0 ? `, by ${t.header[g]}` : ''}:\n${lines.join('\n')}\n(Calculated exactly by the app from ${t.rows.length} rows.)`,
  };
}

/** Load a document's tables and analyze the named sheet (or the first sheet that has the column). */
export async function analyzeDocument(documentId: string, op: Operation, opts: { column?: string; groupBy?: string; where?: { column: string; equals: string }; sheet?: string }): Promise<Analysis> {
  const doc = await getDocument(documentId);
  if (!doc) throw new TableError('not_found', 'That document is not in the library.');
  const tables = await readTables(doc);
  const named = opts.sheet ? tables.find(t => t.name.toLowerCase() === opts.sheet!.toLowerCase()) : null;
  const t = named ?? tables.find(x => !opts.column || x.header.some(h => h.toLowerCase() === opts.column!.toLowerCase())) ?? tables[0];
  if (!t) throw new TableError('not_table', 'The file has no table rows.');
  return analyze(t, op, opts);
}

const OP_WORDS: [RegExp, Operation][] = [
  [/\b(total|sum|add up|altogether)\b/i, 'sum'],
  [/\b(average|mean)\b/i, 'average'],
  [/\b(highest|maximum|max|largest|biggest)\b/i, 'max'],
  [/\b(lowest|minimum|min|smallest)\b/i, 'min'],
  [/\b(how many (?:rows|entries|records|orders|items|sales)|count|number of (?:rows|entries|records|orders))\b/i, 'count'],
];
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (q: string, word: string) => word.trim().length > 1 && new RegExp(`\\b${escapeRegex(word.trim())}\\b`, 'i').test(q);

/**
 * Turn a plain question into an exact table operation, or null when it is not one (M15, after the M35 run where the
 * model summed only one of two "North" rows). Needs an operation word; the column is a header the question names
 * (numeric columns only for sum/average/min/max); a cell value the question names becomes the row filter.
 * ponytail: one filter, one column, English operation words; the model answers anything this does not recognize.
 */
export function tableQuestion(q: string, t: Table): { op: Operation; column?: string; where?: { column: string; equals: string } } | null {
  const op = OP_WORDS.find(([re]) => re.test(q))?.[1];
  if (!op) return null;
  const numeric = (i: number) => t.rows.length > 0 && t.rows.filter(r => toNumber(r[i] ?? '') !== null).length >= t.rows.length / 2;
  const column = t.header.find((h, i) => mentions(q, h) && (op === 'count' || numeric(i)));
  if (op !== 'count' && !column) return null;
  let where: { column: string; equals: string } | undefined;
  for (let i = 0; i < t.header.length && !where; i++) {
    if (numeric(i)) continue;
    const value = t.rows.map(r => (r[i] ?? '').trim()).find(v => mentions(q, v));
    if (value) where = { column: t.header[i], equals: value };
  }
  return { op, column, where };
}

/** An exact answer to a table question about one of these documents (CSV/Excel), or null to let the model answer. */
export async function answerTableQuestion(q: string, documentIds: string[]): Promise<{ documentId: string; text: string } | null> {
  for (const id of documentIds) {
    const doc = await getDocument(id);
    if (!doc || (doc.format !== 'csv' && doc.format !== 'xlsx')) continue;
    for (const t of await readTables(doc).catch(() => [] as Table[])) {
      const plan = tableQuestion(q, t);
      if (!plan) continue;
      try { return { documentId: id, text: analyze(t, plan.op, plan).text }; } catch { /* not this table */ }
    }
  }
  return null;
}
