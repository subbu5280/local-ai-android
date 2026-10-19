/**
 * Formatted answers: the small Markdown subset a chat model writes, rendered with plain React Native Text/View (no
 * dependency). Headings, **bold**, *italic*, `inline code`, bullet and numbered lists, > quotes, and fenced code blocks
 * with light syntax colouring and their own Copy button. Anything else is shown as plain text, never dropped.
 * ponytail: no tables, links or nested lists; add when answers need them.
 */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Colors } from './theme';

export type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'numbered'; n: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'para'; text: string };

/** Split a message into blocks. An unclosed ``` (still streaming) is treated as a code block to the end. */
export function parseBlocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+#.-]*)/);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ kind: 'code', lang: fence[1].toLowerCase(), text: body.join('\n') });
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) out.push({ kind: 'heading', level: m[1].length, text: m[2] });
    else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) out.push({ kind: 'bullet', text: m[1] });
    else if ((m = line.match(/^\s*(\d+)[.)]\s+(.*)$/))) out.push({ kind: 'numbered', n: m[1], text: m[2] });
    else if ((m = line.match(/^>\s?(.*)$/))) out.push({ kind: 'quote', text: m[1] });
    else if (line.trim() === '') continue;
    else {
      const last = out[out.length - 1];
      if (last?.kind === 'para' && lines[i - 1]?.trim() !== '') last.text += `\n${line}`; // same paragraph
      else out.push({ kind: 'para', text: line });
    }
  }
  return out;
}

export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

/** Inline **bold**, *italic* / _italic_ and `code`; unmatched markers stay as typed. */
export function parseInline(text: string): Span[] {
  const out: Span[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)/g;
  let at = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    const t = m[0];
    if (t.startsWith('`')) out.push({ text: t.slice(1, -1), code: true });
    else if (t.startsWith('**') || t.startsWith('__')) out.push({ text: t.slice(2, -2), bold: true });
    else out.push({ text: t.slice(1, -1), italic: true });
    at = m.index + t.length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

const KEYWORDS = new Set(('const let var function return if else for while do switch case break continue class new this ' +
  'import from export default async await try catch finally throw def elif in not and or is None True False lambda ' +
  'public private protected static void int long float double boolean char String val fun when null true false ' +
  'package interface extends implements struct enum fn mut pub use match impl self Self type yield with as').split(' '));
export type Token = { text: string; kind: 'keyword' | 'string' | 'comment' | 'number' | 'plain' };

/** Light, language-agnostic colouring: comments, strings, numbers and common keywords. Never changes the text. */
export function tokenize(code: string): Token[] {
  const re = /("""[\s\S]*?"""|'''[\s\S]*?'''|\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)/g;
  const out: Token[] = [];
  let at = 0;
  for (let m; (m = re.exec(code)); ) {
    if (m.index > at) out.push({ text: code.slice(at, m.index), kind: 'plain' });
    const t = m[0];
    const kind = /^(\/\/|#|\/\*)/.test(t) ? 'comment' : /^["'`]/.test(t) ? 'string' : /^\d/.test(t) ? 'number'
      : KEYWORDS.has(t) ? 'keyword' : 'plain';
    out.push({ text: t, kind });
    at = m.index + t.length;
  }
  if (at < code.length) out.push({ text: code.slice(at), kind: 'plain' });
  return out;
}

const CODE_COLORS = { keyword: '#c792ea', string: '#c3e88d', comment: '#7f85a3', number: '#f78c6c', plain: '#e4e6f4' };

function Inline({ text, color, codeBg }: { text: string; color: string; codeBg: string }) {
  return (
    <>
      {parseInline(text).map((s, i) => (
        <Text key={i} style={[s.bold && styles.bold, s.italic && styles.italic,
          s.code && [styles.inlineCode, { backgroundColor: codeBg, color }]]}>{s.text}</Text>
      ))}
    </>
  );
}

/** A rendered answer. `onCopy` copies a code block's text (the app's clipboard helper). */
export function Markdown({ text, colors: c, onCopy }: { text: string; colors: Colors; onCopy: (code: string) => void }) {
  return (
    <View style={styles.gap}>
      {parseBlocks(text).map((b, i) => {
        if (b.kind === 'code') {
          return (
            <View key={i} style={styles.codeBox}>
              <View style={styles.codeHead}>
                <Text style={styles.codeLang}>{b.lang || 'code'}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Copy this code" hitSlop={10} onPress={() => onCopy(b.text)}>
                  <Text style={styles.codeCopy}>⧉ Copy</Text>
                </Pressable>
              </View>
              {/* Code keeps its line breaks: long lines scroll sideways instead of wrapping. */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text selectable style={styles.codeText}>
                  {tokenize(b.text).map((t, j) => <Text key={j} style={{ color: CODE_COLORS[t.kind] }}>{t.text}</Text>)}
                </Text>
              </ScrollView>
            </View>
          );
        }
        const body = <Inline text={b.text} color={c.text} codeBg={c.bg} />;
        if (b.kind === 'heading') {
          return <Text key={i} selectable accessibilityRole="header" style={[styles.heading, { color: c.text, fontSize: 21 - b.level * 2 }]}>{body}</Text>;
        }
        if (b.kind === 'bullet' || b.kind === 'numbered') {
          return (
            <View key={i} style={styles.listRow}>
              <Text style={[styles.marker, { color: c.accent }]}>{b.kind === 'bullet' ? '•' : `${b.n}.`}</Text>
              <Text selectable style={[styles.flex, { color: c.text }]}>{body}</Text>
            </View>
          );
        }
        if (b.kind === 'quote') {
          return <Text key={i} selectable style={[styles.quote, { color: c.muted, borderColor: c.accent }]}>{body}</Text>;
        }
        return <Text key={i} selectable style={{ color: c.text, lineHeight: 21 }}>{body}</Text>;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 6 },
  flex: { flex: 1, lineHeight: 21 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  inlineCode: { fontFamily: 'monospace', fontSize: 13 },
  heading: { fontWeight: '800', marginTop: 4 },
  listRow: { flexDirection: 'row', gap: 8 },
  marker: { fontWeight: '700', minWidth: 16 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, fontStyle: 'italic' },
  codeBox: { backgroundColor: '#0d0f22', borderRadius: 10, overflow: 'hidden' },
  codeHead: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#1a1d3a' },
  codeLang: { color: '#9c9ec2', fontSize: 12, fontFamily: 'monospace' },
  codeCopy: { color: '#f4b23e', fontSize: 12, fontWeight: '600' },
  codeText: { fontFamily: 'monospace', fontSize: 13, lineHeight: 19, padding: 10 },
});
