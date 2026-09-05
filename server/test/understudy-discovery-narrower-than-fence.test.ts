/*
 * THE FENCE DECIDES WHAT IS ALLOWED. DISCOVERY DECIDES WHAT IS FOUND.
 *
 * `isOpenProjectPath` (the fence) allows every worktree of the open project —
 * that is the whole point of the segment test. `openProjectRepos` (discovery)
 * used to find checkouts only through telemetry (`getChanges`, known
 * projects) plus the one checkout the server happens to be running from.
 *
 * A sibling worktree nobody has worked in yet THROUGH THE APP is allowed by
 * the fence and invisible to discovery — a task queued against it is
 * accepted and then never picked up, which is a queue that stops moving with
 * tasks still in it.
 *
 * Measured on the real machine this ran on: `/understudy/work/ask` allowed
 * `agentglass-understudy` and only that one path, while three more real
 * worktrees of the same repository (`agentglass`, `agentglass-unread`, and
 * this very checkout) sat inside the fence and outside discovery.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let U: typeof import("../src/understudy.ts");
let G: typeof import("../src/gitwork.ts");
let root = "";
let sibling = "";
let projectName = "";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

beforeAll(async () => {
  U = await import("../src/understudy.ts");
  G = await import("../src/gitwork.ts");
  U.__setUnderstudyStorePath(join(mkdtempSync(join(tmpdir(), "agx-disc-")), "understudy.json"));

  const base = mkdtempSync(join(tmpdir(), "agx-disc-proj-"));
  root = join(base, "widget");
  execFileSync("git", ["init", "-q", root]);
  git(root, ["config", "user.email", "t@example.com"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "init"]);

  sibling = join(base, "widget-feature");
  git(root, ["worktree", "add", "-q", "-b", "feature", sibling]);

  projectName = "widget";
  U.setOpenProject(projectName, [root, sibling]);
});

describe("discovery must reach everything the fence already allows", () => {
  test("the fence allows both the checkout and its worktree sibling", () => {
    expect(U.isOpenProjectPath(root)).toBe(true);
    expect(U.isOpenProjectPath(sibling)).toBe(true);
  });

  test("git worktree list on the running checkout finds the sibling the fence allows", async () => {
    // This is the source discovery was missing: `openProjectRepos` used to add
    // only `repoRootOf(process.cwd())` and nothing else. The sibling was
    // reachable the whole time, one `git worktree list` away.
    const found = (await G.worktrees(root)).map((w) => w.path);
    expect(found).toContain(root);
    expect(found).toContain(sibling);
  });

  test("openProjectRepos drops a checkout that is no longer on disk", async () => {
    /* Telemetry remembers a checkout after its directory is gone, and a run
       cut from a path that is not there dies with the `ENOENT` a missing
       binary produces. Measured: a deleted `agentglass-dr` sat in the
       installed app's allow-list beside three real checkouts. */
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf("async function openProjectRepos(");
    const block = src.slice(from, src.indexOf("\n}", from));
    const ret = block.slice(block.lastIndexOf("return "));
    expect(ret).toContain("fsExists(r)");
    expect(ret).toContain("isOpenProjectPath(r)");
  });

  test("openProjectRepos widens discovery to the fence's worktree family, not one inch past it", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf("async function openProjectRepos(");
    const block = src.slice(from, src.indexOf("\n}", from));
    const code = block.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

    // The fix: the checkout's own worktree family is folded into discovery.
    expect(code).toContain("repoWorktrees(here)");
    // The fence stays the last word — every root discovery finds still passes
    // through it, worktree family included.
    /* The fence, and then the disk: a checkout telemetry remembers after its
       directory is gone must not reach the loop. */
    expect(code).toContain("roots.filter((r) => isOpenProjectPath(r) && fsExists(r))");
    // Still not the app's own scope, which is a different question from the
    // fence's — understudy-fence-fails-closed.test.ts locks this out already.
    expect(code).not.toContain("workspaceRoot()");
  });
});
