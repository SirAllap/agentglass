/*
 * The cheap, reversible writes on a tracker card, drawn on the press.
 *
 * Resolving a comment went through the same path as deleting one: grey the
 * button, wait for the tracker, then read the whole card again — comments,
 * replies, events — before the tick moved. That read is the slow part, and a
 * resolve does not need it to be believed: it is one call, and pressing again
 * undoes it.
 *
 * So it is a layer over the card the server last returned, with the write
 * going out behind it. The layer itself is `Optimistic` from prOptimistic.ts —
 * the same class the pull request panel uses, over a different type — so the
 * rules are the same ones and are written down there once:
 *
 *   - A refusal takes the layer away, which is the rollback, and says so.
 *   - A read that was already in flight when the write went out answers with
 *     the card as it was before; it does not flip the tick back.
 *   - A read that began after the write landed is the tracker's own answer and
 *     replaces the layer.
 *
 * The patch SETS the state rather than flipping it, because a layer can end up
 * drawn over a card that already has the change in it: two presses in flight
 * must not restore each other's stale state.
 *
 * Deliberately not here: posting, replying, editing or deleting a comment.
 * A comment is words somebody wrote, a delete cannot be undone by pressing
 * again, and all four still wait for the answer.
 */

import type { TaskDetail } from "../../../shared/providers.ts";

export { Optimistic } from "./prOptimistic.ts";

type Comments = TaskDetail["comments"];

/** One comment, resolved or not. Any read of the card fits — the panel holds a
 *  partial one until the first answer is in. */
export const commentResolvedPatch = (commentId: string, resolved: boolean) =>
  <T extends { comments?: Comments }>(d: T): T =>
    d.comments?.some((c) => c.id === commentId)
      ? { ...d, comments: d.comments.map((c) => (c.id === commentId ? { ...c, resolved } : c)) }
      : d;
