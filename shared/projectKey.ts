/**
 * What makes two things the same project. One implementation, both surfaces.
 *
 * There were four. The server had this rule, correctly, in `docker.ts`. The
 * phone had three more — `repoName` in MobileApp, `baseName` in MobileChats and
 * `projectName` in nowQueue — each taking the last segment of a directory path
 * and comparing it to a compose project name with `===`.
 *
 * That comparison cannot work, and the reason is worth stating because it is
 * the confusing half of the container-mixing bug rather than the obvious half:
 * compose lowercases the project name and drops everything outside `[a-z0-9_-]`,
 * so a checkout at `~/code/My.App` runs as project `myapp`. No raw basename will
 * ever equal it. Meanwhile two unrelated repositories both called `web` DO
 * compare equal, so they claim each other's containers.
 *
 * The other half is the linked worktree. A stack brought up from
 * `.claude/worktrees/remote-phone` has that as its working directory and
 * `remote-phone` as its compose project — neither matches the project it
 * belongs to by path or by name.
 *
 * Kept free of imports so both the server and the browser can take it, and so a
 * test of it does not pull an application graph in behind it.
 */

/** A checkout, expressed the way container labels express it. */
export interface ProjectKey {
  /** The checkout directory, without a trailing slash. */
  dir: string;
  /** What compose would have called it. */
  project: string;
}

/** The subset of a container this rule reads. */
export interface ContainerRef {
  project: string | null;
  workingDir: string | null;
}

const trimSlash = (p: string): string => p.replace(/\/+$/, "");

/** The last path segment, on either separator. Windows paths reach this from a
 *  repo root recorded on a machine that uses them. */
export function baseName(path: string): string {
  return trimSlash(path).split(/[\\/]/).filter(Boolean).pop() || path;
}

/** Compose's own transformation of a directory name into a project name. */
export function normaliseProject(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/** The key for a checkout root. */
export function projectKey(root: string): ProjectKey {
  const dir = trimSlash(root);
  return { dir, project: normaliseProject(baseName(dir)) };
}

/**
 * Whether a container belongs to a checkout.
 *
 * Either signal is enough. A directory match is authoritative — that stack was
 * literally launched from inside this checkout, whatever it named itself. A
 * name match is looser (two checkouts of one repository in different
 * directories both answer to `myapp`) but it is the only thing older compose
 * versions give us, and showing a sibling checkout's container is a far smaller
 * failure than showing none of them.
 */
export function inProject(c: ContainerRef, k: ProjectKey): boolean {
  const wd = trimSlash(c.workingDir || "");
  if (wd && (wd === k.dir || wd.startsWith(k.dir + "/"))) return true;
  return !!k.project && normaliseProject(c.project || "") === k.project;
}

/**
 * Which checkout a container belongs to, out of everything we know about.
 *
 * Directory matches are preferred over name matches, and the deepest directory
 * wins: a worktree inside a repository is a better answer than the repository
 * it lives under, and returning the parent would file the container under a
 * checkout it was not started from.
 *
 * Null when nothing matches, and null is a real answer. The phone used to have
 * no way to express it, so a container agentglass could not place simply had no
 * screen — the queue offered a Logs button for it that raised a toast and did
 * nothing.
 */
export function ownerOf(c: ContainerRef, roots: readonly string[]): string | null {
  const keys = roots.map(projectKey);
  const wd = trimSlash(c.workingDir || "");
  let byDir: ProjectKey | null = null;
  if (wd) {
    for (const k of keys) {
      if (wd !== k.dir && !wd.startsWith(k.dir + "/")) continue;
      if (!byDir || k.dir.length > byDir.dir.length) byDir = k;
    }
  }
  if (byDir) return byDir.dir;
  const name = normaliseProject(c.project || "");
  if (!name) return null;
  const byName = keys.find((k) => k.project === name);
  return byName ? byName.dir : null;
}
