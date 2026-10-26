/*
 * The local count of what gets opened: which ids a change of state produces, how
 * a batch is sent, and that a failed send keeps the counts for the next one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();
const sent: { url: string; body: string; keepalive?: boolean }[] = [];
let status = 200;
let mod: typeof import("../src/lib/usageOpens.ts");

beforeAll(async () => {
  stubGlobal("location", new URL("http://localhost:5173/"));
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
  stubGlobal("window", new EventTarget());
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    sent.push({ url, body: String(init?.body), keepalive: init?.keepalive });
    if (status === 0) throw new TypeError("Load failed");
    return new Response("{}", { status });
  });
  mod = await import("../src/lib/usageOpens.ts");
});
beforeEach(() => { sent.length = 0; status = 200; mod.__resetUsageOpens(); });
afterAll(() => mod.__resetUsageOpens());

describe("which ids a change produces", () => {
  test("the first snapshot counts: the window opens on a view", () => {
    expect(mod.opensBetween(null, { view: "git", palette: false, machine: null })).toEqual(["view:git"]);
  });
  test("a view that changed counts once, one that did not does not", () => {
    expect(mod.opensBetween({ view: "git", palette: false }, { view: "term", palette: false })).toEqual(["view:term"]);
    expect(mod.opensBetween({ view: "git" }, { view: "git" })).toEqual([]);
  });
  test("a modal counts when it goes from shut to open, and not while it stays open or when it closes", () => {
    expect(mod.opensBetween({ palette: false }, { palette: true })).toEqual(["panel:palette"]);
    expect(mod.opensBetween({ palette: true }, { palette: true })).toEqual([]);
    expect(mod.opensBetween({ palette: true }, { palette: false })).toEqual([]);
  });
  test("a machine tab counts when it opens or changes", () => {
    expect(mod.opensBetween({ machine: null }, { machine: "ports" })).toEqual(["machine:ports"]);
    expect(mod.opensBetween({ machine: "ports" }, { machine: "resources" })).toEqual(["machine:resources"]);
    expect(mod.opensBetween({ machine: "ports" }, { machine: null })).toEqual([]);
  });
});

describe("the batch", () => {
  test("opens are added up and go in one request, with keepalive so an unload can send it", async () => {
    mod.noteOpen("view:git"); mod.noteOpen("view:git"); mod.noteOpen("settings:about");
    expect(sent).toEqual([]);
    await mod.flushOpens();
    expect(sent.length).toBe(1);
    expect(sent[0]!.url).toMatch(/\/usage\/opens$/);
    expect(sent[0]!.keepalive).toBe(true);
    expect(JSON.parse(sent[0]!.body)).toEqual({ opens: { "view:git": 2, "settings:about": 1 } });
  });

  test("nothing counted sends nothing", async () => {
    await mod.flushOpens();
    expect(sent).toEqual([]);
  });

  test("a send is not repeated: the table is empty after it", async () => {
    mod.noteOpen("view:git");
    await mod.flushOpens();
    await mod.flushOpens();
    expect(sent.length).toBe(1);
  });

  test("a send that fails keeps its counts for the next batch, added to what came after", async () => {
    status = 0;
    mod.noteOpen("view:git");
    await mod.flushOpens();
    status = 200;
    mod.noteOpen("view:git"); mod.noteOpen("panel:stats");
    await mod.flushOpens();
    expect(JSON.parse(sent[1]!.body)).toEqual({ opens: { "view:git": 2, "panel:stats": 1 } });
  });

  test("a server error keeps them too; a refusal does not retry what the server said no to", async () => {
    status = 503;
    mod.noteOpen("view:git");
    await mod.flushOpens();
    status = 400;
    await mod.flushOpens();
    expect(sent.length).toBe(2);
    status = 200;
    await mod.flushOpens();
    expect(sent.length).toBe(2);
  });
});
