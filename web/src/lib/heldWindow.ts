/*
 * Is the window on screen being held by somebody else — narrowed, or zoomed by
 * a phone?
 *
 * Pulled out of the terminal panel so the decision can be tested without a
 * renderer: the card it drives flashed up on its own, and the only way to pin
 * down "on its own" is to feed it the frames that did it.
 */
import type { TmuxWindow } from "../../../shared/types.ts";

export interface Held {
  win: TmuxWindow;
  narrow: { winCols: number; deskCols: number } | null;
  zoomed: boolean;
}

/**
 * The window the desk is showing, and what is holding it, or null.
 *
 * The window on screen is narrower than the terminal drawing it.
 *
 * tmux sizes a shared window to fit every client, so a phone attaching with a
 * fit reflows this desk to 80 columns and the desk is given no explanation
 * whatsoever — the panes just get small and stay small.
 *
 * The condition is the size comparison, never `w.phone` and never a
 * server-side list of who is attached. A phone with no fit costs the desk
 * nothing and is the common case, so a notice keyed on presence would cry
 * wolf on it; and a registry disagrees with tmux the moment a fit fails, a
 * phone changes window, or a phone's socket dies without cleanup running.
 * This asks tmux what the window is, which cannot be wrong about it.
 *
 * Columns ONLY. Measured: a 200×50 client gives a 200×49 window, because tmux
 * spends a row on the status line — so a rows comparison fires on every desk
 * that has a bar, forever.
 *
 * A window with no `cols` is one tmux did not answer a size for, which is not
 * the same claim as "narrow" — it takes the notice off, not on.
 *
 * And the second way a phone takes this window: it zooms it.
 *
 * A phone attaches to a WINDOW, so a four-pane window gave it four tabs
 * drawing the same 2x2 grid — the server now zooms the pane that was tapped
 * so one tab means one pane. That flag is on the shared window, so the desk
 * gets a window with one pane where it had four. It is not narrow, so the
 * comparison above cannot see it, and it is just as much of a "what happened
 * to my layout" as the width is.
 *
 * `phone` IS the condition here, and that is the opposite of the rule above
 * on purpose. Zoom is a key people press for themselves several times a day
 * (`prefix z`); a notice on every zoomed window would be an explanation for
 * something that needs none, forever. So it fires only while a phone is on
 * the window. The cost is the mirror image of what the width notice avoids: a
 * desk that zoomed a window ITSELF while a phone happened to be on it is told
 * the phone did it. Wrong attribution on a rare case beats a permanent false
 * alarm on a common one — and the button gives the panes back either way.
 *
 * The other end of it — a phone that dies without its teardown running leaves
 * the window zoomed and this notice gone — is left alone deliberately. That
 * state is one `prefix z` from fixed, which is a key the person already has,
 * unlike a window pinned at 80 columns.
 *
 * One card for both reasons rather than two that can stack: they have the
 * same cause, the same button, and the same fix — and a desk that has lost
 * both its width and its panes has one problem, not two.
 */
export function heldWindow(
  tmuxActive: boolean,
  windows: TmuxWindow[],
  activeWindow: string | null,
  client: { cols: number; rows: number } | null,
): Held | null {
  /*
   * The window the strip highlights, but only once tmux agrees it is showing
   * it. A clicked tab is highlighted a round trip before tmux switches, and
   * until tmux does, the width it reports for that window is whatever the
   * window had the last time a client showed it: tmux resizes only the window
   * a client is on (measured on 3.7, `window-size latest` with
   * `aggressive-resize on`: a tab left behind at 152 columns stays 152 while
   * the desk is 174, and is 174 in the same command list that selects it). So
   * the leftover width read as a reflow, and the card flashed for exactly the
   * round trip. Nothing is lost by waiting for it — tmux resizes the window as
   * it selects it, and a window that is STILL narrow after that is the real
   * thing, reported on the next frame.
   */
  const win = windows.find((w) => w.id === activeWindow && w.active) ?? null;
  const zoomed = tmuxActive && !!win?.phone && !!win?.flags.includes("Z");
  const narrow = tmuxActive && win?.cols && client && win.cols < client.cols
    ? { winCols: win.cols, deskCols: client.cols }
    : null;
  return win && (narrow || zoomed) ? { win, narrow, zoomed } : null;
}
