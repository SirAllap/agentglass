/*
 * Moving a card for either tracker, from the one shape a picker reads.
 *
 * What a mistake costs: ClickUp's picker sending a different body than it
 * always has, a Jira move labelled with our words instead of the site's, a
 * missing permission read as "no statuses", a move that needs a field going
 * out anyway, and a stale card moved without its stamp. Requests are counted
 * at `fetch`, with the body as it went out.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
import type { ProviderTask } from "../../shared/providers.ts";
const stubGlobal = globalStubs();

let mod: typeof import("../src/lib/trackerStatus.ts");
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
  mod = await import("../src/lib/trackerStatus.ts");
});

beforeEach(() => { sent = []; answers = {}; });

const json = (body: unknown, status = 200) => () => Response.json(body, { status });
const card = (o: Record<string, unknown>) => ({ title: "Fix timeout", url: "", updated: 1768294800000, ...o }) as unknown as ProviderTask;
const jiraCard = card({ id: "20042", customId: "ORBIT-1042", url: "https://acme.atlassian.net/browse/ORBIT-1042", status: "In Progress" });
const cuCard = card({ id: "86abc", status: "open", listId: "9001" });

describe("ClickUp", () => {
  test("the list's statuses are the options, and the write is the call the picker always made", async () => {
    answers["/clickup/list"] = json({ ok: true, statuses: [
      { status: "open", type: "open", orderindex: 0, color: "#87909e" },
      { status: "in review", type: "custom", orderindex: 1, color: "#a875ff" },
      { status: "complete", type: "closed", orderindex: 2, color: "#6bc950" },
    ] });
    const r = await mod.clickupStatusOptions(cuCard);
    expect(r.data!.map((o) => [o.key, o.label, o.toKind, o.color])).toEqual([
      ["open", "open", "open", "#87909e"], ["in review", "in review", "open", "#a875ff"], ["complete", "complete", "done", "#6bc950"],
    ]);
    expect(sent.map((s) => s.path)).toEqual(["/clickup/list?id=9001"]);

    answers["/clickup/card"] = json({ ok: true });
    sent = [];
    await mod.clickupSetStatus(cuCard, r.data![1]!);
    expect(sent).toEqual([{ method: "POST", path: "/clickup/card", body: { id: "86abc", updated: 1768294800000, status: "in review" } }]);
  });

  test("a card with no list has no options, and nothing is asked", async () => {
    expect(await mod.clickupStatusOptions(card({ id: "86abc", status: "open" }))).toEqual({ ok: true, data: [] });
    expect(sent.length).toBe(0);
  });

  test("a list that cannot be read is an error", async () => {
    answers["/clickup/list"] = json({ ok: false, error: "ClickUp did not answer" });
    expect(await mod.clickupStatusOptions(cuCard)).toEqual({ ok: false, error: "ClickUp did not answer" });
  });
});

describe("Jira", () => {
  const moves = (options: unknown[], extra: object = {}) => json({ ok: true, options, ...extra });
  const m = (id: string, label: string, extra: object = {}) => ({ id, name: `move ${id}`, label, toStatus: label, toKind: "open", ...extra });

  test("the site's moves, labelled by the status they lead to; a loop into the same status is dropped", async () => {
    answers["/jira/transitions"] = moves([m("21", "In Review", { color: "#ffab00" }), m("22", "In Progress"), m("23", "Done", { toKind: "done" })]);
    const r = await mod.jiraStatusOptions(jiraCard);
    expect(r.data).toEqual([
      { key: "21", label: "In Review", toStatus: "In Review", toKind: "open", color: "#ffab00" },
      { key: "23", label: "Done", toStatus: "Done", toKind: "done" },
    ]);
    expect(sent.map((s) => s.path)).toEqual(["/jira/transitions?key=ORBIT-1042"]);
  });

  test("a move that needs a field keeps its `needs` and is refused with nothing sent", async () => {
    answers["/jira/transitions"] = moves([m("41", "Done", { needs: ["resolution"] })]);
    const opt = (await mod.jiraStatusOptions(jiraCard)).data![0]!;
    expect(opt.needs).toEqual(["resolution"]);
    sent = [];
    const r = await mod.jiraSetStatus(jiraCard, opt);
    expect(r).toEqual({ ok: false, error: "That move needs resolution" });
    expect(sent.length).toBe(0);
  });

  test("the form's values ride with the move, and the stamp is still the one the person saw", async () => {
    answers["/jira/transitions"] = moves([m("41", "Done", { needs: ["resolution"] })]);
    answers["/jira/transition"] = () => new Response(JSON.stringify({ ok: true, task: jiraCard }), { headers: { "content-type": "application/json" } });
    const opt = (await mod.jiraStatusOptions(jiraCard)).data![0]!;
    sent = [];
    expect((await mod.jiraSetStatus(jiraCard, opt, { resolution: "10000", comment: "Shipped" })).ok).toBe(true);
    expect(sent.map((s) => s.body)).toEqual([{ key: "ORBIT-1042", transitionId: "41", updated: jiraCard.updated, fields: { resolution: "10000", comment: "Shipped" } }]);
  });

  test("an empty list is the server's sentence about the person, never 'no statuses'", async () => {
    answers["/jira/transitions"] = moves([], { cannot: "You cannot move ORBIT-1042" });
    expect(await mod.jiraStatusOptions(jiraCard)).toEqual({ ok: false, error: "You cannot move ORBIT-1042" });
  });

  test("an empty list with no sentence still says it in the same words", async () => {
    answers["/jira/transitions"] = moves([]);
    expect(await mod.jiraStatusOptions(jiraCard)).toEqual({ ok: false, error: "You cannot move ORBIT-1042" });
  });

  test("an error from the server, and a throttle, pass through", async () => {
    answers["/jira/transitions"] = json({ ok: false, error: "Jira is limiting requests, try again in 10s", throttled: true });
    expect(await mod.jiraStatusOptions(jiraCard)).toEqual({ ok: false, error: "Jira is limiting requests, try again in 10s", throttled: true });
    answers = {};
    expect(await mod.jiraStatusOptions(jiraCard)).toEqual({ ok: false, error: "Could not reach the server" });
  });

  test("the move is sent with the key, the move's id and the stamp the person saw", async () => {
    answers["/jira/transition"] = json({ ok: true, task: { customId: "ORBIT-1042", status: "In Review" } });
    const r = await mod.jiraSetStatus(jiraCard, { key: "21", label: "In Review", toStatus: "In Review", toKind: "open" });
    expect(r.task).toMatchObject({ status: "In Review" });
    expect(sent).toEqual([{ method: "POST", path: "/jira/transition", body: { key: "ORBIT-1042", transitionId: "21", updated: 1768294800000 } }]);
  });

  test("a conflict and a refusal come back as they are", async () => {
    answers["/jira/transition"] = json({ ok: false, conflict: true, error: "Somebody changed this card while you had it open, reloaded" }, 409);
    const opt = { key: "21", label: "In Review", toStatus: "In Review", toKind: "open" as const };
    expect(await mod.jiraSetStatus(jiraCard, opt)).toMatchObject({ ok: false, conflict: true });
    answers["/jira/transition"] = json({ ok: false, error: "Writing to Jira is switched off" }, 400);
    expect(await mod.jiraSetStatus(jiraCard, opt)).toEqual({ ok: false, error: "Writing to Jira is switched off" });
  });
});

describe("the seam", () => {
  test("each tracker answers with its own two operations, and nothing else decides", async () => {
    const seam = await import("../src/lib/trackerApi.ts");
    expect(seam.TRACKERS.clickup.statusOptions).toBe(mod.clickupStatusOptions);
    expect(seam.TRACKERS.clickup.setStatus).toBe(mod.clickupSetStatus);
    expect(seam.TRACKERS.jira.statusOptions).toBe(mod.jiraStatusOptions);
    expect(seam.TRACKERS.jira.setStatus).toBe(mod.jiraSetStatus);
  });

  test("a move through the seam is the same wire as above", async () => {
    const seam = await import("../src/lib/trackerApi.ts");
    answers["/jira/transition"] = json({ ok: true });
    await seam.TRACKERS.jira.setStatus(jiraCard, { key: "21", label: "In Review", toStatus: "In Review", toKind: "open" });
    answers["/clickup/card"] = json({ ok: true });
    await seam.TRACKERS.clickup.setStatus(cuCard, { key: "in review", label: "in review", toStatus: "in review", toKind: "open" });
    expect(sent.map((s) => [s.path, s.body])).toEqual([
      ["/jira/transition", { key: "ORBIT-1042", transitionId: "21", updated: 1768294800000 }],
      ["/clickup/card", { id: "86abc", updated: 1768294800000, status: "in review" }],
    ]);
  });
});
