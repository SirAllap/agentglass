/*
 * The write door of /control: `settings.set`.
 *
 * Level 1 opens and reads; level 2 changes one local setting, and only one the
 * window's registry lists. What the server owns of that is small and is pinned
 * here: the shape of the value, the level switch, the per-caller rate limit and
 * what the audit line may hold (the setting, never the value).
 */
import { describe, expect, test } from "bun:test";
import { parseControlCmd, controlLevel, makeWriteLimiter, changedSetting, UI_MAX_LEVEL, SETTINGS_WRITES_PER_MINUTE } from "../src/control.ts";
import { targetOf } from "../src/actions.ts";

const set = (value: unknown, id: unknown = "diff.wrap", level?: 1 | 2 | 3) =>
  parseControlCmd({ cmd: "ui", do: "settings.set", args: { id, value } }, level);

describe("settings.set arguments", () => {
  test("a string, a number and a boolean travel; nothing else does", () => {
    expect(set(true)).toEqual({ cmd: "ui", do: "settings.set", args: { id: "diff.wrap", value: true } } as never);
    expect(set(false)).not.toBeNull();
    expect(set(0)).not.toBeNull();
    expect(set("")).not.toBeNull();
    expect(set("fira")).not.toBeNull();
    for (const v of [null, undefined, {}, [], [1], { a: 1 }, NaN, Infinity, "x".repeat(201), "a\nb", "a\u0000b"]) expect(set(v), String(v)).toBeNull();
  });

  test("the id is a slug", () => {
    for (const id of ["", " diff.wrap", "diff wrap", "../x", "a\nb", 3, null, "x".repeat(81)]) expect(set(true, id), String(id)).toBeNull();
    expect(set(true, "rail.place.docker")).not.toBeNull();
  });

  test("a missing value is a refusal, not a write of nothing", () => {
    expect(parseControlCmd({ cmd: "ui", do: "settings.set", args: { id: "diff.wrap" } })).toBeNull();
    expect(parseControlCmd({ cmd: "ui", do: "settings.set" })).toBeNull();
  });

  test("get and list take an id and nothing", () => {
    expect(parseControlCmd({ cmd: "ui", do: "settings.get", args: { id: "diff.wrap" } })).not.toBeNull();
    expect(parseControlCmd({ cmd: "ui", do: "settings.get", args: {} })).toBeNull();
    expect(parseControlCmd({ cmd: "ui", do: "settings.list" })).toEqual({ cmd: "ui", do: "settings.list", args: {} } as never);
  });
});

describe("the level switch", () => {
  test("the default is 2, so a write is accepted by default", () => {
    expect(UI_MAX_LEVEL).toBe(3);
    expect(controlLevel({})).toBe(2);
    expect(set(true)).not.toBeNull();
  });

  test("AGENTGLASS_CONTROL_LEVEL=1 keeps opens and reads and refuses the write", () => {
    expect(controlLevel({ AGENTGLASS_CONTROL_LEVEL: "1" })).toBe(1);
    expect(set(true, "diff.wrap", 1)).toBeNull();
    expect(parseControlCmd({ cmd: "ui", do: "settings.get", args: { id: "diff.wrap" } }, 1)).not.toBeNull();
    expect(parseControlCmd({ cmd: "ui", do: "settings.open", args: { page: "diff" } }, 1)).not.toBeNull();
    expect(parseControlCmd({ cmd: "view", to: "git" }, 1)).not.toBeNull();
  });

  test("unset is the default, 2; a value that is set and unreadable fails closed to 1", () => {
    expect(controlLevel({ AGENTGLASS_CONTROL_LEVEL: undefined })).toBe(2);
    for (const v of ["9", "", "off", "0", "-1", "2.5", "high", "none", "readonly"]) expect(controlLevel({ AGENTGLASS_CONTROL_LEVEL: v }), String(v)).toBe(1);
  });
});

describe("the per-caller write limit", () => {
  test("allows the limit, refuses the next, and a refusal is not counted", () => {
    const l = makeWriteLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect([l.hit("a", t0), l.hit("a", t0 + 1), l.hit("a", t0 + 2)]).toEqual([true, true, true]);
    expect(l.hit("a", t0 + 3)).toBe(false);
    expect(l.hit("a", t0 + 30_000)).toBe(false);
    // The first three have aged out; the refused ones left no mark.
    expect(l.hit("a", t0 + 60_001)).toBe(true);
  });

  test("callers do not share a budget", () => {
    const l = makeWriteLimiter(1, 60_000);
    expect(l.hit("local", 0)).toBe(true);
    expect(l.hit("local", 1)).toBe(false);
    expect(l.hit("10.0.0.7", 2)).toBe(true);
  });

  test("the default is a sweep through Settings, not a loop", () => {
    expect(SETTINGS_WRITES_PER_MINUTE).toBe(30);
  });
});

describe("what the audit line holds", () => {
  test("the setting for a settings.set, nothing for the rest", () => {
    expect(changedSetting(set("secret-looking-value", "terminal.font")!)).toBe("terminal.font");
    expect(changedSetting(parseControlCmd({ cmd: "ui", do: "settings.get", args: { id: "diff.wrap" } })!)).toBeNull();
    expect(changedSetting(parseControlCmd({ cmd: "view", to: "git" })!)).toBeNull();
  });

  test("the target of the line is the setting id, and no body field can carry the value", () => {
    expect(targetOf("/control/settings.set", { setting: "diff.wrap" })).toBe("diff.wrap");
    expect(targetOf("/control/settings.set", { setting: "diff.wrap", value: "hunter2" })).toBe("diff.wrap");
    expect(targetOf("/control/settings.set", {})).toBe("");
  });
});

describe("the route", async () => {
  const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  const at = src.indexOf('if (pathname === "/control" && req.method === "POST") {');
  const body = src.slice(at, src.indexOf("The understudy's own surface", at))
    .split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

  test("the limit is checked before anything is sent, and answers 429", () => {
    expect(at).toBeGreaterThan(0);
    expect(body.indexOf("controlWriteLimit.hit(")).toBeGreaterThan(0);
    expect(body.indexOf("controlWriteLimit.hit(")).toBeLessThan(body.indexOf("sendControl("));
    expect(body).toContain("429");
  });

  test("the audit line is given the setting id and never the arguments", () => {
    expect(body).toContain("{ setting }");
    const audit = body.slice(body.indexOf("const audit ="), body.indexOf("\n", body.indexOf("const audit =")));
    expect(audit).not.toMatch(/args|value|\bb\b/);
  });
});
