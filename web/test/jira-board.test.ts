/*
 * The Jira tab is the Tasks board with Jira as its source.
 *
 * Three things have to hold and none of them needs a renderer: the groups are
 * the view's own statuses in the view's own order (empty ones kept), a column
 * a site has no data for is not drawn, and a control Jira cannot honour is left
 * out of the screen rather than drawn and refused. The first two are pure rules
 * lifted out of the body (lib/boardGroups.ts) and run here; the third is a rule
 * about source and is asserted against it, like the other screens'.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal";
import { blockersOf, foldCard, groupByStatus, looksLikeCardId, readyCount, tableColumns } from "../src/lib/boardGroups.ts";
import type { JiraViewRead, ListStatus, ProviderTask } from "../../shared/providers.ts";
import { readState } from "../src/lib/boardStaleness.ts";

const stubGlobal = globalStubs();
let asked: { path: string; method: string }[] = [];
let signals: (AbortSignal | null | undefined)[] = [];
let answer: (path: string) => unknown = () => ({ ok: true });
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
stubGlobal("fetch", async (input: unknown, init?: { method?: string; signal?: AbortSignal | null }) => {
  signals.push(init?.signal);
  const u = new URL(String(input));
  const path = u.pathname + u.search;
  asked.push({ path, method: init?.method ?? "GET" });
  return new Response(JSON.stringify(answer(path)), { headers: { "content-type": "application/json" } });
});
const { JIRA_BOARD, boardOf, statusesOfCards, __forgetJiraReads } = await import("../src/lib/jiraBoard.ts");
const { CLICKUP_BOARD } = await import("../src/lib/boardSource.ts");

const SRC = readFileSync(new URL("../src/components/TasksPanel.tsx", import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const body = (() => {
  const from = SRC.indexOf("function ClickUpBody(");
  return strip(SRC.slice(from, SRC.indexOf("\n}\n", from) + 2));
})();

const st = (status: string, i: number, type: ListStatus["type"] = "open"): ListStatus => ({ status, type, orderindex: i });
const card = (id: string, status: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: `ORBIT-${id}`, title: `Card ${id}`, status, statusKind: "open", assignees: [], tags: [], ...o } as ProviderTask);

/* The shape of a board whose columns are not the order the cards arrive in. */
const SEVEN = [st("Backlog", 0), st("Selected", 1), st("In Progress", 2), st("In Review", 3), st("QA", 4), st("Done", 5, "done"), st("Released", 6, "done")];

describe("the groups are the view's own statuses", () => {
  const cards = [card("5", "QA"), card("1", "Backlog"), card("3", "In Progress"), card("9", "Done", { statusKind: "done" }), card("4", "In Progress"), card("8", "Released", { statusKind: "done" })];

  test("seven groups in column order, two of them empty, whatever order the cards arrive in", () => {
    const g = groupByStatus(cards, SEVEN);
    expect(g.map((x) => x.status)).toEqual(["Backlog", "Selected", "In Progress", "In Review", "QA", "Done", "Released"]);
    expect(g.map((x) => x.rows.length)).toEqual([1, 0, 2, 0, 1, 1, 1]);
    expect(g.filter((x) => x.rows.length === 0).map((x) => x.status)).toEqual(["Selected", "In Review"]);
  });

  test("done comes from the status's own type, not from its name", () => {
    const g = groupByStatus(cards, [...SEVEN.slice(0, 5), st("Finished?", 5, "open"), st("Shipped", 6, "done")]);
    expect(g.find((x) => x.status === "Finished?")!.done).toBe(false);
    expect(g.find((x) => x.status === "Shipped")!.done).toBe(true);
  });

  test("a card in a status the view did not list still shows, after the listed ones", () => {
    const g = groupByStatus([...cards, card("7", "On hold")], SEVEN);
    expect(g.at(-1)!.status).toBe("On hold");
    expect(g.at(-1)!.rows).toHaveLength(1);
  });

  test("points add up per group, and a card with none adds nothing", () => {
    const g = groupByStatus([card("1", "QA", { points: 3 }), card("2", "QA", { points: 0 }), card("3", "QA")], SEVEN);
    expect(g.find((x) => x.status === "QA")!.points).toBe(3);
  });

  test("inside a group the caller's own order is applied, to the cards of that group only", () => {
    const g = groupByStatus([card("1", "QA"), card("2", "QA"), card("3", "Done")], SEVEN, (list) => [...list].reverse());
    expect(g.find((s) => s.status === "QA")!.rows.map((t) => t.id)).toEqual(["2", "1"]);
    expect(g.find((s) => s.status === "Done")!.rows.map((t) => t.id)).toEqual(["3"]);
  });
});

