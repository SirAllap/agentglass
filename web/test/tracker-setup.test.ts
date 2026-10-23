/*
 * Which trackers are connected here, as one answer.
 *
 * What a mistake costs: a card link that flashes on a machine with no tracker,
 * one that never appears because a failed read was kept for a minute, or a
 * second tracker's answer hiding the first. Requests are counted at `fetch`.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();

let mod: typeof import("../src/lib/trackerSetup.ts");
let cu: typeof import("../src/lib/clickupSetup.ts");
let calls: string[] = [];
let answers: Record<string, () => Response> = {};

beforeAll(async () => {
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
  stubGlobal("fetch", async (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const a = answers[path];
    if (!a) throw new TypeError("no network");
    return a();
  });
  mod = await import("../src/lib/trackerSetup.ts");
  cu = await import("../src/lib/clickupSetup.ts");
});

const ok = (body: unknown) => () => Response.json(body);
const jiraOn = { connected: true, site: "acme.atlassian.net", kind: "cloud", auth: "basic", api: 3, deployment: "cloud", account: "Ada Example", prefixes: ["ORBIT", "ACME"], writes: false };
const jiraOff = { connected: false, site: null, kind: null, auth: null, api: null, deployment: null, account: null, prefixes: [], writes: false };

beforeEach(() => {
  calls = [];
  answers = {};
  mod.__forgetTrackerSetup();
  cu.__forgetClickupSetup();
});

describe("trackerSetup", () => {
  test("neither connected is an empty answer", async () => {
    answers["/clickup/views"] = ok({ views: [], connected: false });
    answers["/jira/status"] = ok(jiraOff);
    expect(await mod.trackerSetup()).toEqual({});
  });

  test("Jira alone: its site and every project key it can see", async () => {
    answers["/clickup/views"] = ok({ views: [], connected: false });
    answers["/jira/status"] = ok(jiraOn);
    expect(await mod.trackerSetup()).toEqual({ jira: { connected: true, prefixes: ["ORBIT", "ACME"], site: "acme.atlassian.net" } });
  });

  test("ClickUp alone keeps the prefix it has always had", async () => {
    answers["/clickup/views"] = ok({ views: [], connected: true, prefix: "ORB-" });
    answers["/jira/status"] = ok(jiraOff);
    expect(await mod.trackerSetup()).toEqual({ clickup: { connected: true, prefix: "ORB-" } });
  });

  test("both are in the answer", async () => {
    answers["/clickup/views"] = ok({ views: [], connected: true, prefix: "ORB-" });
    answers["/jira/status"] = ok(jiraOn);
    const s = await mod.trackerSetup();
    expect(Object.keys(s).sort()).toEqual(["clickup", "jira"]);
  });

  test("asking again within a minute is no new request, for either tracker", async () => {
    answers["/clickup/views"] = ok({ views: [], connected: true });
    answers["/jira/status"] = ok(jiraOn);
    await mod.trackerSetup();
    await mod.trackerSetup();
    await Promise.all([mod.trackerSetup(), mod.trackerSetup()]);
    expect(calls.filter((c) => c === "/jira/status").length).toBe(1);
    expect(calls.filter((c) => c === "/clickup/views").length).toBe(1);
  });

  test("callers arriving together on a cold start share one read", async () => {
    answers["/clickup/views"] = ok({ views: [], connected: false });
    answers["/jira/status"] = ok(jiraOn);
    await Promise.all([mod.trackerSetup(), mod.trackerSetup(), mod.trackerSetup()]);
    expect(calls.filter((c) => c === "/jira/status").length).toBe(1);
  });

  test("a Jira read that failed is left out and is not kept: the next ask tries again", async () => {
    answers["/clickup/views"] = ok({ views: [], connected: true });
    expect(await mod.trackerSetup()).toEqual({ clickup: { connected: true, prefix: undefined } });
    answers["/jira/status"] = ok(jiraOn);
    expect((await mod.trackerSetup()).jira?.site).toBe("acme.atlassian.net");
  });

  test("Jira down does not take ClickUp's answer with it", async () => {
    answers["/clickup/views"] = ok({ views: [], connected: true, prefix: "ORB-" });
    const s = await mod.trackerSetup();
    expect(s.clickup).toEqual({ connected: true, prefix: "ORB-" });
    expect(s.jira).toBeUndefined();
  });
});
