/*
 * The window's calls to Polaris: which verb and path each one uses, that a root is
 * encoded, and that a PUT carries the desk header and reads a 202 as not saved.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal";

const stubGlobal = globalStubs();
const calls: { url: string; method: string; body: unknown }[] = [];
let status = 200;
stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
stubGlobal("fetch", async (url: string, init?: { method?: string; body?: string }) => {
  calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
  return new Response(JSON.stringify({ ok: true, items: [] }), { status, headers: { "content-type": "application/json" } });
});

let api: typeof import("../src/lib/api.ts").api;
beforeAll(async () => { api = (await import("../src/lib/api.ts")).api; });
beforeEach(() => { calls.length = 0; status = 200; });

const ROOT = "/work/acme/orbit";
describe("the Polaris client", () => {
  test("reads go by GET with the root encoded", async () => {
    await api.polarisSettings(ROOT);
    await api.polarisSettings();
    await api.polarisItems(ROOT);
    expect(calls.map((c) => [c.method, c.url.replace(/^.*?\/polaris/, "/polaris")])).toEqual([
      ["GET", `/polaris/settings?root=${encodeURIComponent(ROOT)}`],
      ["GET", "/polaris/settings"],
      ["GET", `/polaris/items?root=${encodeURIComponent(ROOT)}`],
    ]);
  });

  test("a save is a PUT carrying the change and the root", async () => {
    await api.polarisSettingsSave({ preset: "guided" }, ROOT);
    await api.polarisSettingsSave({ enabled: true });
    expect(calls.map((c) => [c.method, c.body])).toEqual([["PUT", { preset: "guided", root: ROOT }], ["PUT", { enabled: true }]]);
  });

  test("a 202 from the door reads as not saved", async () => {
    status = 202;
    expect(await api.polarisSettingsSave({ enabled: true }, ROOT)).toMatchObject({ ok: false, error: expect.stringContaining("not saved") });
  });

  test("a click is a POST to the item's own path", async () => {
    await api.polarisAct(ROOT, 7, { type: "dock" });
    await api.polarisBeaconSend(ROOT, 7, { reason: "conflict" });
    await api.polarisBeaconEdit(ROOT, 7, { reason: "conflict", text: "Rebase on main." });
    await api.polarisBeaconDiscard(ROOT, 7, { reason: "conflict" });
    expect(calls.map((c) => [c.method, c.url.replace(/^.*?\/polaris/, "/polaris"), c.body])).toEqual([
      ["POST", "/polaris/items/7/action", { root: ROOT, type: "dock" }],
      ["POST", "/polaris/items/7/beacon/send", { root: ROOT, reason: "conflict" }],
      ["POST", "/polaris/items/7/beacon/edit", { root: ROOT, reason: "conflict", text: "Rebase on main." }],
      ["POST", "/polaris/items/7/beacon/discard", { root: ROOT, reason: "conflict" }],
    ]);
  });
});
