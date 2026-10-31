/*
 * The lanes and rows of the Jira list: grouping, nesting, paging, columns, sorting, the states, and the source rules the
 * screen files must keep (every row reports a right-click, the pull-request chip reads through the shared store, no native
 * tooltip). The pure rules run here without a renderer.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ListStatus, ProviderTask } from "../../shared/providers.ts";
import {
  FIRST_PAGE, FULL_UP_TO, MORE_PAGE, buildLanes, columnsFor, filtering, listState, morePage, nestSubtasks, sortCards, staleNote,
  thirdColumn, visibleRows, CLEARED, type LaneInput,
} from "../src/components/jira/list/laneModel.ts";
import { NO_FILTERS } from "../src/components/jira/list/model.ts";
import { __resetLaneState, laneFolded, laneSortOf, setLaneFolded, setLaneSort } from "../src/lib/jiraLaneState.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const mem = new Map<string, string>();
stubGlobal("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
afterAll(() => __resetLaneState());

const st = (status: string, i: number, type: ListStatus["type"] = "open"): ListStatus => ({ status, type, orderindex: i });
const card = (id: string, status: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: `ORB-${id}`, title: `Card ${id}`, status, statusKind: "open", assignees: [], tags: [], ...o } as ProviderTask);
const STATUSES = [st("To do", 0), st("In progress", 1), st("Done", 2, "done")];
const input = (cards: ProviderTask[], o: Partial<LaneInput> = {}): LaneInput =>
  ({ cards, statuses: STATUSES, group: "status", thenGroup: "none", epics: [], ...o });

describe("sub-tasks nest under their parent", () => {
  const parent = card("1", "To do");
  const kid = card("2", "To do", { issueType: "Sub-task", parent: { key: "ORB-1", title: "Parent", type: "Story" } as ProviderTask["parent"] });
  test("a sub-task in the same list goes under its parent", () => {
    const rows = nestSubtasks([parent, kid]);
    expect(rows.map((r) => r.card.id)).toEqual(["1"]);
    expect(rows[0]!.subs.map((s) => s.id)).toEqual(["2"]);
  });
  test("a sub-task whose parent is elsewhere keeps a row of its own, so no lane count lies", () => {
    expect(nestSubtasks([kid]).map((r) => r.card.id)).toEqual(["2"]);
  });
});

describe("a long lane pages", () => {
  test("up to the full-up-to size every row is drawn", () => {
    expect(visibleRows(FULL_UP_TO, 0)).toBe(FULL_UP_TO);
  });
  test("120 cards draw 8, then 40 more at a time, and the button says what is left", () => {
    expect(visibleRows(120, 0)).toBe(FIRST_PAGE);
    expect(morePage(120, 8)).toEqual({ step: MORE_PAGE, left: 120 - 8 - MORE_PAGE });
    expect(visibleRows(120, MORE_PAGE)).toBe(48);
    expect(morePage(120, 112)).toEqual({ step: 8, left: 0 });
    expect(morePage(120, 120)).toBeNull();
  });
});

describe("the lanes", () => {
  test("status lanes follow the workflow, a finished lane only when it holds something", () => {
    const lanes = buildLanes(input([card("1", "To do"), card("2", "In progress")]));
    expect(lanes.map((l) => l.status)).toEqual(["To do", "In progress"]);
    expect(buildLanes(input([card("3", "Done", { statusKind: "done" })])).map((l) => l.status)).toContain("Done");
  });
  test("with an active sprint the rest is a Backlog lane, folded by default and never in the sprint's own page", () => {
    const cards = [card("1", "To do", { sprint: "Sprint 4" }), card("2", "To do")];
    const lanes = buildLanes(input(cards, { sprintName: "Sprint 4" }));
    const back = lanes.find((l) => l.key === "backlog");
    expect(back?.folded).toBe(true);
    expect(back?.cards.map((t) => t.id)).toEqual(["2"]);
    expect(buildLanes(input(cards, { sprintName: "Sprint 4", sprintView: true })).some((l) => l.key === "backlog")).toBe(false);
  });
  test("Assigned to me is one lane per project, each row wearing its status dot", () => {
    const lanes = buildLanes(input([card("1", "To do", { list: "Orbit" }), card("2", "To do", { list: "Acme" })], { assigned: true }));
    expect(lanes.map((l) => l.status).sort()).toEqual(["Acme", "Orbit"]);
    expect(lanes.every((l) => l.flat)).toBe(true);
  });
  test("grouping by priority gives a lane per priority; Then splits each by status once", () => {
    const cards = [card("1", "To do", { priority: "high" }), card("2", "In progress", { priority: "high" })];
    const lanes = buildLanes(input(cards, { group: "priority", thenGroup: "status" }));
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.sub?.map((s) => s.status)).toEqual(["To do", "In progress"]);
    expect(lanes[0]!.sub?.every((s) => s.key?.startsWith(`${lanes[0]!.key}/`))).toBe(true);
  });
  test("the third column is the sprint where cards have one, the epic for projects and areas", () => {
    expect(thirdColumn({ group: "status", cards: [card("1", "To do", { sprint: "Sprint 4" })] })).toBe("Sprint");
    expect(thirdColumn({ group: "status", cards: [card("1", "To do")] })).toBe("Epic");
    expect(thirdColumn({ group: "status", assigned: true, cards: [card("1", "To do", { sprint: "S" })] })).toBe("Epic");
  });
});

describe("sorting a lane", () => {
  const a = card("10", "To do", { priority: "low", due: "2026-11-02" });
  const b = card("2", "To do", { priority: "urgent" });
  const c = card("3", "To do", { priority: "high", due: "2026-11-01" });
  test("rank keeps the given order", () => expect(sortCards([a, b, c], "rank").map((t) => t.id)).toEqual(["10", "2", "3"]));
  test("key sorts ORB-2 before ORB-10", () => expect(sortCards([a, b, c], "key").map((t) => t.id)).toEqual(["2", "3", "10"]));
  test("priority puts urgent first", () => expect(sortCards([a, b, c], "priority").map((t) => t.id)).toEqual(["2", "3", "10"]));
  test("due puts soonest first and a card without a date last", () => expect(sortCards([a, b, c], "due").map((t) => t.id)).toEqual(["3", "10", "2"]));
});

describe("the columns that fit", () => {
  test("all of them when wide, Epic goes first and Due last as it narrows", () => {
    expect(columnsFor(1400)).toMatchObject({ epic: true, pr: true, who: true, due: true, pts: true });
    expect(columnsFor(0).epic).toBe(true);
    const mid = columnsFor(905);
    expect(mid.epic).toBe(false);
    expect(mid.due).toBe(true);
    expect(columnsFor(300)).toMatchObject({ epic: false, pts: false, who: false, pr: false, due: false });
  });
});

describe("what the list area shows", () => {
  const base = { error: undefined, shown: 3, areaId: null };
  test("each phase has its state", () => {
    expect(listState({ ...base, phase: "loading" })).toBe("loading");
    expect(listState({ ...base, phase: "failed", error: "Jira is not connected" })).toBe("not-connected");
    expect(listState({ ...base, phase: "failed", error: "HTTP 500" })).toBe("failed");
    expect(listState({ ...base, phase: "empty" })).toBe("empty-space");
    expect(listState({ ...base, phase: "empty", areaId: "ORB-9" })).toBe("epic-0");
    expect(listState({ ...base, phase: "ready", shown: 0 })).toBe("no-match");
    expect(listState({ ...base, phase: "ready" })).toBe("lanes");
  });
  test("filters count as narrowing; the grouping does not, and CLEARED undoes them", () => {
    expect(filtering(NO_FILTERS)).toBe(false);
    expect(filtering({ ...NO_FILTERS, group: "priority" })).toBe(false);
    expect(filtering({ ...NO_FILTERS, mineOnly: true })).toBe(true);
    expect(filtering({ ...NO_FILTERS, mineOnly: true, query: "x", ...CLEARED })).toBe(false);
  });
  test("a failed re-read over cards on screen is a strip that says how old they are", () => {
    const m = { read: "retrying" as const, phase: "ready" as const, error: "Could not reach Jira", throttled: false, unauthorised: false, at: 0 };
    expect(staleNote({ ...m, read: "fine" })).toBeNull();
    expect(staleNote(m)).toEqual({ tone: "warn", text: "Could not reach Jira. Showing the cards from an earlier read." });
    expect(staleNote({ ...m, read: "stale", unauthorised: true })?.tone).toBe("err");
  });
});

describe("what a person did to the lanes", () => {
  beforeEach(() => { mem.clear(); __resetLaneState(); });
  test("a sort is remembered per view and lane, rank is the default and clears the entry", () => {
    expect(laneSortOf("board:1", "status:to do")).toBe("rank");
    setLaneSort("board:1", "status:to do", "due");
    expect(laneSortOf("board:1", "status:to do")).toBe("due");
    expect(laneSortOf("board:2", "status:to do")).toBe("rank");
    expect(JSON.parse(mem.get("agentglass.jira.laneSort")!)).toEqual({ "board:1|status:to do": "due" });
    setLaneSort("board:1", "status:to do", "rank");
    expect(laneSortOf("board:1", "status:to do")).toBe("rank");
  });
  test("a lane falls back to its own fold default until the person chooses", () => {
    expect(laneFolded("v", "backlog", true)).toBe(true);
    setLaneFolded("v", ["backlog"], false);
    expect(laneFolded("v", "backlog", true)).toBe(false);
  });
});

describe("source rules of the screen files", () => {
  const dir = import.meta.dir + "/../src/components/jira/list/";
  const read = (f: string) => Bun.file(dir + f).text();
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const files = ["JiraRow.tsx", "JiraLaneHead.tsx", "JiraLanes.tsx", "JiraStates.tsx", "JiraStrip.tsx", "JiraColumns.tsx"];
  const sources = Promise.all(files.map(async (f) => [f, code(await read(f))] as const));

  test("rows report a right-click, sub-task rows through their own door", async () => {
    const src = Object.fromEntries(await sources);
    expect(src["JiraRow.tsx"]).toContain("onContextMenu={onMenu ?");
    expect(src["JiraLanes.tsx"]).toContain("sub ? onSubtaskMenu : onRowMenu");
    expect(src["JiraLaneHead.tsx"]).toContain("onMenu(e, lane)");
  });
  test("the pull-request chip reads through the shared store, never its own fetch", async () => {
    const src = Object.fromEntries(await sources);
    expect(src["JiraRow.tsx"]).toContain("cardPrsOf(");
    for (const [, s] of Object.entries(src)) expect(s).not.toMatch(/\/jira\/prs|fetch\(/);
  });
  test("no native title tooltip in the new files", async () => {
    for (const [, s] of await sources) expect(s).not.toMatch(/<(?:div|span|button|a|b|img|svg|p|section)\b[^>]*\stitle=/);
  });
});
