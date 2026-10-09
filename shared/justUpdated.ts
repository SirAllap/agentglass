import { LAGGING_SENTENCE } from "./githubStatus.ts";

/**
 * Where an "Update branch" stands, judged from what GitHub shows now and never
 * from the press.
 *
 * `gh pr update-branch` answers 202: the merge is QUEUED on GitHub's side. It
 * can then silently not happen — mergeability still UNKNOWN, a conflict found
 * late — and the head stays where it was. The panel used to latch "the branch
 * was just updated, waiting for the checks" the moment the press went out, and
 * so blocked a retry for four minutes, with a false sentence, on a branch
 * whose last commit was two hours old and that had grown from 3 behind to 6.
 * That is the one state where pressing again is the right move.
 *
 * So the stages are told apart by the head commit:
 *
 *   requested  the call was accepted and the head is still the one we pressed
 *              on, inside the window. Button held: a second press queues a
 *              second merge. Says "requested", not "updated".
 *   stalled    same head, window over. GitHub did not do it. Button back, with
 *              a sentence saying so.
 *   moved      the head changed after our request: the update really happened.
 *              Only now "just updated"; held while the first runs start.
 *   fresh-head the head commit is younger than the window and no check exists
 *              yet (someone else's push, or ours seen late).
 *   idle       none of those. Never inferred from UNKNOWN mergeability or from
 *              the timestamps of checks that already passed.
 *
 * Ceiling: "fresh-head" reads the commit date, not the push date, so a commit
 * made long ago and pushed just now is only seen through our own request.
 */
export const REQUEST_WINDOW_MS = 2 * 60_000;
export const MOVED_WINDOW_MS = 4 * 60_000;
/** How long "GitHub did not update the branch" stays on screen. */
export const STALLED_SHOWN_MS = 30 * 60_000;

export interface OwnUpdate {
  /** When the call came back ok (the request was accepted), not when it was pressed. */
  at: number;
  /** The head sha the panel pressed it on. */
  headBefore: string;
}

export interface UpdateStandingInput {
  now: number;
  own?: OwnUpdate | null;
  /** The head sha as GitHub shows it now. */
  headSha?: string | null;
  headCommittedAt?: string | null;
  /** How many checks exist on the head commit. */
  checksTotal: number;
  /** The branch ref on GitHub, read fresh. Pass it only when it was read after
   *  the pull request's head last changed. */
  refSha?: string | null;
}

export type UpdateStanding = "idle" | "requested" | "stalled" | "moved" | "fresh-head" | "pr-lagging";

export function updateStanding(i: UpdateStandingInput): UpdateStanding {
  /* The branch moved and the pull request did not follow: GitHub updated it but
     has not synced its own pull request (measured: branch ref at the merge
     commit, PR head and mergeability still the old ones). Another press is
     refused with "head sha didn't match", so it is held rather than offered. */
  if (i.refSha && i.headSha && i.refSha !== i.headSha) return "pr-lagging";
  const o = i.own;
  if (o && i.now >= o.at) {
    const age = i.now - o.at;
    const moved = !!i.headSha && !!o.headBefore && i.headSha !== o.headBefore;
    if (moved) { if (age < MOVED_WINDOW_MS) return "moved"; }
    else if (age < REQUEST_WINDOW_MS) return "requested";
    else if (age < STALLED_SHOWN_MS) return "stalled";
  }
  if (i.checksTotal > 0 || !i.headCommittedAt) return "idle";
  const at = Date.parse(i.headCommittedAt);
  return Number.isFinite(at) && i.now >= at && i.now - at < MOVED_WINDOW_MS ? "fresh-head" : "idle";
}

/** Runs are expected and may not exist yet. */
export const awaitingChecksOf = (s: UpdateStanding) => s === "moved" || s === "fresh-head";
/** The button must not be pressed again right now. */
export const updateHeld = (s: UpdateStanding) => s === "pr-lagging" || s === "requested" || s === "moved" || s === "fresh-head";

export function updateHeldTitle(s: UpdateStanding): string | null {
  if (s === "pr-lagging") return `${LAGGING_SENTENCE} Pressing Update again would be refused until it does.`;
  if (s === "requested") return "Update requested — waiting for GitHub to move the branch. Pressing again now would queue a second merge.";
  if (s === "moved" || s === "fresh-head") return "The branch was just updated — waiting for the checks to start. Pushing again would restart them.";
  return null;
}

/** The sentence under a button that is back after GitHub did not move the branch. */
export function stalledNote(mergeState: string, detail?: string): string {
  const why = mergeState === "UNKNOWN"
    ? " GitHub is still computing mergeability, which can make it skip the update."
    : "";
  return `GitHub accepted the update but the branch did not move.${why}${detail ? ` ${detail}` : ""} Press again to ask once more.`;
}
