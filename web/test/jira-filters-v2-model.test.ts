/* The Filters popover V2's model: the sentence on top, the rail summaries, what a group's Clear does. */
import { describe, expect, test } from "bun:test";
import { NO_FILTERS, type JiraListFilters } from "../src/components/jira/list/model.ts";
import { clearGroup, GROUPS, cardsLine, pickedIn, railSummary, sentenceParts, showLabel } from "../src/components/jira/list/filtersV2Model.ts";

const f = (p: Partial<JiraListFilters>): JiraListFilters => ({ ...NO_FILTERS, ...p });

describe("sentenceParts", () => {
  test("nothing on reads as no parts", () => expect(sentenceParts(f({}))).toEqual([]));
  test("each narrowing is one part with its own lead words, in reading order", () => {
    const p = sentenceParts(f({ spaces: ["ORBIT"], statusPick: ["Code review", "Ready for QA"], tagPick: ["flaky"], mineOnly: true }));
    expect(p.map((x) => `${x.lead} ${x.label}`)).toEqual(["in ORBIT", "assigned to me", "status Code review or Ready for QA", "labelled flaky"]);
  });
  test("removing a part clears only its own group", () => {
    const p = sentenceParts(f({ statusPick: ["Done"], tagPick: ["flaky"] }));
    expect(p.find((x) => x.id === "label")!.clear).toEqual({ tagPick: [], tagAll: false });
  });
  test("an epic reads by its title, a person by their name, falling back to the key", () => {
    const p = sentenceParts(f({ epicPick: ["ORBIT-7", "ORBIT-9"], assigneePick: ["u1"] }), { epics: { "ORBIT-7": "Auth hardening" }, people: { u1: "Ada Orbit" } });
    expect(p.find((x) => x.id === "epic")!.label).toBe("Auth hardening or ORBIT-9");
    expect(p.find((x) => x.id === "people")!.label).toBe("Ada Orbit");
  });
  test("a toggle reads in lower case; show done reads as including done", () => {
    const p = sentenceParts(f({ flaggedOnly: true, showDone: true }));
    expect(p.map((x) => `${x.lead} ${x.label}`)).toEqual(["that are flagged", "including done"]);
  });
});

describe("railSummary and pickedIn", () => {
  test("a group with nothing picked says any", () => { for (const g of GROUPS) expect(railSummary(f({}), g.id)).toBe("any"); });
  test("counts picks, and names one or two spaces", () => {
    expect(railSummary(f({ statusPick: ["A", "B"] }), "status")).toBe("2 picked");
    expect(railSummary(f({ spaces: ["ORBIT"] }), "space")).toBe("ORBIT");
    expect(railSummary(f({ spaces: ["A", "B", "C"] }), "space")).toBe("3 picked");
  });
  test("people count Mine with the picked faces", () => {
    expect(pickedIn(f({ mineOnly: true, assigneePick: ["u1"] }), "people")).toBe(2);
    expect(railSummary(f({ mineOnly: true }), "people")).toBe("me");
  });
  test("signals name the one on, count when several", () => {
    expect(railSummary(f({ blockedOnly: true }), "signals")).toBe("Blocked");
    expect(railSummary(f({ blockedOnly: true, flaggedOnly: true }), "signals")).toBe("2 on");
  });
});

describe("CLEAR_GROUP", () => {
  test("clearing a group undoes exactly what it picked", () => {
    const on = f({ statusPick: ["A"], tagPick: ["x"], assigneePick: ["u1"], mineOnly: true, dueOnly: true });
    for (const g of GROUPS) {
      const after = { ...on, ...clearGroup(on, g.id) };
      expect(pickedIn(after, g.id)).toBe(0);
    }
    expect({ ...on, ...clearGroup(on, "status") }.tagPick).toEqual(["x"]);
  });
});

describe("the corner", () => {
  test("N of M cards, singular for one", () => {
    expect(cardsLine(5, 63)).toEqual({ n: "5", of: "of 63 cards" });
    expect(cardsLine(1, 1).of).toBe("of 1 card");
    expect(showLabel(1)).toBe("Show 1 card");
    expect(showLabel(5)).toBe("Show 5 cards");
  });
});

import { groupRows, searchRows, togglePatch } from "../src/components/jira/list/filtersV2Model.ts";
describe("rows of the open group", () => {
  const src = { cards: [], statuses: [], tags: ["flaky", "infra-cost"], team: [{ key: "u1", name: "Ada Orbit" }] } as never;
  test("a pick turns a row on and a second pick turns it off", () => {
    const on = f({ ...togglePatch("label", f({}), "flaky") });
    expect(groupRows("label", on, src).map((r) => r.on)).toEqual([true, false]);
    expect(togglePatch("label", on, "flaky")).toEqual({ tagPick: [] });
  });
  test("a switch group flips its own field", () => {
    expect(togglePatch("signals", f({}), "blockedOnly")).toEqual({ blockedOnly: true });
    expect(groupRows("signals", f({ blockedOnly: true }), src).find((r) => r.id === "blockedOnly")!.on).toBe(true);
    expect(groupRows("signals", f({}), src).some((r) => r.id === "dueOnly")).toBe(false);
  });
  test("search keeps rows holding the words, any case", () => {
    expect(searchRows(groupRows("label", f({}), src), " INFRA ").map((r) => r.label)).toEqual(["infra-cost"]);
    expect(searchRows(groupRows("people", f({}), src), "").length).toBe(1);
  });
});