describe("the columns a site has data for", () => {
  test("a site without sprints, estimates or points draws neither of them", () => {
    const c = tableColumns([card("1", "QA"), card("2", "Done")], JIRA_BOARD.caps.fieldEdits);
    expect(c).toEqual({ who: false, sprint: false, est: false, pts: false, cmts: false });
  });

  test("a sprint on one card draws SPRINT, and a point value (zero is one) draws PTS", () => {
    const c = tableColumns([card("1", "QA", { sprint: "Sprint 4" }), card("2", "QA", { points: 0 })], JIRA_BOARD.caps.fieldEdits);
    expect(c.sprint).toBe(true);
    expect(c.pts).toBe(true);
  });

  test("where points can be set the column is always there; where they cannot, only with a value", () => {
    expect(tableColumns([card("1", "QA")], true).pts).toBe(true);
    expect(tableColumns([card("1", "QA")], false).pts).toBe(false);
    expect(CLICKUP_BOARD.caps.fieldEdits).toBe(true);
    expect(JIRA_BOARD.caps.fieldEdits).toBe(false);
  });
});

describe("what the board says, in Jira's words", () => {
  test("a comment column with no count on any card is not drawn; where the tracker always counts, it is", () => {
    expect(tableColumns([card("1", "QA")], false).cmts).toBe(false);
    expect(tableColumns([card("1", "QA", { comments: 0 })], false).cmts).toBe(true);
    expect(tableColumns([card("1", "QA")], true).cmts).toBe(true);
  });

  test("a rate limit is a wait, never an alarm, with rows or without", () => {
    const base = { error: "Jira is limiting requests, try again in 30s", rows: 0, pollMs: 60_000, now: 1e12 };
    expect(readState({ ...base })).toBe("stale");
    expect(readState({ ...base, throttled: true })).toBe("retrying");
    expect(readState({ ...base, rows: 3, at: 1, throttled: true })).toBe("retrying");
    const r = boardOf({ ok: false, throttled: true, error: "Jira is limiting requests, try again in 30s", tasks: [], columns: [], at: 0 });
    expect(r.throttled).toBe(true);
    expect(boardOf({ ok: false, error: "x", tasks: [], columns: [], at: 0 }).throttled).toBeUndefined();
    expect(body).toContain("throttled: data?.throttled");
  });

  test("the cut-short tooltip names the tracker whose board it is", () => {
    expect(body).toContain("Open the board in ${source.nouns.tracker} to see the rest.");
    expect(body).not.toContain("Open the board in ClickUp");
  });

  test("a short Jira key is a card to fetch on Enter; ClickUp's rule is as it was", () => {
    expect(looksLikeCardId("ORBIT-12", false)).toBe(true);
    expect(looksLikeCardId(" orbit_x-7 ", false)).toBe(true);
    expect(looksLikeCardId("ORBIT-12", true)).toBe(false);
    expect(looksLikeCardId("ORBIT-1042", true)).toBe(true);
    expect(looksLikeCardId("1042", true)).toBe(true);
    expect(looksLikeCardId("rematch", false)).toBe(false);
    expect(looksLikeCardId("ORBIT-", false)).toBe(false);
    expect(body).toContain("looksLikeCardId(q, source.caps.workspaceSearch, source.shortKeys)");
  });

  test("Jira searches the site AND fetches a short key, ClickUp still only a long id", () => {
    expect(JIRA_BOARD.shortKeys).toBe(true);
    expect(CLICKUP_BOARD.shortKeys).toBeUndefined();
    expect(looksLikeCardId("ORBIT-12", true, JIRA_BOARD.shortKeys)).toBe(true);
    expect(looksLikeCardId("orbit_x-7", true, true)).toBe(true);
    expect(looksLikeCardId("ORBIT-", true, true)).toBe(false);
    expect(looksLikeCardId("rematch", true, true)).toBe(false);
    expect(looksLikeCardId("ORBIT-12", true, CLICKUP_BOARD.shortKeys)).toBe(false);
  });

  test("the same status spelled two ways is one group, wearing the spelling the view lists", () => {
    const g = groupByStatus([card("1", "In review"), card("2", "In Review"), card("3", "Done", { statusKind: "done" })], SEVEN.map((s) => (s.status === "In Review" ? { ...s, color: "#ffab00" } : s)));
    expect(g.map((x) => x.status)).toEqual(["Backlog", "Selected", "In Progress", "In Review", "QA", "Done", "Released"]);
    const review = g.find((x) => x.status === "In Review")!;
    expect(review.rows.map((t) => t.id)).toEqual(["1", "2"]);
    expect(review.color).toBe("#ffab00");
    expect(review.i).toBe(3);
  });
});

