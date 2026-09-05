/*
 * Which checkout a container came out of.
 *
 * Container names are global. Volumes are global. Ports are global. The only
 * thing on a container that remembers where it came from is compose's
 * `working_dir` label — and the panel already reads it, to decide what to show.
 * This turns the same label into the answer to the question people actually
 * ask in front of the screen: "is that mine, or is it the other worktree's?".
 *
 * Two rules shape everything here:
 *
 *   1. No processes. Resolving an owner must cost nothing, because it happens
 *      for every container on every poll. The path match is string work, and
 *      the branch is read straight out of `.git/HEAD` — a file read, not a
 *      `git` spawn, which is the difference between free and 30ms × N.
 *   2. Unknown stays unknown. A container from a directory this machine's open
 *      project knows nothing about gets its directory name and no branch, never
 *      a guess.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

export interface DockerOwner {
  /** The checkout's directory name — what tells two clones of one branch apart. */
  worktree: string;
  /** Its current branch, or null when it could not be read (detached HEAD,
   *  a directory that is not a checkout, a path that no longer exists). */
  branch: string | null;
  /** True when this is NOT the project the cockpit is open on. That is the
   *  case worth a colour: the container is running, it just isn't yours. */
  foreign: boolean;
  /** Absolute path, for tooltips and for the "open that worktree" affordance.
   *  Never rendered raw in a chip — the leaf is what fits. */
  path: string;
}

/**
 * Is `child` inside `parent` (or the same directory)?
 *
 * Compared segment by segment rather than with `startsWith`, which would put
 * `~/code/orbit-1042` inside `~/code/orbit` — two sibling worktrees whose names
 * share a prefix, which is exactly how every worktree on this machine is named.
 */
function within(parent: string, child: string): boolean {
  if (parent === child) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * The checkout a compose `working_dir` belongs to.
 *
 * `working_dir` is the directory the stack was brought up from, which is
 * usually a subdirectory of the checkout (`<worktree>/compose`), so the match
 * is "the longest known root that contains it" — longest because
 * `~/code/orbit` and `~/code/orbit/packages/api` can both be legitimate roots
 * and the narrower one is the truer answer.
 */
export function ownerOf(workingDir: string | null | undefined, family: string[], openRoot: string | null): DockerOwner | null {
  if (!workingDir || !isAbsolute(workingDir)) return null;
  const dir = resolve(workingDir);

  let best: string | null = null;
  for (const root of family) {
    if (!root) continue;
    const r = resolve(root);
    if (within(r, dir) && (best === null || r.length > best.length)) best = r;
  }

  // Not one of ours: still worth naming — a stack from another project is a
  // legitimate thing to see, and "unknown" would be less true than its own
  // directory name.
  if (best === null) {
    return { worktree: basename(dir) || dir, branch: branchOfCheckout(dir), foreign: true, path: dir };
  }
  return {
    worktree: basename(best) || best,
    branch: branchOfCheckout(best),
    foreign: openRoot === null ? false : resolve(openRoot) !== best,
    path: best,
  };
}

/* -------------------------------------------------------------------------
 * The branch, without spawning git.
 *
 * `git rev-parse --abbrev-ref HEAD` costs a process — about 30ms — and this
 * runs once per distinct checkout on every poll. `.git/HEAD` is one line and
 * the answer is in it; the cache below only exists so that a poll over twelve
 * containers from three worktrees does three file reads, not twelve.
 * ---------------------------------------------------------------------- */

const TTL_MS = 5_000;
const branchCache = new Map<string, { at: number; branch: string | null }>();

/** Test seam: the cache is keyed by path and lives as long as the process. */
export function __resetBranchCacheForTest(): void {
  branchCache.clear();
}

/**
 * The branch checked out in `dir`, or null.
 *
 * Null covers every honest "there isn't one": a detached HEAD (which is a real
 * state, not an error — `git bisect` and `pol-base` both live there), a
 * directory that is not a checkout at all, and anything unreadable.
 */
export function branchOfCheckout(dir: string): string | null {
  const hit = branchCache.get(dir);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.branch;
  if (branchCache.size > 128) branchCache.clear();
  const branch = readBranch(dir);
  branchCache.set(dir, { at: Date.now(), branch });
  return branch;
}

function readBranch(dir: string): string | null {
  try {
    const dot = `${dir}/.git`;
    const st = statSync(dot);
    // A linked worktree's `.git` is a FILE holding `gitdir: <path>`, and that
    // path is where its own HEAD lives. Following it is the whole reason this
    // works for worktrees at all — the main repo's HEAD would report the main
    // checkout's branch for every one of them.
    const head = st.isDirectory()
      ? `${dot}/HEAD`
      : (() => {
          const line = readFileSync(dot, "utf8").trim();
          const m = /^gitdir:\s*(.+)$/.exec(line);
          if (!m) return null;
          const g = m[1]!.trim();
          return `${isAbsolute(g) ? g : resolve(dir, g)}/HEAD`;
        })();
    if (!head) return null;
    const text = readFileSync(head, "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
    return ref ? ref[1]!.trim() : null;   // a bare sha means detached
  } catch {
    return null;
  }
}

/** The directory a `.git` file points at, exported for the one caller that
 *  needs to watch it. Kept beside the reader so both stay in step. */
export function gitHeadPath(dir: string): string | null {
  try {
    const dot = `${dir}/.git`;
    const st = statSync(dot);
    if (st.isDirectory()) return `${dot}/HEAD`;
    const m = /^gitdir:\s*(.+)$/.exec(readFileSync(dot, "utf8").trim());
    if (!m) return null;
    const g = m[1]!.trim();
    return `${isAbsolute(g) ? g : resolve(dir, g)}/HEAD`;
  } catch {
    return null;
  }
}

/** Where a worktree's parent directory is — used to group "the family" in the
 *  UI without re-deriving it in three places. */
export const parentOf = (path: string): string => dirname(path);
