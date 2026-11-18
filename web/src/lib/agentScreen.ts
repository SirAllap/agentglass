// What an agent's browser call does to the person's screen.
//
// "raise": the pane may be shown and the window may take focus (today's rule).
// "background": the tab loads where nobody looks. The pane does not open, the
// window is not raised and does not take focus.
//
// A pure function so the rule is one line a test can hold, and so the page that
// acts on it and the setting row that names it cannot drift apart.

export type AgentScreenMode = "raise" | "background";

/**
 * @param paneVisible whether the Browser pane is on screen right now.
 * @param agentsWithoutScreen the `browser.agentsWithoutScreen` setting.
 * A visible pane is the person watching: the call runs there as always. Only a
 * hidden pane with the setting on goes to the background.
 */
export const OFFSCREEN_FALLBACK = { w: 1280, h: 800 } as const;

/**
 * How the workspace keeps the Browser pane while it is not the view on screen.
 * "offscreen": mounted with a real size, parked off the viewport, so its
 * webviews keep painting and capturePage works (a hidden, stacked pane of a
 * different size gets no frames). "normal": the usual stacked, hidden box.
 * Only the browser pane, only when the setting is on, only while it is hidden.
 */
export function paneBoxMode(isBrowser: boolean, paneVisible: boolean, agentsWithoutScreenOn: boolean): "offscreen" | "normal" {
  return isBrowser && !paneVisible && agentsWithoutScreenOn ? "offscreen" : "normal";
}

/** The size to give the parked pane: the last visible one, else the fallback. */
export function offscreenSize(last: { w: number; h: number } | null): { w: number; h: number } {
  return last && last.w > 0 && last.h > 0 ? last : { ...OFFSCREEN_FALLBACK };
}

/** The box's `visibility`: a parked pane paints (off-viewport) so its guests keep getting frames; only a stacked inactive one is hidden. */
export function paneVisibility(active: boolean, parked: boolean, framed: boolean): "visible" | "hidden" {
  return active || (parked && !framed) ? "visible" : "hidden";
}

export function agentScreenMode(paneVisible: boolean, agentsWithoutScreen: boolean): AgentScreenMode {
  return !paneVisible && agentsWithoutScreen ? "background" : "raise";
}
