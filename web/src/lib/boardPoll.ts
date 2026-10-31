/*
 * When a board asks its server again without being told to.
 *
 * It does not, on a timer. A focused board used to wake every minute and ask
 * every five (12 reads an hour per board for a view nobody was touching); that
 * heartbeat is gone, and the one moment that matters asks on its own: coming
 * back to the window re-reads rows that are a minute old, so a board left
 * behind the terminal is fresh by the time it is looked at.
 *
 * Refresh, and any local edit, force a read (they never come through here).
 *
 * The ceiling: a window that stays focused and untouched shows the rows it
 * last read, and says when ("read 14:02"). Age is the whole decision, so it is
 * tested here and not in the screen.
 */
/** Not a timer: the age at which `readState` starts to doubt rows the window has
 *  not re-read. Nothing wakes up to ask when it passes. */
export const BOARD_POLL_MS = 300_000;
export const BOARD_FOCUS_MS = 60_000;

export function boardDue(now: number, at: number | undefined): boolean {
  if (!at) return true;
  return now - at >= BOARD_FOCUS_MS;
}
