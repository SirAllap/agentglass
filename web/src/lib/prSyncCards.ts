// What one card says while a lane's "Sync N" is running.
//
// The job is the popover's own (`run` and `results` in PrLaneSync): the board
// mirrors each transition into a step per pull request, and this maps a step to
// the two places on the card that can speak — the slot where "Update · N" sits,
// and the Branch cell that carries the behind count. No second read of GitHub.
//
// Why the card changes at all: the list says "Syncing 4 · 0 of 4" while every
// card under it still offered an enabled Update, so the only thing that moved
// during a 15-25 s run was a sentence in a popover that a lane header hides as
// soon as you look at the cards.
//
// A rule about states and not a renderer: there is no renderer in this project,
// and a rule that lives only inside JSX is a rule nothing checks.
import type { PrSummary } from "../../../shared/types.ts";
import { SYNC_AT_ONCE } from "./prSyncLane.ts";

/** One row of a running press. `idle` is the absence of a step, not a value here. */
export type SyncPhase = "queued" | "syncing" | "done" | "failed";

export interface SyncCardStep {
  phase: SyncPhase;
  /** The server's sentence on a failed one, or the local copy's fate on a done one. */
  detail?: string;
}

/** How long "Updated" stays before the card goes back to its own Update and its new count. */
export const SYNC_DONE_MS = 1600;

/** The mark the Update slot carries when its own spinner is not drawn: a clock, a success flash, a warning. */
export type SyncMark = "waiting" | "done" | "failed";

export interface SyncCardView {
  /** A quiet accent edge and a progress cursor, as a card with its own Update in flight already wears. */
  running: boolean;
  /** The control that stands where "Update · N" stands. */
  action: {
    label: string;
    /** Why it is off, or what happened: the tooltip. */
    title: string;
    disabled: boolean;
    /** The button's own spinner (Chrome's `pending`). */
    pending: boolean;
    mark: SyncMark;
    /** Pressing it sends the same Update again. */
    retry: boolean;
  };
  /** The Branch cell, only while the job has something of its own to say about it. */
  branch: { tone: "run"; word: string; title: string } | null;
}

/** Absent step: the card draws its own Update, its own count, nothing else. */
export function syncCardView(
  step: SyncCardStep | null | undefined,
  p: Pick<PrSummary, "number" | "headRefName" | "baseRefName">,
): SyncCardView | null {
  if (!step) return null;
  const branch = `${p.baseRefName} into ${p.headRefName}`;
  switch (step.phase) {
    case "queued":
      return {
        running: false,
        action: {
          label: "Waiting",
          title: `Queued by the lane's Sync, ${SYNC_AT_ONCE} at a time, and this one has not started. Pressing it here would send the same update twice.`,
          disabled: true, pending: false, mark: "waiting", retry: false,
        },
        branch: null,
      };
    case "syncing":
      return {
        running: true,
        action: {
          label: "Merging…",
          title: `Merging ${branch} on GitHub. It cannot be sent again until this answers.`,
          disabled: true, pending: true, mark: "waiting", retry: false,
        },
        branch: {
          tone: "run", word: "Merging…",
          title: `Merging ${branch}: the count it shows is how far behind it was before this run.`,
        },
      };
    case "done":
      return {
        running: false,
        action: {
          label: "Updated",
          title: `${step.detail ? `${step.detail}. ` : ""}The base is in, and the card is reading the new state from GitHub.`,
          disabled: true, pending: false, mark: "done", retry: false,
        },
        branch: null,
      };
    case "failed":
      return {
        running: false,
        action: {
          label: "Retry",
          title: step.detail ? `GitHub refused it: ${step.detail}. Press to send the same update again.` : "GitHub refused it. Press to send the same update again.",
          disabled: false, pending: false, mark: "failed", retry: true,
        },
        branch: null,
      };
  }
}
