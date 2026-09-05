/*
 * SEED A FRESHLY CUT WORKTREE with what git does not carry.
 *
 * `git worktree add` copies the tracked tree and nothing else: no `.env`, no
 * local settings, no generated files a repository ignores on purpose. A new
 * checkout does not start without them, and an agent seated in it spends its
 * first turn reading "cannot find .env" as a bug of its own — this repo's own
 * loop documents four runs in a row lost that way, before it learned to run
 * the install itself. Twenty-three tools in the same space solve it the same
 * way, so the shape is settled: a `.worktreeinclude` file at the repository
 * root, one ignored path per line, copied from the primary checkout into every
 * new worktree.
 *
 * Copied, never linked: a symlink would make the worktree's `.env` the main
 * checkout's, and an agent editing one would edit the other. Never overwrites:
 * a path already in the new checkout is git's, and git wins. Never leaves the
 * repository: a line that resolves outside it, or that names something git
 * tracks, is skipped with a word rather than obeyed — the file is data in the
 * repository, and a repository is not to be trusted with `../../.ssh`.
 *
 * "Resolves outside it" is judged on the real path, not the spelling. The
 * first version compared strings — `resolve(root, rel).startsWith(root)` —
 * and a repository that tracks `cfg -> ../..` with a `.worktreeinclude`
 * naming `cfg/.ssh/id_rsa` passed that test while `cpSync` followed the link
 * into the home directory of whoever cut the worktree. So every component of
 * the path is `lstat`ed on both sides and a symlink anywhere in it is
 * refused, the entry itself may not be a link (a link would be reproduced as
 * an absolute pointer back into the main checkout — the very thing the
 * "never linked" line above forbids), and the file must be one git ignores:
 * that is what the include file is for, and a tracked or merely untracked
 * path has no business being copied by a side channel.
 */
import { cpSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export const WORKTREE_INCLUDE = ".worktreeinclude";

/** The paths a `.worktreeinclude` names — comments and blanks dropped,
 *  anything that climbs out of the repository refused. */
export function includeList(text: string): { paths: string[]; refused: string[] } {
  const paths: string[] = [];
  const refused: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const norm = line.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!norm || norm.startsWith("/") || norm.split("/").includes("..") || /^[A-Za-z]:/.test(norm) || norm.startsWith("~")) { refused.push(line); continue; }
    paths.push(norm);
  }
  return { paths, refused };
}

export interface SeedReport {
  copied: string[];
  missing: string[];
  kept: string[];
  /** Spelled so as to leave the repository, or really outside it once the
   *  path is resolved through the filesystem. */
  refused: string[];
  tracked: string[];
  /** A symlink — the entry itself, or a component on the way to it, on
   *  either side. Copying through one is copying somewhere else. */
  linked: string[];
  /** Present and untracked, but not ignored by git either. The include file
   *  exists for ignored local files; anything else is refused. */
  unignored: string[];
}

/**
 * `lstat` each component of `rel` under `base`, never following a link.
 * `link` is the first component that is a symlink (as a path relative to
 * `base`), or null when none is; `present` is how many leading components
 * exist — the walk stops at the first that does not, or at the link.
 */
function walk(base: string, rel: string): { link: string | null; present: number; total: number } {
  const parts = rel.split("/").filter(Boolean);
  let cur = base;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]!);
    let st;
    try { st = lstatSync(cur); } catch { return { link: null, present: i, total: parts.length }; }
    if (st.isSymbolicLink()) return { link: parts.slice(0, i + 1).join("/"), present: i, total: parts.length };
  }
  return { link: null, present: parts.length, total: parts.length };
}

/** Real path of the deepest existing ancestor of `rel` under `base` (the
 *  first `present` components), or null when even `base` cannot be resolved. */
