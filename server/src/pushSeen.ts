/**
 * A session pushed: the pull request it pushed to has a new head.
 *
 * The panel kept saying "merging is blocked, N files conflict" and "N commits
 * ahead of what GitHub has" for as long as the answers it held stayed valid, and
 * a push is the one thing that keeps them valid: the conflict preview is keyed
 * by the LOCAL branch tip, which a push does not move, and the pull request
 * reads are kept for a minute or more. The event that matters already passes
 * through here (the session's own PostToolUse for the Bash call), so it drops
 * both caches. Nothing new polls; the next read the panel makes anyway is the
 * one that asks GitHub.
 *
 * `git push --dry-run` is not a push: outwardShell says so.
 */
import { forgetConflictPreviews } from "./gitwork.ts";
import { invalidateRepoReads, notePushed } from "./prs.ts";
import { outwardShell } from "./outward.ts";

export function notePush(cwd: string, command: string): void {
  if (outwardShell(command)?.kind !== "push") return;
  forgetConflictPreviews();
  /* What was pushed and when: a reading older than this, or still on another
     commit shortly after, is not allowed to say "ready" (shared/prFreshness.ts). */
  const at = Date.now();
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  const branch = git("branch", "--show-current"), sha = git("rev-parse", "HEAD");
  if (branch && sha) void notePushed(cwd, branch, sha, at).catch(() => {});
  void invalidateRepoReads(cwd).catch(() => { /* no GitHub remote: nothing was cached */ });
}
