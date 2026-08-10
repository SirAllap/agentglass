/*
 * A safety copy of the user's last good resurrect save.
 *
 * Measured on a real machine, and it cost a working session. resurrect keeps
 * every save it has ever made and a `last` symlink pointing at the newest;
 * continuum saves on a timer. When the tmux server was killed, a save fired
 * while it was going away and wrote a file with ONE pane in it — then `last`
 * pointed at that. The good save from ten minutes earlier, with five sessions
 * and a running agent in it, was still on disk and no longer reachable by
 * anything that restores. Timestamps, in order:
 *
 *   19:53:17   1356 bytes   5 sessions, 9 panes, the agent among them
 *   20:03:10    166 bytes   1 pane          <- `last` now points here
 *   20:03:47                the next server starts and restores THAT
 *
 * The same shape had already emptied `assistant-sessions.json` once before, so
 * it is not a freak: a save on a dying or newborn server is a poorer answer
 * than the one it replaces, and resurrect has no notion of "poorer".
 *
 * agentglass cannot stop that save — it is somebody else's timer on somebody
 * else's plugin, and racing it would be two savers on one server, which is its
 * own way to lose sessions. What it can do is keep the good file where nothing
 * else writes, and put `last` back when it can PROVE the current one is a
 * clobber.
 *
 * The rules this holds to, because this is the user's own data:
 *
 *   - Copies live in our directory. Their resurrect saves are read, never
 *     written and never deleted.
 *   - The only write into their directory is the `last` symlink, only when the
 *     file it points at is strictly poorer than a copy we took, and never
 *     without keeping what it pointed at first.
 *   - We restore nothing ourselves. Repointing `last` is what makes THEIR
 *     restore do the right thing, which is the opposite of competing with it.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, renameSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * Home, read from the environment first.
 *
 * Measured on Bun 1.3.9: `os.homedir()` does NOT follow `$HOME` — it resolves
 * out of the passwd entry, so a test that redirects HOME still gets the
 * developer's real home and every path below points at their live resurrect
 * saves. The rest of this repo never noticed because it hangs everything off
 * `XDG_CONFIG_HOME`, and there is no XDG variable for `~/.tmux`.
 *
 * `$HOME` first is also correct outside the test: it is what every other
 * program on POSIX honours, so a session started with a different HOME finds
 * the saves that session is actually using.
 */
const home = (): string => process.env.HOME || homedir();

/** Where resurrect keeps its saves. Read-only to us, apart from `last`. */
export function resurrectDir(): string {
  return join(home(), ".tmux", "resurrect");
}

/** Where our copies go. Deleting this directory costs the safety net and
 *  nothing else. */
export function snapshotDir(): string {
  return join(
    process.env.XDG_CONFIG_HOME || join(home(), ".config"),
    "agentglass",
    "resurrect",
  );
}

/**
 * Under `bun test`, the real directories are off limits — same rule as the
 * config and the database. A suite redirects HOME and XDG_CONFIG_HOME at a
 * scratch directory and gets exactly what it put there; anything else reads as
 * "no saves", so no test can read or repoint the developer's own resurrect.
 */
const offLimits = (p: string): boolean => {
  if (process.env.NODE_ENV !== "test") return false;
  const scratch = tmpdir();
  return p !== scratch && !p.startsWith(scratch + "/");
};

/** How many copies to keep. Enough to step back past a bad afternoon, few
 *  enough that the directory stays something a person can read. */
export const KEEP = 5;

/**
 * What a save is worth, in panes.
 *
 * Panes rather than bytes: `@resurrect-capture-pane-contents` makes the file
 * size depend on how much scrollback happened to be on screen, so a save of an
 * empty server after a busy one can be larger and still hold nothing. A pane
 * line is one pane, and that is the thing being lost.
 */
export function panesIn(text: string): number {
  return text.split("\n").filter((l) => l.startsWith("pane\t")).length;
}

/** The file `last` really points at, and how much is in it. */
export function readLast(): { path: string; panes: number; text: string } | null {
  const link = join(resurrectDir(), "last");
  if (offLimits(link)) return null;
  try {
    const path = realpathSync(link);
    const text = readFileSync(path, "utf8");
    return { path, panes: panesIn(text), text };
  } catch { return null; }
}

