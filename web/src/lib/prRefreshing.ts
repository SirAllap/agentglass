// What a card shows between "the update finished" and "GitHub has been read again".
//
// Measured: after an Update, the card keeps its OLD state for about ten seconds.
// `doUpdateBranch` calls `loadList(true)`, but `listPrs` answers with the cache
// it already has and starts the GitHub read in the background (server/src/prs.ts
// `refreshList`), so the board sees the same rows. The next look at them comes
// from the settle ladder (lib/prSettle.ts: 0.5, 1, 2, 4, 8 s), and the row only
// changes when a ladder step asks after the server's read has landed — measured
// at 9.8 s against a stub GitHub, in prRefresh.ts.
//
// So the fix is not a shorter poll: it is to read THAT pull request directly as
// soon as the write returns (`PrDetail`, forced), and hold the card in a
// `refreshing` state until that answer arrives. If it never does, the ceiling
// clears it and the event line says the read did not come back.
//
// The decision is here, apart from the screen, and the store beside it is only
// the map of who is refreshing.

/** After this long, a refresh that has not landed stops claiming one is coming. */
export const REFRESH_CEILING_MS = 45_000;

export type RefreshPhase = "reading" | "expired";

/** `null` when this pull request is not refreshing; otherwise which state its card draws. */
export function refreshPhase(since: number | undefined, now: number): RefreshPhase | null {
  if (!since) return null;
  return now - since >= REFRESH_CEILING_MS ? "expired" : "reading";
}

/**
 * Whether a read after a write shows the branch having moved.
 *
 * GitHub answers 202 for an update it has queued ("has not moved the branch
 * yet"), and the reads that follow it in the next seconds return the OLD head;
 * clearing on one of those puts the card back on "Update · N" for a merge that
 * is still coming. Only a different head, or nothing to compare against, ends
 * the hold.
 */
export function refreshMoved(headBefore: string | null | undefined, headSha: string | null | undefined): boolean {
  return !headBefore || headSha !== headBefore;
}
