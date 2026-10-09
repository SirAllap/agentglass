/*
 * When a board asks its server again without being told to.
 *
 * Idle, a focused list board used to ask every two minutes against a 60 s
 * server clock: 60 reads an hour (2 ClickUp requests each), for a view nobody
 * was touching. Now it asks every five minutes, and the moments that matter
 * ask sooner on their own:
 *   - Refresh, and any local edit, force a read (they never come through here);
 *   - coming back to the window asks again once the rows are a minute old, so
 *     a board left behind the terminal is fresh by the time it is looked at.
 *
 * The ceiling: a window that stays focused and untouched shows rows up to five
 * minutes old. Cause and age are the whole decision, so it is tested here and
 * not in the screen.
 */
export const BOARD_POLL_MS = 300_000;
export const BOARD_FOCUS_MS = 60_000;
/** How often the timer wakes to look. Looking is free: only `boardDue` asks. */
export const BOARD_TICK_MS = 60_000;

export function boardDue(now: number, at: number | undefined, cause: "tick" | "focus"): boolean {
  if (!at) return true;
  return now - at >= (cause === "focus" ? BOARD_FOCUS_MS : BOARD_POLL_MS);
}
