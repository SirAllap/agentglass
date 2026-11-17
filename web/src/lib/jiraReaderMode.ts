/*
 * The open card's own bare-letter keys: `r` for reader mode (a wide, chrome-free read of the description,
 * drawn over the card) and `e` for the description's own edit box — both outside any field, both plain
 * (no modifier). Esc then closes only what the letter opened, never the card behind it or the dock
 * around it. The card's keydown handler keeps a listener of its own to do that: registered once, on
 * mount, with no dependency that would make it re-add itself later — a child component's listener
 * always goes on *before* its parent's (JiraDock's own Esc-closes-the-card one), so as long as it stays
 * first in the list it sees Escape first and marks it `defaultPrevented` before the parent's handler
 * ever asks.
 */
import { typingInto } from "./taskGrammar.ts";

/** A bare letter, outside a field: no modifier, not typing. */
function bareKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">, target: EventTarget | null, key: string): boolean {
  return e.key === key && !e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey && !typingInto(target as HTMLElement | null);
}

/** A bare `r`: opens (or, from the card's handler, toggles) reader mode. */
export const opensReader = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">, target: EventTarget | null): boolean => bareKey(e, target, "r");

/** A bare `e`: opens the description's own edit box (the same box the pencil opens). */
/** A bare `c`: the Activity tab with the comment box focused, the same landing as the right-click "Comment". */
export const opensComment = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">, target: EventTarget | null): boolean => bareKey(e, target, "c");

/** A bare `w`: the Work tab, what the card's agents are doing and did, the same landing as the menu's "What its agent did". */
export const opensWork = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">, target: EventTarget | null): boolean => bareKey(e, target, "w");

/** A bare `o`: the card in Jira, the same as the header's More ▸ Open in Jira. */
export const opensInJira = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">, target: EventTarget | null): boolean => bareKey(e, target, "o");

/** A bare `t`: the card's live agent's terminal tab, brought forward (the header's agent chip does the same). */
export const opensAgentTab = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">, target: EventTarget | null): boolean => bareKey(e, target, "t");

/** A bare `y` ("yank"): copies the open card's Jira link, through the header's own button so it shows "Copied". */
export const copiesLink = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">, target: EventTarget | null): boolean => bareKey(e, target, "y");

/** Shift+Y: the link as Markdown with the card's title, what the copy button gives on a Shift-click. */
export const copiesMarkdownLink = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">, target: EventTarget | null): boolean =>
  e.key === "Y" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !typingInto(target as HTMLElement | null);

export const opensDescriptionEdit = (e: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "metaKey" | "altKey">, target: EventTarget | null): boolean => bareKey(e, target, "e");
