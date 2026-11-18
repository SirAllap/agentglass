/* The board card's menu rows from the approved mockup: Edit in panel, Create subtask, Clone, Send to terminal's two children, Sprint's Next and Backlog, Epic. Pure: no screen. */
import { describe, expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import { cardActions, epicChildren, filterActions, type CardActionFacts } from "../src/components/jira/list/menus/cardActions.ts";
import { WRITES_OFF_WHY } from "../src/components/jira/list/menus/menuModel.ts";

const card = (o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id: "1", customId: "ORB-1", title: "Card", status: "In progress", statusKind: "open", assignees: [], tags: [], url: "https://acme.example.net/browse/ORB-1", priority: null, due: null, updated: 0, issueType: "Task", ...o } as ProviderTask);
const facts = (o: Partial<CardActionFacts> = {}): CardActionFacts => ({
  pr: null, pinned: false, writable: true, moves: { to: [] }, people: [], agent: false,
  sprint: { name: "S14" }, futures: [{ id: "15", name: "S15" }], epics: [{ key: "ORB-10", name: "Onboarding" }, { key: "ORB-11", name: "Billing" }], ...o,
});
const all = (o?: Partial<CardActionFacts>, t = card()) => cardActions(t, facts(o)).groups.flatMap((g) => g.items);
const row = (id: string, o?: Partial<CardActionFacts>, t = card()) => all(o, t).find((r) => r.id === id)!;

describe("the groups follow the mockup", () => {
  test("Open has Edit in panel after Open card; Work has Create subtask and Clone", () => {
    const g = cardActions(card(), facts()).groups;
    expect(g[0]!.items.map((i) => i.id)).toEqual(["open", "edit", "openJira"]);
    expect(g[1]!.items.map((i) => i.id)).toEqual(["terminal", "next", "flight", "subtask", "clone"]);
    expect(g[2]!.items.map((i) => i.id)).toEqual(["moveTo", "assignTo", "sprintTo", "epicTo"]);
  });
  test("Send to terminal has two children and says what each does", () => {
    const kids = row("terminal").children!;
    expect(kids.map((k) => k.id)).toEqual(["worker", "copyPrompt"]);
    expect(kids[0]!.sub).toContain("starts work");
    expect(kids[1]!.sub).toContain("no terminal");
  });
});

describe("writes are off with the reason when Changes is off", () => {
  test("Edit, Create subtask, Clone, Sprint and Epic carry the reason", () => {
    for (const id of ["edit", "subtask", "clone", "sprintTo", "epicTo"]) expect(row(id, { writable: false }).why).toBe(WRITES_OFF_WHY);
    for (const id of ["edit", "subtask", "clone", "sprintTo", "epicTo"]) expect(row(id).why).toBeUndefined();
  });
  test("a sub-task takes no sub-task and follows its parent's epic; an epic is in none", () => {
    expect(row("subtask", {}, card({ issueType: "Sub-task" })).why).toContain("sub-task");
    expect(row("epicTo", {}, card({ issueType: "Sub-task" })).why).toContain("parent");
    expect(row("epicTo", {}, card({ issueType: "Epic" })).why).toContain("epic");
  });
});