describe("the ready chip", () => {
  const open = card("1", "QA");
  const blocked = card("2", "In Progress", { waitsOn: ["1"] });
  const freed = card("3", "In Progress", { waitsOn: ["9"] });
  const finished = card("9", "Done", { statusKind: "done" });

  test("a card waiting on an open card is counted out", () => {
    expect(readyCount([open, blocked])).toBe(1);
    expect(blockersOf(blocked, new Map([[open.id, open]])).map((t) => t.id)).toEqual(["1"]);
  });

  test("a dependency that is done, or not on the board, does not block", () => {
    expect(readyCount([open, freed, finished])).toBe(2);
    expect(blockersOf(freed, new Map([[finished.id, finished]]))).toEqual([]);
    expect(blockersOf(blocked, new Map())).toEqual([]);
  });
});

describe("a card the pane read or wrote", () => {
  test("is laid over the board's row: opening a card keeps its sprint, points, blockers and rank", () => {
    const row = card("1", "In Progress", { sprint: "Sprint 4", points: 5, waitsOn: ["2"], order: "000003" });
    const fresh = card("1", "QA", { people: [], comments: 2 });
    const out = foldCard(row, fresh);
    expect(out).toMatchObject({ status: "QA", sprint: "Sprint 4", points: 5, waitsOn: ["2"], order: "000003", comments: 2 });
    expect(foldCard(undefined, fresh)).toBe(fresh);
  });

  test("and the board folds it that way, not by replacing the row", () => {
    expect(body).toContain("[task.id]: foldCard(byId.get(task.id), task)");
  });
});

