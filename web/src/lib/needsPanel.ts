// The decisions behind the "waiting on you" panel, out of the component so
// they can be tested without a renderer.

/** How wide the panel is drawn, and the gap it keeps from every edge. */
export const NEEDS_PANEL_W = 380;
const GAP = 8;

/**
 * Whether a panel opened for `openedFor` should still be open now that the
 * list reads `current`.
 *
 * The open flag used to outlive the list it was opened for. The panel hid when
 * the chip went away, but the flag stayed true, so the NEXT alert — minutes
 * later, about something else — drew the panel again with nobody having asked
 * for it. A panel that opens by itself and then has nothing to click outside of
 * is a panel that stays on screen. It closes, for good, once nothing it was
 * opened for is still waiting.
 */
export function needsStaysOpen(openedFor: readonly string[], current: readonly string[]): boolean {
  return openedFor.some((k) => current.includes(k));
}

/**
 * Where the panel goes, horizontally.
 *
 * Centred under the chip, then pulled back so it ends before `rightLimit` — the
 * left edge of the bar's right-hand group, which holds the plan usage. Clamped
 * only to the window, it hung over the usage meter on any window where the chip
 * sat right of centre. When the room between the left edge and the limit is
 * narrower than the panel, the limit loses: a panel cut off by the window is
 * worse than one that overlaps a meter.
 */
export function needsPanelLeft(
  anchor: { left: number; width: number },
  viewportW: number,
  rightLimit: number | null,
  width = NEEDS_PANEL_W,
): number {
  const end = Math.min(viewportW, rightLimit ?? viewportW) - GAP;
  const centred = anchor.left + anchor.width / 2 - width / 2;
  return Math.max(GAP, Math.min(centred, end - width));
}