/** Our copies, richest first, then newest first. */
export function snapshots(): { path: string; panes: number }[] {
  const dir = snapshotDir();
  if (offLimits(dir)) return [];
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".txt")); }
  catch { return []; }
  const out: { path: string; panes: number }[] = [];
  for (const n of names.sort().reverse()) {
    const path = join(dir, n);
    try { out.push({ path, panes: panesIn(readFileSync(path, "utf8")) }); }
    catch { /* unreadable copy: not a copy */ }
  }
  return out.sort((a, b) => b.panes - a.panes || (a.path < b.path ? 1 : -1));
}

/** The one worth putting back. */
export const bestSnapshot = (): { path: string; panes: number } | null => snapshots()[0] ?? null;

/**
 * Take a copy, if there is something worth copying.
 *
 * A save with fewer than two panes is exactly the shape of the clobber this
 * exists for, so it is never worth keeping: a real session has more than one
 * pane, and a single-pane save is either a brand-new server or a dying one.
 *
 * Returns the copy's path, or null when nothing was taken — which is the
 * ordinary case, since this runs on a timer and most ticks find the same file.
 */
export function snapshot(): string | null {
  const last = readLast();
  if (!last || last.panes < 2) return null;
  const dir = snapshotDir();
  if (offLimits(dir)) return null;
  const to = join(dir, basename(last.path));
  try {
    if (existsSync(to)) return null; // already have this exact save
    mkdirSync(dir, { recursive: true });
    copyFileSync(last.path, to);
    // Oldest by name, which is a timestamp, so sorting is chronological.
    const all = readdirSync(dir).filter((n) => n.endsWith(".txt")).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
      try { rmSync(join(dir, old)); } catch { /* it is only a copy */ }
    }
    return to;
  } catch { return null; }
}

/**
 * Has `last` been clobbered by a poorer save than one we hold?
 *
 * Strictly poorer, and never merely different: a user who closes four sessions
 * on purpose has a smaller save and means it. What this catches is the save
 * that lands with one pane over one that had nine, which is not a decision
 * anybody made.
 */
export function clobbered(): { now: number; had: number; from: string } | null {
  const last = readLast();
  const best = bestSnapshot();
  if (!last || !best) return null;
  if (last.panes >= best.panes) return null;
  // One pane against several is the signature. Two against three is somebody
  // closing a pane, and is none of our business.
  if (last.panes > 1) return null;
  return { now: last.panes, had: best.panes, from: best.path };
}

/**
 * Put `last` back, so THEIR restore reads the good save.
 *
 * The only write this module makes into the user's directory, and the smallest
 * one that fixes anything: a symlink, to a file resurrect wrote itself. What it
 * pointed at is kept as `last.clobbered` first, so nothing is destroyed by the
 * repair either — including the possibility that this judgement was wrong.
 *
 * Returns what it pointed at now, or null when there was nothing to repair.
 */
export function repairLast(): { restored: string; kept: string } | null {
  const bad = clobbered();
  if (!bad) return null;
  const dir = resurrectDir();
  const link = join(dir, "last");
  if (offLimits(link)) return null;
  try {
    const was = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : basename(realpathSync(link));
    // A plain file rather than another symlink, so it cannot be mistaken for
    // the live pointer by anything that follows links.
    copyFileSync(realpathSync(link), join(dir, "last.clobbered"));
    /*
     * Written beside it and moved into place, because a symlink cannot be
     * replaced atomically any other way — and a `last` that is missing for even
     * a moment is a restore that finds nothing.
     */
    const tmp = join(dir, `.last.agx-${process.pid}`);
    symlinkSync(basename(bad.from), tmp);
    renameSync(tmp, link);
    return { restored: basename(bad.from), kept: was };
  } catch { return null; }
}

/** Somewhere for a caller to say where the copies are, without importing paths. */
export const snapshotWhere = (): string => dirname(join(snapshotDir(), "x"));
