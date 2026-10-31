/*
 * Polaris through the settings door, with the real definitions and a scratch config:
 * what an agent's change to each door does, where it is written, and what it reads back.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOOR_IDS, PRESETS } from "../../shared/polaris.ts";
import { classOf } from "../../shared/settingClass.ts";
import { serverSettingDefs } from "../src/serverSettings.ts";
import { makeDoor } from "../src/settingsDoor.ts";
import { readPolaris, readStoredPolaris, writePolaris } from "../src/config.ts";

const savedHome = process.env.XDG_CONFIG_HOME;
const dirs: string[] = [];
let dir = "";
const ROOT = "/work/acme/orbit";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agx-polaris-door-")); dirs.push(dir); process.env.XDG_CONFIG_HOME = dir; });
afterAll(() => {
  if (savedHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function rig() {
  let trusted = false;
  const door = makeDoor({
    defs: () => serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged: () => {} }),
    trusted: () => trusted, applyWindow: async () => ({ ok: true }), changed: () => {}, later: () => {},
  });
  return { door, trust: (on: boolean) => { trusted = on; }, agent: { person: false, who: "worker builder-1", root: ROOT }, person: { person: true, who: "the person", root: ROOT } };
}
const set = (r: ReturnType<typeof rig>, id: string, v: unknown, who = r.agent) => r.door.change(id, v, who);
const doorOf = (id: string) => readPolaris(ROOT).settings.doors[id as keyof ReturnType<typeof readPolaris>["settings"]["doors"]]!;

describe("the settings Polaris exposes", () => {
  test("eighteen ids: enabled and one per door, each with its own class", () => {
    const ids = serverSettingDefs({ terminalEnabled: false, budgetWrites: false, policyChanged: () => {} }).map((d) => d.id).filter((i) => i.startsWith("polaris."));
    expect(ids.sort()).toEqual(["polaris.enabled", ...DOOR_IDS.map((d) => `polaris.door.${d}`)].sort());
    expect(ids).toHaveLength(18);
    expect(ids.filter((i) => !classOf(i))).toEqual([]);
    expect(ids).not.toContain("polaris.preset");
  });

  test("a setting kept per project asks for the project, naming --root", async () => {
    const r = rig();
    expect(r.door.value("polaris.door.relaunch")).toMatchObject({ error: expect.stringContaining("--root") });
    const refused = await r.door.change("polaris.door.relaunch", { mode: "off" }, { person: false, who: "probe" });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("--root") });
    expect(await r.door.change("polaris.enabled", false, { person: false, who: "probe" })).toMatchObject({ ok: false, error: expect.stringContaining("--root") });
    expect(readStoredPolaris(undefined)).toBeNull();
  });

  test("polaris.preset is not readable through the door; the settings route has it", () => {
    const r = rig();
    expect(r.door.value("polaris.preset", ROOT)).toMatchObject({ error: expect.stringContaining("not a setting") });
  });
});

describe("an agent's change to a door", () => {
  test("lowering applies at once, writes the project layer only and stores custom", async () => {
    const r = rig();
    writePolaris(ROOT, { enabled: true, preset: "guided", doors: structuredClone(PRESETS.guided.doors) });
    const a = await set(r, "polaris.door.relaunch", { mode: "off" });
    expect(a).toMatchObject({ ok: true, applied: true });
    expect(doorOf("relaunch")).toMatchObject({ mode: "off", cap: 3 });
    expect(readStoredPolaris(ROOT)).toMatchObject({ preset: "custom" });
    expect(readStoredPolaris(undefined)).toBeNull();
  });

  test("raising waits for the person and applies nothing", async () => {
    const r = rig();
    writePolaris(ROOT, { enabled: true, preset: "guided", doors: structuredClone(PRESETS.guided.doors) });
    await set(r, "polaris.door.relaunch", { mode: "off" });
    const a = await set(r, "polaris.door.relaunch", { mode: "dry" });
    expect(a.ok && !a.applied).toBe(true);
    expect(doorOf("relaunch").mode).toBe("off");
    expect(r.door.pending()).toHaveLength(1);
  });

  test("a live position is refused, even with the trust switch on", async () => {
    const r = rig();
    r.trust(true);
    writePolaris(ROOT, { enabled: true, doors: structuredClone(PRESETS.guided.doors) });
    for (const [door, v] of [["relaunch", { mode: "live" }], ["diagnose", { mode: "auto" }], ["startSession", { mode: "click" }], ["cards", { mode: "on" }]] as const) {
      expect(await set(r, `polaris.door.${door}`, v)).toMatchObject({ ok: false, status: 403 });
    }
    expect(doorOf("relaunch").mode).toBe("dry");
    // ...and a widening that is not live goes through when the switch is on
    expect(await set(r, "polaris.door.course", { mode: "hours", hours: 4 })).toMatchObject({ ok: true, applied: true });
  });

  test("a setting moved its narrower way applies; the wider way waits", async () => {
    const r = rig();
    writePolaris(ROOT, { enabled: true, doors: structuredClone(PRESETS.guided.doors) });
    expect(await set(r, "polaris.door.relaunch", { mode: "dry", cap: 1 })).toMatchObject({ ok: true, applied: true });
    expect(doorOf("relaunch").cap).toBe(1);
    const up = await set(r, "polaris.door.relaunch", { mode: "dry", cap: 3 });
    expect(up.ok && !up.applied).toBe(true);
    expect(doorOf("relaunch").cap).toBe(1);
  });

  test("a mode alone keeps the settings the door has", async () => {
    const r = rig();
    writePolaris(ROOT, { enabled: true, doors: { ...structuredClone(PRESETS.guided.doors), relaunch: { mode: "dry", cap: 2 } } });
    await set(r, "polaris.door.relaunch", { mode: "off" });
    expect(doorOf("relaunch")).toEqual({ mode: "off", cap: 2 });
  });

  test("a value that is not a door is refused by name", async () => {
    const r = rig();
    expect(await set(r, "polaris.door.relaunch", { mode: "always" })).toMatchObject({ ok: false, status: 400 });
    expect(await set(r, "polaris.door.relaunch", { mode: "dry", cap: 7 })).toMatchObject({ ok: false });
    expect(await set(r, "polaris.door.beacon", { mode: "dry" })).toMatchObject({ ok: false });
  });
});

describe("polaris.enabled", () => {
  test("off applies at once; on is the person's, even with the trust switch on", async () => {
    const r = rig();
    r.trust(true);
    writePolaris(ROOT, { enabled: true });
    expect(await set(r, "polaris.enabled", false)).toMatchObject({ ok: true, applied: true });
    expect(readPolaris(ROOT).settings.enabled).toBe(false);
    expect(await set(r, "polaris.enabled", true)).toMatchObject({ ok: false, status: 403 });
    expect(readPolaris(ROOT).settings.enabled).toBe(false);
  });

  test("the person turns it on: with nothing stored that writes Guided, with doors stored it keeps them", async () => {
    const r = rig();
    expect(await set(r, "polaris.enabled", true, r.person)).toMatchObject({ ok: true, applied: true });
    expect(readStoredPolaris(ROOT)).toMatchObject({ enabled: true, preset: "guided" });
    expect(doorOf("relaunch").mode).toBe("dry");
    writePolaris(ROOT, { enabled: false, preset: "custom", doors: { follow: { mode: "on" } } });
    await set(r, "polaris.enabled", true, r.person);
    expect(Object.keys(readStoredPolaris(ROOT)!.doors!)).toEqual(["follow"]);
  });
});

describe("reading", () => {
  test("get returns the resolved value and the layer it came from", async () => {
    const r = rig();
    writePolaris(undefined, { enabled: true, doors: { beacon: { mode: "draft" } } });
    writePolaris(ROOT, { doors: { relaunch: { mode: "dry", cap: 3 } } });
    expect(r.door.value("polaris.door.beacon", ROOT)).toMatchObject({ value: { mode: "draft" }, scopedSet: false, layer: "global" });
    expect(r.door.value("polaris.door.relaunch", ROOT)).toMatchObject({ value: { mode: "dry", cap: 3 }, scopedSet: true, layer: "project" });
    expect(r.door.value("polaris.door.follow", ROOT)).toMatchObject({ layer: "default" });
    expect(r.door.value("polaris.enabled", ROOT)).toMatchObject({ value: true, layer: "global" });
  });

  test("a narrowing is judged against the resolved value, not the project's own", async () => {
    const r = rig();
    writePolaris(undefined, { enabled: true, doors: { relaunch: { mode: "live", cap: 3 } } });
    // the project says nothing, so "dry" is lower than the global "live" it inherits
    expect(await set(r, "polaris.door.relaunch", { mode: "dry" })).toMatchObject({ ok: true, applied: true });
    expect(readStoredPolaris(undefined)).toMatchObject({ doors: { relaunch: { mode: "live" } } });
  });

  test("the config file keeps what a newer version wrote", async () => {
    const r = rig();
    writePolaris(ROOT, { version: 2, enabled: true, doors: { follow: { mode: "on", futureKey: 1 } }, newerSection: { a: 1 } } as never);
    await set(r, "polaris.door.follow", { mode: "off" });
    const file = JSON.parse(readFileSync(join(dir, "agentglass", "config.json"), "utf8")).polaris.projects[ROOT];
    expect(file).toMatchObject({ version: 2, newerSection: { a: 1 }, doors: { follow: { mode: "off", futureKey: 1 } } });
  });
});

describe("the CLI's get", () => {
  // The route names the layer; the CLI rebuilt the answer from value and class only, so an agent could not tell whose value it read.
  test("passes the layer and whether the project set it through", () => {
    const src = readFileSync(join(import.meta.dir, "../../bin/agentglass-ui"), "utf8");
    expect(src).toContain('for k in ("scopedSet", "layer") if k in body');
  });
});
