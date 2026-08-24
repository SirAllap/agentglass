/*
 * A picture from the phone, into the prompt of whatever is running in the pane.
 *
 * ── why a path and not the bytes ─────────────────────────────────────────
 * Because a TUI has no way to take an image over a pseudo-terminal. What every
 * agent CLI does accept is a FILE PATH, and that is what a desktop paste of an
 * image actually delivers: the file is written somewhere and its name goes
 * into the prompt. So the phone uploads the bytes, the server writes them
 * outside any checkout and answers with a path, and the path is pasted.
 *
 * ── and why it is pasted rather than typed ───────────────────────────────
 * Bracketed paste. Wrapped in the two markers below, a TUI that has enabled
 * the mode — Claude Code, Codex and the rest all do — treats the whole run as
 * one insertion. Sent as bare keystrokes instead, a path is forty individual
 * characters arriving at a composer that may be doing something with a few of
 * them: `/` opens a command menu in more than one of these, and a slash is the
 * one character a path is guaranteed to contain.
 *
 * The markers are also what settles the newline question. A path sent as keys
 * ends in whatever the caller appends and nothing else can say "that was one
 * thing"; inside the brackets there is no ambiguity and no Enter — the person
 * types their question after it and sends when they mean to.
 *
 * ── pure, and that is the point ──────────────────────────────────────────
 * The native picker is required lazily by the caller, so everything here can
 * be tested: what gets wrapped, what is trimmed, and what happens when the
 * server answers with something that is not a path.
 */

/** Written as an escape rather than pasted in literally: a raw control
 *  character in a source file is invisible in every diff it appears in. */
const ESC = "\u001b";

/** The two halves of bracketed paste, as xterm and every TUI expect them. */
export const PASTE_ON = `${ESC}[200~`;
export const PASTE_OFF = `${ESC}[201~`;

/**
 * The keystrokes that put `file` in the composer, and nothing else.
 *
 * A trailing space, because the next thing somebody types is a sentence about
 * the picture and `…/image.png what is wrong here` is not what they meant. It
 * is inside the brackets rather than after them so it arrives as part of the
 * same paste.
 *
 * Returns an empty string for an empty path rather than pasting two markers
 * with nothing between them, which some composers render as a stray character.
 */
export function pastePayload(file: string): string {
  const path = file.trim();
  if (!path) return "";
  return `${PASTE_ON}${path} ${PASTE_OFF}`;
}

/**
 * What the phone sends up, from what the picker gave it.
 *
 * `name` is only ever read for its extension on the server, and it is sent
 * rather than derived here because the picker knows the real one — a HEIC that
 * arrives called `.png` is a file an agent will try to read as a PNG.
 */
export interface Upload { data: string; name: string }

/** The answer `/terminal/image` gives back. */
export interface Uploaded { ok: boolean; file?: string; error?: string }

/**
 * The path an upload produced, or the reason there is none.
 *
 * Its own function because "the request worked" and "the server wrote a file"
 * are two different things, and a screen that read `ok` alone would paste
 * `undefined` into somebody's prompt — which would then be sent.
 */
export function fileFrom(answer: Uploaded | null | undefined): { file: string } | { error: string } {
  if (!answer) return { error: "The computer did not answer." };
  if (!answer.ok) return { error: answer.error || "That image could not be sent." };
  const file = typeof answer.file === "string" ? answer.file.trim() : "";
  if (!file) return { error: "The computer took the image but did not say where it put it." };
  return { file };
}
