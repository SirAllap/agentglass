/*
 * What a Jira board does with its context, with no renderer: how cards group
 * under their parent, how a sprint's dates read, what a drop asks of the site
 * and where the dropped card sorts until the board is read again. Then the
 * rules about source the screen has to keep: a control the source cannot
 * honour is not drawn, a quick filter is a read and not a filter over rows, and
 * only a card of one status group can be dragged onto another of it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal";
import { epicTone, groupByParent, groupModeOf, guessOrder, rankOf, rankable, sortedByOrder, sprintLine } from "../src/lib/jiraBoardContext.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const stubGlobal = globalStubs();
const asked: string[] = [];
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
stubGlobal("fetch", async (input: unknown) => {
  const u = new URL(String(input));
  asked.push(u.pathname + u.search);
  return new Response(JSON.stringify({ ok: true, tasks: [], columns: [], at: 1 }), { headers: { "content-type": "application/json" } });
});
const { JIRA_BOARD, __forgetJiraReads } = await import("../src/lib/jiraBoard.ts");
const { CLICKUP_BOARD } = await import("../src/lib/boardSource.ts");

const card = (id: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: `ORBIT-${id}`, title: `Card ${id}`, status: "To Do", statusKind: "open", assignees: [], tags: [], ...o } as ProviderTask);
const under = (key: string, title = `Parent ${key}`, type = "Epic") => ({ parent: { key, title, type } });

describe("grouping by parent", () => {
  test("parents in the order their first card comes, each card kept in the order it arrived, the bare ones last", () => {
    const g = groupByParent([card("1", under("ORBIT-100")), card("2"), card("3", under("ORBIT-200")), card("4", under("ORBIT-100")), card("5")]);
    expect(g.map((x) => x.key)).toEqual(["ORBIT-100", "ORBIT-200", ""]);
    expect(g.map((x) => x.rows.map((t) => t.id))).toEqual([["1", "4"], ["3"], ["2", "5"]]);
    expect(g[0]).toMatchObject({ title: "Parent ORBIT-100", type: "Epic" });
    expect(g.at(-1)!.title).toBe("No parent");
  });
  test("how much of each is done is counted by the status's own kind", () => {
    const g = groupByParent([card("1", { ...under("ORBIT-100"), statusKind: "done" }), card("2", under("ORBIT-100")), card("3", { statusKind: "done" })]);
    expect(g[0]!.done).toBe(1);
    expect(g[1]!.done).toBe(1);
  });
  test("no cards with no parent is no empty group, and no cards at all is no groups", () => {
    expect(groupByParent([card("1", under("ORBIT-100"))]).map((x) => x.key)).toEqual(["ORBIT-100"]);
    expect(groupByParent([])).toEqual([]);
  });
  test("the saved choice is honoured only where there is a parent to group by", () => {
    expect(groupModeOf("parent", true)).toBe("parent");
    expect(groupModeOf("parent", false)).toBe("status");
    expect(groupModeOf(null, true)).toBe("status");
    expect(groupModeOf("nonsense", true)).toBe("status");
  });
  test("an epic's colour is a house tone by its number, and no colour is a quiet one", () => {
    expect(epicTone("color_1")).toBe("--primary");
    expect(epicTone("color_6")).toBe("--primary");
    expect(epicTone("dark_orange_2")).toBe("--success");
    expect(epicTone(undefined)).toBe("--text3");
    expect(epicTone("")).toBe("--text3");
  });
});

describe("the sprint line", () => {
  const s = (start: string, end: string) => ({ id: "41", name: "Sprint 4", state: "active" as const, start: Date.parse(start), end: Date.parse(end) });
  const at = (iso: string) => Date.parse(iso);
  test("the dates, and the days left counted by calendar day", () => {
    const sp = s("2026-10-05T09:00:00Z", "2026-10-19T09:00:00Z");
    expect(sprintLine(sp, at("2026-10-10T20:00:00Z"))).toEqual({ range: "Oct 5 – Oct 19", left: "9 days left", late: false });
    expect(sprintLine(sp, at("2026-10-18T10:00:00Z")).left).toBe("1 day left");
    expect(sprintLine(sp, at("2026-10-19T23:00:00Z")).left).toBe("ends today");
  });
  test("past the end it says so, and is late", () => {
    const sp = s("2026-10-05T09:00:00Z", "2026-10-19T09:00:00Z");
    expect(sprintLine(sp, at("2026-10-20T10:00:00Z"))).toMatchObject({ left: "ended yesterday", late: true });
    expect(sprintLine(sp, at("2026-10-25T10:00:00Z"))).toMatchObject({ left: "ended 6 days ago", late: true });
  });
  test("a sprint with no dates has no line about them", () => {
    expect(sprintLine({ id: "1", name: "Sprint 1", state: "active", start: 0, end: 0 }, Date.now())).toEqual({ range: "", left: "", late: false });
  });
});

describe("what a drop asks of the site", () => {
  const keys = ["ORBIT-1", "ORBIT-2", "ORBIT-3", "ORBIT-4"];
  test("the top half of a card is before it, the bottom half is after it", () => {
    expect(rankOf(keys, "ORBIT-4", "ORBIT-2", "top")).toEqual({ key: "ORBIT-4", ask: { before: "ORBIT-2" } });
    expect(rankOf(keys, "ORBIT-1", "ORBIT-3", "bottom")).toEqual({ key: "ORBIT-1", ask: { after: "ORBIT-3" } });
  });
  test("a drop that leaves the card where it is asks nothing", () => {
    expect(rankOf(keys, "ORBIT-2", "ORBIT-2", "top")).toBeNull();
    expect(rankOf(keys, "ORBIT-2", "ORBIT-3", "top")).toBeNull();
    expect(rankOf(keys, "ORBIT-2", "ORBIT-1", "bottom")).toBeNull();
    expect(rankOf(keys, "ORBIT-1", "ORBIT-1", "bottom")).toBeNull();
  });
  test("a card or a target the group does not hold asks nothing", () => {
    expect(rankOf(keys, "ORBIT-9", "ORBIT-2", "top")).toBeNull();
    expect(rankOf(keys, "ORBIT-2", "ORBIT-9", "top")).toBeNull();
  });
  test("the first and the last place are reachable", () => {
    expect(rankOf(keys, "ORBIT-3", "ORBIT-1", "top")).toEqual({ key: "ORBIT-3", ask: { before: "ORBIT-1" } });
    expect(rankOf(keys, "ORBIT-2", "ORBIT-4", "bottom")).toEqual({ key: "ORBIT-2", ask: { after: "ORBIT-4" } });
  });
});

describe("where the dropped card sorts until the board is read again", () => {
  const ranked = (id: string, order: string) => card(id, { order });
  test("half a step either side of its neighbour, which sorts between the right two", () => {
    const rows = [ranked("1", "000000"), ranked("2", "000001"), ranked("3", "000004"), ranked("4", "000005")];
    // The last card goes before the third.
    const before = guessOrder("000004", "top")!;
    expect(sortedByOrder(rows.map((t) => (t.id === "4" ? { ...t, order: before } : t))).map((t) => t.id)).toEqual(["1", "2", "4", "3"]);
    // The first goes after the second.
    const after = guessOrder("000001", "bottom")!;
    expect(sortedByOrder(rows.map((t) => (t.id === "1" ? { ...t, order: after } : t))).map((t) => t.id)).toEqual(["2", "1", "3", "4"]);
  });
  test("a neighbour with no order gives no guess, and a group is rankable only when every card has one", () => {
    expect(guessOrder(undefined, "top")).toBeNull();
    expect(guessOrder("", "top")).toBeNull();
    expect(guessOrder("x", "bottom")).toBeNull();
    expect(rankable([ranked("1", "000000"), ranked("2", "000001")])).toBe(true);
    expect(rankable([ranked("1", "000000"), card("2")])).toBe(false);
    expect(rankable([ranked("1", "000000")])).toBe(false);
  });
});

describe("the source and the screen", () => {
  const SRC = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const body = (() => { const from = SRC.indexOf("function ClickUpBody("); return strip(SRC.slice(from, SRC.indexOf("\n}\n", from) + 2)); })();
  const rowFn = (() => { const from = SRC.indexOf("function ClickUpRow("); return strip(SRC.slice(from, SRC.indexOf("\n}\n", from) + 2)); })();

  test("only Jira has a context to draw, and ClickUp's board has none of its controls", () => {
    expect(JIRA_BOARD.caps.context).toBe(true);
    expect(JIRA_BOARD.boardContext).toBeDefined();
    expect(JIRA_BOARD.rank).toBeDefined();
    expect(CLICKUP_BOARD.caps.context).toBeUndefined();
    expect(CLICKUP_BOARD.boardContext).toBeUndefined();
    expect(CLICKUP_BOARD.rank).toBeUndefined();
  });

  test("the context is drawn only where the source has it", () => {
    expect(body).toContain("source.caps.context && ctx && <JiraQuickChips");
    expect(body).toContain("source.caps.context && <JiraGroupBy");
    expect(body).toContain("!onLooked && ctx?.sprint &&");
    expect(rowFn).toContain("source.caps.context && t.issueType");
  });

  test("a quick filter is a read of the narrower board, with the filters of ITS board", async () => {
    __forgetJiraReads();
    asked.length = 0;
    await JIRA_BOARD.read("board:3", false, ["1", "2"]);
    expect(asked).toEqual(["/jira/view?id=board%3A3&filters=1%2C2"]);
    // No kept copy is asked for, and none is waited on: the whole board's minute is not the narrowed one's.
    expect(asked.some((a) => a.includes("cached=1"))).toBe(false);
    expect(body).toContain("source.read(id, false, quickRef.current[id])");
    expect(body).toContain("source.read(id, force, id ? quickRef.current[id] : undefined)");
    // Never a filter over the rows already on screen.
    expect(body).not.toMatch(/rows\.filter\([^)]*quick/);
  });

  test("a drop is a rank only inside one status group, with the write switch on, on a board, never grouped by parent", () => {
    expect(body).toContain("const canRank = !!source.rank && !!boards?.writeEnabled && !!boardViewId?.startsWith(\"board:\") && !byParent && !onLooked;");
    expect(body).toContain("if (!canRank || !rankable(g.rows)) return undefined;");
    // Both halves of a drag ask: the line is only drawn inside the group, and a drop outside it sends nothing.
    expect(body.split("from.group !== g.status").length - 1).toBe(2);
    // The parent groups' rows are never given a drag.
    const parentBlock = body.slice(body.indexOf("{byParent && parentGroups.map"), body.indexOf("{!onLooked && !byParent && groups.map"));
    expect(parentBlock).not.toContain("drag=");
    expect(parentBlock).toContain("showStatus");
  });

  test("a row is draggable only when it was handed a drag, and the drop line is out of the layout", () => {
    expect(rowFn).toContain("draggable={!!drag}");
    expect(rowFn).toMatch(/absolute left-0 right-0 pointer-events-none/);
    expect(rowFn).not.toMatch(/drag\?\.edge[^\n]*paddingTop|drag\?\.edge[^\n]*marginTop/);
  });
});
