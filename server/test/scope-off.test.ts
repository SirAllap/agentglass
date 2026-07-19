// The other half of the scoping contract: with no project open, the cockpit is
// machine-wide and must show *everything*.
//
// This is a unit test on the clause builder rather than an integration test on
// the query layer, because `bun test` runs every file in one process: db.ts and
// config.ts each read their scope once at module load, so a second file that
// imported them with a different AGENTGLASS_ROOT would just inherit whichever
// scope loaded first and assert nothing. scope.test.ts owns the integration
// side; this owns the shape of the filter itself.
import { describe, expect, test } from "bun:test";
import { scopeClause } from "../src/db.ts";

describe("scopeClause", () => {
  test("unscoped produces no filter at all", () => {
    // The whole-machine view must not narrow anything — an empty clause is the
    // difference between "every project" and "silently only the ones with a
    // recorded path".
    const { clause, args } = scopeClause(null);
    expect(clause).toBe("");
    expect(args).toEqual([]);
  });

  test("scoped matches the root and everything under it", () => {
    const { clause, args } = scopeClause("/home/dev/proj");
    expect(clause).toContain("project_path = ?");
    expect(clause).toContain("project_path LIKE ?");
    expect(args).toEqual([
      "/home/dev/proj",
      "/home/dev/proj/%",
      "/home/dev/proj",
      "/home/dev/proj/%",
    ]);
  });

  test("consults cwd as well as the resolved repo root", () => {
    // A turn in a linked worktree or a monorepo subdir records a project_path
    // that can sit outside the scope while the cwd is inside it.
    expect(scopeClause("/x").clause).toContain("cwd_path");
  });

  test("the LIKE prefix cannot match a sibling with a shared name", () => {
    // "/code/app" must not drag in "/code/app-backup" — hence the trailing "/".
    const [, like] = scopeClause("/code/app").args;
    expect(like).toBe("/code/app/%");
    expect("/code/app-backup/file".startsWith("/code/app/")).toBe(false);
  });

  test("binds parameters instead of interpolating the path", () => {
    // A project path is user input (typed into the picker); it never reaches
    // SQL as text.
    const { clause } = scopeClause("'; DROP TABLE events; --");
    expect(clause).not.toContain("DROP");
  });
});
