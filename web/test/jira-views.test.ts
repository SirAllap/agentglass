/*
 * Saved Jira views on the web side: the addresses the api asks.
 *
 * What a mistake costs: a failed add that goes to the wrong route. Which group
 * a card sits in, and the rail's rows, are the board's now (jira-board.test.ts).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";

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
