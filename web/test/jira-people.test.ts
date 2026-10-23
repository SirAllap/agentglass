/*
 * Who is on a Jira card, and the hand-off, from the card screens' side.
 *
 * What a mistake costs: the hand-off sequenced in the client (two requests,
 * one stamp: the trap the server route exists to avoid), a partial landing
 * shown as plain success, a person matched by name instead of id, a short list
 * of people presented as everybody, ClickUp's tracker growing a second people
 * path beside the one its tests pin. Requests are counted at `fetch`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal";
import type { JiraHandoffRule, ProviderTask } from "../../shared/providers.ts";
const stubGlobal = globalStubs();

let P: typeof import("../src/lib/trackerPeople.ts");
let S: typeof import("../src/lib/jiraSettings.ts");
let T: typeof import("../src/lib/trackerApi.ts");
let M: typeof import("../src/lib/jiraMine.ts");
let sent: { method: string; path: string; body: unknown }[] = [];
let answers: Record<string, (body: unknown) => Response> = {};

beforeAll(async () => {
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push({ method: init?.method ?? "GET", path: u.pathname + u.search, body });
    const a = answers[u.pathname];
    if (!a) throw new TypeError("no network");
    return a(body);
  });
  P = await import("../src/lib/trackerPeople.ts");
  S = await import("../src/lib/jiraSettings.ts");
  T = await import("../src/lib/trackerApi.ts");
  M = await import("../src/lib/jiraMine.ts");
});

beforeEach(() => { sent = []; answers = {}; S.__forgetJiraSettings(); });

const json = (body: unknown, status = 200) => () => Response.json(body, { status });
const card = (o: Record<string, unknown> = {}) => ({
  id: "20042", customId: "ORBIT-1042", title: "Fix timeout", url: "", status: "In Progress", updated: 1768294800000, listId: "ORBIT",
  people: [{ key: "acc-0001", name: "Ada Example", initials: "AE" }], assignees: ["Ada Example"], ...o,
}) as unknown as ProviderTask;
const rule = (o: Partial<JiraHandoffRule> = {}): JiraHandoffRule => ({ to: { id: "4", name: "QA" }, askTo: false, clear: true, askClear: false, ...o });

describe("the seam", () => {
  test("Jira has people and the hand-off; ClickUp keeps its own pickers and has neither here", () => {
    expect(typeof T.TRACKERS.jira.people).toBe("function");
    expect(typeof T.TRACKERS.jira.setPeople).toBe("function");
    expect(typeof T.TRACKERS.jira.handOff).toBe("function");
    expect(T.TRACKERS.jira.caps.multiAssignee).toBe(false);
    expect(T.TRACKERS.clickup.people).toBeUndefined();
    expect(T.TRACKERS.clickup.setPeople).toBeUndefined();
    expect(T.TRACKERS.clickup.handOff).toBeUndefined();
  });
});

describe("people", () => {
  test("asked by the card's key and what was typed, trimmed; a move rides along when given", async () => {
    answers["/jira/assignable"] = json({ ok: true, people: [{ key: "acc-0002", id: "acc-0002", name: "Grace Sample" }] });
    const r = await P.jiraPeople(card(), "  gr ");
    expect(r).toEqual({ ok: true, data: [{ key: "acc-0002", id: "acc-0002", name: "Grace Sample" }] });
    await P.jiraPeople(card(), "gr", "21");
    expect(sent.map((s) => s.path)).toEqual(["/jira/assignable?key=ORBIT-1042&q=gr", "/jira/assignable?key=ORBIT-1042&q=gr&transition=21"]);
  });

  test("a failure is an error with the server's sentence, never nobody", async () => {
    answers["/jira/assignable"] = json({ ok: false, error: "Could not reach Jira", throttled: true });
    expect(await P.jiraPeople(card(), "x")).toEqual({ ok: false, error: "Could not reach Jira", throttled: true });
    answers = {};
    expect(await P.jiraPeople(card(), "x")).toEqual({ ok: false, error: "Could not reach the server" });
  });

  test("one write, with the stamp the person saw; nobody is null", async () => {
    answers["/jira/assignee"] = json({ ok: true });
    await P.jiraSetPeople(card(), { set: "acc-0002" });
    await P.jiraSetPeople(card(), { set: null });
    expect(sent).toEqual([
      { method: "POST", path: "/jira/assignee", body: { key: "ORBIT-1042", to: "acc-0002", updated: 1768294800000 } },
      { method: "POST", path: "/jira/assignee", body: { key: "ORBIT-1042", to: null, updated: 1768294800000 } },
    ]);
  });

  test("who is on the card is matched by the card's id for them, never by name", () => {
    expect(P.isOnCard(card(), { key: "ada", id: "acc-0001", name: "Someone else" })).toBe(true);
    expect(P.isOnCard(card(), { key: "acc-0009", id: "acc-0009", name: "Ada Example" })).toBe(false);
    expect(P.isOnCard(card({ people: [] }), { key: "acc-0001", id: "acc-0001", name: "Ada Example" })).toBe(false);
  });
});

describe("the hand-off", () => {
  test("ONE request, whatever it does: the server orders the move and the unassign", async () => {
    answers["/jira/handoff"] = json({ ok: true, task: card({ status: "QA", people: [] }) });
    await P.jiraHandOff(card(), { to: "4", clear: true });
    expect(sent).toEqual([{ method: "POST", path: "/jira/handoff", body: { key: "ORBIT-1042", updated: 1768294800000, to: "4", clear: true } }]);
    sent = [];
    await P.jiraHandOff(card());
    expect(sent).toEqual([{ method: "POST", path: "/jira/handoff", body: { key: "ORBIT-1042", updated: 1768294800000 } }]);
  });

  test("the button: a fixed status is its label; asking is a dialog; nothing set is no button", () => {
    expect(P.handoffOffer(undefined)).toBeNull();
    expect(P.handoffOffer(rule({ to: null }))).toBeNull();
    expect(P.handoffOffer(rule())).toEqual({ label: "Move to QA", asks: false });
    expect(P.handoffOffer(rule({ askClear: true }))).toEqual({ label: "Move to QA", asks: true });
    expect(P.handoffOffer(rule({ askTo: true }))).toEqual({ label: "Hand off…", asks: true });
    expect(P.handoffOffer(rule({ to: null, askTo: true }))).toEqual({ label: "Hand off…", asks: true });
  });

  test("a partial landing is said as a warning, never as plain success", () => {
    expect(P.handoffSaid({ ok: true, partial: "Moved to QA, but Ada Example is still assigned: Could not reach Jira", task: card({ status: "QA" }) }))
      .toBe("!Moved to QA, but Ada Example is still assigned: Could not reach Jira");
    expect(P.handoffSaid({ ok: true, task: card({ status: "QA", people: [] }) })).toBe("now QA · unassigned");
    expect(P.handoffSaid({ ok: false, conflict: true })).toBe("!somebody changed this card while you had it open");
    expect(P.handoffSaid({ ok: false, error: "ORBIT-1042 cannot go to QA from To Do" })).toBe("!ORBIT-1042 cannot go to QA from To Do");
  });
});

describe("the settings this window holds", () => {
  test("read once for every reader, and replaced in place by a save", async () => {
    answers["/jira/settings"] = json({ ok: true, writes: true, handoff: { ORBIT: rule() } });
    const [a, b] = await Promise.all([S.loadJiraSettings(), S.loadJiraSettings()]);
    expect(a).toEqual({ writes: true, handoff: { ORBIT: rule() } });
    expect(b).toBe(a);
    await S.loadJiraSettings();
    expect(sent.length).toBe(1);
    S.noteJiraSettings({ writes: true, handoff: {} });
    expect(await S.loadJiraSettings()).toEqual({ writes: true, handoff: {} });
    expect(sent.length).toBe(1);
  });

  test("a failed read is not kept, so the next reader asks again", async () => {
    expect(await S.loadJiraSettings()).toBeNull();
    answers["/jira/settings"] = json({ ok: true, writes: false, handoff: {} });
    expect(await S.loadJiraSettings()).toEqual({ writes: false, handoff: {} });
  });

  test("a card's project: the key the site gave it, else the part of its id before the number", () => {
    expect(S.projectOf({ id: "1", listId: "ORBIT" })).toBe("ORBIT");
    expect(S.projectOf({ id: "1", customId: "acme-7" })).toBe("ACME");
    expect(S.projectOf({ id: "20042" })).toBe("");
    expect(S.ruleFor({ writes: false, handoff: { ORBIT: rule() } }, "ORBIT")).toEqual(rule());
    expect(S.ruleFor(null, "ORBIT")).toBeUndefined();
  });
});

describe("one datum, two views", () => {
  test("a written card replaces its row; a list without it is the same array", () => {
    const rows = [card(), card({ id: "20043", customId: "ORBIT-1043" })];
    const after = card({ status: "QA", people: [] });
    const next = M.replaceTask(rows, after);
    expect(next[0]).toBe(after);
    expect(next[1]).toBe(rows[1]);
    expect(rows[0]!.status).toBe("In Progress");
    const other = [card({ id: "1" })];
    expect(M.replaceTask(other, after)).toBe(other);
  });
});

describe("the screens, as source", () => {
  const read = (p: string) => readFileSync(new URL("../src/" + p, import.meta.url), "utf8");
  const code = (p: string) => read(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  test("the Jira tab's card has the status, the person and the hand-off, and folds a write back into its lists", () => {
    const s = code("components/JiraTasks.tsx");
    // A move's new stamp reaches the card, or the next write from it is a conflict.
    expect(s).toContain("<TrackerStatusPick tracker={TRACKERS.jira} task={t} query={query} onSaid={setSaid} onTask={onTask} />");
    expect(s).toContain("<TrackerPeoplePick tracker={TRACKERS.jira}");
    expect(s).toContain("<TrackerHandOffButton tracker={TRACKERS.jira}");
    expect(s).toContain("<Facts t={picked} onTask={changed} />");
    expect(s).toContain("replaceTask(");
  });

  test("the people picker asks the site after a pause, through the house picker, never filtering a short list as everybody", () => {
    const s = code("components/TrackerPeoplePick.tsx");
    expect(s).toContain("<PeoplePick");
    expect(s).toContain("onQuery=");
    expect(s).toContain("PEOPLE_WAIT_MS");
    expect(s).toContain("Not listed? Type more of the name.");
    expect(P.PEOPLE_WAIT_MS).toBeGreaterThanOrEqual(200);
    expect(s).toContain("setRes(null); setQ(\"\"); }, [task.id]);");
    const pick = code("components/PeoplePick.tsx");
    expect(pick).toContain("q.trim() && !p.onQuery");
  });

  test("the hand-off button sends one request and puts the answer in the card store", () => {
    const s = code("components/TrackerHandOffButton.tsx");
    expect(s.match(/await run\(/g)?.length).toBe(1);
    expect(s).not.toContain("setPeople");
    expect(s).not.toContain("setStatus(");
    expect(s).toContain("putCard(query, r.task)");
  });

  test("the hand-off settings row is a component of its own, to be mounted in the Settings Tasks pane", () => {
    const s = code("components/jira/HandoffSettings.tsx");
    expect(s).toContain("export function HandoffSettings() {");
    // It writes the local settings and never Jira.
    expect(s).toContain("api.setJiraHandoff(");
    // Not before the stored rules are read: a press then would save over them.
    expect(s).toContain("const frozen = saving || !settings;");
    expect(s).not.toMatch(/api\.jira(SetAssignee|HandOff|Transition)\(/);
  });
});
