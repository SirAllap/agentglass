/*
 * The lanes and rows of the Jira list: grouping, nesting, paging, columns, sorting, the states, and the source rules the
 * screen files must keep (every row reports a right-click, the pull-request chip reads through the shared store, no native
 * tooltip). The pure rules run here without a renderer.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ListStatus, ProviderTask } from "../../shared/providers.ts";
import { api } from "../src/lib/api.ts";
import { forgetJiraSubtasks, jiraSubtasksVersion, onJiraSubtasks, peekJiraSubtasks, readJiraSubtasks } from "../src/lib/jiraSubtasks.ts";
import {
  FIRST_PAGE, FULL_UP_TO, MORE_PAGE, buildLanes, childRows, columnsFor, epicColumn, filtering, keyOf, listState, morePage, nestSubtasks, opensSubtasks,
  sortCards, staleNote, thirdColumn, visibleRows, CLEARED, type LaneInput,
} from "../src/components/jira/list/laneModel.ts";
import { NO_FILTERS } from "../src/components/jira/list/model.ts";
import { SHOWN_FACES, peopleOf } from "../src/components/jira/list/PeopleFaces.tsx";
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

describe("a child row's Epic column", () => {
  const epic = { key: "ORB-10", title: "Report improvements", type: "Epic" } as ProviderTask["parent"];
  const parent = card("1", "To do", { parent: epic });
  const kid = (o: Partial<ProviderTask> = {}): ProviderTask =>
    card("2", "To do", { issueType: "Sub-task", parent: { key: "ORB-1", title: "Card 1", type: "Story" } as ProviderTask["parent"], ...o });

  test("a card wears its own epic, as any row does", () => {
    expect(epicColumn(parent)?.key).toBe("ORB-10");
    expect(epicColumn(card("3", "To do"))).toBeUndefined();
  });

  test("a sub-task inherits the epic of the row it hangs under", () => {
    expect(epicColumn(kid(), parent)?.key).toBe("ORB-10");
  });

  test("a sub-task's own parent is that row, not an epic: with no epic above, the column is empty", () => {
    expect(epicColumn(kid())).toBeUndefined();
    expect(epicColumn(kid(), card("4", "To do"))).toBeUndefined();
  });

  test("an epic Jira puts on the sub-task itself wins over the row's", () => {
    expect(epicColumn(kid({ parent: epic }), parent)?.key).toBe("ORB-10");
    expect(epicColumn(kid({ parent: { key: "ORB-11", title: "Another epic", type: "Epic" } }), parent)?.key).toBe("ORB-11");
  });
});

describe("a parent opens the sub-tasks its board read left out", () => {
  /* The reported case: a row wearing `↳ 1` with nothing under it, because the board's search never returns the child. */
  const parent = card("1", "To do", { subtasks: 2 });
  const kid = (id: string, o: Partial<ProviderTask> = {}): ProviderTask =>
    card(id, "To do", { issueType: "Sub-task", parent: { key: "ORB-1", title: "Card 1", type: "Story" } as ProviderTask["parent"], ...o });

  test("the chevron is the card's own count, less the children its lane already draws", () => {
    expect(opensSubtasks(parent)).toBe(true);
    expect(opensSubtasks(card("2", "To do"))).toBe(false);
    expect(opensSubtasks(card("3", "To do", { subtasks: 0 }))).toBe(false);
    expect(opensSubtasks(parent, 1)).toBe(true);
    // A chevron that would open nothing is a dead control: a text search does return sub-tasks.
    expect(opensSubtasks(card("4", "To do", { subtasks: 1 }), 1)).toBe(false);
    expect(opensSubtasks(kid("5", { subtasks: 2 }))).toBe(false);
  });

  test("a child row keeps its own key and status, never the parent's lane's", () => {
    const rows = childRows([kid("2", { status: "Merged", statusKind: "done" })], []);
    expect(rows.map((t) => [keyOf(t), t.title, t.status, t.statusKind])).toEqual([["ORB-2", "Card 2", "Merged", "done"]]);
  });

  test("a child the lane already draws under its parent is not drawn a second time", () => {
    const child = kid("2");
    const entry = nestSubtasks([parent, child])[0]!;
    expect(entry.subs.map((t) => t.id)).toEqual(["2"]);
    expect(childRows([child, kid("3")], entry.subs).map((t) => t.id)).toEqual(["3"]);
  });
});

