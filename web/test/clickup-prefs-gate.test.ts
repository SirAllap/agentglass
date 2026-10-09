/*
 * A machine with no ClickUp makes no ClickUp-shaped request.
 *
 * The workflow settings were read by every Tasks panel, ClickUp or not, so a
 * GitHub-only user's browser asked the server for `/clickup/prefs` each time the
 * tab opened. The read is local and harmless; it is still a request for a thing
 * that machine cannot have. The gate is the same local answer the rest of the
 * app uses for "is ClickUp here".
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";
const stubGlobal = globalStubs();

let asked: string[] = [];
let connected = false;
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
stubGlobal("location", { hostname: "localhost", origin: "http://localhost:4000", search: "" });
stubGlobal("fetch", async (input: unknown) => {
  const url = String(input);
  asked.push(new URL(url).pathname);
  const body = url.includes("/clickup/prefs")
    ? { ok: true, prefs: { cardSkillPattern: "clickup" } }
    : { views: [], folders: [], connected };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
});

const Prefs = await import("../src/lib/clickupPrefs.ts");
const Setup = await import("../src/lib/clickupSetup.ts");

beforeEach(() => { asked = []; Prefs.__forgetClickupPrefs(); Setup.__forgetClickupSetup(); });

describe("clickupPrefs()", () => {
  test("not connected: null, and /clickup/prefs is never asked", async () => {
    connected = false;
    expect(await Prefs.clickupPrefs()).toBeNull();
    expect(asked.filter((p) => p === "/clickup/prefs")).toEqual([]);
  });

  test("connected: the prefs are read, once for however many ask", async () => {
    connected = true;
    const [a, b] = await Promise.all([Prefs.clickupPrefs(), Prefs.clickupPrefs()]);
    expect(a?.cardSkillPattern).toBe("clickup");
    expect(b).toBe(a);
    expect(asked.filter((p) => p === "/clickup/prefs")).toHaveLength(1);
  });

  test("a disconnect drops the copy held for the minute", async () => {
    connected = true;
    await Prefs.clickupPrefs();
    connected = false;
    Prefs.__forgetClickupPrefs(); Setup.__forgetClickupSetup();
    expect(await Prefs.clickupPrefs()).toBeNull();
  });
});
