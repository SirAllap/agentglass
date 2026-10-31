import { describe, expect, test } from "bun:test";
import { cardPeopleOf, cardSkipOf, editCardPeople, handOverPlan, nextStatuses, statusTone, type HandOverInput } from "../src/lib/prHandOver.ts";

// A pull request on acme/orbit by dana-r, linked to ORBIT-1042 in ClickUp, card in "in progress".
const input = (o: Partial<Omit<HandOverInput, "card" | "tracker">> & { card?: Partial<HandOverInput["card"]>; tracker?: Partial<HandOverInput["tracker"]> } = {}): HandOverInput => ({
  mode: "reviewers", author: "dana-r", picked: ["mara-k"], already: [],
  ...o,
  tracker: { kind: "clickup", card: "ORBIT-1042", status: "in progress", ...o.tracker },
  card: { mirror: true, people: [], status: "in review", ...o.card },
});
const ids = (i: HandOverInput) => handOverPlan(i).steps.map((s) => s.id);

describe("the plan, in order", () => {
  test("GitHub reviewers, then the card's people, then its status", () => {
    const p = handOverPlan(input());
    expect(p.steps.map((s) => [s.id, s.system])).toEqual([["gh-reviewers", "github"], ["card-assign", "clickup"], ["card-status", "clickup"]]);
    expect(p.summary).toBe("Request mara-k on GitHub · assign mara-k on ClickUp · move to in review");
    expect(p.done).toEqual({ label: "Done", disabled: false });
  });
  test("assignees mode assigns on GitHub instead", () => {
    const p = handOverPlan(input({ mode: "assignees", picked: ["mara-k", "theo-w"] }));
    expect(p.steps[0]).toMatchObject({ id: "gh-assignees", add: ["mara-k", "theo-w"] });
    expect(p.summary.startsWith("Assign mara-k, theo-w on GitHub")).toBe(true);
  });
  test("the hand-over asks for a review whatever mode was left on, and its button says so", () => {
    const p = handOverPlan(input({ mode: "assignees", handOver: true }));
    expect(p.steps[0].id).toBe("gh-reviewers");
    expect(p.done.label).toBe("Hand over");
  });
  test("Jira names itself", () => {
    const p = handOverPlan(input({ tracker: { kind: "jira", card: "ORBIT-1042" } }));
    expect(p.steps.map((s) => s.label)).toEqual(["GitHub", "Jira", "Jira"]);
    expect(p.summary).toContain("assign mara-k on Jira");
  });
  test("teams go to GitHub as teams and never to the card", () => {
    const p = handOverPlan(input({ picked: ["mara-k", "@acme/qa"] }));
    expect(p.steps[0]).toMatchObject({ add: ["mara-k"], teams: ["@acme/qa"], text: "Request mara-k, @acme/qa on GitHub" });
    expect(p.cardPeople).toEqual(["mara-k"]);
  });
});

describe("what is left out", () => {
  test("the author cannot ask themselves for a review, and is not mirrored onto the card", () => {
    const p = handOverPlan(input({ picked: ["dana-r", "mara-k"] }));
    expect(p.steps[0].add).toEqual(["mara-k"]);
    expect(p.cardPeople).toEqual(["mara-k"]);
  });
  test("but the author can be an assignee", () => {
    expect(handOverPlan(input({ mode: "assignees", picked: ["dana-r"] })).steps[0].add).toEqual(["dana-r"]);
  });
  test("people already on the pull request are not sent again", () => {
    const p = handOverPlan(input({ picked: ["mara-k", "theo-w"], already: ["MARA-K"] }));
    expect(p.steps[0].add).toEqual(["theo-w"]);
  });
  test("the status step is gone when the choice is Leave it, or is where the card already is", () => {
    expect(ids(input({ card: { status: null } }))).toEqual(["gh-reviewers", "card-assign"]);
    expect(ids(input({ card: { status: "In Progress" } }))).toEqual(["gh-reviewers", "card-assign"]);
  });
  test("nobody picked: only a status move is left, or nothing", () => {
    expect(ids(input({ picked: [] }))).toEqual(["card-status"]);
    const none = handOverPlan(input({ picked: [], card: { status: null } }));
    expect(none).toMatchObject({ empty: true, summary: "Nothing to apply yet", done: { label: "Done", disabled: true } });
  });
});

describe("the card's own people", () => {
  test("mirroring follows the picker; once off, the card keeps its own list", () => {
    const own = { mirror: false, people: ["kofi-o"], status: null };
    expect(cardPeopleOf({ ...own, mirror: true }, ["mara-k"])).toEqual(["mara-k"]);
    expect(cardPeopleOf(own, ["mara-k"])).toEqual(["kofi-o"]);
    expect(handOverPlan(input({ card: own })).steps.map((s) => [s.id, s.add])).toEqual([["gh-reviewers", ["mara-k"]], ["card-assign", ["kofi-o"]]]);
  });
  test("editing the card's list turns mirroring off", () => {
    expect(editCardPeople(["kofi-o"])).toEqual({ mirror: false, people: ["kofi-o"] });
  });
});

