/*
 * The four inconsistencies: the Signals door in Watch only, one count for both
 * sides, one resolver for the master switch, and a badge for a door with no code.
 * Fixtures are invented (acme/orbit, ORBIT-1042).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOOR_IDS, PRESETS, doorsOn, enabledInvalid, polarisEnabled, resolvePolaris, withPreset,
  type DoorId, type SettingsAnswer,
} from "../../shared/polaris.ts";
import { readPolaris, writePolaris } from "../src/config.ts";
import { enabledOf, enabledProblemOf, doorView } from "../../web/src/lib/polarisView.ts";

const ROOT = "/work/acme/orbit";
const LANDING: readonly DoorId[] = ["cleared", "labels", "approvals", "redsNamed"];
const SIGNALS: readonly DoorId[] = ["signals", "diagnose"];
const dirs: string[] = [];
const savedHome = process.env.XDG_CONFIG_HOME;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "agx-polaris-gaps-"));
  dirs.push(dir);
  process.env.XDG_CONFIG_HOME = dir;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedHome;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The answer the window draws, from the real resolver. */
function answer(global: unknown = null, project: unknown = null): SettingsAnswer {
  const r = resolvePolaris(global, project);
  return {
    ok: true, ...r.settings, layers: r.layers, enabledLayer: r.enabledLayer, enabledInvalid: r.enabledInvalid, presetLayer: r.presetLayer,
    ...(project ? { root: ROOT, stored: project as SettingsAnswer["stored"], below: (global ?? undefined) as SettingsAnswer["below"] } : { stored: (global ?? undefined) as SettingsAnswer["stored"] }),
  };
}

describe("the Signals door in Watch only", () => {
  test("Watch only reads and sorts, so signals is on there, and every preset inherits it", () => {
    expect(PRESETS.watchOnly.doors.signals.mode).toBe("on");
    for (const id of ["watchOnly", "guided", "fullAutopilot"] as const) expect(PRESETS[id].doors.signals.mode).toBe("on");
    const stored = withPreset(null, "watchOnly");
    writePolaris(ROOT, stored);
    expect(readPolaris(ROOT).settings.doors.signals.mode).toBe("on");
  });
});

describe("one count, from both sides", () => {
  test("Watch only gives Landing 4 of 4, from the preset and from config.json", () => {
    expect(doorsOn(PRESETS.watchOnly.doors, LANDING)).toBe(4);
    writePolaris(ROOT, withPreset(null, "watchOnly"));
    expect(doorsOn(readPolaris(ROOT).settings.doors, LANDING)).toBe(4);
  });

  test("the door whose safest position already does something (people's approvals) counts as on", () => {
    expect(PRESETS.watchOnly.doors.approvals.mode).toBe("people");
    expect(doorsOn(PRESETS.watchOnly.doors, ["approvals"])).toBe(1);
  });
});

describe("the master switch, read by one resolver", () => {
  test("true, false, a non-boolean, and a missing value, on either layer", () => {
    expect(polarisEnabled({ project: { enabled: true } })).toBe(true);
    expect(polarisEnabled({ project: { enabled: false } })).toBe(false);
    // A project's non-boolean is not a switch: the global boolean answers, and false when none does.
    expect(polarisEnabled({ project: { enabled: "true" } })).toBe(false);
    expect(polarisEnabled({ project: { enabled: "true" }, global: { enabled: true } })).toBe(true);
    expect(polarisEnabled({ global: { enabled: true } })).toBe(true);
    expect(polarisEnabled({ global: { enabled: "true" } })).toBe(false);
    expect(polarisEnabled({})).toBe(false);
    expect(enabledInvalid({ project: { enabled: "true" }, global: { enabled: true } })).toBe("project");
    expect(enabledInvalid({ global: { enabled: "yes" } })).toBe("global");
    expect(enabledInvalid({ project: { enabled: false } })).toBeNull();
  });

  test("the resolved settings and the window agree, and an unusable value is named, never turned into true", () => {
    const r = resolvePolaris({ enabled: true }, { enabled: "true" });
    expect(r.settings.enabled).toBe(true);
    expect(r.enabledInvalid).toBe("project");
    const a = answer({ enabled: true }, { enabled: "true" });
    expect(enabledOf(a)).toBe(true);
    expect(enabledProblemOf(a)).toBe("project");
    const alone = answer(null, { enabled: "true" });
    expect(alone.enabled).toBe(false);
    expect(enabledOf(alone)).toBe(false);
    expect(enabledProblemOf(alone)).toBe("project");
  });
});

describe("doors with no code", () => {
  test("Re-run and Start a session are badged and not counted as on, while Diagnose wakes the seat in Full autopilot", () => {
    const a = answer(null, withPreset(null, "fullAutopilot"));
    for (const door of ["rerunButton", "startSession"] as const) {
      expect(doorView(a, "global", door).unwired).toBe(true);
    }
    expect(a.doors.startSession.mode).toBe("click");
    expect(doorView(a, "global", "diagnose").unwired).toBe(false);
    expect(doorsOn(a.doors, ["startSession", "rerunButton", "diagnose"])).toBe(1);
  });

  test("Diagnose at When I click is badged and not counted, while Automatically is", () => {
    const a = answer(null, withPreset(null, "guided"));
    expect(a.doors.diagnose.mode).toBe("click");
    expect(doorView(a, "global", "diagnose").unwired).toBe(true);
    expect(doorsOn(a.doors, SIGNALS)).toBe(1);
  });

  test("the Signals door reads, so it is not badged and counts as on, in Watch only too", () => {
    const a = answer(null, withPreset(null, "watchOnly"));
    expect(doorView(a, "global", "signals").unwired).toBe(false);
    expect(doorsOn(a.doors, SIGNALS)).toBe(1);
  });

  test("Follow tracker cards keeps its badge off once part B reads it, and every preset still writes all 17 doors", () => {
    const a = answer(null, withPreset(null, "fullAutopilot"));
    expect(doorView(a, "global", "cards").unwired).toBe(false);
    expect(doorsOn(a.doors, ["cards"])).toBe(1);
    for (const id of ["watchOnly", "guided", "fullAutopilot"] as const) expect(Object.keys(PRESETS[id].doors)).toHaveLength(DOOR_IDS.length);
    expect(DOOR_IDS).toHaveLength(17);
  });
});
