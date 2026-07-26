// Is the shell at a prompt, or is something else holding the screen?
//
// The panel's one-click commands type into the live shell, which is the right
// model for a terminal and the wrong one when vim is up: the text lands in the
// buffer instead of at a prompt (#4).
//
// The tell is the alternate screen buffer. A full-screen program switches to it
// on entry (DECSET 1049) and back on exit, which is precisely the set of
// programs this goes wrong for: vim, htop, lazygit, less, tmux, fzf's
// full-screen mode. xterm.js tracks which buffer is active, so the question is
// answerable on the client with no shell integration at all.
//
// What this deliberately does not detect: a foreground program that stays on
// the normal screen — a running `npm install`, a `python` REPL. Typing during
// those is what a terminal does; the line queues on stdin and runs when the
// program is done with it, which is the behaviour a user of a real terminal
// expects. The damage case is the one where the keystrokes are eaten by an
// editor and silently change a file.
//
// OSC 133 prompt marking (what #4 originally proposed, and what #297 needs for
// per-command telemetry) would answer the general question, at the cost of
// injecting shell integration into whatever shell the user runs and surviving
// their rc files. Worth it for the telemetry; not needed for this.

/** Whether typing now would land inside a full-screen program rather than at a
 *  prompt. `undefined` (no terminal yet) is not a full-screen program. */
export function typingWouldLandInApp(buffer: { type?: string } | null | undefined): boolean {
  return buffer?.type === "alternate";
}