describe("no card half", () => {
  test("no tracker for the repository: GitHub only", () => {
    const p = handOverPlan(input({ tracker: { kind: null, card: undefined } }));
    expect(p.cardSkip).toBe("no-tracker");
    expect(p.steps.map((s) => s.id)).toEqual(["gh-reviewers"]);
  });
  test("a tracker but no card linked: GitHub only", () => {
    const p = handOverPlan(input({ tracker: { card: undefined } }));
    expect(p.cardSkip).toBe("unlinked");
    expect(p.summary).toBe("Request mara-k on GitHub");
  });
  test("a read-only token: GitHub only, even with a status chosen", () => {
    const p = handOverPlan(input({ tracker: { readOnly: true } }));
    expect(p.cardSkip).toBe("read-only");
    expect(p.steps.map((s) => s.id)).toEqual(["gh-reviewers"]);
  });
  test("the order of the reasons: no tracker, then unlinked, then read-only", () => {
    expect(cardSkipOf({ kind: null, readOnly: true })).toBe("no-tracker");
    expect(cardSkipOf({ kind: "jira", readOnly: true })).toBe("unlinked");
    expect(cardSkipOf({ kind: "jira", card: "ORBIT-1", readOnly: true })).toBe("read-only");
    expect(cardSkipOf({ kind: "jira", card: "ORBIT-1" })).toBeNull();
  });
});

describe("the statuses offered", () => {
  test("review first, then what follows, three at most", () => {
    expect(nextStatuses("clickup", "to do")).toEqual(["in review", "in progress", "in qa"]);
    expect(nextStatuses("jira", "To Do")).toEqual(["In review", "In progress", "Ready for QA"]);
  });
  test("past review: the steps that follow", () => {
    expect(nextStatuses("clickup", "in review")).toEqual(["in qa", "done"]);
    expect(nextStatuses("jira", "Done")).toEqual([]);
  });
  test("a status the chain does not know offers the chain from the top, any case", () => {
    expect(nextStatuses("clickup", "blocked")[0]).toBe("in review");
    expect(nextStatuses("clickup", "IN PROGRESS")).toEqual(["in review", "in qa", "done"]);
  });
  test("the tracker's own ordered statuses replace the common chain", () => {
    expect(nextStatuses("jira", "Backlog", ["Backlog", "Doing", "Peer review", "Shipped"])).toEqual(["Peer review", "Doing", "Shipped"]);
  });
  test("tone: done and QA green, review blue, progress amber, else grey", () => {
    expect(["done", "in qa", "Ready for QA", "In review", "in progress", "to do"].map(statusTone))
      .toEqual(["done", "done", "done", "review", "progress", "plain"]);
  });
});

describe("a hand-over replaces whoever held the card", () => {
  test("the previous people come off in the same step, named in the sentence", () => {
    const p = handOverPlan(input({ handOver: true, card: { mirror: false, people: ["Mara K"], drop: ["Dana R"], status: null } }));
    expect(p.steps.find((s) => s.id === "card-assign")).toMatchObject({ add: ["Mara K"], drop: ["Dana R"], text: "assign Mara K and take Dana R off on ClickUp" });
  });
  test("someone who stays is not taken off", () => {
    const p = handOverPlan(input({ handOver: true, card: { mirror: false, people: ["Mara K"], drop: ["mara k", "Dana R"], status: null } }));
    expect(p.steps.find((s) => s.id === "card-assign")!.drop).toEqual(["Dana R"]);
  });
  test("a plain request that names no drop takes nobody off", () => {
    expect(handOverPlan(input({ card: { mirror: false, people: ["Mara K"], status: null } })).steps.find((s) => s.id === "card-assign")!.drop).toBeUndefined();
  });
  test("a read-only card is never touched, drop or not", () => {
    expect(ids(input({ handOver: true, tracker: { readOnly: true }, card: { mirror: false, people: [], drop: ["Dana R"], status: null } }))).toEqual(["gh-reviewers"]);
  });
});

describe("what the team's own review step also writes", () => {
  test("a comment or a field is a step of the card, after its people and status", () => {
    const p = handOverPlan(input({ card: { mirror: false, people: ["Mara K"], status: "in review", extras: ["comment on the card"] } }));
    expect(p.steps.map((s) => s.id)).toEqual(["gh-reviewers", "card-assign", "card-status", "card-extras"]);
    expect(p.summary).toBe("Request mara-k on GitHub · assign Mara K on ClickUp · move to in review · comment on the card");
  });
  test("with no card half there is nothing to add them to", () => {
    expect(ids(input({ tracker: { kind: null }, card: { extras: ["comment on the card"] } }))).toEqual(["gh-reviewers"]);
  });
});
