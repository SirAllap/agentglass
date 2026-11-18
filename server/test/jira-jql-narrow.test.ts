/*
 * Current sprint and Hide done go to Jira inside the search, so the 1000-card cap cuts what the person asked for and not
 * the whole site first. Measured on a Team view: 1000 read, 41 left after the filters ran here, sprint cards past the cap
 * never seen.
 */
import { expect, test } from "bun:test";
import { narrowJql } from "../src/jiraJql.ts";

const NONE = { sprint: false, hideDone: false };

test("nothing asked leaves the search as typed", () => {
  expect(narrowJql("project = ORBIT ORDER BY rank", NONE)).toBe("project = ORBIT ORDER BY rank");
});
test("both clauses AND the view's search in parentheses and keep its ORDER BY last", () => {
  expect(narrowJql("assignee is not EMPTY OR project = ORBIT ORDER BY updated DESC", { sprint: true, hideDone: true }))
    .toBe("(assignee is not EMPTY OR project = ORBIT) AND sprint in openSprints() AND statusCategory != Done ORDER BY updated DESC");
});
test("a clause the search already has is not added twice", () => {
  expect(narrowJql("project = ORBIT AND statusCategory != Done", { sprint: true, hideDone: true }))
    .toBe("(project = ORBIT AND statusCategory != Done) AND sprint in openSprints()");
  expect(narrowJql("sprint in openSprints()", { sprint: true, hideDone: false })).toBe("sprint in openSprints()");
});
test("an empty search is only the clauses", () => {
  expect(narrowJql("ORDER BY rank", { sprint: false, hideDone: true })).toBe("statusCategory != Done ORDER BY rank");
});
