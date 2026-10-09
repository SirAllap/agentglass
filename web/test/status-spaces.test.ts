/*
 * Which spaces the status picker leads with.
 *
 * The fixture is the shape of a real workspace: ten spaces from Get Spaces, one
 * of them holding all the person's cards with an eighteen-status set, a legacy
 * space nobody uses, and cards that each carry their space and their status.
 */
import { describe, expect, test } from "bun:test";
import type { ClickUpSpace } from "../../shared/providers.ts";
import { statusSpaces } from "../../shared/statusSpaces.ts";
import { CLICKUP } from "../src/lib/clickupWorkflow.ts";
import { allStatuses, countedIds, moments, reach, reachOf, splitSpaces, withCounted, type Step } from "../src/lib/workflowMap.ts";

const st = (status: string, type = "custom") => ({ status, type });
const WORK = ["to do", "shaping", "ready for design", "in design", "ready for engineering", "in development", "code review", "pre qa", "ready for qa", "in qa", "qa complete", "blocked", "ready for deployment", "in staging", "in production", "released", "won't fix / obsolete", "completed"];
const SPACES: ClickUpSpace[] = [
  { id: "1", name: "Platform / Build", statuses: [st("open", "open"), st("closed", "closed")] },
  { id: "2", name: "Old Board (LEGACY DO NOT USE)", statuses: [st("in progress"), st("done", "done")] },
  { id: "3", name: "Orbit", statuses: WORK.map((w) => st(w)) },
  { id: "4", name: "Sales", statuses: [st("requests"), st("backlog/wishlist")] },
  { id: "5", name: "Support", statuses: [st("open", "open"), st("solved", "closed")] },
];
const card = (spaceId: string | undefined, listId: string, list: string, status: string) =>
  ({ spaceId, listId, list, status, statusKind: "other" as const });
const names = (r: { spaces: ClickUpSpace[] }) => r.spaces.map((s) => s.name);

describe("statusSpaces", () => {
  test("cards across three lists of one space: that space leads, marked as yours, the rest follow", () => {
    const r = statusSpaces(SPACES, [
      card("3", "10", "Bugs", "code review"), card("3", "11", "Misc", "in production"), card("3", "12", "Search", "pre qa"),
    ]);
    expect(r.source).toBe("tasks");
    expect(names(r)).toEqual(["Orbit", "Platform / Build", "Sales", "Support", "Old Board (LEGACY DO NOT USE)"]);
    expect(r.spaces[0]).toMatchObject({ mine: true, cards: 3 });
    expect(r.spaces[0]!.statuses.length).toBe(18);
    expect(r.spaces.slice(1).every((s) => s.mine === false)).toBe(true);
    expect(r.spaces.map((s) => s.counted)).toEqual([true, false, false, false, false]);
  });

  test("space-level statuses only: no card has a status its space lacks, so no list is invented", () => {
    const r = statusSpaces(SPACES, [card("3", "10", "Bugs", "Code Review")]);
    expect(r.spaces.some((s) => s.fromList)).toBe(false);
  });

  test("a list that overrides its space: its own statuses appear, as seen on its cards, named by space and list", () => {
    const r = statusSpaces(SPACES, [
      card("5", "20", "Tickets", "open"),
      card("5", "21", "Escalations", "triage"), card("5", "21", "Escalations", "waiting on vendor"), card("5", "21", "Escalations", "triage"),
    ]);
    const o = r.spaces.find((s) => s.fromList)!;
    expect(o.name).toBe("Support / Escalations");
    expect(o.statuses.map((x) => x.status)).toEqual(["triage", "waiting on vendor"]);
    expect(o).toMatchObject({ mine: true, cards: 3 });
    expect(names(r).indexOf("Support")).toBeLessThan(names(r).indexOf("Support / Escalations"));
  });

  test("the busiest space is first, whatever order the workspace answered in", () => {
    const r = statusSpaces(SPACES, [
      card("3", "10", "Bugs", "blocked"),
      card("5", "30", "Tickets", "open"), card("5", "30", "Tickets", "open"), card("5", "31", "Chat", "solved"),
    ]);
    expect(names(r).slice(0, 2)).toEqual(["Support", "Orbit"]);
  });

  test("a legacy space the person has no cards in goes last, and is flagged", () => {
    const r = statusSpaces(SPACES, [card("3", "10", "Bugs", "blocked")]);
    expect(names(r).at(-1)).toBe("Old Board (LEGACY DO NOT USE)");
    expect(r.spaces.at(-1)!.legacy).toBe(true);
  });

  test("no cards read yet: every space comes back and counts (legacy last), with a sentence that says why", () => {
    const r = statusSpaces(SPACES, []);
    expect(r.source).toBe("spaces");
    expect(names(r)).toEqual(["Platform / Build", "Orbit", "Sales", "Support", "Old Board (LEGACY DO NOT USE)"]);
    expect(r.spaces.every((s) => s.counted)).toBe(true);
    expect(r.note).toContain("No cards have been read yet");
    expect(r.spaces.some((s) => s.mine !== undefined)).toBe(false);
  });

  test("cards that name no space (a payload without one) fall back too, and say so differently", () => {
    const r = statusSpaces(SPACES, [card(undefined, "10", "Bugs", "blocked")]);
    expect(r.source).toBe("spaces");
    expect(r.note).toContain("None of your cards say which space");
  });

  test("cards in a space the workspace answer no longer lists are ignored, not a crash", () => {
    const r = statusSpaces(SPACES, [card("999", "1", "Gone", "x")]);
    expect(r.source).toBe("spaces");
  });
});

