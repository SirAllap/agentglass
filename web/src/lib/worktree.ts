// Reading a worktree as part of its project, in the UI.
//
// The server folds linked worktrees into the project they belong to and tags
// each one with `worktreeOf`. What's left is naming them so a user with a dozen
// checkouts open can tell at a glance which card an agent, a shell or a diff
// belongs to. Directory names carry that information already — the convention
// is `<project>-<card>` — so the useful label is the part that *isn't* the
// project name.

/** Leaf directory name of an absolute path. */
export const dirName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

/**
 * Short label for a linked worktree, relative to its project — `WEB-1042` for
 * `~/code/orbit-WEB-1042` belonging to `~/code/orbit`. Null for a project.
 *
 * The prefix is only stripped when it's actually there: worktrees living under
 * `<repo>/.worktrees/<name>`, or named anything else, keep their directory name
 * rather than being mangled into something that no longer matches what the user
 * sees in a shell prompt.
 */
export function worktreeTag(r: { root: string; worktreeOf?: string }): string | null {
  if (!r.worktreeOf) return null;
  const project = dirName(r.worktreeOf);
  const leaf = dirName(r.root);
  return (leaf.startsWith(project + "-") ? leaf.slice(project.length + 1) : leaf) || leaf;
}

/**
 * The worktree a session ran in, or null if it ran in the project itself.
 *
 * `cwd_path` is recorded whenever a turn ran somewhere other than the repo root,
 * which covers two different things: a linked worktree (a sibling directory —
 * the branch the agent is working) and a monorepo subdirectory (*inside* the
 * root — not a separate checkout, and not worth a badge). The prefix test is
 * what separates them, and it's the same rule the server folds sessions with.
 */
/**
 * Where a session should be resumed: the exact checkout it ran in, falling back
 * to the repo it rolls up to.
 *
 * `project_path` folds every worktree onto the main repo, which is right for
 * grouping and wrong for this — resuming an agent that spent its life on
 * `orbit-WEB-1042` would drop it in `orbit` on master, where its branch isn't
 * checked out, its edits aren't present, and the conversation it's continuing
 * no longer matches the tree in front of it.
 */
export function sessionCwd(s: { project_path?: string | null; cwd_path?: string | null }): string | null {
  return s.cwd_path || s.project_path || null;
}

export function sessionWorktree(s: { project_path?: string | null; cwd_path?: string | null }): string | null {
  const { cwd_path: cwd, project_path: root } = s;
  if (!cwd || !root || cwd === root || cwd.startsWith(root + "/")) return null;
  const leaf = dirName(cwd);
  const project = dirName(root);
  return (leaf.startsWith(project + "-") ? leaf.slice(project.length + 1) : leaf) || leaf;
}
