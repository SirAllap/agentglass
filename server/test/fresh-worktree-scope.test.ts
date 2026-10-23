// A worktree cut a moment ago is inside the project.
//
// The family of a checkout is cached for a few seconds, because inScope() sits
// on every git write and shell open. A button that cuts a worktree and then
// asks for a terminal window in it lands inside that window: the cached list
// was taken before the worktree existed, inScope said "outside the project",
// and the handoff was dropped without a word.
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "agx-fresh-wt-")));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "w.db");

function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", "-c", "user.email=a@b.c", "-c", "user.name=a", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

test("a linked worktree added after the family was cached is in scope at once", async () => {
  const project = join(dir, "orbit");
  const fresh = join(dir, "orbit-ORBIT-1042-merge");
  mkdirSync(project, { recursive: true });
  git(project, "init", "-q", "-b", "main");
  git(project, "commit", "-q", "--allow-empty", "-m", "init");
  const { inScope } = await import("../src/config.ts");
  const { worktreeFamily } = await import("../src/worktree.ts");
  worktreeFamily(project); // what any git write in the last five seconds did
  git(project, "worktree", "add", "-q", "-b", "merge-it", fresh);
  expect(inScope(fresh, project)).toBe(true);
  // Not a licence: a directory git has not registered stays outside.
  const stray = join(dir, "orbit-notes");
  mkdirSync(stray, { recursive: true });
  expect(inScope(stray, project)).toBe(false);
});
