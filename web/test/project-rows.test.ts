// The Repos tab listed a linked worktree as if it were another project, so one
// repository on two branches read as two repositories. They fold into one row;
// the branch is chosen inside.
import { describe, expect, test } from "bun:test";
import { projectRows } from "../src/mobile/projects.ts";

/** The shape the tab hands in: a checkout, its name, and what it holds. */
const repo = (root: string, name: string, branch: string, extra: { worktreeOf?: string; dirty?: number } = {}) => ({
  ref: { root, name, branch, dirty: 0, ahead: 0, behind: 0, ...(extra.worktreeOf ? { worktreeOf: extra.worktreeOf } : {}) },
  name, branch, dirty: extra.dirty ?? 0, ahead: 0, behind: 0, prs: 0, down: 0,
});

describe("projectRows", () => {
  test("a worktree folds into the repository it belongs to", () => {
    const rows = projectRows([
      repo("/code/agentglass", "agentglass", "main"),
      repo("/code/agentglass/.claude/worktrees/remote-phone", "remote-phone", "fix/phone", { worktreeOf: "/code/agentglass", dirty: 5 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.main.name).toBe("agentglass");
    expect(rows[0]!.checkouts).toHaveLength(2);
  });

  test("the project's checkout comes first, whatever order they arrived in", () => {
    const rows = projectRows([
      repo("/code/app/.claude/worktrees/b", "b", "feat/b", { worktreeOf: "/code/app" }),
      repo("/code/app", "app", "main"),
      repo("/code/app/.claude/worktrees/a", "a", "feat/a", { worktreeOf: "/code/app" }),
    ]);
    expect(rows[0]!.checkouts[0]!.name).toBe("app");
    expect(rows[0]!.checkouts.slice(1).map((c) => c.name)).toEqual(["a", "b"]);
  });

  test("separate repositories stay separate", () => {
    const rows = projectRows([repo("/code/one", "one", "main"), repo("/code/two", "two", "main")]);
    expect(rows.map((r) => r.main.name)).toEqual(["one", "two"]);
  });

  test("a worktree whose repository is not in the list stands on its own", () => {
    // Scoped views can hand us the checkout without its parent; dropping it
    // would make the work in it invisible.
    const rows = projectRows([repo("/code/app/.claude/worktrees/x", "x", "feat/x", { worktreeOf: "/code/app", dirty: 2 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.main.name).toBe("x");
  });

  test("nothing in, nothing out", () => {
    expect(projectRows([])).toEqual([]);
  });
});
