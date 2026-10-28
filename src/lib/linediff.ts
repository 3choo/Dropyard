// Line diff (Myers O(ND)) producing unified-diff hunks with context.

export type DiffLine = { t: ' ' | '-' | '+'; s: string };
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[] };
export type TextDiff = { hunks: Hunk[]; additions: number; deletions: number } | { tooLarge: true };

const MAX_EDIT = 4000;
const CONTEXT = 3;

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = { t: ' ' | '-' | '+'; a: number; b: number };

function myers(a: string[], b: string[]): Op[] | null {
  // Trim the common prefix/suffix first; most edits are local.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const max = Math.min(n + m, MAX_EDIT);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    v = next;
  }
  if (!found) return null;
  trace.push(v.slice());

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ t: '+', a: x, b: y - 1 });
    else ops.push({ t: '-', a: x - 1, b: y });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ t: ' ', a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  ops.reverse();
  const full: Op[] = [];
  for (let i = 0; i < pre; i++) full.push({ t: ' ', a: i, b: i });
  for (const op of ops) full.push({ t: op.t, a: op.a + pre, b: op.b + pre });
  for (let i = 0; i < suf; i++) full.push({ t: ' ', a: a.length - suf + i, b: b.length - suf + i });
  return full;
}

export function diffText(oldText: string, newText: string): TextDiff {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = myers(a, b);
  if (!ops) return { tooLarge: true };
  let additions = 0;
  let deletions = 0;
  const changed: number[] = [];
  ops.forEach((op, i) => {
    if (op.t === '+') additions++;
    if (op.t === '-') deletions++;
    if (op.t !== ' ') changed.push(i);
  });
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < changed.length) {
    const start = Math.max(0, changed[i]! - CONTEXT);
    let end = Math.min(ops.length - 1, changed[i]! + CONTEXT);
    while (i + 1 < changed.length && changed[i + 1]! - CONTEXT <= end + 1) {
      i++;
      end = Math.min(ops.length - 1, changed[i]! + CONTEXT);
    }
    i++;
    const slice = ops.slice(start, end + 1);
    const first = slice[0]!;
    // Line numbers are 1-based; an empty side points at the line it follows.
    const oldLines = slice.filter((o) => o.t !== '+').length;
    const newLines = slice.filter((o) => o.t !== '-').length;
    const oldStart = oldLines === 0 ? first.a : first.a + 1;
    const newStart = newLines === 0 ? first.b : first.b + 1;
    hunks.push({
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: slice.map((o) => ({ t: o.t, s: o.t === '+' ? b[o.b]! : a[o.a]! })),
    });
  }
  return { hunks, additions, deletions };
}
