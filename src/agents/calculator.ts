/**
 * Arithmetic without eval: a small recursive-descent parser over a fixed grammar. Nothing in the expression is ever
 * executed as code; unknown characters, names or functions are errors.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | 'mod') unary | 'of' unary)*      "20% of 150" = 0.2 * 150
 *   unary   := ('-' | '+') unary | power                             -3^2 = -(3^2) = -9, as in mathematics
 *   power   := postfix ('^' unary)?                                  right-associative; 2^-1 = 0.5
 *   postfix := primary '%'?                                          "15%" = 0.15
 *   primary := number | '(' expr ')' | name '(' expr (',' expr)* ')' | 'pi' | 'e'
 *
 * Functions: sqrt abs round floor ceil min max ln log (base 10). Limits: 200 characters, 20 levels of nesting.
 */

export class CalcError extends Error {}

export const MAX_EXPRESSION = 200;
const MAX_DEPTH = 20;

const FUNCTIONS: Record<string, { args: [number, number]; fn: (...a: number[]) => number }> = {
  sqrt: { args: [1, 1], fn: x => { if (x < 0) throw new CalcError('square root of a negative number'); return Math.sqrt(x); } },
  abs: { args: [1, 1], fn: Math.abs },
  round: { args: [1, 2], fn: (x, d = 0) => { const f = 10 ** Math.max(0, Math.min(12, Math.trunc(d))); return Math.round(x * f) / f; } },
  floor: { args: [1, 1], fn: Math.floor },
  ceil: { args: [1, 1], fn: Math.ceil },
  min: { args: [1, 20], fn: Math.min },
  max: { args: [1, 20], fn: Math.max },
  ln: { args: [1, 1], fn: x => { if (x <= 0) throw new CalcError('logarithm of a non-positive number'); return Math.log(x); } },
  log: { args: [1, 1], fn: x => { if (x <= 0) throw new CalcError('logarithm of a non-positive number'); return Math.log10(x); } },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token = { kind: 'num'; value: number } | { kind: 'op'; value: string } | { kind: 'name'; value: string };

function lex(input: string): Token[] {
  // "3 x 4" and "3×4" mean multiply; only between a number/")" and a number/"(", so "max(" keeps its x.
  const s = input.replace(/([\d)])\s*[×x]\s*(?=[\d(.])/g, '$1*').replace(/×/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').trim();
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i));
    if (num) { out.push({ kind: 'num', value: Number(num[0]) }); i += num[0].length; continue; }
    const name = /^[a-zA-Z]+/.exec(s.slice(i));
    if (name) { out.push({ kind: 'name', value: name[0].toLowerCase() }); i += name[0].length; continue; }
    if ('+-*/^%(),'.includes(ch)) {
      if (ch === '*' && s[i + 1] === '*') { out.push({ kind: 'op', value: '^' }); i += 2; continue; } // 2**3
      out.push({ kind: 'op', value: ch }); i++; continue;
    }
    throw new CalcError(`unsupported character "${ch}"`);
  }
  return out;
}

/**
 * Evaluate an arithmetic expression.
 * @returns a finite number
 * @throws CalcError for anything outside the grammar, division by zero, or a non-finite result
 */
export function calculate(expression: string): number {
  if (expression.length > MAX_EXPRESSION) throw new CalcError(`expression longer than ${MAX_EXPRESSION} characters`);
  const t = lex(expression);
  if (t.length === 0) throw new CalcError('empty expression');
  let pos = 0;
  let depth = 0;
  const peek = () => t[pos];
  const isOp = (v: string) => t[pos]?.kind === 'op' && t[pos].value === v;
  const isName = (v: string) => t[pos]?.kind === 'name' && t[pos].value === v;
  const expect = (v: string) => { if (!isOp(v)) throw new CalcError(`expected "${v}"`); pos++; };
  const nest = <T>(f: () => T): T => {
    if (++depth > MAX_DEPTH) throw new CalcError('expression nested too deeply');
    try { return f(); } finally { depth--; }
  };

  const expr = (): number => nest(() => {
    let v = term();
    while (isOp('+') || isOp('-')) v = (t[pos++].value === '+') ? v + term() : v - term();
    return v;
  });
  const term = (): number => {
    let v = unary();
    for (;;) {
      if (isOp('*')) { pos++; v *= unary(); }
      else if (isOp('/')) { pos++; const d = unary(); if (d === 0) throw new CalcError('division by zero'); v /= d; }
      else if (isName('mod')) { pos++; const d = unary(); if (d === 0) throw new CalcError('division by zero'); v %= d; }
      else if (isName('of')) { pos++; v *= unary(); }
      else return v;
    }
  };
  const unary = (): number => {
    if (isOp('-')) { pos++; return nest(() => -unary()); }
    if (isOp('+')) { pos++; return nest(() => unary()); }
    return power();
  };
  const power = (): number => {
    const base = postfix();
    if (!isOp('^')) return base;
    pos++;
    return nest(() => base ** unary());
  };
  const postfix = (): number => {
    let v = primary();
    if (isOp('%')) { pos++; v /= 100; }
    return v;
  };
  const primary = (): number => {
    const tok = peek();
    if (!tok) throw new CalcError('unexpected end of expression');
    if (tok.kind === 'num') { pos++; return tok.value; }
    if (tok.kind === 'op' && tok.value === '(') { pos++; const v = expr(); expect(')'); return v; }
    if (tok.kind === 'name') {
      pos++;
      if (tok.value in CONSTANTS) return CONSTANTS[tok.value];
      const f = FUNCTIONS[tok.value];
      if (!f) throw new CalcError(`unknown name "${tok.value}"`);
      expect('(');
      const args = [expr()];
      while (isOp(',')) { pos++; args.push(expr()); }
      expect(')');
      if (args.length < f.args[0] || args.length > f.args[1]) throw new CalcError(`${tok.value} takes ${f.args.join(' to ')} values`);
      return f.fn(...args);
    }
    throw new CalcError(`unexpected "${tok.value}"`);
  };

  const result = expr();
  if (pos < t.length) throw new CalcError(`unexpected "${t[pos].value}"`);
  if (!Number.isFinite(result)) throw new CalcError('the result is not a finite number');
  return result;
}

/** A readable result: up to 10 significant digits, no floating-point noise (0.1 + 0.2 = 0.3). */
export const formatNumber = (n: number) => String(Number(n.toPrecision(10)));

/** The arithmetic part of a sentence ("What is 12.5% of 80?" -> "12.5% of 80"), or null if there is none. */
/** Spoken arithmetic as symbols, so "15% of 240 plus 7" is one expression (not "15% of 240" with "plus 7" lost). */
export function wordsToSymbols(text: string): string {
  return text.replace(/\bmultiplied by\b|\btimes\b/gi, '*').replace(/\bdivided by\b|\bover\b/gi, '/')
    .replace(/\bplus\b|\badded to\b/gi, '+').replace(/\bminus\b|\bless\b/gi, '-');
}

export function extractExpression(raw: string): string | null {
  const text = wordsToSymbols(raw);
  const candidates = text.match(/[-+(]?\s*[\d.(][\d\s.+\-*/^%()×÷x]*(?:\s*(?:of|mod)\s*[\d.(][\d\s.+\-*/^%()×÷x]*)*/gi) ?? [];
  const best = candidates.map(c => c.trim().replace(/[?.!\s]+$/, '')).filter(c => /\d/.test(c) && /[-+*/^%×÷x]|\bof\b|\bmod\b/i.test(c))
    .sort((a, b) => b.length - a.length)[0];
  if (!best) return null;
  try { calculate(best); return best; } catch { return null; }
}
