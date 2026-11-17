/* The Priority group, and how a pane lists values: picked on top, others by count, empty ones dimmed (empty statuses folded). */
import { describe, expect, test } from "bun:test";
import { filterCards, NO_FILTERS, type JiraListFilters } from "../src/components/jira/list/model.ts";
import { groupRows, railSummary, sentenceParts, togglePatch } from "../src/components/jira/list/filtersV2Model.ts";
import { pickRest, readLayout, tabRestore, NO_LAYOUT } from "../src/components/jira/list/viewsModel.ts";
import { filterCount } from "../src/components/jira/list/headerModel.ts";

let n = 0;
const card = (status: string, priority: string | null) => ({ id: `c${++n}`, title: "t", key: `ORBIT-${n}`, status, statusKind: "open", tags: [], priority }) as never;
const cards = [card("Doing", "high"), card("Doing", "high"), card("Doing", null), card("Review", "low")];
const f = (p: Partial<JiraListFilters>): JiraListFilters => ({ ...NO_FILTERS, ...p });
const src = { cards, statuses: [{ status: "Todo", type: "open" }, { status: "Doing", type: "open" }, { status: "Review", type: "open" }] as never, tags: [], team: [] };

describe("priority filter", () => {
  test("a picked priority keeps only those cards; none means no priority", () => {
    expect(filterCards(cards, f({ priorityPick: ["high"] })).length).toBe(2);
    expect(filterCards(cards, f({ priorityPick: ["none"] })).length).toBe(1);
  });
  test("is not leaves it out", () => expect(filterCards(cards, f({ notPick: { priority: ["high"] } })).length).toBe(2));
  test("pick patch, rail, sentence, badge", () => {
    const p = togglePatch("priority", f({}), "high");
    expect(p).toEqual({ priorityPick: ["high"] });
    const x = f(p);
    expect(railSummary(x, "priority")).toBe("High");
    expect(sentenceParts(x).map((s) => `${s.lead} ${s.label}`)).toEqual(["with priority High"]);
    expect(filterCount(x)).toBe(1);
  });
  test("it survives a restart; an old saved state without it still loads", () => {
    const kept = pickRest(f({ priorityPick: ["low"] }));
    expect(kept.priorityPick).toEqual(["low"]);
    const layout = readLayout({ kept: { "|": { statusPick: ["Doing"] } } });
    expect(tabRestore(layout, "", "", undefined).priorityPick).toEqual([]);
    expect(tabRestore(readLayout({ kept: { "|": kept } }), "", "", undefined).priorityPick).toEqual(["low"]);
  });
});

describe("how a pane lists values", () => {
  test("priorities: by count, none in this view dimmed at the end", () => {
    const rows = groupRows("priority", f({}), src);
    expect(rows.map((r) => r.id)).toEqual(["high", "low", "none", "urgent", "normal"]);
    expect(rows.find((r) => r.id === "urgent")!.note).toBe("none in this view");
    expect(rows.find((r) => r.id === "high")!.note).toBeUndefined();
  });
  test("a picked value stays on top even with a small count", () => {
    expect(groupRows("priority", f({ priorityPick: ["low"] }), src)[0]!.id).toBe("low");
  });
  test("an empty status is folded; an empty picked status is not", () => {
    expect(groupRows("status", f({}), src).filter((r) => r.folded).map((r) => r.id)).toEqual(["Todo"]);
    expect(groupRows("status", f({ statusPick: ["Todo"] }), src).some((r) => r.folded)).toBe(false);
  });
});

import { facetCounts, nextGroup, paneKey, stepRow } from "../src/components/jira/list/filtersV2Model.ts";

describe("facet counts", () => {
  test("a group's counts apply every other group but not its own", () => {
    const x = f({ statusPick: ["Doing"], priorityPick: ["high"] });
    // priority counts: Doing cards only (status applies), the priority pick itself does not
    expect(Object.fromEntries(facetCounts("priority", x, src)!)).toEqual({ high: 2, none: 1 });
    // status counts: high cards only
    expect(Object.fromEntries(facetCounts("status", x, src)!)).toEqual({ Doing: 2 });
  });
  test("rows carry them: a value with no card under the other picks is dimmed", () => {
    const rows = groupRows("priority", f({ statusPick: ["Review"] }), src);
    expect(rows.find((r) => r.id === "low")!.count).toBe(1);
    expect(rows.find((r) => r.id === "high")!.note).toBe("none in this view");
  });
  test("Done counts the done cards picking it would show, though Hide done is on", () => {
    const done = { ...(card("Done", null) as object), statusKind: "done" } as never;
    const c = facetCounts("status", f({ showDone: false }), { ...src, cards: [...cards, done, done] })!;
    expect(c.get("Done")).toBe(2);
  });
  test("toggle groups have none", () => expect(facetCounts("signals", f({}), src)).toBeNull());
});

