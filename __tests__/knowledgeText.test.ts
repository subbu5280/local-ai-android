// Pure document-processing rules: formats, normalization, Markdown, CSV, tokens and chunking.
import { chunkDocument, CHUNK_TOKENS, MAX_CHUNKS } from '../src/knowledge/chunker';
import { csvToText, detectFormat, markdownToText, normalizeText, parseCsv, textFor } from '../src/knowledge/text';
import { queryTerms, tokenize } from '../src/knowledge/tokens';
import { estimateTokens } from '../src/chatStore';

test('formats: by extension first (Android labels .md/.csv as octet-stream), then MIME; others unsupported', () => {
  expect(detectFormat('Notes.MD', 'application/octet-stream')).toBe('md');
  expect(detectFormat('data.csv', null)).toBe('csv');
  expect(detectFormat('report.pdf', 'application/pdf')).toBe('pdf');
  expect(detectFormat('readme', 'text/plain')).toBe('txt');
  expect(detectFormat('scan', 'application/pdf')).toBe('pdf');
  expect(detectFormat('photo.gif', 'image/gif')).toBeNull();
  expect(detectFormat('photo.jpg', 'image/jpeg')).toBe('image'); // M13: recognized with OCR
  // M11: Word and Excel (Office Open XML) are supported; the old binary .doc/.xls and other formats are not.
  expect(detectFormat('book.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx');
  expect(detectFormat('sales', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx');
  expect(detectFormat('old.doc', 'application/msword')).toBeNull();
  expect(detectFormat('old.xls', 'application/vnd.ms-excel')).toBeNull();
});

test('normalization: BOM, line ends, control characters, spaces and blank lines', () => {
  expect(normalizeText('﻿a\r\nb\rc\t\td\u0007   e  \n\n\n\nf  ')).toBe('a\nb\nc d e\n\nf');
  expect(normalizeText('é')).toBe('é'); // NFC: one code point
});

test('markdown keeps visible text and drops syntax', () => {
  const md = '# Title\n\nSee [the guide](https://x.y) and ![logo](a.png).\n\n**Bold** and *italic* `code`\n\n```js\nconst a = 1;\n```\n> quote\n<!-- hidden -->';
  expect(normalizeText(markdownToText(md))).toBe('Title\n\nSee the guide and logo.\n\nBold and italic code\n\nconst a = 1;\nquote');
});

test('CSV: quotes, escaped quotes, commas and line breaks inside fields; rows name their columns', () => {
  expect(parseCsv('a,b\n"x, y","say ""hi"""\n"multi\nline",3\n\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', '3']]);
  expect(csvToText('﻿name,city\nAsha,Pune\nRavi,\n')).toBe('Row 1: name: Asha; city: Pune\nRow 2: name: Ravi');
  expect(textFor('csv', 'only,a,header')).toBe('only, a, header');
  expect(textFor('csv', '')).toBe('');
});

test('tokens: lowercase words without punctuation; Indian scripts kept whole; light plural rule', () => {
  expect(tokenize("Refunds: the Policy's 30-day window!")).toEqual(['refund', 'the', 'policy', '30', 'day', 'window']);
  expect(tokenize('Kafka గురించి చెప్పండి.')).toEqual(['kafka', 'గురించి', 'చెప్పండి']);
  expect(tokenize('मौसम कैसा है। ठीक॥')).toEqual(['मौसम', 'कैसा', 'है', 'ठीक']); // danda is punctuation
  expect(tokenize('a I x 7')).toEqual(['7']); // single Latin letters dropped, digits kept
  expect(tokenize('Glass class status')).toEqual(['glass', 'class', 'statu']); // "ss" stays; consistent both sides
});

test('query terms drop English stop words unless nothing else is left', () => {
  expect(queryTerms('What does the document say about refunds?')).toEqual(['refund']);
  expect(queryTerms('to be or not to be')).toEqual(['to', 'be', 'or', 'not']);
  expect(queryTerms('Kafka గురించి')).toEqual(['kafka']); // "about" is a Telugu query stop word (M5)
});

test('chunking: bounded passages, paragraph boundaries, overlap, page references', () => {
  const para = (n: number) => `Paragraph ${n}. ${'Sentence about topic number ' + n + '. '.repeat(1)}`.repeat(6);
  const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n');
  const chunks = chunkDocument([{ text, page: null }]);
  expect(chunks.length).toBeGreaterThan(1);
  chunks.forEach((c, i) => {
    expect(c.ordinal).toBe(i);
    expect(c.tokens).toBeLessThanOrEqual(CHUNK_TOKENS);
    expect(c.tokens).toBe(estimateTokens(c.text));
  });
  // overlap: the start of each later passage repeats text from the end of the previous one
  const first = chunks[0].text;
  const nextStart = chunks[1].text.split('\n\n')[0];
  expect(first.endsWith(nextStart)).toBe(true);
  // pages: passages never cross pages
  const pdf = chunkDocument([{ text: 'Page one text.', page: 1 }, { text: 'Page two text.', page: 2 }]);
  expect(pdf.map(c => [c.page, c.text])).toEqual([[1, 'Page one text.'], [2, 'Page two text.']]);
});

test('chunking: a huge paragraph or a sentence without spaces is still cut within the budget', () => {
  const longSentence = 'word '.repeat(3000);
  const noSpaces = 'x'.repeat(5000);
  for (const text of [longSentence, noSpaces]) {
    const chunks = chunkDocument([{ text, page: null }]);
    expect(chunks.every(c => c.tokens <= CHUNK_TOKENS)).toBe(true);
    expect(chunks.map(c => c.text).join('').replace(/\s/g, '').length).toBeGreaterThanOrEqual(text.replace(/\s/g, '').length);
  }
});

test('chunking: Indian-script text is sized by its real token cost (about one per character)', () => {
  const telugu = 'నమస్కారం మిత్రమా. '.repeat(200);
  const chunks = chunkDocument([{ text: telugu, page: null }]);
  expect(chunks.every(c => c.tokens <= CHUNK_TOKENS)).toBe(true);
  // Telugu letters cost ~1 token each (spaces and dots 1/4), so a passage holds far fewer characters than English.
  expect(chunks.every(c => c.tokens >= c.text.length * 0.75)).toBe(true);
});

test('chunking refuses documents that need more than MAX_CHUNKS passages', () => {
  const many = Array.from({ length: MAX_CHUNKS + 1 }, (_, i) => `Item ${i} ${'z'.repeat(800)}`).join('\n\n');
  expect(() => chunkDocument([{ text: many, page: null }])).toThrow(/too many passages/);
});