describe("the person chooses which spaces count", () => {
  const cards = [card("3", "10", "Bugs", "blocked"), card("3", "10", "Bugs", "blocked"), card("5", "30", "Tickets", "open")];

  test("a choice beats where the cards live: the chosen count, the rest are ignored but still in the answer", () => {
    const r = statusSpaces(SPACES, cards, ["4", "5"]);
    expect(r.source).toBe("chosen");
    expect(r.spaces.filter((s) => s.counted).map((s) => s.name)).toEqual(["Support", "Sales"]);
    expect(r.spaces.filter((s) => !s.counted).map((s) => s.name).sort()).toEqual(["Old Board (LEGACY DO NOT USE)", "Orbit", "Platform / Build"].sort());
    expect(r.spaces.length).toBe(SPACES.length);
    expect(r.spaces.find((s) => s.name === "Orbit")).toMatchObject({ counted: false, mine: true });
  });

  test("a choice holds before any card is read", () => {
    const r = statusSpaces(SPACES, [], ["4"]);
    expect(r.source).toBe("chosen");
    expect(r.spaces.filter((s) => s.counted).map((s) => s.name)).toEqual(["Sales"]);
    expect(r.note).toBeUndefined();
  });

  test("a list place follows its space: ignored with it, counted with it", () => {
    const over = [card("5", "21", "Escalations", "triage")];
    const withIt = statusSpaces(SPACES, over, ["5"]).spaces.find((s) => s.fromList)!;
    expect(withIt).toMatchObject({ counted: true, spaceId: "5" });
    const without = statusSpaces(SPACES, over, ["4"]).spaces.find((s) => s.fromList)!;
    expect(without.counted).toBe(false);
  });

  test("a choice naming only spaces that no longer exist falls back to the default and says so", () => {
    const r = statusSpaces(SPACES, cards, ["999"]);
    expect(r.source).toBe("tasks");
    expect(r.note).toContain("no longer in this workspace");
    expect(r.spaces.filter((s) => s.counted).map((s) => s.name)).toEqual(["Orbit", "Support"]);
  });

  test("ignoring and counting again work on the counted ids, and never leave nothing counted", () => {
    const sp = statusSpaces(SPACES, cards).spaces;
    expect(countedIds(sp)).toEqual(["3", "5"]);
    expect(withCounted(sp, "3", false)).toEqual(["5"]);
    expect(withCounted(sp, "4", true)).toEqual(["3", "5", "4"]);
    expect(withCounted(statusSpaces(SPACES, [], ["4"]).spaces, "4", false)).toBeNull();
  });

  test("a step whose status lives only in an ignored space says so, and is not 'absent' or silently fine", () => {
    const sp = statusSpaces(SPACES, cards, ["5"]).spaces;
    const { yours, other } = splitSpaces(sp);
    const step: Step = { kind: "move", status: "ready for qa", also: [], unassign: "none", assign: { who: "none" } };
    const m = moments(CLICKUP.nouns)[step.kind];
    expect(reachOf(yours, step, m, other)).toEqual({ kind: "ignored", where: ["Orbit"] });
    // Counted again, the same step is plain coverage.
    const back = splitSpaces(statusSpaces(SPACES, cards, ["5", "3"]).spaces);
    expect(reachOf(back.yours, step, m, back.other).kind).toBe("some");
    // A status no space has at all stays what it was: absent, not "ignored".
    expect(reachOf(yours, { ...step, status: "nowhere" }, m, other).kind).toBe("some");
  });

  test("ignored spaces are out of the picker's statuses and out of the coverage count", () => {
    const { yours } = splitSpaces(statusSpaces(SPACES, cards, ["4", "5"]).spaces);
    expect(allStatuses(yours).some((x) => x.name === "ready for qa")).toBe(false);
    expect(reach(yours, "open", "spaces").text).toBe("only Support");
    expect(reach(yours, "requests", "spaces").text).toBe("only Sales");
  });
});

describe("the picker reads the narrowed spaces", () => {
  const r = statusSpaces(SPACES, [card("3", "10", "Bugs", "blocked")]);
  const { yours, other } = splitSpaces(r.spaces);

  test("his eighteen statuses are the picker, in full, and reach reads against his one space, not against ten", () => {
    expect(allStatuses(yours).length).toBe(18);
    expect(allStatuses(yours).find((x) => x.name === "ready for engineering")).toBeDefined();
    expect(reach(yours, "ready for engineering", "spaces").text).toBe("all 1 spaces");
  });

  test("the ignored spaces are kept for the Ignored group, not removed and not mixed in", () => {
    expect(other.map((s) => s.name)).toContain("Sales");
    expect(allStatuses(yours).some((x) => x.name === "requests")).toBe(false);
    expect(allStatuses(other).some((x) => x.name === "requests")).toBe(true);
  });

  test("with nothing known, nothing is hidden", () => {
    const s = splitSpaces(SPACES);
    expect(s.yours.length).toBe(SPACES.length);
    expect(s.other).toEqual([]);
  });
});
