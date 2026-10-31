/*
 * The Settings tab's decisions: which setting a field is, how a value goes over
 * the wire and back, what a refusal means, what each mode's track says. The
 * markup rules (a radio is a radio, a switch is a switch, motion is transform
 * and opacity) are read from source: there is no renderer here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_PILOT_SETTINGS, FIELDS, PILOT_KEYS, decode, encode, meter, noteFor, nowLine, parseUsd, track,
} from "../src/lib/pilotSettings.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
const tab = code(read("src/components/flightPlan/SettingsTab.tsx"));
const css = read("src/components/flightPlan/pilotSettings.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("keys", () => {
  test("every field has its own id under flightPlan, and the defaults are the engine's", () => {
    expect(new Set(FIELDS.map((f) => PILOT_KEYS[f].id)).size).toBe(FIELDS.length);
    for (const f of FIELDS) expect(PILOT_KEYS[f].id.startsWith("flightPlan.")).toBe(true);
    expect(Object.keys(DEFAULT_PILOT_SETTINGS).sort()).toEqual([...FIELDS].sort());
    expect(DEFAULT_PILOT_SETTINGS).toMatchObject({ pilot: "copilot", sizes: "ML", secondLooks: 1, maxFlying: 2, dailyUsd: 5, weeklyUsd: 20, costCapUsd: 0.5, permissions: "auto" });
  });
  test("bypass is one machine-wide decision, the rest follow the project", () => {
    expect(PILOT_KEYS.permissions.scope).toBe("app");
    expect(PILOT_KEYS.pilot.scope).toBe("project");
    expect(PILOT_KEYS.askOnLarge.scope).toBe("project");
    expect(PILOT_KEYS.askOnSensitive.scope).toBe("project");
  });
});

describe("decode and encode", () => {
  test("reviews travel as the list of ticked places and come back as flags", () => {
    expect(encode("reviews", { plan: true, taskDone: false, pr: true })).toEqual(["plan", "pr"]);
    expect(decode("reviews", ["taskDone"])).toEqual({ plan: false, taskDone: true, pr: false });
    expect(decode("reviews", [])).toEqual({ plan: false, taskDone: false, pr: false });
  });
  test("a value the field does not take is not one: the default stays", () => {
    expect(decode("pilot", "turbo")).toBeUndefined();
    expect(decode("secondLooks", 3)).toBeUndefined();
    expect(decode("maxFlying", "2")).toBeUndefined();
    expect(decode("dailyUsd", -1)).toBeUndefined();
    expect(decode("dailyUsd", Number.NaN)).toBeUndefined();
    expect(decode("askOnLarge", "true")).toBeUndefined();
    expect(decode("permissions", "bypassPermissions")).toBe("bypassPermissions");
  });
  test("everything but the reviews goes over as it is", () => {
    for (const f of FIELDS.filter((x) => x !== "reviews")) expect(encode(f, DEFAULT_PILOT_SETTINGS[f] as never)).toBe(DEFAULT_PILOT_SETTINGS[f]);
  });
});

describe("dollar boxes", () => {
  test("an amount in range is taken to the cent, a leading $ is forgiven", () => {
    expect(parseUsd("costCapUsd", "0.5")).toEqual({ ok: true, value: 0.5 });
    expect(parseUsd("dailyUsd", " $7.456 ")).toEqual({ ok: true, value: 7.46 });
  });
  test("zero, negative, empty, text and over-the-ceiling say why", () => {
    for (const t of ["0", "-2", "", "abc", "5.01"]) expect(parseUsd("costCapUsd", t).ok).toBe(false);
    expect(parseUsd("costCapUsd", "5").ok).toBe(true);
    const r = parseUsd("weeklyUsd", "99999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("week");
  });
});

describe("how a write came back", () => {
  test("saved is no note; waiting for approval is a note, not an error", () => {
    expect(noteFor({ ok: true })).toBeNull();
    expect(noteFor({ ok: true, applied: false })?.kind).toBe("wait");
  });
  test("a person-only refusal is the lock note and never an error", () => {
    expect(noteFor({ ok: false, error: "bypass lets a builder run every tool: only the person turns it on" })?.kind).toBe("lock");
  });
  test("a key the engine has not shipped, or no server, is an error that says so", () => {
    const n = noteFor({ ok: false, error: "no such setting: flightPlan.maxFlying" });
    expect(n?.kind).toBe("error");
    expect(n?.text).toContain("flightPlan.maxFlying");
    expect(noteFor({ ok: false })?.kind).toBe("error");
  });
});

describe("meter, now lines, track", () => {
  test("the meter fills to the cap and warns from 80 %", () => {
    expect(meter(1.2, 5)).toEqual({ pct: 0.24, tone: "ok" });
    expect(meter(4, 5).tone).toBe("warn");
    expect(meter(9, 5)).toEqual({ pct: 1, tone: "full" });
    expect(meter(1, 0).pct).toBe(0);
  });
  test("with nobody in the seat Co-pilot and Autopilot say they act as Manual; Manual does not", () => {
    expect(nowLine("autopilot", 1, 2, false)?.tail).toBe("No seat: acts as Manual");
    expect(nowLine("manual", 2, 0, false)?.bold).toBe("2 plans");
    expect(nowLine("copilot", undefined, undefined, true)).toBeNull();
    expect(nowLine("autopilot", 1, 2, true)).toEqual({ bold: "1 question", tail: " for you · 2 flying" });
    expect(nowLine("copilot", 1, 0, true)?.bold).toBe("1 Go card");
  });
  test("eight steps in every mode; one Go, and only Autopilot hands it to the orchestrator", () => {
    for (const p of ["manual", "copilot", "autopilot"] as const) {
      const t = track(p);
      expect(t.map((s) => s.key)).toEqual(["create", "write", "review", "answer", "go", "launch", "build", "integrate"]);
      expect(t.filter((s) => s.gate).length).toBe(1);
      expect(t.find((s) => s.key === "review")!.actor).toBe("reviewer");
      expect(t.find((s) => s.key === "build")!.actor).toBe("builder");
    }
    expect(track("copilot").find((s) => s.gate)!.actor).toBe("person");
    expect(track("autopilot").find((s) => s.gate)!.actor).toBe("coordinator");
    expect(track("manual").find((s) => s.key === "integrate")!.actor).toBe("person");
  });
});

describe("the tab, from source", () => {
  test("the modes are real radios in a radiogroup, the toggles are switches", () => {
    expect(tab).toContain('role="radiogroup"');
    expect(tab).toContain('type="radio"');
    expect(tab).toContain('role="switch"');
    expect(tab).toContain("aria-describedby=");
  });
  test("it reads and writes through the per-key door and keeps the master switch", () => {
    expect(tab).toContain('api.settingsDoorSet("flightPlan.enabled"');
    const hook = code(read("src/components/flightPlan/usePilotSettings.ts"));
    expect(hook).toContain("api.settingAt(");
    expect(hook).toContain("api.settingAtSet(");
    expect(hook).toContain("put(f, prev)");
  });
  test("no colour literals but the four actor hues and white ink, defined once", () => {
    const literals = [...(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])];
    expect(literals.sort()).toEqual(["#7a4fb5", "#2f7d8a", "#3b66b0", "#c27a2c", "#fff"].sort());
    expect(tab).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  test("transitions name transform or opacity only", () => {
    for (const m of css.matchAll(/transition:\s*([^;}]+)/g)) {
      if (m[1]!.trim() === "none !important") continue;
      for (const part of m[1]!.split(",")) expect(part.trim().split(/\s+/)[0]).toMatch(/^(transform|opacity)$/);
    }
  });
  test("press, reduced motion and the container query are there", () => {
    expect(css).toContain("scale(.97)");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("@container ps (max-width: 760px)");
  });
});
