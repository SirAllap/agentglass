/*
 * A Jira card's comments as threads: a comment, and the replies to it under it.
 *
 * Cloud's replies are one level deep, which is what the site draws too, so a
 * thread is a root and its replies and nothing deeper. A reply whose root is not
 * among the comments read (the card read left it out, or it was deleted) is
 * drawn as a comment of its own with its marker, because hiding it would hide
 * something somebody wrote.
 *
 * Order: the roots are oldest or newest first as asked; the replies inside a
 * thread are always oldest first, the way a conversation reads.
 */
import type { TaskDetail } from "../../../shared/providers.ts";

type Comment = TaskDetail["comments"][number];
export interface Thread { root: Comment; replies: Comment[]; /** The comment it answers is not among those read. */ orphan: boolean }

export function threadsOf(comments: readonly Comment[], newestFirst: boolean): Thread[] {
  const byTime = [...comments].sort((a, b) => a.at - b.at);
  const byId = new Map(byTime.map((c) => [c.id, c]));
  // The highest comment reachable from this one: a reply to a reply belongs to the thread it is in, and a cycle stops.
  const topOf = (c: Comment): Comment => {
    let cur = c;
    const seen = new Set([c.id]);
    while (cur.parentId) {
      const up = byId.get(cur.parentId);
      if (!up || seen.has(up.id)) break;
      seen.add(up.id);
      cur = up;
    }
    return cur;
  };
  const replies = new Map<string, Comment[]>();
  const roots: Comment[] = [];
  for (const c of byTime) {
    const top = topOf(c);
    // A top that is itself an answer is a loop in the data: nothing in it is hidden, each comment stands as a root.
    if (top !== c && topOf(top) === top) replies.set(top.id, [...(replies.get(top.id) ?? []), c]);
    else roots.push(c);
  }
  const out = roots.map((root) => ({ root, replies: replies.get(root.id) ?? [], orphan: !!root.parentId }));
  return newestFirst ? out.reverse() : out;
}

/** Who a comment answers, by name, for the places that draw replies in time order (the All tab). */
export function answeredBy(comments: readonly Comment[]): Map<string, string> {
  const who = new Map(comments.map((c) => [c.id, c.who]));
  const out = new Map<string, string>();
  for (const c of comments) if (c.parentId && who.has(c.parentId)) out.set(c.id, who.get(c.parentId)!);
  return out;
}

/**
 * The comments after a post, with the threads the pane already knew. The card read back after a comment does not ask
 * Jira who answers whom (one request fewer), so a comment keeps the parent it had, and the one comment that is new and
 * the person's own takes the comment it was sent as an answer to. Anything else new stays at the top level until the
 * card is read again.
 */
export function keepThreads(prev: readonly Comment[], next: readonly Comment[], replyTo?: string | null): Comment[] {
  const known = new Map(prev.map((c) => [c.id, c.parentId]));
  const fresh = next.filter((c) => !known.has(c.id) && c.mine);
  return next.map((c) => {
    if (c.parentId) return c;
    const was = known.get(c.id);
    if (was) return { ...c, parentId: was };
    return replyTo && fresh.length === 1 && fresh[0]!.id === c.id ? { ...c, parentId: replyTo } : c;
  });
}
