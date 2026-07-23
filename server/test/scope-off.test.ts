// The other half of the scoping contract: with no project open, the cockpit is
// machine-wide and must show *everything*.
//
// This is a unit test on the clause builder rather than an integration test on
// the query layer, because `bun test` runs every file in one process: db.ts and
// config.ts each read their scope once at module load, so a second file that
// imported them with a different AGENTGLASS_ROOT would just inherit whichever
// scope loaded first and assert nothing.
//
// What is left here is what can be asserted with no rows at all. The filter is
// now built from the paths the events table actually contains — that is the
// whole optimisation — so "what a populated scope looks like" moved to
// scope.test.ts, which has rows. Asserting it here would only ever prove the
// empty case.
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

  test("a scope with nothing recorded matches nothing, rather than everything", () => {
    // The dangerous failure mode of building the filter from what the table
    // holds: if it holds nothing for this project, the clause must still
    // exclude every other project's rows. An empty IN list is also a syntax
    // error, so this case needs its own answer.
    const { clause, args } = scopeClause("/nowhere/at/all");
    expect(clause.trim()).toBe("AND 0");
    expect(args).toEqual([]);
  });

  test("binds parameters instead of interpolating the path", () => {
    // A project path is user input (typed into the picker); it never reaches
    // SQL as text.
    const { clause } = scopeClause("'; DROP TABLE events; --");
    expect(clause).not.toContain("DROP");
  });
});
