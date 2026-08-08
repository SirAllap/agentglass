/**
 * The copies this server writes for something to LOOK at, and the one place
 * that knows where they live.
 *
 * Two things need a file on disk that the workspace does not have: a pull
 * request's version of a file, fetched from GitHub at its head commit, and a
 * branch's version, read out of the object store. Both are read-only snapshots,
 * both go under the system temp directory, and both are opened in the editor by
 * the PTY — which has to admit them without admitting `/tmp` in general.
 *
 * It exists because that admission was a string literal, twice, in a different
 * file from the two that write the directories. Adding the second kind of copy
 * therefore produced a pane with a SHELL in it: the path was not in scope and
 * did not match the one prefix `terminal.ts` knew, so it fell back exactly as
 * its comment promises — "silently viewing a different file is worse than
 * viewing none". Correct behaviour, missing registration.
 *
 * So the only way to make one of these directories is the function whose set
 * the check reads. A third kind cannot forget to tell the terminal about itself.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What each kind of copy is called on disk. The names are load-bearing: the
 *  check below is a prefix test, and a rename here is a rename there. */
const KINDS = {
  /** A pull request's file at its head commit — see prFileToTemp. */
  pr: "agentglass-pr-",
  /** A branch's file, for anything the viewer does not render — see fileToTemp. */
  ref: "agentglass-ref-",
} as const;

export type ViewTempKind = keyof typeof KINDS;

/** A fresh directory for one copy. One file per directory on purpose: the PTY
 *  opens the editor with this directory as its view root, and a shared one would
 *  put every file anybody has ever looked at in that editor's file list. */
export function makeViewTempDir(kind: ViewTempKind): string {
  return mkdtempSync(join(tmpdir(), KINDS[kind]));
}

/**
 * True for a path this server wrote as a read-only copy.
 *
 * Used by the PTY to decide a file outside the workspace may still be opened.
 * A prefix test rather than a lookup of live directories, because the pane may
 * be opened seconds or minutes after the copy was made and a registry would
 * have to be cleaned up — and because being under a directory only this process
 * creates is already the property that matters.
 */
export function isViewTemp(abs: string): boolean {
  return Object.values(KINDS).some((p) => abs.startsWith(join(tmpdir(), p)));
}

/** The directory of such a copy, for the editor's view root — never the file's
 *  own folder, which for a working-tree peek is somebody's repository. */
export function viewTempDirOf(abs: string): string | null {
  if (!isViewTemp(abs)) return null;
  const cut = abs.lastIndexOf("/");
  return cut > 0 ? abs.slice(0, cut) : null;
}
