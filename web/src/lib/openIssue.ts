/*
 * "Show me that issue."
 *
 * The third of these, and the shape is settled by now: openPrs.ts takes you
 * from a card to a pull request, openCard.ts from a pull request back to its
 * ClickUp card, and this one from a pull request to the GitHub issue it closes.
 *
 * It exists because that last link was already on screen and went the wrong
 * way. The pull-request sidebar has said "Merging this closes: #123" for a
 * while — the server reads `closingIssuesReferences` and has always had it —
 * but the number was an `<a target="_blank">`, so the one cross-reference
 * GitHub hands us for free was the one that put you in a browser. Everything
 * else in this app that knows about another view goes TO it.
 *
 * A number and a repository travel, not an issue. The Tasks view already knows
 * how to read one and is the thing that owns the reading; handing it a row
 * would mean the pull-request panel holding an opinion about what an issue
 * looks like, and inventing one for an issue that has since been deleted or
 * transferred.
 */

export interface IssueJump {
  /** The issue number, which is what the Issues view selects by. */
  number: number;
  /**
   * The checkout to read it from, when the sender knows one.
   *
   * Usually empty, and that is correct rather than lazy: the Issues view has no
   * repository picker, deliberately — issues come from the remote, and every
   * worktree of a project shares it. So the receiver's own root is right nearly
   * always, and this is here for the case it is not.
   */
  root?: string;
  /** Rises per request, so asking for the same issue twice is two arrivals
   *  rather than one that looks already served. */
  n: number;
}

let listener: ((j: IssueJump) => void) | null = null;
let seq = 0;

export function onOpenIssue(fn: ((j: IssueJump) => void) | null): () => void {
  listener = fn;
  return () => { if (listener === fn) listener = null; };
}

/** Open the Tasks view on this GitHub issue. */
export function openIssue(number: number, root?: string): void {
  if (!Number.isInteger(number) || number <= 0) return;
  listener?.({ number, root, n: ++seq });
}
