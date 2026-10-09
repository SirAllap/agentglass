/*
 * The workflow map's decisions: what a saved setting reads as, what a pick
 * sends, which spaces a status reaches, and what is proposed.
 *
 * The fixture is the shape of a real workspace: statuses are per space, one
 * space has a column the others lack, and a saved name was typed in another case.
 */
import { describe, expect, test } from "bun:test";
import type { ClickUpPrefs } from "../../shared/providers.ts";
import {
  addable, allStatuses, coverage, filterStatuses, isActive, moments, needsStatus, pinsOn, reach, reachOf, resolveImplicit, suggestStatus,
  type MapSpace, type Step,
} from "../src/lib/workflowMap.ts";
import { LEAVE_ALONE, mergePreselect, readyForQaStatus, reviewStatus } from "../src/lib/cardMove.ts";
import { CLICKUP, addTurnsWritesOn, clickupAdd, clickupBlocks, clickupRemove, clickupSteps } from "../src/lib/clickupWorkflow.ts";

const st = (status: string, type = "custom") => ({ status, type });
const SPACES: MapSpace[] = [
  { id: "1", name: "Engineering", statuses: [st("to do", "open"), st("in progress"), st("code review"), st("Ready for QA"), st("done", "done")] },
  { id: "2", name: "Platform", statuses: [st("backlog", "open"), st("in review"), st("ready for qa"), st("done", "done")] },
  { id: "3", name: "Support", statuses: [st("open", "open"), st("waiting on customer"), st("solved", "closed")] },
];

const prefs = (over: Partial<ClickUpPrefs> = {}): ClickUpPrefs => ({
  handoff: { enabled: false, statusNames: [], unassign: "none", assign: { who: "none" } },
  review: { enabled: false, statusNames: [], assignReviewer: false, assign: { who: "none" } },
  merge: { enabled: false, statusNames: [], assign: { who: "none" } },
  flows: { noteOnCard: false },
  prLinkField: "", swatchField: "", cardSkillPattern: "", assigned: { includeSubtasks: false },
  sprintListPattern: "", readOnlyFieldPattern: "", bell: { kinds: [] }, statusSpaces: { counted: [] },
  ...over,
});

describe("settings read as steps", () => {
  test("a workspace that set nothing has no steps: the map is empty, not full of off switches", () => {
    expect(clickupSteps(prefs())).toEqual([]);
  });

  test("each saved setting is the step of the same name, in map order", () => {
    const p = prefs({
      handoff: { enabled: true, statusNames: ["Ready for QA", "Testing"], unassign: "all", assign: { who: "none" } },
      review: { enabled: true, statusNames: ["code review"], assignReviewer: true, assign: { who: "none" } },
      merge: { enabled: true, statusNames: ["done"], assign: { who: "none" } },
      flows: { noteOnCard: true },
    });
    const s = clickupSteps(p);
    expect(s.map((x) => x.kind)).toEqual(["move", "menu", "merge", "people", "note"]);
    /* The prefs above are the shape from before the row existed: a step without "Also assign" leaves everyone as they are. */
    expect(s[0]).toMatchObject({ kind: "move", status: "Ready for QA", also: ["Testing"], unassign: "all", implicit: false, assign: { who: "none" } });
    expect(s[0]!.blocks).toEqual([{ type: "move", statusNames: ["Ready for QA", "Testing"] }, { type: "unassign", who: "all" }]);
    expect(s[2]).toMatchObject({ kind: "merge", status: "done" });
  });

  test("an old hand-off with no names is a step on the built-in default, not a step that needs one", () => {
    const raw = clickupSteps(prefs({ handoff: { enabled: true, statusNames: [], unassign: "me", assign: { who: "none" } } }))[0]!;
    expect(raw).toMatchObject({ kind: "move", status: null, unassign: "me", implicit: true });
    const s = resolveImplicit(CLICKUP, [raw], allStatuses(SPACES))[0]!;
    expect(s).toMatchObject({ status: "Ready for QA", implicit: true });
    expect(needsStatus(s, moments(CLICKUP.nouns).move)).toBe(false);
  });

  test("what the map resolves is what the app runs: the same status, through the real readers", () => {
    const listed = allStatuses(SPACES);
    const engineering = SPACES[0]!.statuses.map((x) => ({ ...x, orderindex: 0 }));
    const p = prefs({ handoff: { enabled: true, statusNames: [], unassign: "none", assign: { who: "none" } }, review: { enabled: true, statusNames: [], assignReviewer: false, assign: { who: "none" } } });
    const [move, menu] = resolveImplicit(CLICKUP, clickupSteps(p), listed);
    expect(readyForQaStatus(engineering, "in progress", p.handoff)?.toLowerCase()).toBe(move!.status!.toLowerCase());
    expect(reviewStatus(engineering, "in progress", p.review.statusNames)).toBe(menu!.status!);
  });

  test("a step the app would do nothing for stays 'needs a status': no review status anywhere", () => {
    const none: MapSpace[] = [{ id: "9", name: "Ops", statuses: [st("to do", "open"), st("done", "done")] }];
    const p = prefs({ review: { enabled: true, statusNames: [], assignReviewer: false, assign: { who: "none" } } });
    const s = resolveImplicit(CLICKUP, clickupSteps(p), allStatuses(none))[0]!;
    expect(s.status).toBeNull();
    expect(needsStatus(s, moments(CLICKUP.nouns).menu)).toBe(true);
  });

  test("a status the person chose is never replaced by the default", () => {
    const p = prefs({ handoff: { enabled: true, statusNames: ["code review"], unassign: "none", assign: { who: "none" } } });
    const s = resolveImplicit(CLICKUP, clickupSteps(p), allStatuses(SPACES))[0]!;
    expect(s).toMatchObject({ status: "code review", implicit: false });
  });

  test("the merge choice and the people step need no status to count as active", () => {
    const m = moments(CLICKUP.nouns);
    const merge: Step = { kind: "merge", status: null, also: [], unassign: "none", assign: { who: "none" } };
    expect(needsStatus(merge, m.merge)).toBe(false);
    expect(isActive(merge, m.merge)).toBe(true);
    expect(isActive({ kind: "people", status: null, also: [], unassign: "none", assign: { who: "none" } }, m.people)).toBe(true);
    expect(isActive({ kind: "menu", status: null, also: [], unassign: "none", assign: { who: "none" } }, m.menu)).toBe(false);
  });
});

