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
  handoff: { enabled: false, statusNames: [], unassign: "none", assign: { who: "none" } }, review: { enabled: false, statusNames: [], assignReviewer: false, assign: { who: "none" } },
  merge: { enabled: false, statusNames: [], assign: { who: "none" } }, flows: { noteOnCard: false }, prLinkField: "", swatchField: "", cardSkillPattern: "",
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
const L = await import("../src/lib/workflowLayout.ts");
const ID = "clickup.statusSpaces.counted";
const DEFAULT_WORDS = "the spaces my cards live in";
const settle = () => Bun.sleep(20);
const api = () => R.makeSettings(R.SETTING_DEFS);

beforeEach(() => { sent = []; refuse = false; S.__forgetClickupSpaces(); P.clickupPrefsSaved(prefs([])); });
afterAll(() => { P.__forgetClickupPrefs(); S.__forgetClickupSpaces(); });

describe("clickup.statusSpaces.counted", () => {
  test("it is listed as writable at level 2, and reads none chosen as an empty string", () => {
    const l = R.makeSettings(R.SETTING_DEFS.filter((d) => d.id === ID)).list()[0]!;
    expect(l).toMatchObject({ writable: true, secret: false, type: "string", value: "", display: DEFAULT_WORDS });
    expect(api().get(ID)).toEqual({ ok: true, id: ID, value: "", display: DEFAULT_WORDS });
  });

  test("a write reads back at once, saves through /clickup/prefs, and asks the server for the spaces again, not ClickUp", async () => {
    const r = api().set(ID, "902, 901,902");
    expect(r).toMatchObject({ ok: true, prev: "", value: "902,901" });
    expect(api().get(ID)).toEqual({ ok: true, id: ID, value: "902,901", display: "902, 901" });
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
    expect(s.get(ID)).toEqual({ ok: true, id: ID, value: "", display: DEFAULT_WORDS });
    await settle();
    expect(sent.find((x) => x.url.includes("/clickup/prefs"))!.body).toEqual({ statusSpaces: { counted: [] } });
  });

  test("a save the server refuses puts the old pick back", async () => {
    refuse = true;
    api().set(ID, "901");
    expect(api().get(ID)).toEqual({ ok: true, id: ID, value: "901", display: "901" });
    await settle();
    expect(api().get(ID)).toEqual({ ok: true, id: ID, value: "", display: DEFAULT_WORDS });
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

/* The eye on a list saves through the setting an agent writes, so the page and an agent cannot disagree:
   what the eye presses is what `settings get` then says, and the other way round. */
describe("the eye on a list, through the setting", () => {
  const units = [
    { id: "902", name: "Orbit", statuses: [] },
    { id: "901", name: "Sales", statuses: [] },
    { id: "903", name: "Support", statuses: [], counted: false },
  ];
  const press = (u: (typeof units)[number], current = units) => {
    const ids = L.eyeIds(current, u);
    if (ids) api().set(ID, ids.join(","));
    return ids;
  };

  test("hiding a list saves the others; the setting reads them back, and undo brings the list back", async () => {
    expect(press(units[1]!)).toEqual(["902"]);
    expect(api().get(ID)).toEqual({ ok: true, id: ID, value: "902", display: "902" });
    await settle();
    expect(sent.find((x) => x.url.includes("/clickup/prefs"))!.body).toEqual({ statusSpaces: { counted: ["902"] } });
  });

  test("showing a hidden list adds it to those that count", async () => {
    expect(press(units[2]!)).toEqual(["902", "901", "903"]);
    expect(api().get(ID)).toEqual({ ok: true, id: ID, value: "902,901,903", display: "902, 901, 903" });
  });

  test("what an agent wrote is what the eye starts from, and the last counted list has no eye to press", () => {
    api().set(ID, "902");
    const now = units.map((u) => ({ ...u, counted: u.id === "902" }));
    expect(L.eyeIds(now, now[0]!)).toBeNull();
    expect(L.eyeIds(now, now[1]!)).toEqual(["902", "901"]);
  });
});

/* "orchestrator-agx changed Spaces that count for statuses: default -> 90170067734" told the person nothing.
   The chip and the agent's own read now use the words a person would: the spaces' names, and what an
   empty list means. */
describe("the pick of counted spaces, in words", () => {
  const D = R.setting(ID);
  test("nothing chosen is the default, said as what it does", () => {
    expect(D.display("")).toBe("the spaces my cards live in");
    expect(R.settings.display(ID, "")).toBe("the spaces my cards live in");
  });
  test("ids become the names of the spaces last read; one not read stays its id; nothing is invented", async () => {
    (globalThis as { fetch: unknown }).fetch = async () => new Response(JSON.stringify({ ok: true, source: "tasks", spaces: [
      { id: "901", name: "Platform", statuses: [] }, { id: "902", name: "Orbit", statuses: [] }, { id: "list:7", name: "Platform / Inbox", statuses: [], fromList: true, spaceId: "901" },
    ] }), { headers: { "content-type": "application/json" } });
    await S.readSpaces(true);
    expect(D.display("901")).toBe("Platform");
    expect(D.display("902,901")).toBe("Orbit, Platform");
    expect(D.display("902,555")).toBe("Orbit, 555");
    expect(api().get(ID)).toMatchObject({ value: "", display: "the spaces my cards live in" });
    api().set(ID, "901,902");
    expect(api().get(ID)).toMatchObject({ value: "901,902", display: "Platform, Orbit" });
  });
  test("before any space is read the ids are said as they are", () => {
    S.__forgetClickupSpaces();
    expect(D.display("901")).toBe("901");
  });
});
