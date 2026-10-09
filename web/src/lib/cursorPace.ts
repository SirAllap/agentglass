// How long the editor-cursor poll waits before it asks again, or null for "not
// at all".
//
// Measured: with the window not looked at, the poll re-armed a 450 ms timer
// that asked nothing, 8,000 wake-ups an hour for a pane nobody could see. The
// answer to "should I ask again" while unlooked is "no, and the window will say
// when it is back" (focus, visibilitychange), which is a timer that does not
// exist. Once five answers in a row said the cursor had not moved it rests at
// 1.5 s, and the first change takes it back to 450 ms. The ceiling: the first
// move after a rest is seen up to 1.5 s late.
export const CURSOR_MS = 450;
export const CURSOR_SLOW_MS = 1500;
export const CURSOR_STILL = 5;

export function cursorDelay(looking: boolean, still: number): number | null {
  if (!looking) return null;
  return still >= CURSOR_STILL ? CURSOR_SLOW_MS : CURSOR_MS;
}
