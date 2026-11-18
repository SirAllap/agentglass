/*
 * Which tabs carry the seat's glyph instead of the ordinary dot.
 *
 * The tab strip marks a tab only when something matters (lib/windowMark.ts);
 * the seat's tab is the one exception — it always draws something, because
 * the glyph's whole job is to say "this is the one" at a glance, even idle.
 * The colour is still the dot's own (idle reads as nothing elsewhere, so it
 * gets its own muted tone here), so state is never lost to the shape change.
 */
import type { Mark } from "./windowMark.ts";

export type SeatTone = "idle" | "working" | "needs-you";

/** Not the seat's pane: null, and the tab draws exactly what it always drew. */
export function seatGlyphTone(seat: boolean | undefined, mark: Mark | null): SeatTone | null {
  if (!seat) return null;
  if (mark === "needs-you") return "needs-you";
  if (mark === "working") return "working";
  return "idle";
}
