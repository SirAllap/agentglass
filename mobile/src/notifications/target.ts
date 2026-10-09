/*
 * Where tapping an alert goes.
 *
 * The notification's `data` comes back from the OS on a tap, and nothing on
 * this side proves the app wrote it, so it is read as untrusted: the only
 * outcomes are the Terminal tab, with or without a tmux pane to select. A
 * value is never handed to the router as a path, only as a pane id that has
 * passed the one shape tmux hands out.
 *
 * Ceiling: an alert carries a pane or nothing (see AlertNote). A PR or card
 * target would need the alert to know it first; until then those alerts land on
 * the Terminal, which is the screen that lists the agents.
 */

export interface AlertRoute {
  pathname: "/terminal";
  params?: { pane: string };
}

/** tmux pane ids are `%` and digits. Anything else is not one. */
const PANE = /^%\d{1,9}$/;

export function alertRoute(data: unknown): AlertRoute | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.kind !== "alert") return null;
  if (typeof d.pane === "string" && PANE.test(d.pane)) return { pathname: "/terminal", params: { pane: d.pane } };
  return { pathname: "/terminal" };
}
