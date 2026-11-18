/*
 * Copying ClickUp's steps onto Jira's map: a status travels by NAME, a name
 * Jira does not have is a question rather than a guess, a step Jira already has
 * is kept until the person says replace, and a value only ClickUp understands
 * is dropped and said out loud.
 *
 * The fixture is the shape of two real settings files: ClickUp's statuses are
 * the invented words a team might type, Jira's are the site's own, and one name
 * differs only in case and the spaces around it.
 */
import { describe, expect, test } from "bun:test";
import type { ClickUpPrefs, JiraSteps } from "../../shared/providers.ts";
import { clickupSteps } from "../src/lib/clickupWorkflow.ts";
import { jiraDotColour, jiraSteps } from "../src/lib/jiraWorkflow.ts";
import { allStatuses, type MapSpace, type Step } from "../src/lib/workflowMap.ts";
import { askKey, copyPatch, copyPlan } from "../src/lib/copySteps.ts";

const SPACES: MapSpace[] = [
  {
    id: "ORBIT", name: "Orbit core",
    statuses: [
      { status: "to do", type: "open" },
      { status: "code review", type: "custom" },
      { status: "ready for qa", type: "custom" },
      { status: "done", type: "done" },
    ],
  },
];
const STATUSES = allStatuses(SPACES);

const prefs = (over: Partial<ClickUpPrefs> = {}): ClickUpPrefs => ({
  handoff: { enabled: false, statusNames: [], unassign: "none", assign: { who: "none" } },
  review: { enabled: false, statusNames: [], assignReviewer: false, assign: { who: "none" } },
  merge: { enabled: false, statusNames: [], assign: { who: "none" } },
  flows: { noteOnCard: false },
  prLinkField: "", swatchField: "", cardSkillPattern: "", assigned: { includeSubtasks: false },
  sprintListPattern: "", readOnlyFieldPattern: "", bell: { kinds: [] }, statusSpaces: { counted: [] },
  ...over,
});

const off = { enabled: false, blocks: [] };
const jira = (over: Partial<JiraSteps> = {}): JiraSteps => ({ handoff: off, review: off, merge: off, people: off, note: off, ...over });

const handoff = (names: string[]) => clickupSteps(prefs({ handoff: { enabled: true, statusNames: names, unassign: "none", assign: { who: "none" } } }));

describe("copying ClickUp's steps onto Jira's", () => {
  test("a status Jira has by the same name is copied onto it, block for block", () => {
    const plan = copyPlan(handoff(["code review"]), [], STATUSES);
    expect(plan.asks).toEqual([]);
    expect(plan.steps).toEqual([{ kind: "move", blocks: [{ type: "move", statusNames: ["code review"] }], waiting: [], clash: false }]);
    expect(copyPatch(plan)).toEqual({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["code review"] }] } });
  });

  test("a name in another case, or with spaces around it, lands on the status Jira has", () => {
    const plan = copyPlan(handoff(["  CODE Review "]), [], STATUSES);
    expect(plan.asks).toEqual([]);
    expect(plan.steps[0]!.blocks).toEqual([{ type: "move", statusNames: ["code review"] }]);
  });

  test("a status Jira does not have is listed with the site's names to pick from, and nothing is saved until it is answered", () => {
    const plan = copyPlan(handoff(["in review"]), [], STATUSES);
    expect(plan.asks).toEqual([{ kind: "move", name: "in review", choices: ["to do", "code review", "ready for qa", "done"] }]);
    expect(askKey(plan.asks[0]!)).toBe("move:in review");
    /* Unanswered: the step is not saved, and nothing else is either. */
    expect(copyPatch(plan)).toEqual({});
    expect(copyPatch(plan, [{ kind: "move", name: "in review", to: "ready for qa" }])).toEqual({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["ready for qa"] }] } });
    /* "Skip this step" is an answer: the step stays out, the copy still lands. */
    expect(copyPatch(plan, [{ kind: "move", name: "in review", to: null }])).toEqual({});
  });

  test("a step Jira already has is kept, unless the person says replace", () => {
    const existing = jiraSteps(jira({ handoff: { enabled: true, blocks: [{ type: "link" }] } }));
    const plan = copyPlan(handoff(["code review"]), existing, STATUSES);
    expect(plan.steps[0]).toMatchObject({ kind: "move", clash: true });
    expect(copyPatch(plan)).toEqual({});
    expect(copyPatch(plan, [], ["move"])).toEqual({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["code review"] }] } });
  });

  test("a ClickUp member named on a step is not a Jira account: the block is dropped, and the confirmation says so", () => {
    const from: Step[] = [{
      kind: "move", status: "code review", also: [], unassign: "none", assign: { who: "none" },
      blocks: [
        { type: "move", statusNames: ["code review"] },
        { type: "assign", who: "person", person: { id: 91234, name: "Ada Test" } },
      ],
    }];
    const plan = copyPlan(from, [], STATUSES);
    expect(plan.dropped).toEqual([{ kind: "move", what: "the person named on ClickUp's card (Ada Test)", why: "a ClickUp member is not a Jira account" }]);
    expect(plan.steps[0]!.blocks).toEqual([{ type: "move", statusNames: ["code review"] }]);
    expect(copyPatch(plan)).toEqual({ handoff: { enabled: true, blocks: [{ type: "move", statusNames: ["code review"] }] } });
  });

  test("every kind and every block travels: the two single controls, a comment, a field and the ask flags", () => {
    const from = clickupSteps(prefs({
      handoff: { enabled: true, statusNames: ["code review"], unassign: "me", assign: { who: "me" } },
      review: { enabled: true, statusNames: ["ready for qa"], assignReviewer: true, assign: { who: "none" }, blocks: [
        { type: "move", statusNames: ["ready for qa"] },
        { type: "comment", text: "{pr} is ready", ask: true },
        { type: "field", field: "Sprint", value: "Next" },
      ] },
      merge: { enabled: true, statusNames: ["done"], assign: { who: "none" } },
      flows: { noteOnCard: true },
    }));
    const plan = copyPlan(from, [], STATUSES);
    expect(plan.steps.map((s) => s.kind)).toEqual(["move", "menu", "merge", "people", "note"]);
    expect(plan.asks).toEqual([]);
    const patch = copyPatch(plan);
    expect(Object.keys(patch)).toEqual(["handoff", "review", "merge", "people", "note"]);
    expect(patch.review!.blocks).toEqual([
      { type: "move", statusNames: ["ready for qa"] },
      { type: "comment", text: "{pr} is ready", ask: true },
      { type: "field", field: "Sprint", value: "Next" },
    ]);
    expect(patch.handoff!.blocks).toEqual([{ type: "move", statusNames: ["code review"] }, { type: "unassign", who: "me" }, { type: "assign", who: "me" }]);
    expect(patch.people).toEqual({ enabled: true });
    expect(patch.note).toEqual({ enabled: true });
  });

  test("nothing in ClickUp's file means nothing to copy", () => {
    expect(copyPlan([], [], STATUSES)).toEqual({ steps: [], asks: [], dropped: [] });
    expect(copyPatch(copyPlan([], [], STATUSES))).toEqual({});
  });
});

describe("Jira's status dots", () => {
  test("a status wears its category's colour in the house's tokens: not started, in progress, finished", () => {
    expect(jiraDotColour("open")).toBe("var(--text3)");
    expect(jiraDotColour("custom")).toBe("var(--warning)");
    expect(jiraDotColour("done")).toBe("var(--success)");
    /* A category the site names that the map does not know is quiet, never a wrong colour. */
    expect(jiraDotColour("something else")).toBe("var(--text3)");
  });
});
