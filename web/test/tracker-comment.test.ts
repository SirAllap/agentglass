/*
 * Commenting on a card through the tracker seam, and the Jira card pane that
 * uses it.
 *
 * What a mistake costs: ClickUp's box sending a different body than it always
 * has; a Jira comment naming somebody by the wrong id, or by nobody, so the
 * person is never told; a second read after a write that already carried the
 * thread; and a pane whose composer scrolls away with the thread it answers.
 * Requests are counted at `fetch`, with the body as it went out.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import type { ProviderTask } from "../../shared/providers.ts";
const stubGlobal = globalStubs();

let mod: typeof import("../src/lib/trackerComment.ts");
let seam: typeof import("../src/lib/trackerApi.ts");
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
  mod = await import("../src/lib/trackerComment.ts");
  seam = await import("../src/lib/trackerApi.ts");
});

beforeEach(() => { sent = []; answers = {}; });

const json = (body: unknown, status = 200) => () => Response.json(body, { status });
const card = (o: Record<string, unknown>) => ({ title: "Fix timeout", url: "", updated: 1768294800000, ...o }) as unknown as ProviderTask;
const jiraCard = card({ id: "20042", customId: "ORBIT-1042", url: "https://acme.atlassian.net/browse/ORBIT-1042" });
const cuCard = card({ id: "86abc", customId: "ORBIT-1042" });

describe("the seam", () => {
  test("ClickUp's comment is the call the card box always made, by the card's own id, and ignores a mention list", async () => {
    answers["/clickup/comment"] = json({ ok: true });
    const r = await seam.TRACKERS.clickup.comment(cuCard, "**hi** @Ada", [{ id: "acc-0001", name: "Ada" }]);
    expect(r.ok).toBe(true);
    expect(sent).toEqual([{ method: "POST", path: "/clickup/comment", body: { id: "86abc", text: "**hi** @Ada" } }]);
  });

  test("Jira's goes by the card's key, with the people named, and brings the thread back", async () => {
    const after = { ...jiraCard, updated: 1768294900000 };
    answers["/jira/comment"] = json({ ok: true, task: after, detail: { task: after, description: "", subtasks: [], checklists: [], comments: [] }, more: 0 });
    const r = await seam.TRACKERS.jira.comment(jiraCard, "@Ada Example look", [{ id: "acc-0001", name: "Ada Example" }]);
    expect(sent).toEqual([{ method: "POST", path: "/jira/comment", body: { key: "ORBIT-1042", text: "@Ada Example look", mentions: [{ id: "acc-0001", name: "Ada Example" }] } }]);
    expect(r).toMatchObject({ ok: true, task: { updated: 1768294900000 }, more: 0 });
    expect(r.detail?.task.updated).toBe(1768294900000);
  });

  test("a refusal is the server's sentence, and no network is a sentence too", async () => {
    answers["/jira/comment"] = json({ ok: false, error: "Writing to Jira is switched off" }, 400);
    expect(await seam.TRACKERS.jira.comment(jiraCard, "hi")).toMatchObject({ ok: false, error: "Writing to Jira is switched off" });
    delete answers["/jira/comment"];
    expect(await seam.TRACKERS.jira.comment(jiraCard, "hi")).toEqual({ ok: false, error: "Could not reach the server" });
  });

  test("posted but not read back is a warning that travels with the answer", async () => {
    answers["/jira/comment"] = json({ ok: true, partial: "The comment was posted, but the card could not be read back. Reload it." });
    expect((await seam.TRACKERS.jira.comment(jiraCard, "hi")).partial).toContain("posted");
  });
});

describe("who a Jira comment names", () => {
  test("everybody offered while typing keeps a row number, and the text decides who is named", () => {
    const o = new mod.OfferedPeople();
    const first = o.add([{ key: "acc-0001", name: "Ada Example" }, { key: "acc-0002", name: "Grace Sample" }]);
    expect(first.map((p) => p.id)).toEqual([1, 2]);
    // A later search that offers Ada again keeps her number, and adds Lin.
    const second = o.add([{ key: "acc-0003", name: "Lin Tester" }, { key: "acc-0001", name: "Ada Example" }]);
    expect(second.map((p) => [p.key, p.id])).toEqual([["acc-0003", 3], ["acc-0001", 1]]);
    expect(o.named("@Ada Example and @Lin Tester, not Grace")).toEqual([
      { id: "acc-0001", name: "Ada Example" }, { id: "acc-0003", name: "Lin Tester" },
    ]);
  });

  test("a name inside a longer word is not somebody named", () => {
    const o = new mod.OfferedPeople();
    o.add([{ key: "ada", name: "Ada" }]);
    expect(o.named("@Adams please")).toEqual([]);
    // Which of two overlapping names a mention is, is decided where the text
    // is turned into a document (longest first), so both may be sent.
    o.add([{ key: "adamo", name: "Ada Mo" }]);
    expect(o.named("@Ada Mo please").map((p) => p.id).sort()).toEqual(["ada", "adamo"]);
  });

  test("nobody offered is nobody named", () => {
    expect(new mod.OfferedPeople().named("@Ada Example")).toEqual([]);
  });
});

/* The pane is pinned by its shape in source, the way the ClickUp card's is
   (composer-pinned.test.ts): there is no renderer in this project. */
