/*
 * What a card on the board can DO, and what its one press does.
 *
 * The board's cards carried a press that opened the pull request, whatever the
 * lane had asked for: a card filed under "Blocked" for a failing check said
 * "Rerun" and then took you to a screen where you pressed it again. The mock's
 * sheet 62 is the fix — approve, ask for changes, re-run, sync, or open — and
 * this is the table it draws, kept off the phone so the rules are testable.
 *
 * The two rules that are not cosmetic:
 *
 * A row this phone cannot carry out is NOT drawn. A pairing set to read-only
 * gets the sheet with "Open the pull request" alone, rather than three rows
 * that come back 403.
 *
 * A row is only offered when the pull request is open and the action has
 * something to do — "Re-run the failed checks" on a green run is a press that
 * cannot change anything, and "Approve" on somebody else's pull request you
 * were not asked to review is a review GitHub will take but nobody wanted.
 */
import type { Suggested } from "../../../shared/prLanes.ts";

export type PrActionId =
  | "approve" | "changes" | "comment" | "reviewers" | "watch" | "rerun" | "sync" | "merge" | "open";

export interface PrActionFacts {
  /** The pairing may write at all (host.scope === "full"). */
  mayWrite: boolean;
  /** The pull request's own state, as GitHub has it. */
  state: "OPEN" | "CLOSED" | "MERGED";
  /** The reader is the one being waited on: the card is in the review lane. */
  forMe: boolean;
  /** Checks that failed, from the rollup. */
  failure: number;
  /** The base branch, for the sync row's second line. */
  base?: string;
  /** The person's merge lock sentence while it holds, or null (shared/mergeLock.ts). */
  mergeLock?: string | null;
}

export interface PrActionRow {
  id: PrActionId;
  label: string;
  sub: string;
  /** Why the row is drawn but cannot be pressed — the merge lock's own sentence. */
  off?: string;
}

export function actionRows(f: PrActionFacts): PrActionRow[] {
  const rows: PrActionRow[] = [];
  const open = f.state === "OPEN";
  if (open && f.mayWrite && f.forMe) {
    rows.push({ id: "approve", label: "Approve", sub: "Records your review on GitHub." });
    rows.push({ id: "changes", label: "Request changes", sub: "Says what has to change before it lands." });
  }
  if (open && f.mayWrite) {
    rows.push({ id: "comment", label: "Comment", sub: "A note on the conversation, not a verdict." });
    rows.push({ id: "reviewers", label: "Request a review", sub: "Asks people or teams to look at it." });
    rows.push({ id: "watch", label: "Tell me when…", sub: "A notification when it goes green, is approved or changes." });
  }
  if (open && f.mayWrite && f.failure > 0) {
    rows.push({ id: "rerun", label: "Re-run the failed checks", sub: "Only the jobs that failed, on the same head." });
  }
  if (open && f.mayWrite) {
    rows.push({ id: "sync", label: "Sync this branch", sub: `Merges ${f.base ?? "the base"} in, on the computer.` });
  }
  /* The desktop card offers "Merge…" too, greyed with the lock's sentence while
     the person's merge lock holds. The press opens the merge sheet on the pull
     request, where the method and the hold live; the server refuses a locked
     merge as well, so this is the reader's warning, not the only guard. */
  if (open && f.mayWrite) {
    const lock = f.mergeLock?.trim();
    rows.push(lock
      ? { id: "merge", label: "Merge…", sub: `Merge locked: ${lock}`, off: lock }
      : { id: "merge", label: "Merge…", sub: "Opens the merge sheet on the pull request." });
  }
  rows.push({ id: "open", label: "Open the pull request", sub: "Checks, files, the conversation and merge." });
  return rows;
}

/**
 * The card's footer press.
 *
 * A write on a read-only pairing falls back to opening the pull request: the
 * label stays the lane's ("Rerun", "Merge") because it is what the lane asks
 * for, and the press takes you to the screen where the row is drawn disabled
 * with the reason. A press that silently did nothing would be worse than
 * either.
 */
export function footerPress(action: Suggested, mayWrite: boolean): Suggested {
  return mayWrite ? action : "open";
}

/**
 * The lock sentence out of `/prs/merge-lock`'s answer, or null when it does not
 * hold. A failed read is null as well: the server refuses a locked merge on its
 * own, so a phone that could not read the lock must not invent one.
 */
export function lockSaid(answer: { ok: boolean; state?: { locked: boolean; reason: string } | null } | null | undefined): string | null {
  if (!answer?.ok || !answer.state?.locked) return null;
  return answer.state.reason || "Merge locked";
}

/** What the card says after a re-run, or after GitHub refused one. */
export function rerunSaid(ok: boolean, detail?: string): string {
  if (!ok) return detail || "GitHub refused the re-run.";
  return detail || "Re-running the failed jobs.";
}
