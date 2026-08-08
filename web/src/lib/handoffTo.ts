/*
 * Where handing something to Claude lands: the app's chat, or a tmux pane.
 *
 * Its own file because two panels ask — the ClickUp card and the pull request —
 * and a preference that lives inside one of them is a preference the other has
 * to import a panel to read. It is four lines; the reason it exists is that it
 * is shared.
 *
 * A preference rather than a question each time: you either work in the app's
 * chat or you work in your terminal, and that changes about as often as your
 * shell does. It is a setting at all because the chat may not always be here —
 * a destination that can be deprecated should never be the only one wired in.
 */
export type HandoffTo = "chat" | "term";
const KEY = "agentglass.handoffTo";

export function handoffTo(): HandoffTo {
  try { return localStorage.getItem(KEY) === "term" ? "term" : "chat"; } catch { return "chat"; }
}
export function setHandoffTo(v: HandoffTo): void {
  try { localStorage.setItem(KEY, v); } catch { /* private mode — lasts the session */ }
}
