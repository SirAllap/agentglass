/*
 * The board's second pass against the mockup: swimlanes keep one set of columns, the quick toggles narrow the cards,
 * JQL answered by the site wins only for the query it answers, the live agent and the checks come from stores the app
 * already has, the key bar lists only keys that are handled, and the accent is one token.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderTask } from "../../shared/providers.ts";
import type { AgentCard } from "../src/lib/derive.ts";
import { boardKey, laneOf, looksJql } from "../src/components/jira/list/boardModel.ts";
import { NO_FILTERS, filterCards } from "../src/components/jira/list/model.ts";
import { liveKeys, workerFor, checksForUrl, __putChecks } from "../src/lib/jiraCardWork.ts";
import { BOARD_KEYS } from "../src/components/jira/list/JiraKeyBar.tsx";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const board = await Bun.file(new URL("../src/components/jira/list/JiraBoard.tsx", import.meta.url)).text();
const view = await Bun.file(new URL("../src/components/jira/list/JiraListView.tsx", import.meta.url)).text();
const hook = await Bun.file(new URL("../src/lib/useJiraList.ts", import.meta.url)).text();
const doc = await Bun.file(new URL("../../docs/design-system.md", import.meta.url)).text();

const card = (n: string, o: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id: n, customId: `ORBIT-${n}`, title: `Card ${n}`, status: "To Do", statusKind: "open", assignees: [], tags: [], priority: null, due: null, ...o } as ProviderTask);
const agent = (o: Partial<AgentCard>): AgentCard => ({ session_id: "s1", source_app: "claude", status: "working", cost: 1.84, lastSeen: 1, title: "", cwd: null, model_name: "sonnet", ...o } as AgentCard);

describe("swimlanes", () => {
  const cards = [
    card("1042", { parent: { key: "ORBIT-250", title: "Auth hardening" } as ProviderTask["parent"], priority: "high", people: [{ name: "Mira R." }] as ProviderTask["people"] }),
    card("1050", { parent: { key: "ORBIT-300", title: "Billing sync" } as ProviderTask["parent"], priority: "urgent" }),
    card("1065"),
  ];
  test("none is one unnamed row with every card", () => {
    expect(laneOf(cards, "none")).toEqual([{ id: "all", label: "", cards }]);
  });
  test("by epic: one row per epic, the cards with none last", () => {
    expect(laneOf(cards, "epic").map((r) => [r.label, r.cards.length])).toEqual([["Auth hardening", 1], ["Billing sync", 1], ["No epic", 1]]);
  });
  test("by priority: highest first, no priority last", () => {
    expect(laneOf(cards, "priority").map((r) => r.label)).toEqual(["Highest", "High", "No priority"]);
  });
  test("by assignee: unassigned last", () => {
    expect(laneOf(cards, "assignee").map((r) => r.label)).toEqual(["Mira R.", "Unassigned"]);
  });
  test("one row of column heads for every lane, so a column keeps its x", () => {
    expect(board.match(/className="agx-jb-heads"/g)?.length).toBe(1);
    expect(board).toContain('<div className="agx-jb-row">{columns.map((col) => cell(');
  });
});

describe("quick toggles", () => {
  const cards = [card("1", { flagged: true }), card("2", { due: "2026-11-20" }), card("3", { blockedBy: ["4"] } as Partial<ProviderTask>), card("4")];
  test("flagged, has due date", () => {
    expect(filterCards(cards, { ...NO_FILTERS, flaggedOnly: true }).map((t) => t.id)).toEqual(["1"]);
    expect(filterCards(cards, { ...NO_FILTERS, dueOnly: true }).map((t) => t.id)).toEqual(["2"]);
  });
  test("live worker keeps the cards a live agent names, and nothing when none does", () => {
    expect(filterCards(cards, { ...NO_FILTERS, liveOnly: true, live: ["ORBIT-2"] }).map((t) => t.id)).toEqual(["2"]);
    expect(filterCards(cards, { ...NO_FILTERS, liveOnly: true }).map((t) => t.id)).toEqual([]);
  });
});

describe("JQL on the site", () => {
  const cards = [card("1042"), card("1043")];
  test("the site's keys win while they answer the query typed", () => {
    const f = { ...NO_FILTERS, query: "sprint in openSprints()", site: { q: "sprint in openSprints()", keys: ["ORBIT-1043"] } };
    expect(filterCards(cards, f).map((t) => t.id)).toEqual(["1043"]);
  });
  test("an answer for an older query is ignored: the local reading applies", () => {
    const f = { ...NO_FILTERS, query: "key = ORBIT-1042", site: { q: "key = ORBIT-1043", keys: ["ORBIT-1043"] } };
    expect(filterCards(cards, f).map((t) => t.id)).toEqual(["1042"]);
  });
  test("only text with an operator goes to the site, once per pause, from the list's one reader", () => {
    expect(looksJql("project = ORBIT")).toBe(true);
    expect(looksJql("assignee in (a, b)")).toBe(true);
    expect(looksJql("session tokens")).toBe(false);
    expect(hook).toContain("api.jiraJql(typed, ac.signal");
    expect(hook).toContain("setTimeout(");
    expect(hook).not.toContain("setInterval(");
    expect(view).not.toMatch(/api\.jira/);
  });
});

describe("the live agent and the checks", () => {
  test("a live agent whose title or folder names the key is the card's worker; the most recent wins", () => {
    const a = [agent({ session_id: "a", title: "ORBIT-1042 rotate tokens", lastSeen: 5, cost: 1.84 }), agent({ session_id: "b", cwd: "/w/orbit-1042-fix", lastSeen: 9, cost: 0.4 })];
    expect(workerFor("ORBIT-1042", a)?.sessionId).toBe("b");
    expect(workerFor("ORBIT-104", a)).toBeNull();
  });
  test("an idle or failed session is no worker", () => {
    expect(workerFor("ORBIT-1042", [agent({ title: "ORBIT-1042", status: "idle" })])).toBeNull();
    expect(workerFor("ORBIT-1042", [agent({ title: "ORBIT-1042", status: "failed" })])).toBeNull();
  });
  test("live keys are read off titles and folders, upper-cased", () => {
    expect(liveKeys([agent({ title: "orbit-1042 builder" }), agent({ cwd: "/w/ORBIT-1050", status: "waiting" }), agent({ title: "ORBIT-9", status: "idle" })]).sort()).toEqual(["ORBIT-1042", "ORBIT-1050"]);
  });
  test("checks are found by the pull request's address, whatever the case of the repo", () => {
    __putChecks("https://github.com/orbit/app/pull/412", { total: 3, success: 3, failure: 0, skipped: 0, pending: 0, allDone: true, verdict: "green", failing: [] } as never, 7);
    expect(checksForUrl("https://github.com/Orbit/App/pull/412")?.at).toBe(7);
    expect(checksForUrl("https://github.com/orbit/app/pull/413")).toBeNull();
  });
});

describe("keys", () => {
  test("/ focuses the search, never while typing", () => {
    expect(boardKey({ key: "/" }, false)).toBe("search");
    expect(boardKey({ key: "/" }, true)).toBeNull();
    expect(boardKey({ key: "a" }, false)).toBe("agents");
    expect(boardKey({ key: "n" }, false)).toBe("needs");
    expect(boardKey({ key: "a", ctrlKey: true }, false)).toBeNull();
  });
  test("every key in the bar is handled somewhere", () => {
    const handled: Record<string, string> = { j: board, k: board, Enter: board, b: view, d: view, "/": view, "[": view, v: view, F: view, "⇧": view, "?": view, a: view, n: view };
    for (const k of BOARD_KEYS.flatMap((x) => x.keys)) {
      if (k === "g" || k === "1-9") continue;
      expect(handled[k], k).toBeDefined();
    }
    expect(board).toContain('k === "j"');
    expect(view).toContain('k === "search"');
    expect(view).toContain('k === "agents"');
    expect(view).toContain('k === "needs"');
  });
});

describe("the accent", () => {
  test("one token, in the doc, used for the chosen things", () => {
    expect(css).toMatch(/--jira-accent: var\(--primary\);/);
    expect(doc).toContain("`--jira-accent`");
    expect(css).toMatch(/\.agx-jb-card\[aria-selected="true"\] \{ box-shadow: inset 0 0 0 2px var\(--jira-accent\)/);
    expect(css).toMatch(/\.agx-jb-more \{[^}]*background: var\(--jira-accent\)/);
  });
  test("titles in the prose face, keys in mono", () => {
    expect(css).toMatch(/\.agx-jb-title \{[^}]*font-family: var\(--font-prose\)/);
    expect(css).toMatch(/\.agx-jb-key \{[^}]*font-family: var\(--font-mono/);
  });
});
