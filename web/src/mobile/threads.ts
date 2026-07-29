import type { PrThread } from "../../../shared/types.ts";

/**
 * Line threads, which the phone had flattened into their first sentence.
 *
 * The Talk tab took each thread, threw away every reply, and printed
 * `path:line — <the first comment>` as one more entry in a sorted list. So the
 * conversation you most need to read on a phone — the back-and-forth about one
 * line, the one that decides whether you can merge — was the one thing reduced
 * to its opening remark. Resolved and unresolved looked identical. Outdated
 * looked identical. There was no way to reply and no way to resolve, though
 * `replyToThread` and `resolveReviewThread` have been on the server all along.
 *
 * What is worth testing here is the ordering and the addressing, not the
 * markup: which threads a person needs to see first, and which comment id a
 * reply has to attach to. Both are easy to get subtly wrong and impossible to
 * notice afterwards.
 */

export interface ThreadRow {
  thread: PrThread;
  /** Where it happened, in the words the header uses. */
  where: string;
  /** Everything after the opening remark. */
  replies: number;
  /** The comment a reply attaches to. */
  replyTo: number | null;
  /** Why this is not worth your attention, or null when it is. */
  quiet: "resolved" | "outdated" | null;
}

/**
 * `path:line`, or the range, or just the file.
 *
 * A thread on a deleted or heavily rewritten file can arrive with no line at
 * all, and printing `src/cart.ts:null` is how that reads today.
 */
export function where(t: PrThread): string {
  const name = t.path || "(unknown file)";
  const end = t.line ?? t.originalLine ?? null;
  if (end == null) return name;
  const start = t.startLine ?? null;
  return start && start < end ? `${name}:${start}–${end}` : `${name}:${end}`;
}

/**
 * Which comment a reply hangs off.
 *
 * GitHub's replies endpoint is `/pulls/{n}/comments/{id}/replies`, and the id
 * has to be one that is actually in the thread. The first comment is the stable
 * choice: it exists for as long as the thread does, whereas the last one moves
 * every time anybody answers — so a screen holding a stale copy would post
 * against an id the server has already superseded.
 */
export function replyTarget(t: PrThread): number | null {
  for (const c of t.comments) {
    if (typeof c.databaseId === "number" && c.databaseId > 0) return c.databaseId;
  }
  return null;
}

/**
 * Threads in the order a person needs them.
 *
 * Open first, because those are the ones standing between this and a merge.
 * Then outdated — the code under them has moved, so they are usually safe to
 * skip but not always. Resolved last: kept, because "what did we decide about
 * this line" is a real question, and dropped from the count.
 *
 * Inside a band, by file and then by line, so reading down the list is reading
 * down the diff rather than following the order GitHub happened to return.
 */
export function orderThreads(threads: readonly PrThread[]): ThreadRow[] {
  const rank = (t: PrThread) => (t.isResolved ? 2 : t.isOutdated ? 1 : 0);
  return [...threads]
    .sort((a, b) =>
      rank(a) - rank(b) ||
      (a.path || "").localeCompare(b.path || "") ||
      (a.line ?? a.originalLine ?? 0) - (b.line ?? b.originalLine ?? 0))
    .map((t) => ({
      thread: t,
      where: where(t),
      replies: Math.max(0, t.comments.length - 1),
      replyTo: replyTarget(t),
      // Resolved wins over outdated: it is the stronger statement, and a thread
      // that is both should read as settled rather than as stale.
      quiet: t.isResolved ? "resolved" : t.isOutdated ? "outdated" : null,
    }));
}

/** How many still want an answer — the number the tab badge and the overview
 *  line are both claiming. Outdated counts: the code moved, the question may
 *  not have been answered. */
export function openCount(threads: readonly PrThread[]): number {
  return threads.filter((t) => !t.isResolved).length;
}
