/*
 * How a pull request's conversations are ordered and labelled.
 *
 * The screen renders; this decides — the same split diffLines.ts and expand.ts
 * make, and here for a reason those two do not have. A thread screen can only
 * be seen with real threads on it, which needs a GitHub the test machine does
 * not have, so everything that can be decided without drawing is decided out
 * here where a test can reach it. What is left in the screen is layout.
 */
import type { PrThread } from "../../../shared/types.ts";

/**
 * The order to read them in.
 *
 * Unresolved first, because they are the ones still asking something of
 * somebody. Outdated next: GitHub's own word for a thread whose lines have
 * changed underneath it, and usually safe to skip — but not hidden, because
 * "usually" is not "always" and a remark about code that has since moved is
 * still a remark somebody made.
 *
 * Resolved last, and kept. A resolved thread is the record of an argument that
 * was had, which is exactly what you go looking for when the same line comes
 * back a week later.
 *
 * Within each group, the order the detail already put them in — which is file
 * order. A second sort here would be a second opinion about the same list.
 */
export function ordered(threads: PrThread[]): PrThread[] {
  const rank = (t: PrThread): number => (t.isResolved ? 2 : t.isOutdated ? 1 : 0);
  return threads
    .map((t, at) => ({ t, at }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.at - b.at)
    .map(({ t }) => t);
}

/**
 * Where a thread is, in the shortest form that still identifies it.
 *
 * `line` is null on an outdated thread — the lines it was written about are
 * gone from the current diff — and `originalLine` is where it was written. For
 * a LABEL that fallback is right and honest: it says where the conversation
 * happened. It is emphatically not right for applying a suggestion, which is
 * why `suggestionRange` refuses rather than falling back. The two questions
 * look the same and are not.
 */
export function whereOf(thread: Pick<PrThread, "path" | "line" | "startLine" | "originalLine">): string {
  const line = thread.line ?? thread.originalLine ?? null;
  if (line === null) return thread.path;
  const span = thread.startLine && thread.startLine !== line ? `${thread.startLine}-${line}` : `${line}`;
  return `${thread.path}:${span}`;
}

/**
 * The end of a diff hunk, which is the part worth showing.
 *
 * A comment is anchored to the LAST line of the hunk GitHub kept with it;
 * everything above is context leading up to that line. On a phone there is
 * room for about eight rows before the comment itself is pushed off screen, so
 * the tail is what survives and the head is what goes.
 *
 * Blank lines are dropped first: `diffHunk` arrives with a trailing newline
 * and sometimes two, and counting those as content spends the budget on
 * nothing.
 */
export function hunkTail(text: string, rows = 8): { lines: string[]; clipped: boolean } {
  const all = (text ?? "").split("\n").filter((l) => l.length > 0);
  return { lines: all.slice(-rows), clipped: all.length > rows };
}

/**
 * Can this thread be replied to, and with which id.
 *
 * The REST reply endpoint takes the NUMERIC id of a comment in the thread.
 * `PrThreadComment.id` is a GraphQL node id and the two are not
 * interchangeable — the shared type says so, and posting one where the other
 * is expected fails with a 404 that reads like the thread does not exist.
 *
 * The FIRST comment carrying one, not the last: replying to a thread means
 * `in_reply_to` its opening comment, and GitHub threads the rest itself.
 */
export function replyAnchor(thread: Pick<PrThread, "comments">): number | null {
  for (const c of thread.comments) {
    if (typeof c.databaseId === "number" && Number.isSafeInteger(c.databaseId)) return c.databaseId;
  }
  return null;
}
