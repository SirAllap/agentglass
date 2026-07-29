/**
 * Reviewing a pull request from a phone, properly.
 *
 * The screen could approve and it could merge, and that was the whole of it:
 * no "request changes", no "comment", and no way to say anything about a
 * specific line. `MobileDiff` has taken an `onLine` prop since it was written —
 * it renders every line as a button when you pass one, and the footer even says
 * "Tap a line to comment on it" — and nothing has ever passed it. So the
 * feature was built, shipped, and unreachable.
 *
 * Wiring it up as it stood would have been worse than leaving it. `onLine` gave
 * the caller `(path, line)` and nothing else, and a diff has two coordinate
 * systems: an added or context line carries its number in the *new* file, and a
 * deleted line carries its number in the *old* one. Posting a deleted line's
 * number as a RIGHT-side comment either lands on unrelated code that happens to
 * sit at that number now, or is rejected outright. The side is not decoration;
 * it is half the address.
 *
 * GitHub's own model is a *pending review*: you read, you leave remarks as you
 * go, and you submit them together with a verdict — one notification for the
 * author instead of a scatter of them. That is what this holds.
 *
 * Its own module, with no imports, so the rules can be tested without the
 * screen around them.
 */

export type Verb = "approve" | "request_changes" | "comment";
export type Side = "LEFT" | "RIGHT";

/** The three kinds of line a diff renders that can carry a comment. */
export type LineKind = "add" | "del" | "ctx";

export interface DraftComment {
  path: string;
  line: number;
  side: Side;
  body: string;
}

export interface ReviewDraft {
  /** The covering note. Optional for an approval, load-bearing otherwise. */
  body: string;
  comments: DraftComment[];
}

export const EMPTY: ReviewDraft = { body: "", comments: [] };

/**
 * Which file a line number belongs to.
 *
 * A deleted line only exists on the left; everything else is addressed on the
 * right. Context lines are numbered in the new file by the renderer, so they
 * are RIGHT too — which is also what GitHub expects for an unchanged line.
 */
export function sideFor(kind: LineKind): Side {
  return kind === "del" ? "LEFT" : "RIGHT";
}

/** One remark can occupy one address, so a second on the same line replaces it
 *  rather than stacking two comments the reader has to reconcile. */
function sameSpot(a: DraftComment, path: string, line: number, side: Side): boolean {
  return a.path === path && a.line === line && a.side === side;
}

export function commentAt(
  d: ReviewDraft, path: string, line: number, side: Side,
): DraftComment | null {
  return d.comments.find((c) => sameSpot(c, path, line, side)) ?? null;
}

/**
 * Leave a remark, replace one, or clear it.
 *
 * An empty body is a deletion rather than a comment saying nothing: the composer
 * opens pre-filled when you tap a line you have already annotated, so clearing
 * the box and confirming is the obvious way to take it back.
 */
export function setComment(
  d: ReviewDraft, path: string, line: number, side: Side, body: string,
): ReviewDraft {
  const text = body.trim();
  const rest = d.comments.filter((c) => !sameSpot(c, path, line, side));
  if (!text || !path || !Number.isInteger(line) || line <= 0) return { ...d, comments: rest };
  return { ...d, comments: [...rest, { path, line, side, body: text }] };
}

/** Every path this draft has something to say about, in the order first said. */
export function annotatedPaths(d: ReviewDraft): string[] {
  return [...new Set(d.comments.map((c) => c.path))];
}

export function countFor(d: ReviewDraft, path: string): number {
  return d.comments.filter((c) => c.path === path).length;
}

export interface Refusal { ok: false; why: string }
export type Verdict = { ok: true } | Refusal;

/**
 * Whether this verb can be submitted, and if not, the sentence to show.
 *
 * The rules are GitHub's, mirrored here so a button is disabled with a reason
 * on it rather than a request coming back red. The server checks the same
 * things — it has to, since it is reachable from the desktop too — and the
 * wording is kept close so the two do not tell different stories.
 */
export function canSubmit(
  d: ReviewDraft, verb: Verb | null, viewerDidAuthor: boolean,
): Verdict {
  if (!verb) return { ok: false, why: "Choose approve, request changes, or comment" };
  // GitHub refuses both of these on your own pull request. Commenting on it is
  // allowed, and is the useful one — that is how you answer a reviewer.
  if (viewerDidAuthor && verb === "approve") {
    return { ok: false, why: "You cannot approve your own pull request" };
  }
  if (viewerDidAuthor && verb === "request_changes") {
    return { ok: false, why: "You cannot request changes on your own pull request" };
  }
  // An empty COMMENT review is rejected outright, and a REQUEST_CHANGES with
  // nothing said is unkind to whoever receives it.
  if (verb !== "approve" && !d.body.trim() && !d.comments.length) {
    return { ok: false, why: "Say something, or leave at least one line comment" };
  }
  return { ok: true };
}

/** What the header says you are about to send. */
export function summarise(d: ReviewDraft): string {
  const n = d.comments.length;
  const files = annotatedPaths(d).length;
  if (!n) return d.body.trim() ? "A note, with no line comments" : "Nothing queued yet";
  return `${n} comment${n > 1 ? "s" : ""} on ${files} file${files > 1 ? "s" : ""}`;
}
