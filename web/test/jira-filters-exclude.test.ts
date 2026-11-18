/* "Is not": every value can be left out; a pick and an exclusion never sit together; Label takes any of / all of; it all survives a restart. */
import { describe, expect, test } from "bun:test";
import { filterCards, NO_FILTERS, type JiraListFilters } from "../src/components/jira/list/model.ts";
import { clearGroup, groupRows, pickedIn, railSummary, sentenceParts, togglePatch } from "../src/components/jira/list/filtersV2Model.ts";
import { pickRest, readLayout } from "../src/components/jira/list/viewsModel.ts";
import { filterCount } from "../src/components/jira/list/headerModel.ts";

let n = 0;
const card = (status: string, tags: string[], extra: Record<string, unknown> = {}) => ({ id: `c${++n}`, title: "t", key: `ORBIT-${1000 + n}`, status, statusKind: "open", tags, ...extra }) as never;
const cards = [card("Doing", ["flaky", "infra"]), card("Doing", ["infra"]), card("Review", ["flaky"]), card("Review", [])];
const f = (p: Partial<JiraListFilters>): JiraListFilters => ({ ...NO_FILTERS, ...p });
const left = (p: Partial<JiraListFilters>) => filterCards(cards, f(p)).length;

describe("leaving values out", () => {
  test("a left-out label hides the cards that hold it", () => expect(left({ notPick: { label: ["flaky"] } })).toBe(2));
  test("a left-out status hides it, in every group the same way", () => expect(left({ notPick: { status: ["Review"] } })).toBe(2));
  test("a pick and an exclusion together: in infra, not flaky", () => expect(left({ tagPick: ["infra"], notPick: { label: ["flaky"] } })).toBe(1));
  test("a space left out hides that space, whatever the case", () => {
    const two = [card("Doing", [], { customId: "ORBIT-1" }), card("Doing", [], { customId: "ACME-2" })];
    expect(filterCards(two, f({ notPick: { space: ["acme"] } })).length).toBe(1);
  });
});

describe("any of / all of", () => {
  test("any of keeps cards with one of the labels, all of only with every one", () => {
    expect(left({ tagPick: ["flaky", "infra"] })).toBe(3);
    expect(left({ tagPick: ["flaky", "infra"], tagAll: true })).toBe(1);
  });
});

describe("the toggle", () => {
  test("is not on a value leaves it out, a second time takes it back", () => {
    const on = f(togglePatch("label", f({}), "flaky", "not"));
    expect(on.notPick).toEqual({ label: ["flaky"] });
    expect(togglePatch("label", on, "flaky", "not")).toEqual({ notPick: { label: [] } });
  });
  test("leaving out a picked value moves it over, never keeps it in both", () => {
    const p = togglePatch("label", f({ tagPick: ["flaky"] }), "flaky", "not");
    expect(p.tagPick).toEqual([]);
    expect(p.notPick).toEqual({ label: ["flaky"] });
  });
  test("picking a left-out value takes the exclusion away", () => {
    const p = togglePatch("label", f({ notPick: { label: ["flaky"] } }), "flaky");
    expect(p.notPick).toEqual({ label: [] });
    expect(p.tagPick).toEqual(["flaky"]);
  });
  test("switch groups (signals) have no is not", () => expect(togglePatch("signals", f({}), "blockedOnly", "not")).toEqual({ blockedOnly: true }));
  test("the row says it is left out", () => {
    const rows = groupRows("label", f({ notPick: { label: ["flaky"] } }), { cards, statuses: [], tags: ["flaky", "infra"], team: [] });
    expect(rows.map((r) => [r.id, !!r.out, r.on])).toEqual([["flaky", true, false], ["infra", false, false]]);
  });
});

describe("what the popover says", () => {
  const on = f({ tagPick: ["infra"], notPick: { label: ["flaky"] } });
  test("the sentence marks the left-out part", () => {
    const p = sentenceParts(on).find((x) => x.excluded)!;
    expect(`${p.lead} ${p.label}`).toBe("not flaky");
    expect(f(p.clear as never).notPick).toEqual({ label: [] });
  });
  test("all of reads as and", () => expect(sentenceParts(f({ tagPick: ["a", "b"], tagAll: true })).find((x) => x.id === "label")!.label).toBe("a and b"));
  test("the rail and the badge count the exclusions", () => {
    expect(railSummary(f({ notPick: { label: ["flaky"] } }), "label")).toBe("not flaky");
    expect(railSummary(on, "label")).toBe("1 picked · 1 not");
    expect(filterCount(on)).toBe(2);
  });
  test("clearing the group clears both lists and all of", () => {
    const after = { ...f({ tagPick: ["a"], tagAll: true, notPick: { label: ["b"], status: ["Done"] } }) };
    const next = { ...after, ...clearGroup(after, "label") };
    expect(pickedIn(next, "label")).toBe(0);
    expect(next.tagAll).toBe(false);
    expect(next.notPick).toEqual({ status: ["Done"] });
  });
});

describe("a restart", () => {
  test("exclusions and all of are kept; old saved state without them still loads", () => {
    const kept = pickRest(f({ tagAll: true, notPick: { label: ["flaky"], status: [] } }));
    const back = readLayout(JSON.parse(JSON.stringify({ kept: { "v|": kept } }))).kept["v|"]!;
    expect(back.notPick).toEqual({ label: ["flaky"] });
    expect(back.tagAll).toBe(true);
    const old = readLayout({ kept: { "v|": { statusPick: ["Doing"] } } }).kept["v|"]!;
    expect(old.statusPick).toEqual(["Doing"]);
    expect(old.notPick).toBeUndefined();
  });
});
