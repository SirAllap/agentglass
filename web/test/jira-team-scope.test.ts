import { describe, expect, test } from "bun:test";
import { scopeId } from "../../shared/jiraScope.ts";
import { NO_VIEW_FILTERS, teamScoped, viewJql } from "../src/components/jira/list/viewsModel.ts";

const TEAM = { team: true };
const MINE = { team: false };

describe("Team opened over a space is scoped to it", () => {
  test("the space of the open scope becomes the view's space filter", () => {
    const f = teamScoped(TEAM, undefined, scopeId({ space: "ORB" }));
    expect(f?.spaces).toEqual(["ORB"]);
    expect(viewJql({ team: true, sprint: true }, f)).toContain('project in ("ORB")');
  });
  test("an epic inside the space scopes to the space", () => {
    expect(teamScoped(TEAM, undefined, scopeId({ space: "ORB", epic: "ORB-7" }))?.spaces).toEqual(["ORB"]);
  });
  test("a space the person already picked is theirs", () => {
    const kept = { ...NO_VIEW_FILTERS, spaces: ["ACM"] };
    expect(teamScoped(TEAM, kept, scopeId({ space: "ORB" }))).toBe(kept);
  });
  test("Mine stays across spaces", () => {
    expect(teamScoped(MINE, undefined, scopeId({ space: "ORB" }))).toBeUndefined();
  });
  test("no space open (Assigned to me, nothing): nothing is invented", () => {
    expect(teamScoped(TEAM, undefined, null)).toBeUndefined();
    expect(teamScoped(TEAM, undefined, "not-a-scope")).toBeUndefined();
  });
});
