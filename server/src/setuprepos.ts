/*
 * What step 4 lists: every repository a folder holds, with its branch.
 *
 * The picker's own `/projects/precheck` counts them for a preview; a checkbox
 * per repository with its branch needs the newline each row reads, so this is
 * the same walk with the reference read. Nothing is added here: the folder is
 * only listed, and `POST /workspace` is still the one write.
 */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { GitRepoRef, SetupRepos } from "../../shared/types.ts";
import { expandDir } from "./projectadd.ts";
import { reposUnder, repoNow } from "./gitwork.ts";

/** The most rows one answer carries. A folder of a thousand checkouts would
 *  otherwise be a thousand `git status` calls inside one request; the step says
 *  it listed the first of them and the picker lists the rest. */
export const SETUP_REPO_MAX = 200;

export async function setupRepos(pathIn: unknown): Promise<SetupRepos> {
  const none: SetupRepos = { path: "", exists: false, repos: [], capped: false };
  if (typeof pathIn !== "string" || !pathIn.trim() || pathIn.includes("\0")) return none;
  if (!isAbsolute(expandDir(pathIn))) return none;
  const abs = resolve(expandDir(pathIn));
  try {
    if (!statSync(abs).isDirectory()) return { ...none, path: abs };
  } catch {
    return { ...none, path: abs };
  }
  const roots = reposUnder(abs);
  const refs = await Promise.all(roots.slice(0, SETUP_REPO_MAX).map((r) => repoNow(r)));
  const repos = refs
    .filter((r): r is GitRepoRef => !!r)
    .map((r) => ({ name: r.name, root: r.root, branch: r.branch }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: abs, exists: true, repos, capped: roots.length > SETUP_REPO_MAX };
}
