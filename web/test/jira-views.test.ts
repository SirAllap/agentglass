/*
 * Saved Jira views on the web side: which column a card sits in, how a view
 * with no columns is grouped, the rail's rows, and the addresses the api asks.
 *
 * What a mistake costs: a card under the wrong column because two statuses
 * share a name, a board that hides its empty columns, a failed add that goes
 * to the wrong route.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import { columnGroups, railEntries, statusGroups, viewKindLabel, viewNote } from "../src/lib/jiraViews.ts";
import type { ProviderTask, SavedFolder, SavedView } from "../../shared/providers.ts";

const stubGlobal = globalStubs();

let asked: { path: string; method: string; body?: string }[] = [];
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
stubGlobal("fetch", async (input: unknown, init?: { method?: string; body?: string }) => {
  const u = new URL(String(input));
  asked.push({ path: u.pathname + u.search, method: init?.method ?? "GET", body: init?.body });
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
});
const { api } = await import("../src/lib/api.ts");

const card = (id: string, statusId: string | undefined, status: string, kind: ProviderTask["statusKind"] = "open"): ProviderTask =>
  ({ id, statusId, status, statusKind: kind } as ProviderTask);

describe("columnGroups", () => {
  const cols = [
    { name: "To Do", statusIds: ["1"] },
    { name: "Doing", statusIds: ["2", "4"] },
    { name: "Done", statusIds: ["3"] },
  ];

  test("one group per column in the board's order, the empty one kept", () => {
    const g = columnGroups([card("a", "3", "Done", "done"), card("b", "1", "To Do")], cols);
    expect(g.map((x) => x.name)).toEqual(["To Do", "Doing", "Done"]);
    expect(g.map((x) => x.rows.length)).toEqual([1, 0, 1]);
  });

  test("a card goes where its status id is held: two statuses sharing a name land in their own columns", () => {
    const two = [{ name: "Review", statusIds: ["7"] }, { name: "QA", statusIds: ["8"] }];
    const g = columnGroups([card("a", "7", "Blocked"), card("b", "8", "Blocked")], two);
    expect(g[0].rows.map((t) => t.id)).toEqual(["a"]);
    expect(g[1].rows.map((t) => t.id)).toEqual(["b"]);
  });

  test("a column holding several statuses takes all of them", () => {
    const g = columnGroups([card("a", "2", "In Progress"), card("b", "4", "In Review")], cols);
    expect(g[1].rows.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("Other exists only when a card has no column, and comes last", () => {
    expect(columnGroups([card("a", "1", "To Do")], cols).some((x) => x.name === "Other")).toBe(false);
    const g = columnGroups([card("a", "1", "To Do"), card("b", "99", "Odd"), card("c", undefined, "")], cols);
    expect(g.at(-1)!.name).toBe("Other");
    expect(g.at(-1)!.rows.map((t) => t.id)).toEqual(["b", "c"]);
  });

  test("a column of finished cards is marked done, an empty one is not", () => {
    const g = columnGroups([card("a", "3", "Done", "done")], cols);
    expect(g.map((x) => x.done)).toEqual([false, false, true]);
  });
});

describe("statusGroups", () => {
  test("open first, then other, then done; first seen first inside each", () => {
    const g = statusGroups([
      card("1", "9", "Closed", "done"), card("2", "5", "Waiting", "other"),
      card("3", "6", "Review"), card("4", "1", "To Do"), card("5", "6", "Review"),
    ]);
    expect(g.map((x) => x.name)).toEqual(["Review", "To Do", "Waiting", "Closed"]);
    expect(g[0].rows.map((t) => t.id)).toEqual(["3", "5"]);
    expect(g[3].done).toBe(true);
  });

  test("no cards, no groups", () => {
    expect(statusGroups([])).toEqual([]);
  });
});

describe("railEntries", () => {
  const v = (id: string, name: string, folderId?: string): SavedView => ({ id, name, url: "", addedAt: 0, folderId });
  const f = (id: string, name: string): SavedFolder => ({ id, name, spaceId: "", spaceName: "", addedAt: 0 });
  const views = [v("board:2", "Orbit board", "ORBIT"), v("filter:9", "My filter"), v("board:3", "Orbit bugs", "ORBIT")];

  test("the built-in first, loose views next, then folders", () => {
    const r = railEntries(views, [f("ORBIT", "Orbit")]);
    expect(r.map((e) => e.name)).toEqual(["Assigned to me", "My filter", "Orbit"]);
    expect(r[0].builtin).toBe(true);
  });

  test("an open folder lists its boards one level down; a closed one does not", () => {
    const r = railEntries(views, [f("ORBIT", "Orbit")], new Set(["ORBIT"]));
    expect(r.slice(2).map((e) => [e.name, e.level])).toEqual([["Orbit", 0], ["Orbit board", 1], ["Orbit bugs", 1]]);
    expect(r[2].expanded).toBe(true);
  });

  test("a view whose folder is gone is not lost", () => {
    expect(railEntries([v("board:2", "Orphan", "GONE")], []).map((e) => e.name)).toContain("Orphan");
  });
});

test("viewKindLabel names the kind from the id", () => {
  expect(viewKindLabel("board:1")).toBe("Board");
  expect(viewKindLabel("filter:1")).toBe("Saved filter");
  expect(viewKindLabel("jql:ab")).toBe("Search");
});

describe("viewNote", () => {
  test("a failed read over kept cards is a quiet note, not an alarm", () => {
    expect(viewNote({ ok: false, error: "Jira did not answer" }, true)).toEqual({ text: "Jira did not answer. These are the cards from the last read.", bad: false });
  });
  test("a failed read with nothing to show is an alarm", () => {
    expect(viewNote({ ok: false, error: "No access" }, false)).toEqual({ text: "No access", bad: true });
  });
  test("disk cards with an error keep the sentence, quietly", () => {
    expect(viewNote({ ok: true, cached: true, error: "Rate limited" }, true)!.bad).toBe(false);
    expect(viewNote({ ok: true, cached: true }, true)!.text).toContain("last read");
  });
  test("a clean read says nothing; a cut one says so", () => {
    expect(viewNote({ ok: true }, true)).toBeNull();
    expect(viewNote({ ok: true, truncated: true }, true)!.text).toContain("most recently changed");
  });
});

describe("api: the addresses the new Jira methods ask", () => {
  beforeEach(() => { asked = []; });
  const last = () => asked.at(-1)!;

  test("reads", async () => {
    await api.jiraViews();
    expect(last().path).toBe("/jira/views");
    await api.jiraView("board:12");
    expect(last().path).toBe("/jira/view?id=board%3A12");
    await api.jiraView("board:12", { force: true, cached: true });
    expect(last().path).toBe("/jira/view?id=board%3A12&force=1&cached=1");
    await api.jiraViewChoices("or bit");
    expect(last().path).toBe("/jira/view-choices?q=or%20bit");
    await api.jiraProjectChoices();
    expect(last().path).toBe("/jira/project-choices");
  });

  test("writes are POSTs with the body the server reads", async () => {
    await api.jiraAddView({ url: "https://acme.example/jira/software/projects/ORBIT/boards/1" });
    expect(last().path).toBe("/jira/views/add");
    expect(last().method).toBe("POST");
    await api.jiraAddView({ kind: "filter", id: "10000" });
    expect(JSON.parse(last().body!)).toEqual({ kind: "filter", id: "10000" });
    await api.jiraRemoveView("board:1");
    expect([last().path, last().body]).toEqual(["/jira/views/remove", '{"id":"board:1"}']);
    await api.jiraAddFolder("ORBIT");
    expect([last().path, last().body]).toEqual(["/jira/folders/add", '{"key":"ORBIT"}']);
    await api.jiraRemoveFolder("ORBIT");
    expect([last().path, last().body]).toEqual(["/jira/folders/remove", '{"id":"ORBIT"}']);
  });
});
