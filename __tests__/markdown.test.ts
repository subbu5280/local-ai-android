/** Formatted answers: the Markdown subset the model writes is parsed into blocks and spans without losing text. */
import { parseBlocks, parseInline, tokenize } from '../src/Markdown';

test('blocks: headings, lists, quotes, paragraphs and fenced code (also unclosed while streaming)', () => {
  const md = '# Kafka\n\nKafka stores **records**.\nIn topics.\n\n- one\n* two\n1. first\n2) second\n> note\n```python\nx = 1\n```';
  expect(parseBlocks(md)).toEqual([
    { kind: 'heading', level: 1, text: 'Kafka' },
    { kind: 'para', text: 'Kafka stores **records**.\nIn topics.' },
    { kind: 'bullet', text: 'one' }, { kind: 'bullet', text: 'two' },
    { kind: 'numbered', n: '1', text: 'first' }, { kind: 'numbered', n: '2', text: 'second' },
    { kind: 'quote', text: 'note' },
    { kind: 'code', lang: 'python', text: 'x = 1' },
  ]);
  expect(parseBlocks('Run:\n```js\nconst a')).toEqual([{ kind: 'para', text: 'Run:' }, { kind: 'code', lang: 'js', text: 'const a' }]);
  // Indian-language text and stray markers are kept exactly
  expect(parseBlocks('కాఫ్కా ఒక * స్ట్రీమింగ్ వేదిక')).toEqual([{ kind: 'para', text: 'కాఫ్కా ఒక * స్ట్రీమింగ్ వేదిక' }]);
});

test('inline: bold, italic, code; unmatched markers stay as typed', () => {
  expect(parseInline('Use **acks** and *idempotence* with `enable.idempotence=true`.')).toEqual([
    { text: 'Use ' }, { text: 'acks', bold: true }, { text: ' and ' }, { text: 'idempotence', italic: true },
    { text: ' with ' }, { text: 'enable.idempotence=true', code: true }, { text: '.' }]);
  expect(parseInline('2 * 3 = 6').map(s => s.text).join('')).toBe('2 * 3 = 6');
});

test('code colouring never changes the code text', () => {
  const code = 'def f(x):\n    # add one\n    return x + 1  // "s"\nconst s = \'a\';';
  const t = tokenize(code);
  expect(t.map(x => x.text).join('')).toBe(code);
  expect(t.find(x => x.text === 'def')?.kind).toBe('keyword');
  expect(t.find(x => x.text === '# add one')?.kind).toBe('comment');
  expect(t.find(x => x.text === '1')?.kind).toBe('number');
  // a Python docstring is one string: words inside it are not coloured as keywords
  expect(tokenize('"""This function adds"""')).toEqual([{ text: '"""This function adds"""', kind: 'string' }]);
});
