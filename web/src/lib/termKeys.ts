// Which keys the terminal panel takes, and which belong to the shell.
//
// The panel sits around a real PTY, so any chord it claims is a chord the
// program inside no longer gets. That makes this a short list, kept here rather
// than inline in the panel so it can be read — and tested — on its own.

/**
 * The key that opens find: Ctrl+Shift+F, or Cmd+F where Cmd is not the shell's
 * to begin with.
 *
 * Deliberately not plain Ctrl+F. #8 asked for it, and every other app binds it,
 * but in a terminal it is already taken: readline reads it as forward-char, and
 * less, vim and emacs all page forward on it. Binding it here would break the
 * program running in the shell to add a feature to the panel around it. The
 * terminals that have solved this — VS Code, GNOME Terminal, Konsole — settled
 * on Ctrl+Shift+F for the same reason.
 */
export function isFindChord(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (e.key !== "f" && e.key !== "F") return false;
  if (e.altKey) return false; // Alt+F is forward-word
  if (e.metaKey) return true; // macOS, where Cmd is the app's
  return !!e.ctrlKey && !!e.shiftKey;
}
