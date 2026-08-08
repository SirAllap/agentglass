/*
 * Making a pane's input line say something else.
 *
 * The phone's field is not a copy of the pane's line — it IS the line. What was
 * typed at the computer is already in it when you pick the phone up, and every
 * edit made here is sent onward as it is made, so a backspace on the phone's
 * keyboard is a backspace on the computer.
 *
 * Which means the field cannot just hand over its contents: the pane has a line
 * already, and a terminal has no way to be told "the line is now this". It has
 * a keyboard, and that is all. So the difference is worked out here and sent as
 * the keystrokes that would have produced it.
 *
 * ── WHEN ANY OF THAT IS TRUE, which is narrower than it sounds ────────────
 * Only when the page could READ the pane's line, and it can only read a line
 * whose prompt marker is the first thing on it after any box drawing — see
 * `lineNow` in terminal-html.ts, where the alternative was measured to type
 * DELs into people's real commands (`make build > log.txt` believed to be
 * `log.txt`). An agent's boxed `│ > ` prompt reads. A shell's does not:
 * bash's `user@host:~/code$ ` and fish's `user@host ~/code>` both put
 * something in front of the marker, so the page answers null and the field is
 * an ordinary composer that sends nothing until Enter.
 *
 * That is worth writing down here because it was reported as this file having
 * regressed, and it had not: measured on the emulator against a pane whose
 * prompt is `> `, typing `abc` put `> abc` on the pane and two backspaces left
 * `> a`, exactly as below. Measured against the same phone attached to a bash
 * pane, typing `hello` delivered nothing at all — correctly, because nothing
 * has been sent yet and the field says so ("Write a line for this pane"). The
 * claim that a delete on the phone is a delete on the computer is true for the
 * prompts this can read and false for the ones it cannot, and it had only ever
 * been stated as the first half.
 */

/** DEL, which is what a terminal's erase key sends.
 *
 *  Not `\b`. Backspace moves the cursor one to the left and deletes nothing —
 *  a line edited with it looks right on the phone and is wrong on the computer,
 *  which is the worst of the two possible failures. readline, every shell and
 *  every TUI listen for this one. */
const DEL = "\x7f";

/**
 * The keystrokes that turn `was` into `next` on the pane.
 *
 * Erase back to where the two lines still agree, then type the rest. An edit in
 * the MIDDLE is therefore retyped from that point rather than patched in place,
 * which costs a few characters on the wire and buys the only version that
 * cannot get out of step: the cursor on the pane is somewhere this app cannot
 * see, so anything cleverer would be guessing about it.
 *
 * The prefix is compared by CODE POINT and not by `string[i]`. Indexing walks
 * UTF-16 units, so an emoji or any character outside the basic plane is two
 * steps, and a mismatch landing between its halves would send half a character
 * — and count it as one erase when the terminal holds one glyph.
 */
export function editFor(was: string, next: string): string {
  if (was === next) return "";
  const a = [...was];
  const b = [...next];
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  // Erases are counted in characters the terminal holds, which is why this
  // counts array entries rather than `was.length`.
  return DEL.repeat(a.length - same) + b.slice(same).join("");
}
