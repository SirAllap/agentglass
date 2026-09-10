/*
 * What actually changed INSIDE a line.
 *
 * Shared because two clients ask the same question of the same diff and must
 * not answer it differently. They did: the desk had this, the phone grew its
 * own a week later, and the two disagreed about when a deleted line and an
 * added one are a rewrite of each other — which is a difference a reader would
 * see as one screen marking a word and the other marking nothing.
 *
 * ── the value, and the risk ──────────────────────────────────────────────
 * A hunk that renames one identifier draws two full-width bands and leaves the
 * reader to play spot-the-difference. That is work a machine can do; both
 * lines are right there. But a mark is READ AS A FACT, and a wrong fact about
 * a diff sends somebody looking at code that did not change — so most of what
 * is below is about refusing to mark.
 *
 * ── which lines are a pair ───────────────────────────────────────────────
 * A run of deletions immediately followed by a run of additions is an edit,
 * and the nth of each is the same line before and after. Pairing is positional
 * and therefore a guess, which is exactly why the similarity floor below is
 * not optional: unrelated lines land opposite each other all the time.
 *
 * ── and when a pair is too different to be one ───────────────────────────
 * Two lines that share almost nothing are not an edit of each other; they are
 * a line that went and a line that came. Highlighting them token by token
 * marks nearly everything, which is the same as marking nothing while costing
 * the reader a second to work that out. Below the floor: no marks, two plain
 * bands.
 *
 * ── the cost, which is the reason for the shape below ────────────────────
 * A diff is text a stranger wrote and a line has no length limit — a minified
 * bundle is one line of 300kB. Common prefix and suffix are trimmed first, in
 * one pass each, which is what most real edits are made of. Only what is left
 * in the middle goes through the quadratic part, and only when both middles
 * are short enough for it to be free; past that the whole middle is marked,
 * which is coarser and never slower than the reader's patience.
 */

/** A run of text, and whether it is part of what changed. */
export interface Seg { text: string; changed: boolean }


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

/** Below this share of their characters in common, two lines are not an edit
 *  of each other. Deliberately generous: a line whose right-hand side was
 *  rewritten still shares its declaration, and that is worth marking. */
const SIMILAR = 0.4;

/**
 * The spans to draw for one pair of lines, or null when there is no pair worth
 * drawing.
 *
 * Null is a real answer and the caller must handle it: it means "these two are
 * not an edit of each other", and the honest drawing then is the two plain
 * bands this app already had.
 */
export function tokenDiff(before: string, after: string): { left: Seg[]; right: Seg[] } | null {
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

  /*
   * The middle, and then the floor — in that order, which is not an
   * optimisation but the difference between right and wrong.
   *
   * Measuring similarity from the trimmed head and tail ALONE says a line
   * changed at both of its ends has nothing in common with itself:
   * `const total = sum(items, seed);` against
   * `let total = sum(items, base);` shares its whole middle and agrees on two
   * tokens at the end, and a head-and-tail count calls that 14% and refuses to
   * mark it. So what counts is everything the two lines actually keep,
   * including what the table matched in the middle.
   *
   * In characters rather than tokens, because it is a claim about what a
   * reader sees: one long identifier kept is worth more than three brackets.
   */
  const fits = midA.length <= LCS_LIMIT && midB.length <= LCS_LIMIT;
  const marks = fits
    ? viaLcs(midA, midB)
    : { a: midA.map(() => true), b: midB.map(() => true) };

  let kept = 0;
  for (let i = 0; i < head; i++) kept += a[i]!.length;
  for (let i = 0; i < tail; i++) kept += a[a.length - 1 - i]!.length;
  if (fits) for (let i = 0; i < midA.length; i++) if (!marks.a[i]) kept += midA[i]!.length;
  if ((2 * kept) / (before.length + after.length) < SIMILAR) return null;

  return {
    left: assemble(a, head, tail, marks.a),
    right: assemble(b, head, tail, marks.b),
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
function assemble(all: string[], head: number, tail: number, marks: boolean[]): Seg[] {
  const flags = [
    ...Array.from<boolean>({ length: head }).fill(false),
    ...marks,
    ...Array.from<boolean>({ length: tail }).fill(false),
  ];
  const out: Seg[] = [];
  for (let i = 0; i < all.length; i++) {
    const changed = flags[i] ?? false;
    const last = out[out.length - 1];
    if (last && last.changed === changed) last.text += all[i]!;
    else out.push({ text: all[i]!, changed });
  }
  return out;
}

/**
 * The pairs in a run of rows: which deleted line each added line rewrites.
 *
 * Keyed by index into the rows themselves, because that is what both callers
 * have in hand while they draw. A block of deletions pairs with the block of
 * additions immediately after it, nth with nth, and never across a line of
 * context — a context line is git saying the change block ended.
 *
 * Uneven blocks pair as far as the shorter one goes rather than not at all.
 * Three deleted and one added usually IS one line rewritten and two removed,
 * and the similarity floor in `tokenDiff` is what stops the guess being
 * painted when it is wrong. Refusing the whole block instead would throw away
 * the marks on the pair that is right.
 */
export function pairsIn(rows: { kind: string }[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== "del") { i++; continue; }
    let dels = i;
    while (dels < rows.length && rows[dels]!.kind === "del") dels++;
    let adds = dels;
    while (adds < rows.length && rows[adds]!.kind === "add") adds++;
    for (let k = 0; k < Math.min(dels - i, adds - dels); k++) pairs.set(i + k, dels + k);
    i = adds > dels ? adds : dels;
  }
  return pairs;
}
