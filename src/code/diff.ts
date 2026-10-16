/**
 * A line diff for reviewing proposals: hunks of removed ('-') and added ('+') lines with a little unchanged context,
 * numbered by the original and new line numbers.
 */

export type DiffLine = { type: ' ' | '-' | '+'; text: string; oldLine: number | null; newLine: number | null };
export type Hunk = { lines: DiffLine[] };

// ponytail: LCS table is O(n*m); past MAX_CELLS the diff shows "whole file replaced". Myers diff if big files matter.
const MAX_CELLS = 2_000_000;

/** Line operations turning `a` into `b` (common prefix/suffix trimmed first, LCS in between). */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split(/\r?\n/), y = b.split(/\r?\n/);
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xm = x.slice(pre, x.length - suf), ym = y.slice(pre, y.length - suf);
  const out: DiffLine[] = x.slice(0, pre).map((t, i) => ({ type: ' ', text: t, oldLine: i + 1, newLine: i + 1 }));
  const n = xm.length, m = ym.length;
  if (n * m > MAX_CELLS) {
    xm.forEach((t, i) => out.push({ type: '-', text: t, oldLine: pre + i + 1, newLine: null }));
    ym.forEach((t, j) => out.push({ type: '+', text: t, oldLine: null, newLine: pre + j + 1 }));
  } else {
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xm[i] === ym[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xm[i] === ym[j]) { out.push({ type: ' ', text: xm[i], oldLine: pre + i + 1, newLine: pre + j + 1 }); i++; j++; }
      else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) { out.push({ type: '-', text: xm[i], oldLine: pre + i + 1, newLine: null }); i++; }
      else { out.push({ type: '+', text: ym[j], oldLine: null, newLine: pre + j + 1 }); j++; }
    }
  }
  x.slice(x.length - suf).forEach((t, k) => out.push({ type: ' ', text: t, oldLine: x.length - suf + k + 1, newLine: y.length - suf + k + 1 }));
  return out;
}

/** The changed lines grouped into hunks with `context` unchanged lines around each change. */
export function hunks(a: string, b: string, context = 3): Hunk[] {
  const lines = diffLines(a, b);
  const keep = lines.map(() => false);
  lines.forEach((l, i) => { if (l.type !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true; });
  const out: Hunk[] = [];
  let cur: DiffLine[] | null = null;
  lines.forEach((l, i) => {
    if (keep[i]) { if (!cur) { cur = []; out.push({ lines: cur }); } cur.push(l); } else cur = null;
  });
  return out;
}