describe("a read, as the board draws it", () => {
  const read = (o: Partial<JiraViewRead> = {}): JiraViewRead => ({ ok: true, tasks: [card("1", "QA")], columns: [], at: 1_700_000_000_000, ...o });

  test("the view's statuses go through whole, empty ones included, in the server's order", () => {
    const r = boardOf(read({ statuses: SEVEN }));
    expect(r.statuses.map((s) => s.status)).toEqual(SEVEN.map((s) => s.status));
    expect(r.fields).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  test("a read kept before the server sent statuses still groups: the statuses its cards wear, open first", () => {
    const r = boardOf(read({ tasks: [card("1", "Shipped", { statusKind: "done" }), card("2", "Doing"), card("3", "Doing")] }));
    expect(r.statuses.map((s) => [s.status, s.type])).toEqual([["Doing", "open"], ["Shipped", "done"]]);
    expect(statusesOfCards([])).toEqual([]);
  });

  test("a failed read keeps the rows and says why; a good one says nothing", () => {
    const bad = boardOf(read({ ok: false, error: "Jira is limiting requests" }));
    expect(bad.error).toBe("Jira is limiting requests");
    expect(bad.tasks).toHaveLength(1);
    expect(boardOf(read({ ok: false })).error).toBe("Jira did not answer");
  });

  test("the breadcrumb is the project and the board; the built-in view and a filter outside any project say less", () => {
    const view = (o: object) => ({ id: "board:1", name: "ORBIT board", url: "", addedAt: 0, ...o });
    expect(boardOf(read({ view: view({ folderName: "Orbit" }) })).place).toEqual({ folder: "Orbit", list: "ORBIT board" });
    expect(boardOf(read({ view: view({ id: "filter:7", name: "Open bugs" }) })).place).toEqual({ list: "Open bugs" });
    expect(boardOf(read({ view: view({ id: "me:assigned", name: "Assigned to me", builtin: true }) })).place).toBeUndefined();
    expect(boardOf(read()).place).toBeUndefined();
  });

  test("the cut-short note and the view's own address travel", () => {
    const r = boardOf(read({ truncated: true, view: { id: "board:1", name: "ORBIT board", url: "https://acme.example/b/1", addedAt: 0 } }));
    expect(r.truncated).toBe(true);
    expect(JIRA_BOARD.openAddress(r)).toBe("https://acme.example/b/1");
    expect(JIRA_BOARD.openAddress(null)).toBeUndefined();
  });
});

describe("JIRA_BOARD asks Jira", () => {
  beforeEach(() => { asked = []; __forgetJiraReads(); answer = () => ({ ok: true, tasks: [], columns: [], at: 0 }); });

  test("a board is read by its id, and only Refresh skips the server's minute", async () => {
    await JIRA_BOARD.read("board:12");
    await JIRA_BOARD.read("board:12", true);
    // Nothing kept on disk: the first read goes live after one local look, and Refresh is the only forced one.
    expect(asked.map((a) => a.path)).toEqual(["/jira/view?id=board%3A12&cached=1", "/jira/view?id=board%3A12", "/jira/view?id=board%3A12&force=1"]);
  });

  test("no id asks for the one that was last open; the built-in view goes by its own id", async () => {
    await JIRA_BOARD.read();
    await JIRA_BOARD.read("me:assigned");
    expect(asked.map((a) => a.path)).toEqual(["/jira/view?id=", "/jira/view?id=me%3Aassigned&cached=1", "/jira/view?id=me%3Aassigned"]);
  });

  test("the first read of a view paints what was kept on disk and goes to Jira behind it; the follow-up gets the live answer", async () => {
    const card = (id: string, status: string) => ({ id, customId: `ORBIT-${id}`, title: id, status, statusKind: "open", assignees: [], tags: [] });
    answer = (path) => path.includes("cached=1")
      ? { ok: true, cached: true, tasks: [card("1", "Old")], columns: [], at: 1000 }
      : { ok: true, tasks: [card("1", "New")], columns: [], at: 2000 };
    const first = await JIRA_BOARD.read("board:12");
    expect(first).toMatchObject({ revalidating: true, at: 1000 });
    expect(first.tasks[0]!.status).toBe("Old");
    const second = await JIRA_BOARD.read("board:12", false); // what the body's follow-up asks
    expect(second.tasks[0]!.status).toBe("New");
    expect(second.revalidating).toBeUndefined();
    // One live request for both, and a later poll goes straight to it, never to the disk copy.
    await JIRA_BOARD.read("board:12");
    expect(asked.map((a) => a.path)).toEqual(["/jira/view?id=board%3A12&cached=1", "/jira/view?id=board%3A12", "/jira/view?id=board%3A12"]);
  });

  test("a failed live read still answers the follow-up, with the rows it had", async () => {
    answer = (path) => path.includes("cached=1")
      ? { ok: true, cached: true, tasks: [{ id: "1", status: "Old", statusKind: "open", assignees: [], tags: [] }], columns: [], at: 1000 }
      : { ok: false, error: "Jira did not answer in time", tasks: [{ id: "1", status: "Old", statusKind: "open", assignees: [], tags: [] }], columns: [], at: 1000, cached: true };
    await JIRA_BOARD.read("board:12");
    const second = await JIRA_BOARD.read("board:12", false);
    expect(second.error).toBe("Jira did not answer in time");
    expect(second.tasks).toHaveLength(1);
    expect(second.revalidating).toBeUndefined();
  });

  test("the rail: a project is its own heading (no space above it) and the write switch is Jira's", async () => {
    answer = (path) => path === "/jira/views"
      ? {
        connected: true, site: "acme.example", current: "board:12",
        views: [{ id: "me:assigned", name: "Assigned to me", url: "", addedAt: 0, builtin: true },
          { id: "board:12", name: "ORBIT board", url: "", addedAt: 1, folderId: "ORBIT", folderName: "Orbit", spaceName: "Orbit" }],
        folders: [{ id: "ORBIT", name: "Orbit", spaceId: "ORBIT", spaceName: "Orbit", addedAt: 1 }],
      }
      : { connected: true, writes: true };
    const v = await JIRA_BOARD.views();
    expect(v.views.map((x) => x.spaceName)).toEqual([undefined, undefined]);
    expect(v.folders![0]!.spaceName).toBe("");
    expect(v.current).toBe("board:12");
    expect(v.writeEnabled).toBe(true);
    expect(v.connected).toBe(true);
  });

  test("taking a board or a project off the bar is Jira's own route", async () => {
    await JIRA_BOARD.removeView("board:12");
    await JIRA_BOARD.removeFolder("ORBIT");
    expect(asked.map((a) => `${a.method} ${a.path}`)).toEqual(["POST /jira/views/remove", "POST /jira/folders/remove"]);
  });

  test("a project's board is refused by the server, and the board says so instead of claiming it came off the bar", async () => {
    answer = () => ({ ok: false, error: "That board comes with its project; remove the project instead" });
    expect(await JIRA_BOARD.removeView("board:1")).toEqual({ ok: false, error: "That board comes with its project; remove the project instead" });
    const drop = body.slice(body.indexOf("const dropBoard = async"), body.indexOf("const [wrote, setWrote]"));
    expect(drop).toContain("(gone as { ok?: boolean }).ok === false");
    // The refusal returns before the success note is set.
    expect(drop.indexOf("return;")).toBeGreaterThan(0);
    expect(drop.indexOf("return;")).toBeLessThan(drop.indexOf("is off this bar"));
  });

  test("the words and the keys are Jira's", () => {
    expect(JIRA_BOARD.nouns.openIn).toBe("Open in Jira");
    expect(JIRA_BOARD.nouns.folder).toBe("project");
    expect(JIRA_BOARD.nouns.list).toBe("board");
    expect(JIRA_BOARD.storageKey("listRail")).toBe("agentglass.jira.listRail");
  });
});

describe("a control Jira cannot honour is not drawn", () => {
  test("every capability Jira lacks is off", () => {
    // The site search is the one thing Jira can do of these; it is answered whole, not streamed.
    expect(Object.entries(JIRA_BOARD.caps).filter(([, on]) => on)).toEqual([["workspaceSearch", true]]);
    expect(Object.values(CLICKUP_BOARD.caps).every(Boolean)).toBe(true);
  });

  test("the workspace search box and its button hang on the capability, and a source without one falls back to a jump", () => {
    expect(body).toContain("{source.caps.workspaceSearch && !onLooked && q.trim().length >= 2 && !looksLikeId && (");
    expect(body).toContain("if (!source.caps.workspaceSearch) { if (looksLikeId) void reveal(); return; }");
    expect(body).toContain('`Filter this board · Enter searches ${source.nouns.tracker}`');
    expect(body).toContain("title={source.nouns.searchTip}");
  });

  test("a new address for a saved board is offered only where a source can do it", () => {
    const at = body.indexOf("{source.caps.editAddress && (");
    expect(at).toBeGreaterThan(0);
    expect(body.slice(at, at + 300)).toContain("Change address…");
  });

  test("a list's own members and views, and the slow built-in list's notes, hang on theirs", () => {
    expect(body).toContain("const listForFace = source.caps.listMeta ?");
    expect(body).toContain("const otherList = source.caps.listMeta &&");
    expect(body).toContain("!source.caps.listViews");
    expect(body).toContain("{source.caps.slowAssigned && data?.view?.builtin && !data?.error");
    expect(body.match(/source\.caps\.slowAssigned && boards\.views\.find/g)).toHaveLength(2);
  });

  test("ClickUp's warm-up and id lookup never run for another source", () => {
    expect(body).toContain('const clickupHere = source.id === "clickup" && boards?.connected === true;');
    // The sweep's id lookup is ClickUp's own; another source asks its own `find`.
    const search = body.slice(body.indexOf("const searchAll = useCallback("));
    expect(search).toContain('source.id === "clickup" && /^\\s*([A-Za-z][\\w]*-)?\\d{3,}\\s*$/.test(asked)');
    expect(search).toContain('source.id !== "clickup" && looksLikeCardId(asked, true, source.shortKeys)');
    expect(search).toContain("source.find(asked).then(landCard)");
    // A source that cannot stream is asked once, not streamed and then asked again.
    expect(search).toContain("!source.caps.stream ? { ok: false } : await source.searchStream(");
    expect(body).toContain("if (!source.caps.workspaceSearch) { if (looksLikeId) void reveal(); return; }");
  });

  test("what the board remembers (rail width and folds, card width and mode) is kept under the source's own keys", () => {
    expect(body).toContain("} = boardKeys(source);");
    const keys = SRC.slice(SRC.indexOf("const boardKeys = "), SRC.indexOf("const boardKeys = ") + 700);
    expect(keys).toContain('source.id === "clickup"');
    for (const name of ["listRail", "listRail.shut", "listRail.width", "cardMode", "cardWidth", "wideCard"]) expect(keys).toContain(`source.storageKey("${name}")`);
    // Neither tracker's keys are written by a line that names the other's.
    expect(body).not.toContain("agentglass.clickup.");
  });

  test("the card pane is the source's when it has one, and the add bar likewise", () => {
    expect(body).toContain("picked && source.CardPane");
    expect(body).toContain("{adding && (source.AddView");
    expect(body).toContain("if (!source.AddView && !boards.views.some((v) => !v.builtin)");
  });
});

describe("a Jira card's pull requests", () => {
  const pr = { number: 2196, title: "Fix timeout", state: "OPEN", url: "https://github.com/acme/orbit/pull/2196", link: "own" as const };

  test("forty cards of a project are one request; a card with none is an answer, not a reason to ask again", async () => {
    asked = [];
    answer = (path) => (path.startsWith("/jira/prs?project=") ? { ok: true, byCard: { "ORBIT-991": [pr] } } : { ok: true, prs: [] });
    const store = await import("../src/lib/cardPrStore.ts");
    store.forgetCardPrs();
    const cards = [...Array.from({ length: 40 }, (_, i) => `ORBIT-${i + 1}`), "ORBIT-99", "ORBIT-991"];
    for (const c of cards) expect(store.cardPrsOf(c, c, "", "/work/orbit", "jira")).toBeNull(); // nothing known yet
    await new Promise((r) => setTimeout(r, 30));
    expect(asked.map((a) => a.path)).toEqual(["/jira/prs?project=ORBIT&root=%2Fwork%2Forbit"]);
    // A pull request that names ORBIT-991 gives nothing to ORBIT-99.
    expect(store.cardPrsOf("ORBIT-991", "ORBIT-991", "", "/work/orbit", "jira")!.prs.map((p) => p.number)).toEqual([2196]);
    expect(store.cardPrsOf("ORBIT-99", "ORBIT-99", "", "/work/orbit", "jira")).toMatchObject({ prs: [], error: false });
    for (const c of cards) store.cardPrsOf(c, c, "", "/work/orbit", "jira");
    expect(asked).toHaveLength(1);
    // Another project is another search; a card with no usable key asks nobody.
    store.cardPrsOf("ACME-5", "ACME-5", "", "/work/orbit", "jira");
    expect(store.cardPrsOf("20099", "", "", "/work/orbit", "jira")).toBeNull();
    expect(store.cardPrsOf("20099", "not a key", "", "/work/orbit", "jira")).toBeNull();
    await new Promise((r) => setTimeout(r, 30));
    expect(asked.map((a) => a.path.split("&")[0])).toEqual(["/jira/prs?project=ORBIT", "/jira/prs?project=ACME"]);
    store.forgetCardPrs();
  });

  test("a failed search is kept as an error entry and is not repeated for the rest of the board", async () => {
    asked = [];
    answer = () => ({ ok: false, byCard: {}, error: "could not search GitHub" });
    const store = await import("../src/lib/cardPrStore.ts");
    store.forgetCardPrs();
    store.cardPrsOf("ORBIT-1", "ORBIT-1", "", "/w", "jira");
    await new Promise((r) => setTimeout(r, 30));
    expect(store.cardPrsOf("ORBIT-2", "ORBIT-2", "", "/w", "jira")).toMatchObject({ prs: [], error: true });
    expect(asked).toHaveLength(1);
    store.forgetCardPrs();
  });

  test("a Jira id never meets a ClickUp entry: the same id asks ClickUp on its own", async () => {
    asked = [];
    answer = (path) => (path.startsWith("/jira/prs") ? { ok: true, byCard: {} } : { ok: true, prs: [] });
    const store = await import("../src/lib/cardPrStore.ts");
    store.forgetCardPrs();
    store.cardPrsOf("20042", "ORBIT-1042", "", "/w", "jira");
    store.cardPrsOf("20042", "ORBIT-1042", "", "/w");
    await new Promise((r) => setTimeout(r, 30));
    expect(asked.some((a) => a.path.startsWith("/clickup/prs"))).toBe(true);
    expect(asked.some((a) => a.path.startsWith("/jira/prs?project="))).toBe(true);
    store.forgetCardPrs();
  });
});

describe("Enter searches the site", () => {
  beforeEach(() => { asked = []; signals = []; answer = () => ({ ok: true, tasks: [card("12", "Backlog")] }); });

  test("one request per search, with the query encoded and the reader's abort attached", async () => {
    const ac = new AbortController();
    const r = await JIRA_BOARD.search("sync ORBIT-12 & more", false, ac.signal);
    expect(r.ok).toBe(true);
    expect(asked.map((a) => a.path)).toEqual(["/jira/search?q=sync%20ORBIT-12%20%26%20more"]);
    expect(signals[0]).toBe(ac.signal);
  });

  test("the streamed form is the same single request, delivered as one batch", async () => {
    const got: ProviderTask[][] = [];
    const r = await JIRA_BOARD.searchStream("ORBIT-12", false, (b) => { got.push(b); });
    expect(r.ok).toBe(true);
    expect(got.map((b) => b.map((t) => t.id))).toEqual([["12"]]);
    expect(asked.length).toBe(1);
  });

  test("a short key is fetched through the site's own find, never ClickUp's", async () => {
    answer = () => ({ ok: true, task: card("12", "Backlog") });
    const r = await JIRA_BOARD.find("ORBIT-12");
    expect(r.ok).toBe(true);
    expect(asked.map((a) => a.path)).toEqual(["/jira/find?q=ORBIT-12"]);
  });
});
