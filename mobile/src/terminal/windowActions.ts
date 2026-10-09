/*
 * Renaming and closing a tmux window from the phone.
 *
 * The server has done both for the desk's terminal panel for a while
 * (`POST /terminal/tmux/windows`, ops `rename` and `kill-window`); the phone
 * could only open windows, so a window opened by mistake stayed on the
 * computer until somebody walked to it. What is here is the part that is not
 * the screen: the request, the name rule, and the sentence that goes in front
 * of the one irreversible thing.
 *
 * The name rule is the server's, copied rather than imported (the server does
 * not ship to the phone) — a name the phone lets through and the server
 * refuses would be a button that fails after you have typed.
 */
import type { Tab } from "./tabs.ts";

const TITLE = /^[\w ._/-]{1,40}$/;

/** Null when the name will be taken. */
export function titleProblem(title: string): string | null {
  if (!title.trim()) return "A window needs a name.";
  if (title.length > 40) return "40 characters at most.";
  if (!TITLE.test(title)) return "Letters, digits, spaces and . _ / - only.";
  return null;
}

/** The body for `POST /terminal/tmux/windows`. No directory: the route wants
 *  one only for a window that starts somewhere. */
export function windowRequest(
  tab: Pick<Tab, "session" | "windowId">,
  op: "rename" | "kill-window",
  title?: string,
): { session: string; op: string; windowId: string; title?: string } {
  return { session: tab.session, op, windowId: tab.windowId, title };
}

/** What closing costs, said before it is done. A split window is several
 *  panes and one tap, which is the case a person does not expect. */
export function closeWords(tab: Pick<Tab, "windowName" | "windowPanes">): string {
  const what = tab.windowPanes > 1 ? `its ${tab.windowPanes} panes stop` : "what is running in it stops";
  return `“${tab.windowName}” closes on the computer, and ${what}. This cannot be undone.`;
}
