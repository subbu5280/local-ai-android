/**
 * Turning extracted file text into clean, searchable text: normalization, Markdown, CSV and supported formats.
 * Pure functions (no I/O), so every rule is unit-tested.
 */

export type DocFormat = 'txt' | 'md' | 'pdf' | 'csv' | 'docx' | 'xlsx' | 'image';

/** Largest file read, per format. Bigger files are refused with a clear message instead of freezing the phone. */
export const MAX_BYTES: Record<DocFormat, number> = { txt: 10e6, md: 10e6, csv: 10e6, pdf: 50e6, docx: 30e6, xlsx: 30e6, image: 30e6 };
/** Largest extracted text indexed (characters), and most passages per document. */
export const MAX_CHARS = 2_000_000;

const EXT: Record<string, DocFormat> = { txt: 'txt', text: 'txt', log: 'txt', md: 'md', markdown: 'md', csv: 'csv', pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', jpg: 'image', jpeg: 'image', png: 'image', webp: 'image' };

/**
 * The format of a picked file, from its extension first (Android often labels .md and .csv as octet-stream), then its
 * MIME type; null = not supported.
 */
export function detectFormat(name: string, mime: string | null): DocFormat | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext && EXT[ext]) return EXT[ext];
  const m = (mime ?? '').toLowerCase();
  if (m === 'application/pdf') return 'pdf';
  if (/^image\/(jpeg|png|webp)$/.test(m)) return 'image';
  if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  if (m === 'text/csv' || m === 'text/comma-separated-values') return 'csv';
  if (m === 'text/markdown' || m === 'text/x-markdown') return 'md';
  if (m === 'text/plain') return 'txt';
  return null;
}

/**
 * Deterministic cleanup: Unicode NFC, Windows/old-Mac line ends to \n, control characters removed (tabs become
 * spaces), runs of spaces collapsed, trailing spaces trimmed, at most one blank line in a row.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[  ]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Markdown to plain text: link and image syntax keep their visible text, emphasis markers and HTML comments go, code
 * fences lose their ``` lines but keep the code. Headings and list items stay as lines (they are useful in passages).
 */
export function markdownToText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/gm, '');
}

/** RFC 4180-style CSV rows: commas, quoted fields with "" escapes and line breaks inside quotes. */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && csv[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(f => f.trim())) rows.push(row);
  return rows;
}

/**
 * CSV as readable lines, one per data row, each naming its columns ("Row 3: name: Asha; city: Pune"), so any passage
 * cut from the middle of a table still says what each value means. The first row is taken as the header.
 */
export function csvToText(csv: string): string {
  return rowsToText(parseCsv(csv.replace(/^﻿/, '')));
}

/** Table rows (first row = header) as readable lines; shared by CSV and Excel sheets (M11). */
export function rowsToText(rows: string[][]): string {
  if (rows.length === 0) return '';
  if (rows.length === 1) return rows[0].join(', ');
  const header = rows[0].map((h, i) => h.trim() || `column ${i + 1}`);
  return rows.slice(1).map((r, i) => {
    const cells = r.map((v, j) => [header[j] ?? `column ${j + 1}`, v.trim()] as const).filter(([, v]) => v);
    return `Row ${i + 1}: ${cells.map(([h, v]) => `${h}: ${v}`).join('; ')}`;
  }).join('\n');
}

/** The searchable text of a text-based file, by format. */
export function textFor(format: 'txt' | 'md' | 'csv', raw: string): string {
  if (format === 'csv') return normalizeText(csvToText(raw));
  if (format === 'md') return normalizeText(markdownToText(raw));
  return normalizeText(raw);
}
