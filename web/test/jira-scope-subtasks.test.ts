/*
 * A place page reads what its sidebar row counts. The tree counts cards without sub-tasks; the page's search let them in.
 */
import { expect, test } from "bun:test";
import { scopeJql } from "../../shared/jiraScope.ts";

test("a space, component or no-epic page leaves sub-tasks out, as the tree's counts do", () => {
  for (const s of [{ space: "ORB" }, { space: "ORB", component: "Api" }, { space: "ORB", component: "" }, { space: "ORB", noEpic: true }]) {
    expect(scopeJql(s)).toContain("issuetype not in subTaskIssueTypes()");
  }
});