describe("a parent's sub-tasks are one read per parent, held for the session", () => {
  const calls: string[] = [];
  const store = api as unknown as Record<string, unknown>;
  const saved = store.jiraChildCards;
  const ok = (): Promise<unknown> => Promise.resolve({ ok: true, tasks: [card("2", "Merged", { statusKind: "done" })] });
  let answer: () => Promise<unknown> = ok;
  store.jiraChildCards = (k: string) => { calls.push(k); return answer(); };
  const dir = import.meta.dir + "/../src/components/jira/list/";
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  afterAll(() => { store.jiraChildCards = saved; forgetJiraSubtasks(); });
  beforeEach(() => { calls.length = 0; answer = ok; forgetJiraSubtasks(); });

  test("a closed parent costs no request, and its row says nothing about sub-tasks it has not read", () => {
    expect(peekJiraSubtasks("ORB-1")).toBeNull();
    expect(calls).toEqual([]);
  });

  test("however many rows ask while one is in flight, and however often it is opened, it is one request per parent", async () => {
    const [x, y] = await Promise.all([readJiraSubtasks("ORB-1"), readJiraSubtasks("ORB-1")]);
    const again = await readJiraSubtasks("ORB-1");
    await readJiraSubtasks("ORB-2");
    expect(calls).toEqual(["ORB-1", "ORB-2"]);
    expect(x).toBe(y);
    expect(again).toBe(x);
    expect(x.rows.map((t) => t.id)).toEqual(["2"]);
  });

  test("the rows land and the lanes are told, so a parent already open fills in", async () => {
    let told = 0;
    const off = onJiraSubtasks(() => { told++; });
    const v = jiraSubtasksVersion();
    await readJiraSubtasks("ORB-1");
    off();
    expect(jiraSubtasksVersion()).toBeGreaterThan(v);
    expect(told).toBe(1);
    expect(peekJiraSubtasks("ORB-1")?.rows.length).toBe(1);
  });

  test("a child comes back as a card, not a stub: who, the due date and the points ride with it", async () => {
    answer = () => Promise.resolve({ ok: true, tasks: [card("2", "Merged", { due: "2026-11-10", points: 3, people: [{ key: "acc-1", name: "Ada Example", initials: "AE" }] })] });
    const r = await readJiraSubtasks("ORBIT-1");
    expect(r.rows[0]).toMatchObject({ due: "2026-11-10", points: 3 });
    expect(r.rows[0]!.people?.[0]?.name).toBe("Ada Example");
  });

  test("a site that does not answer is asked once, and the row says so", async () => {
    answer = () => Promise.resolve({ ok: false, error: "Jira did not answer" });
    const r = await readJiraSubtasks("ORB-1");
    await readJiraSubtasks("ORB-1");
    expect(r.error).toBe("Jira did not answer");
    expect(calls.length).toBe(1);
  });

  test("the lane reads the store when a parent opens and never fetches itself; the store has no timer", async () => {
    const lanes = code(await Bun.file(dir + "JiraLanes.tsx").text());
    expect(lanes).toContain("void readJiraSubtasks(key)");
    expect(lanes).toContain("expanded ? peekJiraSubtasks(key) : null");
    for (const f of ["JiraLanes.tsx", "JiraRow.tsx"]) expect(code(await Bun.file(dir + f).text())).not.toMatch(/api\.|fetch\(|\/jira\//);
    const store = code(await Bun.file(import.meta.dir + "/../src/lib/jiraSubtasks.ts").text());
    expect(store).not.toMatch(/setInterval|setTimeout/);
    expect(store).toContain("api.jiraChildCards(key)");
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
  test("Assigned to me grouped by project is one lane per project, each row wearing its status dot", () => {
    const lanes = buildLanes(input([card("1", "To do", { list: "Orbit" }), card("2", "To do", { list: "Acme" })], { assigned: true, group: "project" }));
    expect(lanes.map((l) => l.status).sort()).toEqual(["Acme", "Orbit"]);
    expect(lanes.every((l) => l.flat)).toBe(true);
  });
  test("Assigned to me grouped by status is the workflow's lanes across projects, not one lane per project", () => {
    const lanes = buildLanes(input([card("1", "To do", { list: "Orbit" }), card("2", "To do", { list: "Acme" })], { assigned: true, group: "status" }));
    expect(lanes.map((l) => l.status)).not.toContain("Acme");
    expect(lanes.find((l) => l.status === "To do")?.cards).toHaveLength(2);
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
  test("all of them when wide, Agent goes first, then Who and PR as it narrows", () => {
    expect(columnsFor(1400)).toMatchObject({ status: true, agent: true, pr: true, who: true });
    expect(columnsFor(0).agent).toBe(true);
    const mid = columnsFor(905);
    expect(mid.agent).toBe(false);
    expect(mid.status).toBe(true);
    expect(columnsFor(300)).toMatchObject({ status: false, agent: false, who: false, pr: false });
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

describe("the faces of an epic's children", () => {
  const person = (name: string, key?: string) => ({ key: key ?? name.toLowerCase(), name, initials: name.slice(0, 2).toUpperCase() });
  const three = [person("Ana Li", "acc-1"), person("Sam Orbit", "acc-2"), person("Ola Berg", "acc-3")];
  test("the same person on three children is drawn once, in card order", () => {
    const cards = [
      card("1", "To do", { people: [three[0]!, three[1]!] }),
      card("2", "To do", { people: [three[0]!, three[2]!] }),
    ];
    expect(peopleOf(cards).map((p) => p.name)).toEqual(["Ana Li", "Sam Orbit", "Ola Berg"]);
  });
  test("an epic whose children have nobody gives an empty stack", () => {
    expect(peopleOf([card("1", "To do"), card("2", "Done")])).toEqual([]);
  });
  test("no key and no id still tells two people apart by name", () => {
    const cards = [card("1", "To do", { people: [{ name: "Ana Li", initials: "AL" }, { name: "Ana Li", initials: "AL" }, { name: "Ola Berg", initials: "OB" }] })];
    expect(peopleOf(cards).map((p) => p.name)).toEqual(["Ana Li", "Ola Berg"]);
  });
  test("the epic page's head reads the cards its rows read, write and all", async () => {
    const src = await Bun.file(import.meta.dir + "/../src/components/TasksPanel.tsx").text();
    const head = src.split("\n").find((l) => l.includes("<JiraAreaHead ")) ?? "";
    // The rows draw `over[t.id] ?? t`; a head on the raw read keeps yesterday's people after an assign.
    expect(head).toContain("people={peopleOf(areaHeld.map((t) => over[t.id] ?? t))}");
  });
});

describe("source rules of the screen files", () => {
  const dir = import.meta.dir + "/../src/components/jira/list/";
  const read = (f: string) => Bun.file(dir + f).text();
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const files = ["JiraRow.tsx", "JiraLaneHead.tsx", "JiraLanes.tsx", "JiraStates.tsx", "JiraStrip.tsx", "JiraColumns.tsx", "PeopleFaces.tsx"];
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
  test("an epic's head wears the faces of its children, and only an epic's head does", async () => {
    const head = await read("JiraLaneHead.tsx");
    expect(head).toContain("agx-jl-eph");
    expect(head).toContain("agx-jl-stack");
    // A person or priority lane lists its own people in the column already; faces here would be one each.
    expect(head.match(/<PeopleFaces /g)?.length ?? 0).toBe(0);
  });
  test("the row and the head share one stack, so an avatar cannot be fixed in one and not the other", async () => {
    const row = await read("JiraRow.tsx");
    const faces = await read("PeopleFaces.tsx");
    expect(row).toContain("import { PeopleFaces } from \"./PeopleFaces.tsx\"");
    expect(row).not.toContain("<span className=\"agx-jl-face\"");
    expect(faces).toContain("people.slice(0, SHOWN_FACES)");
  });
  test("the stack is one keyboard stop with every name, and the rest keeps its own tip", async () => {
    const faces = await read("PeopleFaces.tsx");
    expect(faces).toContain("tabIndex={focusable ? 0 : undefined}");
    expect(faces).toContain("aria-label={focusable ? `People: ${names}` : undefined}");
    // The names are the tip's sentence, not its bold title: ten of them as a name is a four-line block.
    expect(faces).toContain('data-tip={tipAttr({ name: "People", text: names })}');
    expect(faces).toContain("data-tip={tipAttr({ name: `${rest} more`, text:");
    expect(SHOWN_FACES).toBe(3);
  });
  test("the stack never swallows the click that folds its head", async () => {
    const faces = await read("PeopleFaces.tsx");
    // The head folds on a click anywhere in it, faces included; a stop here makes that strip dead. Only the board
    // card's stack, which is a button when it is given onPick, stops the click: the plain stack never does.
    const stops = faces.split("\n").filter((l) => l.includes("stopPropagation"));
    expect(stops.length).toBeGreaterThan(0);
    for (const l of stops) expect(l, l.trim().slice(0, 80)).toMatch(/onPick|onPointerDown=\{\(e\) => e\.stopPropagation\(\)\} onClick=\{\(e\) => \{ e\.stopPropagation\(\); onPick/);
  });
  test("a head that grows faces does not move when the pointer arrives", async () => {
    const css = await Bun.file(import.meta.dir + "/../src/index.css").text();
    expect(css).toContain(".agx-jl-head .agx-jl-stack { flex: none; }");
    const faces = await read("PeopleFaces.tsx");
    expect(faces).not.toMatch(/onMouseEnter|onMouseLeave|:hover/);
  });
});

describe("a row opens its sub-tasks where it sits", () => {
  const dir = import.meta.dir + "/../src/components/jira/list/";
  const read = (f: string) => Bun.file(dir + f).text();
  const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const css = () => Bun.file(import.meta.dir + "/../src/index.css").text();

  test("the chevron is a button that says whether it is open, and its press never opens the card", async () => {
    const row = code(await read("JiraRow.tsx"));
    expect(row).toContain('className="agx-jl-twist" aria-expanded={open.expanded}');
    expect(row).toContain("onClick={(e) => { e.stopPropagation(); open.onToggle(); }}");
    // Enter reaches the row only when the row itself has the focus: on the chevron it is the button's own press.
    expect(row).toContain("e.target === e.currentTarget");
  });

  test("the gutter is on every row, so a parent's chevron moves no column", async () => {
    const row = code(await read("JiraRow.tsx"));
    expect(row).toContain(") : <span aria-hidden />}");
    // The captions take the same track, or the two drift apart by one column.
    expect(code(await read("JiraColumns.tsx"))).toContain("<span />\n        <span>Key</span>\n        <span>Card</span>");
    expect(await css()).toContain("--jl-cols: 42px 22px minmax(280px, 2fr)");
  });

  test("an opened child wears the Subtasks section's own chip, drawn once", async () => {
    const row = code(await read("JiraRow.tsx"));
    expect(row).toContain('import { StateChip } from "../DockParts.tsx"');
    expect(row).toContain("chip && <StateChip status={t.status}");
    expect(row.match(/<StateChip /g)?.length).toBe(1);
  });

  test("opening a parent asks Jira once, through the store, and the lane never fetches itself", async () => {
    const lanes = code(await read("JiraLanes.tsx"));
    expect(lanes).toContain("childRows(read.rows, e.subs)");
    expect(lanes).toContain("epicColumn(t, o.above)");
    expect(lanes).toContain("above: e.card");
    expect(lanes).toContain("opensSubtasks(e.card, e.subs.length)");
    for (const f of ["JiraLanes.tsx", "JiraRow.tsx"]) expect(code(await read(f))).not.toMatch(/api\.|fetch\(|\/jira\//);
  });

  test("the chevron turns without moving for a person who asked it not to, and is closed at first", async () => {
    const sheet = await css();
    expect(sheet).toContain('.agx-jl-row .agx-jl-twist[aria-expanded="false"] { transform: rotate(-90deg); }');
    expect(sheet).toContain("@media (prefers-reduced-motion: reduce) { .agx-jl-twist { transition: none; } }");
    expect(code(await read("JiraLanes.tsx"))).toContain("const isOpen = (key: string) => opened[`${view}|${key}`] ?? false;");
  });
});
