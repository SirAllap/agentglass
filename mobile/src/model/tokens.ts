/*
 * What actually changed INSIDE a line.
 *
 * A hunk that renames one identifier draws two full-width bands, one red and
 * one green, and leaves the reader to play spot-the-difference on eleven-point
 * monospace. On a 393-point screen that is most of the work of reading a diff,
 * and it is work a machine can do: the two lines are right there.
 *
 * ── which lines are a pair ───────────────────────────────────────────────
 * A run of deletions immediately followed by a run of additions is an edit,
 * and the nth of each is the same line before and after. That is the rule
 * every diff viewer uses and it is right far more often than it is wrong —
 * but only when the runs are the same length. Three lines deleted and one
 * added is not three edits, it is a deletion and an insertion, and pairing
 * them would draw a relationship that is not there.
 *
 * ── and when a pair is too different to be one ───────────────────────────
 * Two lines that share almost nothing are not an edit of each other; they are
 * a line that went and a line that came. Highlighting them token by token
 * would mark nearly everything, which is the same as marking nothing while
 * costing the reader a second to work that out. So a pair below a similarity
 * floor gets no intra-line marks at all and stays two plain bands.
 *
 * ── the cost, which is the reason for the shape below ────────────────────
 * A diff is text a stranger wrote and a line has no length limit — a minified
 * bundle is one line of 300kB. Common prefix and suffix are trimmed first, in
 * one pass each, which is what most real edits are made of. Only what is left
 * in the middle goes through the quadratic part, and only when both middles
 * are short enough for it to be free; past that the whole middle is marked,
 * which is coarser and never slower than the reader's patience.
 */
import type { DiffLine } from "./diffLines.ts";

/** A run of text, and whether it is part of what changed. */
export interface Span { text: string; changed: boolean }

/**
 * Words, punctuation and runs of space, kept separately.
 *
 * Token granularity rather than character: a renamed identifier is ONE thing
 * that changed, and marking it letter by letter — `agentglas`|`s` — is how a
 * highlight becomes confetti. Whitespace is its own token so that indentation
 * changes show as indentation changing.
 */
export function tokens(line: string): string[] {
  return line.match(/[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g) ?? [];
}

/** Both middles longer than this and the pair keeps the coarse marking. 64×64
 *  comparisons is nothing; the guard is against the line that is a whole file. */
const LCS_LIMIT = 64;

/** Below this share of tokens in common, two lines are not an edit of each
 *  other. Half is deliberately generous: a line whose right-hand side was
 *  rewritten still shares its declaration, and that is worth marking. */
const SIMILAR = 0.3;

/**
 * The spans to draw for one pair of lines, or null when there is no pair worth
 * drawing.
 *
 * Null is a real answer and the caller must handle it: it means "these two are
 * not an edit of each other", and the honest drawing then is the two plain
 * bands this app already had.
 */
export function inlineSpans(before: string, after: string): { before: Span[]; after: Span[] } | null {
  if (before === after) return null;
  const a = tokens(before);
  const b = tokens(after);
  if (!a.length || !b.length) return null;

  // The head and tail the two lines agree on, in tokens. Most edits are a
  // change in the middle of a line that is otherwise identical, so this alone
  // usually leaves a middle of two or three tokens.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const shared = head + tail;
  if (shared / Math.max(a.length, b.length) < SIMILAR) return null;

  const marks = midA.length <= LCS_LIMIT && midB.length <= LCS_LIMIT
    ? viaLcs(midA, midB)
    : { a: midA.map(() => true), b: midB.map(() => true) };

  return {
    before: assemble(a, head, tail, marks.a),
    after: assemble(b, head, tail, marks.b),
  };
}

/**
 * Which of the middle tokens are NOT in the longest common subsequence.
 *
 * The textbook table, on a middle that has already been trimmed and bounded.
 * It is here rather than a prefix rule because the case it buys is common and
 * visible: `foo(a, b)` becoming `foo(a, c, b)` marks `c` and nothing else,
 * where a prefix-only rule marks `c, b` and reads as though two things moved.
 */
function viaLcs(a: string[], b: string[]): { a: boolean[]; b: boolean[] } {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => Array.from<number>({ length: m + 1 }).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const markA = Array.from<boolean>({ length: n }).fill(true);
  const markB = Array.from<boolean>({ length: m }).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { markA[i] = false; markB[j] = false; i++; j++; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return { a: markA, b: markB };
}

/** The whole line as spans: the agreed head, the marked middle, the agreed
 *  tail — with neighbours of the same kind joined, because one `<Text>` per
 *  token is a paragraph the layout engine has to measure word by word. */
function assemble(all: string[], head: number, tail: number, marks: boolean[]): Span[] {
  const flags = [
    ...Array.from<boolean>({ length: head }).fill(false),
    ...marks,
    ...Array.from<boolean>({ length: tail }).fill(false),
  ];
  const out: Span[] = [];
  for (let i = 0; i < all.length; i++) {
    const changed = flags[i] ?? false;
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += all[i]!;
    else out.push({ text: all[i]!, changed });
  }
  return out;
}

/**
 * The pairs in a hunk: which deleted line each added line is a rewrite of.
 *
 * Keyed by index into the hunk's own lines, because that is what the renderer
 * has in hand while it draws. A run only pairs when the two sides are the same
 * length — see the note at the top about three deleted and one added.
 */
export function pairsIn(lines: DiffLine[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== "del") { i++; continue; }
    let dels = i;
    while (dels < lines.length && lines[dels]!.kind === "del") dels++;
    let adds = dels;
    while (adds < lines.length && lines[adds]!.kind === "add") adds++;
    const removed = dels - i;
    const added = adds - dels;
    if (removed > 0 && removed === added) {
      for (let k = 0; k < removed; k++) pairs.set(i + k, dels + k);
    }
    i = adds > dels ? adds : dels;
  }
  return pairs;
}