describe("keyboard", () => {
  test("keys map to actions", () => {
    expect(paneKey({ key: "ArrowDown" })).toEqual({ move: 1 });
    expect(paneKey({ key: " " })).toEqual({ pick: "is" });
    expect(paneKey({ key: " ", altKey: true })).toEqual({ pick: "not" });
    expect(paneKey({ key: "Tab", shiftKey: true }, { rail: true })).toEqual({ group: -1 });
    expect(paneKey({ key: "/" })).toEqual({ search: true });
    expect(paneKey({ key: "a" })).toBeNull();
  });
  test("Tab is the browser's off the rail; Up/Down are the radio group's own", () => {
    expect(paneKey({ key: "Tab" })).toBeNull();
    expect(paneKey({ key: "Tab", shiftKey: true }, { radio: true })).toBeNull();
    expect(paneKey({ key: "ArrowDown" }, { radio: true })).toBeNull();
    expect(paneKey({ key: "ArrowUp" }, { rail: true })).toEqual({ move: -1 });
  });
  test("Tab wraps over the groups; rows stop at the ends", () => {
    expect(nextGroup("status", 1)).toBe("sprint");
    expect(nextGroup("status", -1)).toBe("signals");
    expect(stepRow(-1, 1, 3)).toBe(0);
    expect(stepRow(-1, -1, 3)).toBe(2);
    expect(stepRow(2, 1, 3)).toBe(2);
    expect(stepRow(0, -1, 3)).toBe(0);
    expect(stepRow(0, 1, 0)).toBe(-1);
  });
});

import { MAX_PRESETS, presetIsOn, presetPatch, removePreset, savePreset } from "../src/components/jira/list/viewsModel.ts";

describe("Saved row", () => {
  const on = f({ statusPick: ["Doing"], priorityPick: ["high"], query: "words" });
  test("saving keeps what is on, not the search words; the same name replaces", () => {
    const l = savePreset(readLayout(null), " Hot ", on, true);
    expect(Object.keys(l.saved!)).toEqual(["Hot"]);
    expect(l.saved!.Hot!.query).toBeUndefined();
    expect(savePreset(l, "Hot", f({ statusPick: ["Review"] }), true).saved!.Hot!.statusPick).toEqual(["Review"]);
  });
  test("nothing on, no name, or too many keeps nothing", () => {
    expect(savePreset(readLayout(null), "x", f({}), false).saved).toBeUndefined();
    expect(savePreset(readLayout(null), "  ", on, true).saved).toBeUndefined();
    let l = readLayout(null);
    for (let i = 0; i < MAX_PRESETS + 3; i++) l = savePreset(l, `s${i}`, on, true);
    expect(Object.keys(l.saved!).length).toBe(MAX_PRESETS);
  });
  test("applying turns everything else off first, and reads as on", () => {
    const k = savePreset(readLayout(null), "Hot", on, true).saved!.Hot!;
    const now = f({ tagPick: ["flaky"], mineOnly: true });
    const applied = { ...now, ...presetPatch(k) } as JiraListFilters;
    expect(applied.tagPick).toEqual([]);
    expect(applied.mineOnly).toBe(false);
    expect(applied.priorityPick).toEqual(["high"]);
    expect(presetIsOn(applied, k)).toBe(true);
    expect(presetIsOn(now, k)).toBe(false);
  });
  test("it survives a restart; forgetting removes it; old state without it loads", () => {
    const l = savePreset(readLayout(null), "Hot", on, true);
    expect(readLayout(JSON.parse(JSON.stringify(l))).saved!.Hot!.priorityPick).toEqual(["high"]);
    expect(removePreset(l, "Hot").saved).toEqual({});
    expect(readLayout({ order: [] }).saved).toBeUndefined();
  });
});
