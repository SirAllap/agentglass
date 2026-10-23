/**
 * What "Restore now" says it did. The server's `restored` is the number of
 * windows it stood back up (a session can hold several), so the note counts
 * windows: five windows in two sessions read "Restored 5 sessions" before.
 */
export function restoredNote(windows: number): string {
  return `Restored ${windows} window${windows === 1 ? "" : "s"}.`;
}
