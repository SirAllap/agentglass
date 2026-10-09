/*
 * When a desktop notification is worth asking the server about.
 *
 * ClickUp's daemon posts with an empty app name, and so does any other app the
 * bus does not name. Without a connected ClickUp every such title was sent to
 * the local API to be answered "no card". The gate is the server's own answer
 * to "is ClickUp here"; a failed read counts as no.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();

let sysNotify: typeof import("../src/lib/sysNotify.ts");
beforeAll(async () => {
  stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000" });
  sysNotify = await import("../src/lib/sysNotify.ts");
});

const src = await Bun.file(new URL("../src/lib/sysNotify.ts", import.meta.url)).text();

describe("shouldLookUpNote", () => {
  test("never without a connected ClickUp", () => {
    for (const app of ["", "ClickUp", "slack"]) {
      expect(sysNotify.shouldLookUpNote(app, { connected: false })).toBe(false);
      expect(sysNotify.shouldLookUpNote(app, null)).toBe(false);
      expect(sysNotify.shouldLookUpNote(app, undefined)).toBe(false);
    }
  });
  test("connected: the unnamed daemon and ClickUp itself", () => {
    expect(sysNotify.shouldLookUpNote("", { connected: true })).toBe(true);
    expect(sysNotify.shouldLookUpNote("  ", { connected: true })).toBe(true);
    expect(sysNotify.shouldLookUpNote("ClickUp", { connected: true })).toBe(true);
  });
  test("connected: another named app is still none of its business", () => {
    expect(sysNotify.shouldLookUpNote("Slack", { connected: true })).toBe(false);
  });
});

describe("attachCard", () => {
  test("asks the gate before it asks the server about a title", () => {
    const at = src.indexOf("async function attachCard(");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    const gate = body.indexOf("shouldLookUpNote(app, await clickupSetup())");
    const ask = body.indexOf("api.clickupCardForNote(");
    expect(gate).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(gate);
  });
});

describe("the Tasks panel's warm-up", () => {
  test("waits for a connected ClickUp", async () => {
    const panel = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();
    expect(panel).toContain("if (clickupHere) void api.clickupWarm();");
    expect(panel).not.toContain("useEffect(() => { void api.clickupWarm(); }, []);");
  });
});
