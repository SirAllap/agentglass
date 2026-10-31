import { requestWorktreeJump } from "./worktreeJump.ts";

/** What a board says in its footer after a button: the sentence, whether it
 *  went well, and optionally the place the sentence is about. */
export type FooterNote = { ok: boolean; text: string; go?: { label: string; run: () => void } };

export const SHOW_IN_TERMINAL = "Show in Terminal";

/**
 * The note for something that was opened in a terminal window. Success carries
 * the way to that window; a failure opened nothing, so there is nothing to show.
 * `show` is a parameter so the test does not need the view store.
 */
export function terminalNote(ok: boolean, text: string, show: () => void = () => requestWorktreeJump({ view: "term" })): FooterNote {
  return ok ? { ok, text, go: { label: SHOW_IN_TERMINAL, run: show } } : { ok, text };
}