describe("what a change sends", () => {
  test("adding a step built from blocks starts it empty and switches it on: nothing is chosen for the person", () => {
    expect(clickupAdd("move")).toEqual({ handoff: { enabled: true, blocks: [] } });
    expect(clickupAdd("menu")).toEqual({ review: { enabled: true, blocks: [] } });
    expect(clickupAdd("merge")).toEqual({ merge: { enabled: true, blocks: [] } });
  });

  test("the two steps without blocks are their own switch and touch nothing else", () => {
    expect(clickupAdd("people")).toEqual({ review: { assignReviewer: true } });
    expect(clickupAdd("note")).toEqual({ flows: { noteOnCard: true } });
  });

  test("changing a step replaces its blocks, in the order given", () => {
    const blocks = [{ type: "assign" as const, who: "me" as const }, { type: "move" as const, statusNames: ["testing"] }];
    expect(clickupBlocks("move", blocks)).toEqual({ handoff: { blocks } });
    expect(clickupBlocks("menu", blocks)).toEqual({ review: { blocks } });
    expect(clickupBlocks("merge", blocks)).toEqual({ merge: { blocks } });
  });

  test("removing a step takes its blocks with it, and removing the review item leaves the reviewer list", () => {
    expect(clickupRemove("move")).toEqual({ handoff: { enabled: false, blocks: [] } });
    expect(clickupRemove("menu")).toEqual({ review: { enabled: false, blocks: [] } });
    expect(clickupRemove("people")).toEqual({ review: { assignReviewer: false } });
  });

  test("only the first step switches changes on, and only while they are off", () => {
    expect(addTurnsWritesOn(false, 0)).toBe(true);
    expect(addTurnsWritesOn(false, 2)).toBe(false);
    expect(addTurnsWritesOn(true, 0)).toBe(false);
  });
});

describe("which spaces a status reaches", () => {
  test("case does not matter, and the spaces without it are named", () => {
    const c = coverage(SPACES, "ready for qa");
    expect(c).toEqual({ has: ["Engineering", "Platform"], missing: ["Support"], all: false });
    expect(coverage(SPACES, "DONE").has).toEqual(["Engineering", "Platform"]);
  });

  test("a status every space has is all of them; nowhere is not all", () => {
    expect(coverage([SPACES[0]!], "in progress").all).toBe(true);
    expect(coverage([], "x").all).toBe(false);
    expect(coverage(SPACES, "nonexistent")).toEqual({ has: [], missing: ["Engineering", "Platform", "Support"], all: false });
  });

  test("the picker row says it short: only one, two by name, then a count", () => {
    expect(reach(SPACES, "solved", "spaces")).toEqual({ text: "only Support", partial: true });
    expect(reach(SPACES, "ready for qa", "spaces")).toEqual({ text: "Engineering, Platform", partial: true });
    const wide = [...SPACES, { id: "4", name: "Ops", statuses: [st("done", "done")] }];
    expect(reach(wide, "done", "spaces")).toEqual({ text: "3 of 4 spaces", partial: true });
    expect(reach([SPACES[0]!], "done", "spaces")).toEqual({ text: "all 1 spaces", partial: false });
  });

  test("a step's reach reads as data: everywhere, nothing yet, all, or some with who is missing", () => {
    const m = moments(CLICKUP.nouns);
    const s = (kind: Step["kind"], status: string | null): Step => ({ kind, status, also: [], unassign: "none", assign: { who: "none" } });
    expect(reachOf(SPACES, s("note", null), m.note)).toEqual({ kind: "everywhere" });
    expect(reachOf(SPACES, s("move", null), m.move)).toEqual({ kind: "pending" });
    expect(reachOf(SPACES, s("merge", null), m.merge)).toEqual({ kind: "none-needed" });
    expect(reachOf(SPACES, s("merge", "done"), m.merge)).toMatchObject({ kind: "some", missing: ["Support"] });
    expect(reachOf([SPACES[0]!], s("menu", "code review"), m.menu)).toEqual({ kind: "all", count: 1 });
  });
});

