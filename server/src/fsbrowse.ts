// Directory-name completion for the project picker's "type a folder" input.
//
// Typing `/mnt/hdd/code/current_project/alavera_app` by hand, with no feedback
// until you submit and no way to see what's actually there, is the worst part
// of opening a project that the repo sweep didn't find. This is the smallest
// thing that fixes it: given whatever the user has typed so far, hand back the
// sibling directories that match, so the UI can complete rather than guess.
//
// Deliberately narrow: directory NAMES only. It never opens a file, never
// reports one, and never reveals a file's size or contents — the answer to
// "what's in this folder" is only ever the subfolders you could plausibly open
// as a project.
//
// On scope: this is NOT restricted to `configuredRepoDirs()`. `repoDirs` is
// empty in the default install, so restricting to it would leave the feature
// dead for almost everyone — and this input exists precisely for projects
// living outside the swept directories. The endpoint sits behind the same
// origin/rebinding/token gate as the rest of the surface, which is the real
// boundary; this module's job is only not to widen it.
//
// That reasoning has a limit worth naming. The tempting argument is "the same
// gate already fronts /terminal/pty, which hands out a login shell, so anyone
// who can reach this could already `ls` the machine". True by default — but
// AGENTGLASS_TERMINAL_DISABLED=1 exists, and an operator who turns the shell
// off has deliberately given up that capability. Silently handing it back a
// directory listing at a time would quietly undo their decision, so this gets
// its own switch rather than riding on the terminal's.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname, basename, sep } from "node:path";
import { SKIP_DIRS } from "./gitwork.ts";
import type { FsEntry, FsCompletion } from "../../shared/types.ts";

/** Enough to pick from, few enough that a home directory full of junk can't
 *  turn one keystroke into a megabyte of JSON (or a scrolling wall in the UI).
 *  The response says when it truncated, so the UI can tell the user to keep
 *  typing rather than silently pretend the list is complete. */
const MAX_ENTRIES = 60;

/** Kill switch for operators who don't want the machine's directory tree
 *  readable over the wire, independent of whether the terminal is enabled. */
export const FS_BROWSE_ENABLED = process.env.AGENTGLASS_FS_BROWSE_DISABLED !== "1";

// `repo` is a cheap `.git` stat per entry. Worth it: "which of these forty
// folders is actually a project" is the question the user is really asking.
const EMPTY: FsCompletion = { base: "", entries: [], truncated: false };

/** Expand a leading `~`, matching config.ts so the picker and the scope
 *  resolver agree on what `~/code` means. */
function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Split raw input into "the directory to list" and "the partial name to match".
 *
 * A trailing separator means the user has committed to that directory and wants
 * to see inside it; anything else means the last segment is still being typed
 * and is a filter, not a destination.
 *
 * Only absolute paths (or `~`-rooted ones) are answered. A bare `code` would
 * otherwise resolve against the server's working directory, which is wherever
 * the desktop app happened to be launched from — completions that shift
 * depending on how you started the process are worse than none.
 */
export function splitPrefix(input: unknown): { dir: string; partial: string } | null {
  if (typeof input !== "string") return null;
  // A NUL truncates the path at the syscall boundary, so `/safe\0/../../etc`
  // would be read as `/safe`. Refuse rather than normalise: nothing legitimate
  // types one.
  if (input.includes("\0")) return null;
  const raw = input.trim();
  if (!raw) return null;
  if (!raw.startsWith("/") && !raw.startsWith("~")) return null;
  const expanded = expandHome(raw);
  if (!expanded.startsWith("/")) return null; // `~foo` — another user's home, not ours to guess
  // Ask the *raw* input about the trailing separator: join() drops it while
  // expanding `~/`, which would turn "list my home" into "filter /home by my
  // username". Bare `~` counts as committed for the same reason.
  const committed = raw.endsWith("/") || raw === "~";
  // resolve() collapses `.`, `..` and doubled separators, so what we list is
  // always the real target rather than a path that merely spells it.
  if (committed) return { dir: resolve(expanded), partial: "" };
  return { dir: resolve(dirname(expanded)), partial: basename(expanded) };
}

/** Is this directory a git repo (or a linked worktree, whose `.git` is a file)? */
function isRepo(dir: string): boolean {
  try { statSync(join(dir, ".git")); return true; } catch { return false; }
}

/**
 * Subdirectories of the typed path that match the half-typed last segment.
 *
 * Hidden directories stay out unless the user typed a leading dot themselves:
 * `~/` is mostly dotfiles, and burying `code` under `.cache`, `.config` and
 * `.local` defeats the point. The same package/build directories the repo sweep
 * skips are dropped too — `node_modules` is never the project you meant.
 */
export function completePath(input: unknown): FsCompletion {
  const split = splitPrefix(input);
  if (!split) return EMPTY;
  const { dir, partial } = split;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return { ...EMPTY, base: dir }; }
  const wantHidden = partial.startsWith(".");
  const needle = partial.toLowerCase();
  const names: string[] = [];
  for (const ent of ents) {
    // Symlinks are followed on purpose — a code directory symlinked onto
    // another disk is a normal setup, and `isDirectory()` is false for it.
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    if (!wantHidden && ent.name.startsWith(".")) continue;
    if (SKIP_DIRS.has(ent.name)) continue;
    if (needle && !ent.name.toLowerCase().startsWith(needle)) continue;
    names.push(ent.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  // Cap and truncation are counted over *directories that survive the stat*, not
  // the raw name list. Slicing to MAX_ENTRIES up front let a symlink pointing at
  // a non-directory — dropped just below — burn a slot that a real directory
  // further down never got to fill, silently omitting openable directories. Stat
  // as we go and stop once one directory past the cap proves there are more.
  const entries: FsEntry[] = [];
  let truncated = false;
  for (const name of names) {
    const abs = dir === sep ? sep + name : dir + sep + name;
    // A symlink to a file survived the name filter above; drop it here, where
    // we're already paying for a stat to answer the repo question.
    try { if (!statSync(abs).isDirectory()) continue; } catch { continue; }
    if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
    entries.push({ name, path: abs, repo: isRepo(abs) });
  }
  return { base: dir, entries, truncated };
}
