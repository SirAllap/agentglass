/*
 * The Terminal strip's keyboard doors, for the app-level chords.
 *
 * Ctrl+Alt+J, Ctrl+Alt+N and Ctrl+Shift+T are app chords (App.tsx owns the
 * keydown), but what they do lives with the strip: its Go list, its windows,
 * tmux's door. The strip says what it can do while it is on screen and the
 * chord asks. Nothing registered means no strip is up, and a chord that
 * cannot be answered returns false so it falls through to whoever else wants
 * it rather than being eaten.
 */
export interface StripDoors {
  /** Open the Go list under the project chip (or close it when it is open). */
  goList: () => void;
  /** Jump to the next window waiting for you; false when nothing waits. */
  needYou: () => boolean;
  newShell: () => void;
}

let doors: StripDoors | null = null;

/** The strip on screen takes the doors; the returned function gives them back. */
export function registerStripDoors(d: StripDoors): () => void {
  doors = d;
  return () => { if (doors === d) doors = null; };
}

/** Whether a strip is on screen to take Alt+1..9. */
export const stripUp = (): boolean => doors !== null;

export type StripChord = "goList" | "needYou" | "newShell";

/** Run a chord on the strip that is up. False when there is none, or it has no answer. */
export function runStripChord(which: StripChord): boolean {
  if (!doors) return false;
  if (which === "needYou") return doors.needYou();
  doors[which]();
  return true;
}