describe("the statuses on offer", () => {
  test("distinct across spaces by case, first spelling kept, with where each lives", () => {
    const all = allStatuses(SPACES);
    expect(all.filter((x) => x.name.toLowerCase() === "ready for qa")).toEqual([{ name: "Ready for QA", type: "custom", in: ["Engineering", "Platform"] }]);
    expect(all.length).toBe(10);
  });

  test("typing narrows by a piece of the name, and nothing is invented for a miss", () => {
    const all = allStatuses(SPACES);
    expect(filterStatuses(all, "review").map((x) => x.name)).toEqual(["code review", "in review"]);
    expect(filterStatuses(all, "  ")).toHaveLength(all.length);
    expect(filterStatuses(all, "zzz")).toEqual([]);
  });

  test("the QA step proposes the qa column, the review item an open review one, the merge choice a finishing one", () => {
    const all = allStatuses(SPACES);
    expect(suggestStatus(CLICKUP, "move", all)).toBe("Ready for QA");
    expect(suggestStatus(CLICKUP, "menu", all)).toBe("code review");
    expect(suggestStatus(CLICKUP, "merge", all)).toBe("done");
    expect(suggestStatus(CLICKUP, "note", all)).toBeNull();
  });

  test("'Reviewed' that finishes the card is never what the review item proposes", () => {
    const all = allStatuses([{ id: "1", name: "A", statuses: [st("to do", "open"), st("reviewed", "done")] }]);
    expect(suggestStatus(CLICKUP, "menu", all)).toBeNull();
  });

  test("a workspace with no statuses proposes nothing, and no space offers nothing", () => {
    expect(suggestStatus(CLICKUP, "move", [])).toBeNull();
    expect(allStatuses([])).toEqual([]);
  });
});

describe("the map's bookkeeping", () => {
  test("only steps not yet added are offered, in map order", () => {
    const have = clickupSteps(prefs({ handoff: { enabled: true, statusNames: ["x"], unassign: "none", assign: { who: "none" } }, flows: { noteOnCard: true } }));
    expect(addable(CLICKUP, have)).toEqual(["menu", "merge", "people"]);
    expect(addable({ ...CLICKUP, kinds: ["move", "note"] }, [])).toEqual(["move", "note"]);
  });

  test("a status row shows a pin for every step pointing at it, whatever the case", () => {
    const steps = clickupSteps(prefs({ handoff: { enabled: true, statusNames: ["READY FOR QA"], unassign: "none", assign: { who: "none" } }, merge: { enabled: true, statusNames: ["ready for qa"], assign: { who: "none" } } }));
    expect(pinsOn(steps, "Ready for QA")).toEqual(["move", "merge"]);
    expect(pinsOn(steps, "done")).toEqual([]);
  });

  test("the words come from the tracker: a transition is not a move", () => {
    const jira = { ...CLICKUP.nouns, name: "Jira", item: "issue", move: "Transition to", verb: "Transition" };
    expect(moments(jira).move.blurb).toContain("issue block");
    expect(moments(CLICKUP.nouns).move.blurb).toContain("card block");
    expect(moments(jira).note.blurb).toBe("Writes a comment on the issue.");
  });
});

describe("the merge dialog's card choice", () => {
  const list = [{ status: "in progress", type: "custom" }, { status: "Done", type: "done" }, { status: "closed", type: "closed" }] as never[];
  test("opens on the workspace's own status when the list has it", () => {
    expect(mergePreselect(list, "in progress", ["done"])).toBe("Done");
  });
  test("tries the names in the order written and takes the first the list has", () => {
    expect(mergePreselect(list, "in progress", ["shipped", "closed", "done"])).toBe("closed");
  });
  test("a card already there, no names, or none of them present: leave it alone, never guess a word", () => {
    expect(mergePreselect(list, "done", ["done"])).toBe(LEAVE_ALONE);
    expect(mergePreselect(list, "in progress", [])).toBe(LEAVE_ALONE);
    expect(mergePreselect(list, "in progress", ["shipped"])).toBe(LEAVE_ALONE);
  });
});
