// Linked worktrees are the project on another branch — not projects of their own.
//
// The everyday layout this exists for is a repo with a dozen sibling checkouts:
//
//   ~/code/orbit                 (main)
//   ~/code/orbit-WEB-1042        (worktree, branch WEB-1042-retry-failed-uploads)
//   ~/code/orbit-WEB-1188        (worktree, branch WEB-1188-quota-banner-copy)
//
// Nothing about those paths says they belong together — they're siblings, so a
// prefix test on `~/code/orbit` matches none of them. That single fact broke the
// app in two directions at once. The picker swept the folder, found a `.git` in
// each, and listed thirteen "projects" where the user has one. And having opened
// `orbit`, the terminal, git writes and chat all refused to run in any of those
// checkouts — "outside the open project" — even though the git panel happily
// listed them as worktrees of the very project that was open.
//
// So: one place that answers "is this a linked worktree, and what family does it
// belong to", used by scope enforcement, repo discovery and session labelling
// alike. Two answers, deliberately different in cost:
//
//   worktreeParent() — one stat + one small read, no subprocess. Cheap enough to
//     call per candidate during a directory sweep of hundreds of folders.
//   worktreeFamily() — a real `git worktree list`, cached. Authoritative, and
//     the only way to go from the main repo *down* to its checkouts.
//
// Kept dependency-free (node + Bun only) on purpose: config.ts consults it from
// inScope(), and config.ts sits below everything else in the import graph.

import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The main repo a linked worktree belongs to — read from its `.git` file, with
 * no subprocess and no requirement that git can still resolve anything.
 *
 * A normal checkout has a `.git` **directory**; a linked worktree has a `.git`
 * **file** holding `gitdir: /path/to/main/.git/worktrees/<name>`. That marker is
 * the whole detection, and it survives a worktree whose registration git has
 * since forgotten (a stale `prune`), which is exactly when a subprocess answer
 * would come back empty.
 *
 * Returns null for a main checkout, a non-repo, and — importantly — a
 * *submodule*, whose `.git` is also a file but points at `.git/modules/<name>`.
 * A submodule is genuinely a different repository, so it must keep being listed
 * on its own.
 */
export function worktreeParent(dir: string): string | null {
  let raw: string;
  try {
    const dot = resolve(dir, ".git");
    // isFile() is the discriminator — cheaper and more certain than parsing.
    if (!statSync(dot).isFile()) return null;
    raw = readFileSync(dot, "utf8");
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
  if (!m) return null;
  // The path is normally absolute, but a relative one is legal and appears when
  // a worktree is moved with `git worktree repair`; resolve against the worktree
  // so both forms land on the same answer.
  const gitdir = resolve(dir, m[1]);
  // `<git-dir>/worktrees/<name>` — matched on `/worktrees/` rather than on
  // `/.git/worktrees/`, because the git dir isn't always called `.git`. The
  // other common worktree layout is a bare clone plus sibling checkouts
  // (`~/code/orbit/.bare/worktrees/main`), and hardcoding `.git` left exactly
  // those users with the unfolded picker this change exists to fix.
  const at = gitdir.lastIndexOf("/worktrees/");
  if (at === -1) return null;
  // The project is the directory holding the git dir: `<p>/.git` → `<p>`, and
  // `<p>/.bare` → `<p>`. A submodule (`<p>/.git/modules/<name>`) never reaches
  // here — it has no `/worktrees/` segment — which is what keeps a genuinely
  // separate repository from being folded away as a branch of its superproject.
  return dirname(gitdir.slice(0, at)) || null;
}

/**
 * The git directory backing a checkout — where git keeps its in-progress state.
 *
 * `<root>/.git` for an ordinary clone, but a *linked worktree* has a `.git`
 * **file** pointing at `<main>/.git/worktrees/<name>`, and that per-worktree
 * directory — not the shared one — is where `rebase-merge`, `MERGE_HEAD` and
 * friends live. Two worktrees can be mid-rebase independently, which is the
 * whole reason git separates them, and reading `<root>/.git` blindly would
 * report one checkout's rebase as if it were another's.
 *
 * Null when there is no repo here at all. Deliberately subprocess-free: this is
 * called on the render path of every git poll.
 */
export function gitDir(dir: string): string | null {
  const dot = resolve(dir, ".git");
  try {
    const st = statSync(dot);
    if (st.isDirectory()) return dot;
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dot, "utf8"));
  return m ? resolve(dir, m[1]) : null;
}

