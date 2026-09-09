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

/**
 * The threads that belong on a file of the diff, and where each one sits.
 *
 * `line` is the thread's position in the file as this pull request leaves it —
 * the RIGHT side, which is the side the numbers on the diff screen belong to.
 * That makes the anchor a lookup and not arithmetic.
 *
 * A thread with no `line` is adrift, and that is not an error: GitHub clears
 * it when the lines the conversation was about have changed underneath it. It
 * cannot be drawn against a row of code that no longer says what it said, so
 * it is handed back separately and the screen puts it at the top of the file,
 * where it reads as "about this file, once" rather than as a remark about
 * whatever line happens to be there now.
 *
 * Resolved threads are kept, and grouped like the rest. A resolved thread on a
 * line is the record of an argument that was had about it, which is the thing
 * you go looking for when the same line comes back a week later — the screen
 * draws it collapsed rather than dropping it.
 */
export function threadsOnFile(threads: PrThread[], path: string): {
  byLine: Map<number, PrThread[]>;
  adrift: PrThread[];
} {
  const byLine = new Map<number, PrThread[]>();
  const adrift: PrThread[] = [];
  for (const thread of ordered(threads)) {
    if (thread.path !== path) continue;
    const line = thread.line;
    if (typeof line !== "number") { adrift.push(thread); continue; }
    const at = byLine.get(line);
    if (at) at.push(thread);
    else byLine.set(line, [thread]);
  }
  return { byLine, adrift };
}

/**
 * The one line an unopened thread gets on the diff.
 *
 * A marker under a row of code has room for a name, a state and a few words,
 * and those few words have to be enough to decide whether to open it. So it is
 * the FIRST comment — the remark itself, not the last reply, which out of
 * context is usually "done" — flattened to one line, with the number of
 * replies after it.
 */
export function threadDigest(thread: PrThread): {
  who: string;
  gist: string;
  replies: number;
  state: "open" | "outdated" | "resolved";
} {
  const first = thread.comments[0];
  /* Fenced blocks stand aside for the word "code": a marker is one line, and a
     stack trace flattened into it says nothing while filling all of it. Split
     on the fence rather than matched with a pattern — the segments between a
     pair of fences are the odd ones, which is the whole rule. */
  const parts = (first?.body ?? "").split("```");
  const gist = parts
    .filter((_, i) => i % 2 === 0)
    .join(" code ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    who: first?.author ?? "somebody",
    gist,
    replies: Math.max(0, thread.comments.length - 1),
    state: thread.isResolved ? "resolved" : thread.isOutdated ? "outdated" : "open",
  };
}
