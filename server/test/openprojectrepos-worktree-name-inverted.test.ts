/*
 * DISCOVERY SAW FEWER CHECKOUTS THAN THE FENCE ALLOWED — first by a reversed
 * comparison, then by a narrower one.
 *
 * `openProjectRepos`'s "wanted" block widens discovery to every known project
 * the fence already allows. The first version used
 * `wanted.startsWith(\`${leaf}-\`)`: does the PROJECT NAME extend the
 * CANDIDATE — which only a candidate shorter than or equal to the project
 * name can ever satisfy, so every real worktree failed it.
 *
 * The fix that followed, `leaf === wanted || leaf.startsWith(\`${wanted}-\`)`,
 * repaired the PREFIX case but reimplemented only half of what the fence
 * (`isOpenProjectPath`) actually tests: the fence is a segment match, bounded
 * by `/` or `-` on either side, so it also allows a leaf like
 * `work-agentglass` (the project name as a SUFFIX) or `team-agentglass-2`
 * (as a MIDDLE segment), and it matches case-insensitively. The hand-rolled
 * prefix check passed none of those.
 *
 * Measured: of five realistic leaf shapes the fence accepts for project
 * "agentglass" (`agentglass`, `agentglass-dr`, `work-agentglass`,
 * `team-agentglass-2`, `AgentGlass-dr`), the leaf-startsWith check matched 2
 * and silently dropped 3 — the same "allowed and never found" gap, just on
 * the other side of the string.
 *
 * The fix: stop reimplementing the fence's rule and call the fence itself —
 * `isOpenProjectPath(p.path)` — so discovery can never again drift narrower
 * than what it is filtered by two lines later anyway.
 */
import { describe, expect, test, beforeAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let U: typeof import("../src/understudy.ts");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

beforeAll(async () => {
  U = await import("../src/understudy.ts");
  U.__setUnderstudyStorePath(join(mkdtempSync(join(tmpdir(), "agx-wt-name-")), "understudy.json"));
  U.setOpenProject("widget", ["/tmp/widget"]);
});

describe("the wanted-block's own match must not be narrower than the fence", () => {
  test("the fence allows a worktree name longer than the project it belongs to", () => {
    // Exactly the shape the reversed comparison could never match.
    expect(U.isOpenProjectPath("/tmp/base/widget-longer-worktree-name")).toBe(true);
  });

  test("the fence also allows the project name as a suffix or middle segment, and case-insensitively", () => {
    // The prefix-only "fix" could never match any of these, though the fence
    // — the same segment test `openProjectRepos` is filtered by two lines
    // later — allows all three.
    expect(U.isOpenProjectPath("/tmp/base/work-widget")).toBe(true);
    expect(U.isOpenProjectPath("/tmp/base/team-widget-2")).toBe(true);
    expect(U.isOpenProjectPath("/tmp/base/Widget-dr")).toBe(true);
  });

  test("openProjectRepos's wanted-block delegates to the fence itself, not a reimplementation of it", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    const from = src.indexOf("async function openProjectRepos(");
    const block = src.slice(from, src.indexOf("\n}", from));
    expect(block).toContain("isOpenProjectPath(p.path)");
    // Neither the reversed comparison nor the prefix-only one it was replaced
    // by should come back.
    expect(block).not.toContain("wanted === leaf || wanted.startsWith(`${leaf}-`)");
    expect(block).not.toContain("leaf === wanted || leaf.startsWith(`${wanted}-`)");
  });
});
