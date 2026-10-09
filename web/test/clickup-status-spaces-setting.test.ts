/*
 * The pick of counted spaces as a setting an agent can read and write, held to
 * what the Settings page's buttons do: the same /clickup/prefs save, the held
 * settings changed before the save lands, the old pick back when it is refused,
 * and not one request to ClickUp itself (the spaces are re-answered by this
 * server from what it holds).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { ClickUpPrefs } from "../../shared/providers.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
let sent: { url: string; body?: unknown }[] = [];
let refuse = false;
const prefs = (counted: string[]): ClickUpPrefs => ({
  handoff: { enabled: false, statusNames: [], unassign: "none" }, review: { enabled: false, statusNames: [], assignReviewer: false },
  merge: { enabled: false, statusNames: [] }, flows: { noteOnCard: false }, prLinkField: "", swatchField: "", cardSkillPattern: "",
  assigned: { includeSubtasks: false }, sprintListPattern: "", readOnlyFieldPattern: "", bell: { kinds: [] }, statusSpaces: { counted },
});
stubGlobal("location", { origin: "http://127.0.0.1:1", hostname: "127.0.0.1", search: "", href: "http://127.0.0.1:1/" });
stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage);
stubGlobal("window", new EventTarget());
stubGlobal("fetch", async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  sent.push({ url: String(url), body });
  const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
  if (String(url).includes("/clickup/prefs") && init?.method === "POST") {
    return refuse ? json({ ok: false, error: "no" }) : json({ ok: true, prefs: prefs(body.statusSpaces.counted) });
  }
  return json({ ok: true, spaces: [] });
});

const R = await import("../src/lib/settingsRegistry.ts");
const P = await import("../src/lib/clickupPrefs.ts");
const S = await import("../src/lib/clickupSpaces.ts");
const ID = "clickup.statusSpaces.counted";
const settle = () => Bun.sleep(20);
const api = () => R.makeSettings(R.SETTING_DEFS);

beforeEach(() => { sent = []; refuse = false; S.__forgetClickupSpaces(); P.clickupPrefsSaved(prefs([])); });
afterAll(() => { P.__forgetClickupPrefs(); S.__forgetClickupSpaces(); });

describe("clickup.statusSpaces.counted", () => {
  test("it is listed as writable at level 2, and reads none chosen as an empty string", () => {
    const l = R.makeSettings(R.SETTING_DEFS.filter((d) => d.id === ID)).list()[0]!;
    expect(l).toMatchObject({ writable: true, secret: false, value: "" });
    expect(api().get(ID)).toEqual({ ok: true, id: ID, value: "" });
  });

  test("a write reads back at once, saves through /clickup/prefs, and asks the server for the spaces again, not ClickUp", async () => {
    const r = api().set(ID, "902, 901,902");
    expect(r).toMatchObject({ ok: true, prev: "", value: "902,901" });
    expect(api().get(ID)).toEqual({ ok: true, id: ID, value: "902,901" });
    await settle();
    const save = sent.find((x) => x.url.includes("/clickup/prefs"))!;
    expect(save.body).toEqual({ statusSpaces: { counted: ["902", "901"] } });
    expect(sent.some((x) => x.url.includes("/clickup/status-spaces"))).toBe(true);
    expect(sent.every((x) => !x.url.includes("fresh=1"))).toBe(true);
  });

  test("undo puts the old pick back through the same save", async () => {
    const s = api();
    const w = s.set(ID, "901") as { undo: string };
    await settle();
    sent = [];
    expect(s.undo(w.undo)).toBe(true);
    expect(s.get(ID)).toEqual({ ok: true, id: ID, value: "" });
    await settle();
    expect(sent.find((x) => x.url.includes("/clickup/prefs"))!.body).toEqual({ statusSpaces: { counted: [] } });
  });

  test("a save the server refuses puts the old pick back", async () => {
    refuse = true;
    api().set(ID, "901");
    expect(api().get(ID)).toEqual({ ok: true, id: ID, value: "901" });
    await settle();
    expect(api().get(ID)).toEqual({ ok: true, id: ID, value: "" });
  });

  test("anything that is not a list of space ids is refused and saves nothing", async () => {
    for (const bad of ["Sales", "901;902", 901, true, null, Array.from({ length: 201 }, (_, i) => String(i)).join(",")]) {
      expect(api().set(ID, bad), String(bad)).toEqual({ ok: false, error: expect.stringContaining(`not a valid value for ${ID}; accepted: `) });
    }
    await settle();
    expect(sent).toEqual([]);
  });

  test("the page's own button is this def: the pane calls it, not the save", async () => {
    const pane = await Bun.file(new URL("../src/components/ClickUpPane.tsx", import.meta.url)).text();
    expect(pane).toContain('setting("clickup.statusSpaces.counted").set(');
  });
});