const pane = await Bun.file(new URL("../src/components/jira/JiraCard.tsx", import.meta.url)).text();
const tab = await Bun.file(new URL("../src/components/JiraTasks.tsx", import.meta.url)).text();
const composer = await Bun.file(new URL("../src/components/tasks/Composer.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the Jira card pane", () => {
  test("header and composer stay put; only the thread between them scrolls", () => {
    const src = code(pane);
    // The header wrapper now also holds the edit note's reserved line; it is still one fixed block above the scroller.
    const header = src.indexOf('<div className="shrink-0" style={{ background: "var(--bg)" }}>');
    const scroller = src.indexOf('<div ref={listRef} className="agx-scroll flex-1 min-h-0 overflow-y-auto');
    const foot = src.indexOf('<div className="shrink-0 px-4 pt-2 pb-3" style={{ borderTop: LINE }}>');
    const box = src.indexOf("<Composer value={say}");
    expect(header).toBeGreaterThan(0);
    expect(scroller).toBeGreaterThan(header);
    expect(foot).toBeGreaterThan(scroller);
    expect(box).toBeGreaterThan(foot);
    // Nothing above the thread scrolls with it.
    expect(src.slice(0, scroller)).not.toContain("overflow-y-auto");
    // And the tab hands the whole pane over, rather than wrapping it in a scroller.
    const host = code(tab).indexOf("<JiraCard ");
    expect(host).toBeGreaterThan(0);
    expect(code(tab).slice(host - 200, host)).not.toContain("overflow-y-auto");
  });

  test("it is the card panel's own composer, with Jira's people search behind the @ menu", () => {
    expect(pane).toContain('import { Composer, COMPOSER_MIN } from "../tasks/Composer.tsx";');
    expect(code(pane)).toContain("onPeopleQuery={askPeople}");
    expect(code(pane)).toContain("api.jiraPeople(forKey, q)");
    expect(code(composer)).toMatch(/if \(q && onPeopleQuery\) onPeopleQuery\(q\.query\);/);
  });

  test("a comment that brings the thread back is not followed by another read", () => {
    const send = code(pane).slice(code(pane).indexOf("const send = () => {"));
    // The detail is merged with the threads already held (keepThreads), which is still "use what came back".
    expect(send).toMatch(/if \(r\.detail\) \{ const sent = r\.detail; setDetail\([^\n]*\}\n\s*else void read\(\);/);
    // The mentions sent are the people the text names among those offered.
    expect(send).toContain("TRACKERS.jira.comment(detail?.task ?? t, say, offered.current.named(say), replyTo?.id)");
    // A refused comment keeps its draft.
    expect(send).toMatch(/if \(!r\.ok\) \{ setSayErr\([^)]*\); return; \}/);
  });

  test("the card a write or a fresher read returns updates the list's row", () => {
    expect(code(pane)).toContain("onTaskRef.current(r.detail.task);");
    expect(code(pane)).toContain("if (r.task) { onTaskRef.current(r.task); putCard(key, r.task); }");
    // One swap for the whole tab: the pane hands the card to the board, which draws it over its own row.
    expect(code(tab)).toContain("writes={writable} onTask={onTask}");
  });
});