describe("Sprint", () => {
  test("Current, the future sprint and Backlog, with a check on the one the card is in", () => {
    const kids = (o: Partial<CardActionFacts>) => row("sprintTo", o).children!;
    expect(kids({ inSprint: true }).map((k) => [k.id, !!k.chk])).toEqual([["sprint:current", true], ["sprint:to:15", false], ["sprint:backlog", false]]);
    expect(kids({ sprintId: "15" }).map((k) => !!k.chk)).toEqual([false, true, false]);
    expect(kids({ inBacklog: true }).map((k) => !!k.chk)).toEqual([false, false, true]);
  });
  test("no future sprint planned shows Next off, and no active sprint turns only Current off", () => {
    const kids0 = row("sprintTo", { futures: [] }).children!;
    expect(kids0.map((k) => k.id)).toEqual(["sprint:current", "sprint:next", "sprint:backlog"]);
    expect(kids0[1]!.why).toContain("next sprint");
    const kids = row("sprintTo", { sprint: null, inBacklog: true }).children!;
    expect(kids[0]!.why).toContain("No active sprint");
    expect(kids[2]!.why).toBeUndefined();
  });
  test("three future sprints: each by name with its dates, in the board's order, the card's one ticked", () => {
    const at = (y: number, m: number, d: number) => new Date(y, m, d, 12).getTime();
    const futures = [
      { id: "3", name: "S3", start: at(2026, 10, 18), end: at(2026, 11, 2) },
      { id: "4", name: "S4", start: at(2026, 11, 2), end: at(2026, 11, 16) },
      { id: "5", name: "S5" },
    ];
    const kids = row("sprintTo", { futures, sprintId: "4" }).children!;
    expect(kids.map((k) => [k.id, k.label, k.sub ?? "", !!k.chk])).toEqual([
      ["sprint:current", "Current S14", "", false],
      ["sprint:to:3", "S3", "Nov 18 – Dec 2", false],
      ["sprint:to:4", "S4", "Dec 2 – Dec 16", true],
      ["sprint:to:5", "S5", "", false],
      ["sprint:backlog", "Backlog", "", false],
    ]);
    expect(kids.every((k) => !k.why)).toBe(true);
  });
  test("a view with no sprints (no Sprint facts) draws no Sprint row", () => {
    expect(all({ sprint: undefined }).some((r) => r.id === "sprintTo")).toBe(false);
  });
});

describe("Epic", () => {
  test("lists the epics, then No epic; the card's own is checked, and No epic is when it has none", () => {
    const inEpic = card({ parent: { key: "ORB-11", title: "Billing", type: "Epic" } });
    expect(epicChildren(inEpic, facts()).map((k) => [k.id, !!k.chk])).toEqual([["epic:ORB-10", false], ["epic:ORB-11", true], ["epic:", false]]);
    expect(epicChildren(card(), facts()).map((k) => !!k.chk)).toEqual([false, false, true]);
  });
  test("a parent that is not an epic does not check one", () => {
    const sub = card({ parent: { key: "ORB-11", title: "Billing", type: "Story" } });
    expect(epicChildren(sub, facts()).some((k) => k.id === "epic:ORB-11" && k.chk)).toBe(false);
  });
  test("the row is not drawn where the view does not know its epics, and says so when there are none", () => {
    expect(all({ epics: undefined }).some((r) => r.id === "epicTo")).toBe(false);
    expect(row("epicTo", { epics: [] }).why).toContain("no epics");
  });
  test("the filter reaches an epic by name", () => {
    const rows = filterActions(cardActions(card(), facts()).groups, "billing");
    expect(rows.map((r) => r.id)).toEqual(["epic:ORB-11"]);
  });
});

describe("the card menu's submenu takes clicks", () => {
  // The menu's portal sits at LAYER.menu with a full-window catcher that closes it on an outside click. A submenu in
  // a portal below that layer is drawn but under the catcher: every click on Sprint, Move to, Assign or Copy closed
  // the menu and did nothing.
  test("its portal is above the menu's own layer", async () => {
    const src = await Bun.file(new URL("../src/components/jira/list/menus/JiraCardMenu.tsx", import.meta.url)).text();
    const z = /<Portal z=\{([^}]+)\}>\s*\n?\s*<SubPanel/.exec(src)?.[1] ?? /<Portal z=\{([^}]+)\}>/.exec(src)?.[1];
    expect(z).toBe("LAYER.menu + 1");
    const { LAYER } = await import("../src/lib/layers.ts");
    const menu = await Bun.file(new URL("../src/components/ContextMenu.tsx", import.meta.url)).text();
    expect(menu).toContain("<Portal z={LAYER.menu}>");
    expect(LAYER.menu + 1).toBeGreaterThan(LAYER.menu);
  });
});
