/* Filters set on a Jira view survive a restart, per view: "Assigned to me" and "Team" each keep their own. */
import { describe, expect, test } from "bun:test";
import { NO_FILTERS } from "../src/components/jira/list/model.ts";
import { activeChips, keepRest, keptKey, mayKeepRest, pickRest, readLayout, tabRestore, NO_LAYOUT } from "../src/components/jira/list/viewsModel.ts";
import { ASSIGNED_VIEW_ID } from "../../shared/providers.ts";
import { TAB_PREFIX } from "../src/components/jira/list/tabsModel.ts";
import { filterCount } from "../src/components/jira/list/headerModel.ts";

const restart = (l: typeof NO_LAYOUT) => readLayout(JSON.parse(JSON.stringify(l)));

describe("filters survive a restart, per view", () => {
  test("Spaces ORBIT + Hide done come back for the view they were set on, not for the other", () => {
    const mine = keptKey("view:assigned", "tab:mine");
    const team = keptKey("view:assigned", "tab:team");
    const set = { ...NO_FILTERS, spaces: ["ORBIT"], showDone: false, query: "login", quick: ["q1"] };
    const stored = restart(keepRest(NO_LAYOUT, mine, pickRest(set)));
    const back = { ...NO_FILTERS, ...stored.kept[mine] };
    expect(back.spaces).toEqual(["ORBIT"]);
    expect(back.showDone).toBe(false);
    expect(back.query).toBe("login");
    expect(back.quick).toEqual(["q1"]);
    expect(activeChips(back, undefined).map((c) => c.label)).toEqual(["Search: login", "Spaces: ORBIT", "Hide done", "q1"]);
    expect(stored.kept[team]).toBeUndefined();
  });
  test("the count is the picks: Hide done, the default, is a chip but not a pick", () => {
    expect(filterCount({ ...NO_FILTERS, spaces: ["ORBIT"], showDone: false })).toBe(1);
  });
  test("Clear all stored is the cleared state", () => {
    const k = keptKey("v", "");
    const l = restart(keepRest(keepRest(NO_LAYOUT, k, pickRest({ ...NO_FILTERS, spaces: ["ORBIT"] })), k, pickRest({ ...NO_FILTERS, showDone: true })));
    expect(l.kept[k]?.spaces).toEqual([]);
  });
  test("a restart reads junk as nothing", () => {
    expect(readLayout({ kept: { a: "x", b: { spaces: [1, "ORBIT"], showDone: "yes" } } }).kept.b).toEqual({ spaces: ["ORBIT"] });
  });
});

const MINE = TAB_PREFIX + "mine";
describe("the tab a view starts on gets its kept filters back", () => {
  const key = keptKey(ASSIGNED_VIEW_ID, MINE);
  const stored = restart(keepRest(NO_LAYOUT, key, pickRest({ ...NO_FILTERS, spaces: ["INF"], showDone: false })));
  test("Spaces INF and Hide done are applied on a fresh start, and the stored copy is unchanged", () => {
    const before = JSON.stringify(stored);
    const applied = { ...NO_FILTERS, ...tabRestore(stored, ASSIGNED_VIEW_ID, MINE, undefined) };
    expect(applied.spaces).toEqual(["INF"]);
    expect(activeChips(applied, undefined).map((c) => c.label)).toEqual(["Spaces: INF", "Hide done"]);
    expect(JSON.stringify(stored)).toBe(before);
  });
  test("old per-tab lists that are empty never wipe the slot", () => {
    expect(tabRestore(stored, ASSIGNED_VIEW_ID, MINE, { spaces: [], statusPick: [], people: [], tags: [] }).spaces).toEqual(["INF"]);
  });
  test("a layout that arrives late restores the same way; before it arrives nothing is written", () => {
    expect(tabRestore(NO_LAYOUT, ASSIGNED_VIEW_ID, MINE, undefined).spaces).toEqual([]);
    expect(mayKeepRest(ASSIGNED_VIEW_ID, null)).toBe(false);
    expect(mayKeepRest(ASSIGNED_VIEW_ID, MINE)).toBe(true);
    expect(mayKeepRest("view:other", null)).toBe(true);
  });
});

describe("the tab-less 'Assigned to me' slot is Mine's only", () => {
  test("Team does not restore Mine's saved filters", () => {
    const mine = TAB_PREFIX + "mine";
    const team = TAB_PREFIX + "team";
    const stored = keepRest(NO_LAYOUT, keptKey(ASSIGNED_VIEW_ID, null), { ...pickRest(NO_FILTERS), assigneePick: ["u1"], showDone: true });
    expect(tabRestore(stored, ASSIGNED_VIEW_ID, mine, undefined).assigneePick).toEqual(["u1"]);
    expect(tabRestore(stored, ASSIGNED_VIEW_ID, team, undefined).assigneePick ?? []).toEqual([]);
  });
});
