/*
 * The workflow map offers the same steps on both trackers: a team moving a repo
 * from one to the other finds the map it had. The blocks are the same too, kind
 * for kind: a custom field is set on either.
 */
import { expect, test } from "bun:test";
import type { JiraSteps } from "../../shared/providers.ts";
import { blockInfoFor } from "../../shared/stepBlocks.ts";
import { CLICKUP } from "../src/lib/clickupWorkflow.ts";
import { JIRA, jiraAdd, jiraBlocks, jiraRemove, jiraSteps } from "../src/lib/jiraWorkflow.ts";
import { STEP_ORDER, addable, moments, whereWhen, type Step } from "../src/lib/workflowMap.ts";

const off = { enabled: false, blocks: [] };
const steps = (over: Partial<JiraSteps> = {}): JiraSteps => ({ handoff: off, review: off, merge: off, people: off, note: off, ...over });

test("Jira offers every step kind ClickUp does: no kind belongs to one tracker", () => {
  expect([...JIRA.kinds]).toEqual([...CLICKUP.kinds]);
  expect([...JIRA.kinds]).toEqual([...STEP_ORDER]);
  expect(addable(JIRA, [])).toEqual([...STEP_ORDER]);
});

test("the reviewer list and the note button are steps a site can turn on, like the three it had", () => {
  const on = steps({ people: { enabled: true, blocks: [] }, note: { enabled: true, blocks: [] } });
  expect(jiraSteps(on).map((s) => s.kind)).toEqual(["people", "note"]);
  expect(jiraAdd("people")).toEqual({ people: { enabled: true } });
  expect(jiraAdd("note")).toEqual({ note: { enabled: true } });
  expect(jiraRemove("note")).toEqual({ note: { enabled: false } });
  /* The two single controls have no blocks; asking to change them changes nothing. */
  expect(jiraBlocks("note", [])).toEqual({});
});

test("where each single control shows follows the tracker: Jira's review is a button, not a menu", () => {
  const people: Step = { kind: "people", status: null, also: [], unassign: "none", assign: { who: "none" } };
  const note: Step = { kind: "note", status: null, also: [], unassign: "none", assign: { who: "none" } };
  expect(whereWhen(people, CLICKUP.nouns).where).toBe("The Assigned list in a pull request’s Review menu");
  expect(whereWhen(people, JIRA.nouns).where).not.toContain("Review menu");
  expect(whereWhen(note, JIRA.nouns).where).toBe("The Note button in a pull request’s card block");
});

test("a step kind reads the same on both trackers: one title, one blurb, whatever it draws", () => {
  const clickup = moments(CLICKUP.nouns);
  const jira = moments(JIRA.nouns);
  expect(Object.keys(jira)).toEqual(Object.keys(clickup));
  for (const k of STEP_ORDER) {
    expect(jira[k].title, `${k} is titled differently on Jira`).toBe(clickup[k].title);
    expect(jira[k].blurb, `${k} is described differently on Jira`).toBe(clickup[k].blurb);
    expect(jira[k].needs).toBe(clickup[k].needs);
    expect(jira[k].optional).toBe(clickup[k].optional);
  }
  /* The one title names both places the step shows: Jira draws it as a button, ClickUp as a menu item. */
  expect(clickup.menu.blurb).toContain("review menu");
  expect(clickup.menu.blurb).toContain("button");
});

test("every block ClickUp's steps take, Jira's take too, and a field is one of them", () => {
  const clickup = blockInfoFor("clickup").map((b) => b.type);
  const jira = blockInfoFor("jira").map((b) => b.type);
  /* A field is set by its NAME there too: Jira resolves the name to the site's id against the card's own edit
     screen, and refuses a name the card does not offer rather than creating an option (server/src/jiraSteps.ts). */
  expect(clickup.filter((t) => t !== "link")).toEqual(jira.filter((t) => t !== "link"));
  expect(clickup).toContain("field");
  expect(jira).toContain("field");
  expect(jira).toContain("link");
});