function realAncestor(base: string, rel: string, present: number): string | null {
  const parts = rel.split("/").filter(Boolean).slice(0, present);
  try { return realpathSync(join(base, ...parts)); } catch { return null; }
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/** git's word on whether `rel` is ignored in `root`: `check-ignore -q` exits
 *  0 for an ignored path, 1 for one it would track, 128 when `root` is not a
 *  repository at all — and only the first of those is a yes. */
export function gitIgnored(root: string, rel: string): boolean {
  try {
    const r = Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", "--", rel], {
      stdout: "ignore", stderr: "ignore", stdin: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Copy the include list from `root` into `worktree`. `isTracked` is git's
 * word on whether a path is in the index and `isIgnored` its word on whether
 * the path is ignored — both injected so the copy can be exercised against a
 * fake, with the real `git check-ignore` as the default for the second.
 * Nothing here throws: a seed that fails is a note in the report, and the
 * worktree is still a worktree.
 */
export function seedWorktree(
  root: string,
  worktree: string,
  isTracked: (rel: string) => boolean = () => false,
  isIgnored: (rel: string) => boolean = (rel) => gitIgnored(root, rel),
): SeedReport {
  const report: SeedReport = { copied: [], missing: [], kept: [], refused: [], tracked: [], linked: [], unignored: [] };
  const file = join(root, WORKTREE_INCLUDE);
  // The include file itself is read without following a link: a repository
  // whose `.worktreeinclude` is a symlink elsewhere is asking to be read as
  // something it is not.
  try { if (!lstatSync(file).isFile()) return report; } catch { return report; }
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return report; }
  const { paths, refused } = includeList(text);
  report.refused = refused;
  let realRoot: string, realWt: string;
  try { realRoot = realpathSync(root); realWt = realpathSync(worktree); } catch { report.refused.push(...paths); return report; }
  const rootAbs = resolve(root) + sep;
  const wtAbs = resolve(worktree) + sep;
  for (const rel of paths) {
    const from = resolve(root, rel);
    const to = resolve(worktree, rel);
    if (!from.startsWith(rootAbs) || !to.startsWith(wtAbs)) { report.refused.push(rel); continue; }
    if (isTracked(rel)) { report.tracked.push(rel); continue; }
    // Source side: every component real, none a link, the leaf included.
    const src = walk(root, rel);
    if (src.link !== null) { report.linked.push(rel); continue; }
    if (src.present < src.total) { report.missing.push(rel); continue; }
    let realFrom: string;
    try { realFrom = realpathSync(from); } catch { report.missing.push(rel); continue; }
    if (!under(realFrom, realRoot) || realFrom === realRoot) { report.refused.push(rel); continue; }
    if (!isIgnored(rel)) { report.unignored.push(rel); continue; }
    // Destination side: the parents that already exist must be real and
    // inside the worktree — a checkout on a branch where `cfg` is a link is
    // the same hole from the other direction. The leaf existing at all,
    // link or file, is git's and stays.
    const dst = walk(worktree, rel);
    const leafExists = dst.present === dst.total || (dst.link !== null && dst.present === dst.total - 1);
    if (leafExists) { report.kept.push(rel); continue; }
    if (dst.link !== null) { report.linked.push(rel); continue; }
    const realParent = realAncestor(worktree, rel, dst.present);
    if (realParent === null || !under(realParent, realWt)) { report.refused.push(rel); continue; }
    try {
      // Inside a copied directory the same rule holds file by file: a link
      // is left behind and named, never reproduced.
      const skipped: string[] = [];
      cpSync(from, to, {
        recursive: lstatSync(from).isDirectory(), dereference: false, errorOnExist: false, force: false,
        filter: (src) => {
          let link = false;
          try { link = lstatSync(src).isSymbolicLink(); } catch { return false; }
          if (link) skipped.push(rel + src.slice(from.length));
          return !link;
        },
      });
      report.copied.push(rel);
      report.linked.push(...skipped);
    } catch {
      report.missing.push(rel);
    }
  }
  return report;
}

/** One line for a log or a brief: what was seeded, and what was not and why. */
export function seedSummary(r: SeedReport): string {
  const bits: string[] = [];
  if (r.copied.length) bits.push(`seeded ${r.copied.join(", ")}`);
  if (r.kept.length) bits.push(`kept ${r.kept.join(", ")}`);
  if (r.missing.length) bits.push(`missing in the main checkout: ${r.missing.join(", ")}`);
  if (r.tracked.length) bits.push(`tracked by git, not copied: ${r.tracked.join(", ")}`);
  if (r.unignored.length) bits.push(`not ignored by git, not copied: ${r.unignored.join(", ")}`);
  if (r.linked.length) bits.push(`refused (a symlink, or through one): ${r.linked.join(", ")}`);
  if (r.refused.length) bits.push(`refused (outside the repository): ${r.refused.join(", ")}`);
  return bits.join(" · ");
}
