// The Closed list's per-row answer: local only, batched, "unknown" never "nothing". Real git in a temp directory, fake docker/gh.
import { afterEach, describe, expect, test } from "bun:test";
import { leftoverInventory } from "../src/cleanup.ts";
import { BRANCH, PR, makeWorld, type World } from "./cleanupFixture.ts";

let w: World;
afterEach(() => w?.cleanup());

describe("leftover inventory for list rows", () => {
  test("a PR with a worktree and branch has items; one with nothing on this machine has none; gh is never asked", async () => {
    w = makeWorld();
    w.images = [{ repo: "orbit-django", tag: "orbit-1042", id: "aaa111aaa111", size: "1GB" }];
    const rows = await leftoverInventory(w.main, [{ pr: PR, branch: BRANCH }, { pr: 90, branch: "someone-elses-feature" }], () => w.cfg({ include: ["docker", "worktree", "branch", "stashes", "evidence", "notes", "tab", "agent-scratch"] }), w.ctx());
    const mine = rows[0] as { pr: number; items: number; bytes: number; groups: { group: string }[] };
    expect(mine.items).toBeGreaterThan(2);
    expect(mine.groups.map((g) => g.group)).toContain("worktree");
    expect(mine.groups.map((g) => g.group)).toContain("docker");
    expect(rows[1]).toEqual({ pr: 90, items: 0, bytes: 0, groups: [] });
    expect(w.calls.some((x) => x.startsWith("gh "))).toBe(false);
  });
  test("docker's listings are asked once for the whole batch, not once per row", async () => {
    w = makeWorld();
    await leftoverInventory(w.main, [{ pr: 1, branch: "ORBIT-1-a" }, { pr: 2, branch: "ORBIT-2-b" }, { pr: 3, branch: "ORBIT-3-c" }], () => w.cfg({ include: ["docker"] }), w.ctx());
    expect(w.calls.filter((x) => x.startsWith("docker ps")).length).toBe(1);
    expect(w.calls.filter((x) => x.startsWith("docker images")).length).toBe(1);
  });
  test("a default branch is never offered; a folder that is not a repository is refused", async () => {
    w = makeWorld();
    const rows = await leftoverInventory(w.main, [{ pr: 5, branch: "main" }], () => w.cfg(), w.ctx());
    expect(rows[0]).toMatchObject({ items: 0 });
    await expect(leftoverInventory("/definitely/not/here", [{ pr: 5, branch: "x" }], () => w.cfg(), w.ctx())).rejects.toThrow();
  });
});