// A family is stable for as long as anyone is looking at it — worktrees are
// added by hand, not by the second. Cached briefly anyway because inScope() is
// on the path of every git write, every PTY open and every chat send, and none
// of those should pay for a subprocess. Same TTL as the repo sweep's cache, so
// adding a worktree shows up everywhere at the same time.
const FAMILY_CACHE_MS = 5_000;
const familyCache = new Map<string, { at: number; roots: string[] }>();

/**
 * Every checkout of the repository that owns `root` — the main worktree and all
 * linked ones, absolute, deduped, `root` itself always first.
 *
 * Works from any member: asking from a linked worktree returns the main repo and
 * its siblings just the same, because `git worktree list` reports the whole set
 * regardless of which one you ask from. That symmetry is what lets a user open
 * either `orbit` or `orbit-WEB-1042` as their project and still reach the rest.
 *
 * A plain folder (the "my projects live in here" scope) isn't a repo, so git
 * fails and the answer is just the folder — callers then fall back to their
 * ordinary prefix test, which is already right for that case.
 */
export function worktreeFamily(root: string): string[] {
  const hit = familyCache.get(root);
  if (hit && Date.now() - hit.at < FAMILY_CACHE_MS) return hit.roots;
  if (familyCache.size > 64) familyCache.clear();
  const roots = [root, ...listWorktrees(root)].filter(
    (r, i, all) => r && all.indexOf(r) === i
  );
  familyCache.set(root, { at: Date.now(), roots });
  return roots;
}

/**
 * `git worktree list --porcelain`, reduced to the paths. Empty on any failure —
 * a missing git, a non-repo directory, a repo mid-rebase are all "no family"
 * rather than an error, because every caller has a working fallback.
 *
 * The result is only trusted when `root` is itself one of the listed checkouts.
 * `git -C` walks *up* until it finds a repository, so asking from a monorepo
 * subdirectory (`~/code/app/packages/api` — a legitimate, deliberately narrow
 * scope) would answer with the whole of `~/code/app` and every worktree beside
 * it, quietly widening a scope the user chose to keep small. A subdirectory
 * never appears in `worktree list`; a real checkout always does.
 */
function listWorktrees(root: string): string[] {
  try {
    const p = Bun.spawnSync(["git", "-C", root, "worktree", "list", "--porcelain"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) return [];
    // Records are blank-line separated: a `worktree <path>` line, then optional
    // `HEAD`/`branch`/`bare`/`locked` lines describing it. The `bare` flag has to
    // be read before the record is committed, which is why this can't just
    // filter the `worktree ` lines.
    const out: string[] = [];
    let path = "";
    let bare = false;
    const flush = () => {
      // A bare repo is listed as a worktree but has no working tree — keeping it
      // would put a directory of refs in the scope, and inScope() decides where
      // a shell, a chat and a git write are allowed to run.
      if (path && !bare) out.push(resolve(path));
      path = "";
      bare = false;
    };
    for (const line of p.stdout.toString().split("\n")) {
      if (line.startsWith("worktree ")) { flush(); path = line.slice(9).trim(); }
      else if (line.trim() === "bare") bare = true;
    }
    flush();
    return out.includes(resolve(root)) ? out : [];
  } catch {
    return [];
  }
}

/** Display name for a worktree relative to its project: the branch is what the
 *  user thinks in, but the directory is what disambiguates two checkouts of the
 *  same branch, so callers get the leaf directory name. */
export function worktreeLabel(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
