/*
 * When a policy rule is on: thresholds with hysteresis, readings that must not
 * move a switch, hours across midnight and a clock change, one log row per
 * flip, and nothing that polls. The clock, the readings, the budget and the
 * timers are all handed in; the database is the scratch one `bun test` gives.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db.ts";
import {
  HYSTERESIS, STALE_MS, __forgetWakeups, armedWakeups, evaluate, hoursOn, nextHoursEdge, ruleStates,
  type EvalDeps, type ScopeRules, type UsageRead,
} from "../src/orchpolicy.ts";
import type { PolicyRule, Trigger } from "../../shared/orchestration.ts";
import type { ProviderUsage } from "../../shared/types.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-10T10:00:00Z");

const chain = [{ engine: "opencode", model: "opencode/big-pickle" }];
const rule = (id: string, when: Trigger[], over: Partial<PolicyRule> = {}): PolicyRule =>
  ({ id, name: `Rule ${id}`, enabled: true, when, workers: { builder: chain }, ...over });
const scope = (...rules: PolicyRule[]): ScopeRules[] => [{ scope: "global", label: "all projects", rules }];

const usageRule = (n = 15, window: "5h" | "weekly" | "either" = "5h") =>
  rule("u", [{ kind: "usage", provider: "anthropic", window, remainingAtMost: n }]);

/** A Claude reading with `remaining` percent left in the 5 h window. */
function read(remaining: number, o: { at: number; reset?: string; weekly?: number; error?: string; available?: boolean }): UsageRead {
  const windows = [{ label: "5h", minutes: 300, usedPercent: 100 - remaining, resetsAt: o.reset ?? "2026-10-10T13:00:00Z" }];
  if (o.weekly !== undefined) windows.push({ label: "weekly", minutes: 10080, usedPercent: 100 - o.weekly, resetsAt: "2026-10-15T00:00:00Z" });
  const usage: ProviderUsage = { provider: "anthropic", label: "Claude", available: o.available ?? true, windows, observedAt: o.at };
  return { usage, ...(o.error ? { error: o.error } : {}) };
}

let wakes: { at: number; fn: () => void }[] = [];
const deps = (now: number, r: UsageRead | null, scopes: ScopeRules[], extra: Partial<EvalDeps> = {}): EvalDeps => ({
  now, scopes, usage: () => r, tz: "UTC", budgetOver: () => false,
  schedule: (at, fn) => { const w = { at, fn }; wakes.push(w); return w; },
  cancel: (h) => { wakes = wakes.filter((w) => w !== h); },
  ...extra,
});
const actions = () => db.query<{ action: string; target: string; detail: string }, []>(`SELECT action, target, detail FROM actions WHERE actor = 'policy' ORDER BY id`).all();

beforeEach(() => {
  db.run(`DELETE FROM policy_state`);
  db.run(`DELETE FROM actions WHERE actor = 'policy'`);
  __forgetWakeups();
  wakes = [];
});
afterAll(() => { db.run(`DELETE FROM policy_state`); db.run(`DELETE FROM actions WHERE actor = 'policy'`); });

const active = (id = "u") => ruleStates(scope(usageRule())).find((s) => s.ruleId === id)!.active;

describe("usage: on at N, off at N+5, and a new window", () => {
  test("on at N, still on at N+4, off at N+5", async () => {
    const s = scope(usageRule(15));
    await evaluate(deps(T0, read(16, { at: T0 }), s));
    expect(active()).toBe(false);
    await evaluate(deps(T0 + MIN, read(15, { at: T0 + MIN }), s));
    expect(active()).toBe(true);
    await evaluate(deps(T0 + 2 * MIN, read(15 + HYSTERESIS - 1, { at: T0 + 2 * MIN }), s));
    expect(active()).toBe(true);
    await evaluate(deps(T0 + 3 * MIN, read(15 + HYSTERESIS, { at: T0 + 3 * MIN }), s));
    expect(active()).toBe(false);
  });

  test("off when the window's resetsAt changes, even though the reading is still low", async () => {
    const s = scope(usageRule(15));
    await evaluate(deps(T0, read(10, { at: T0 }), s));
    expect(active()).toBe(true);
    // The new window has 18% left: between N and N+5, where the old state
    // would hold. A new window forgets it.
    await evaluate(deps(T0 + MIN, read(18, { at: T0 + MIN, reset: "2026-10-10T18:00:00Z" }), s));
    expect(active()).toBe(false);
  });

  test("a wobble of 40 readings around N gives one on and no off", async () => {
    const s = scope(usageRule(15));
    for (let i = 0; i < 40; i++) {
      const remaining = i % 2 === 0 ? 14 : 18; // N-1 and N+3, never N+5
      await evaluate(deps(T0 + i * MIN, read(remaining, { at: T0 + i * MIN }), s));
    }
    expect(actions().filter((a) => a.action === "policy/on")).toHaveLength(1);
    expect(actions().filter((a) => a.action === "policy/off")).toHaveLength(0);
  });

  test("either uses the lower of the two windows", async () => {
    const s = scope(usageRule(15, "either"));
    await evaluate(deps(T0, read(80, { at: T0, weekly: 9 }), s));
    expect(active()).toBe(true);
  });

  test("a rule on the weekly window ignores a low 5 h reading", async () => {
    const s = scope(usageRule(15, "weekly"));
    await evaluate(deps(T0, read(3, { at: T0, weekly: 70 }), s));
    expect(active()).toBe(false);
  });

  test("limit is on at 0 remaining and off at 5", async () => {
    const s = scope(rule("l", [{ kind: "limit", provider: "anthropic" }]));
    const on = () => ruleStates(s)[0]!.active;
    await evaluate(deps(T0, read(1, { at: T0 }), s));
    expect(on()).toBe(false);
    await evaluate(deps(T0 + MIN, read(0, { at: T0 + MIN }), s));
    expect(on()).toBe(true);
    await evaluate(deps(T0 + 2 * MIN, read(4, { at: T0 + 2 * MIN }), s));
    expect(on()).toBe(true);
    await evaluate(deps(T0 + 3 * MIN, read(5, { at: T0 + 3 * MIN }), s));
    expect(on()).toBe(false);
  });
});

describe("a reading that is not evidence changes nothing", () => {
  const cases: [string, (now: number) => UsageRead | null, string][] = [
    ["a reading marked unavailable", (now) => read(5, { at: now, available: false }), "no usage reading"],
    ["a poll that failed", (now) => read(95, { at: now, error: "HTTP 429" }), "poll failed"],
    ["no reading at all", () => null, "no usage reading"],
    ["a reading older than 30 min", (now) => read(95, { at: now - 47 * MIN }), "47 min old"],
  ];
  for (const [name, make, said] of cases) {
    test(`${name}: an active rule stays active and says why`, async () => {
      const s = scope(usageRule(15));
      await evaluate(deps(T0, read(5, { at: T0 }), s));
      expect(active()).toBe(true);
      await evaluate(deps(T0 + 60 * MIN, make(T0 + 60 * MIN), s));
      expect(active()).toBe(true);
      expect(ruleStates(s)[0]!.holding).toContain(said);
      expect(ruleStates(s)[0]!.holding.startsWith("holding:")).toBe(true);
    });
    test(`${name}: an inactive rule stays inactive`, async () => {
      const s = scope(usageRule(15));
      await evaluate(deps(T0, read(90, { at: T0 }), s));
      await evaluate(deps(T0 + 60 * MIN, make(T0 + 60 * MIN), s));
      expect(active()).toBe(false);
    });
  }

  test("a fresh reading clears the holding", async () => {
    const s = scope(usageRule(15));
    await evaluate(deps(T0, read(5, { at: T0 }), s));
    await evaluate(deps(T0 + 60 * MIN, null, s));
    expect(ruleStates(s)[0]!.holding).not.toBe("");
    await evaluate(deps(T0 + 61 * MIN, read(5, { at: T0 + 61 * MIN }), s));
    expect(ruleStates(s)[0]!.holding).toBe("");
  });

  test("the weekly window is trusted for 6 h, the 5 h one for 30 min", () => {
    expect(STALE_MS["5h"]).toBe(30 * MIN);
    expect(STALE_MS.weekly).toBe(6 * 60 * MIN);
  });
  test("a weekly reading 3 h old still counts", async () => {
    const s = scope(usageRule(15, "weekly"));
    await evaluate(deps(T0, read(50, { at: T0 - 180 * MIN, weekly: 10 }), s));
    expect(ruleStates(s)[0]!.active).toBe(true);
  });
});

describe("hours", () => {
  const h = (days: number[], from: string, to: string) => ({ kind: "hours" as const, days, from, to });
  const at = (iso: string) => Date.parse(iso);

  test("a window across midnight belongs to the day it starts on", () => {
    const t = h([5], "22:00", "06:00"); // Friday night
    expect(hoursOn(t, at("2026-10-09T23:00:00Z"), "UTC")).toBe(true);   // Fri 23:00
    expect(hoursOn(t, at("2026-10-10T03:00:00Z"), "UTC")).toBe(true);   // Sat 03:00, still Friday's
    expect(hoursOn(t, at("2026-10-10T06:00:00Z"), "UTC")).toBe(false);  // Sat 06:00, ended
    expect(hoursOn(t, at("2026-10-10T23:00:00Z"), "UTC")).toBe(false);  // Sat 23:00, Saturday is not listed
    expect(hoursOn(t, at("2026-10-09T21:59:00Z"), "UTC")).toBe(false);
  });

  test("a clock change in a fixed zone: Sunday 01:00 to 04:00 on the night New York skips an hour", () => {
    const t = h([0], "01:00", "04:00");
    const ny = "America/New_York";
    expect(hoursOn(t, at("2026-03-08T05:59:00Z"), ny)).toBe(false); // 00:59 EST
    expect(hoursOn(t, at("2026-03-08T06:00:00Z"), ny)).toBe(true);  // 01:00 EST
    expect(hoursOn(t, at("2026-03-08T07:30:00Z"), ny)).toBe(true);  // 03:30 EDT, after the skip
    expect(hoursOn(t, at("2026-03-08T07:59:00Z"), ny)).toBe(true);  // 03:59 EDT
    expect(hoursOn(t, at("2026-03-08T08:00:00Z"), ny)).toBe(false); // 04:00 EDT: only two real hours
    // The edges are found in real time, not by adding 24 h.
    expect(nextHoursEdge(t, at("2026-03-08T05:00:00Z"), ny)).toBe(at("2026-03-08T06:00:00Z"));
    expect(nextHoursEdge(t, at("2026-03-08T06:30:00Z"), ny)).toBe(at("2026-03-08T08:00:00Z"));
  });

  test("the end of summer time too: the repeated hour is on once, in real time", () => {
    const t = h([0], "00:30", "03:00");
    const ny = "America/New_York";
    expect(hoursOn(t, at("2026-11-01T04:30:00Z"), ny)).toBe(true);  // 00:30 EDT
    expect(hoursOn(t, at("2026-11-01T06:30:00Z"), ny)).toBe(true);  // 01:30 EST (the second 01:30)
    expect(hoursOn(t, at("2026-11-01T07:59:00Z"), ny)).toBe(true);  // 02:59 EST
    expect(hoursOn(t, at("2026-11-01T08:00:00Z"), ny)).toBe(false); // 03:00 EST
    expect(nextHoursEdge(t, at("2026-11-01T06:30:00Z"), ny)).toBe(at("2026-11-01T08:00:00Z"));
  });

  test("a rule flips at its edge and a wake-up is armed for the next one", async () => {
    const s = scope(rule("w", [h([0, 1, 2, 3, 4, 5, 6], "09:00", "17:00")]));
    await evaluate(deps(at("2026-10-12T08:59:00Z"), null, s));
    expect(ruleStates(s)[0]!.active).toBe(false);
    expect(armedWakeups().map((w) => w.at)).toEqual([at("2026-10-12T09:00:00Z")]);
    await evaluate(deps(at("2026-10-12T09:00:00Z"), null, s));
    expect(ruleStates(s)[0]!.active).toBe(true);
    expect(armedWakeups().map((w) => w.at)).toEqual([at("2026-10-12T17:00:00Z")]);
  });
});

describe("budget and always", () => {
  test("budget follows the status, and a project scope asks about its own root", async () => {
    const asked: (string | undefined)[] = [];
    let over = false;
    const s: ScopeRules[] = [{ scope: "/work/orbit", label: "orbit", root: "/work/orbit", rules: [rule("b", [{ kind: "budget" }])] }];
    const d = (now: number) => deps(now, null, s, { budgetOver: (root) => { asked.push(root); return over; } });
    await evaluate(d(T0));
    expect(ruleStates(s)[0]!.active).toBe(false);
    over = true;
    await evaluate(d(T0 + MIN));
    expect(ruleStates(s)[0]!.active).toBe(true);
    expect(asked.every((r) => r === "/work/orbit")).toBe(true);
  });

  test("a rule that says always is on at once, and a disabled one never is", async () => {
    const s = scope(rule("a", [{ kind: "always" }]), rule("d", [{ kind: "always" }], { enabled: false }));
    await evaluate(deps(T0, null, s));
    const st = ruleStates(s);
    expect(st.find((r) => r.ruleId === "a")!.active).toBe(true);
    expect(st.find((r) => r.ruleId === "d")!.active).toBe(false);
  });

  test("all triggers have to hold", async () => {
    const s = scope(rule("both", [{ kind: "always" }, { kind: "usage", provider: "anthropic", window: "5h", remainingAtMost: 15 }]));
    await evaluate(deps(T0, read(50, { at: T0 }), s));
    expect(ruleStates(s)[0]!.active).toBe(false);
    await evaluate(deps(T0 + MIN, read(10, { at: T0 + MIN }), s));
    expect(ruleStates(s)[0]!.active).toBe(true);
  });
});

describe("one flip, one row", () => {
  test("on and off each write exactly one actions row, and a repeat writes none", async () => {
    const s = scope(usageRule(15));
    await evaluate(deps(T0, read(10, { at: T0 }), s));
    await evaluate(deps(T0 + MIN, read(10, { at: T0 + MIN }), s));
    expect(actions().map((a) => a.action)).toEqual(["policy/on"]);
    await evaluate(deps(T0 + 2 * MIN, read(60, { at: T0 + 2 * MIN }), s));
    await evaluate(deps(T0 + 3 * MIN, read(61, { at: T0 + 3 * MIN }), s));
    expect(actions().map((a) => a.action)).toEqual(["policy/on", "policy/off"]);
    expect(actions()[0]!.target).toBe("Rule u");
    expect(actions()[0]!.detail).toContain("Claude 10% left");
  });

  test("a rule removed while on turns off with its own row", async () => {
    await evaluate(deps(T0, read(10, { at: T0 }), scope(usageRule(15))));
    const r = await evaluate(deps(T0 + MIN, null, scope()));
    expect(r.flips.map((f) => f.on)).toEqual([false]);
    expect(actions().map((a) => a.action)).toEqual(["policy/on", "policy/off"]);
    expect(armedWakeups()).toEqual([]);
  });
});

describe("restart", () => {
  test("the switch survives, and the wake-up at resetsAt is armed again", async () => {
    const s = scope(usageRule(15));
    await evaluate(deps(T0, read(10, { at: T0, reset: "2026-10-10T13:00:00Z" }), s));
    expect(armedWakeups()).toEqual([{ key: "global\u0000u", at: Date.parse("2026-10-10T13:00:00Z") + 1000 }]);
    __forgetWakeups(); wakes = [];                       // the process dies and comes back
    expect(armedWakeups()).toEqual([]);
    // First settle after boot: nothing fresh to read, so nothing may change.
    await evaluate(deps(T0 + 5 * MIN, null, s));
    expect(ruleStates(s)[0]!.active).toBe(true);
    expect(actions().map((a) => a.action)).toEqual(["policy/on"]);
  });

  test("the wake-up at resetsAt runs the evaluation, and the new window turns the rule off", async () => {
    const s = scope(usageRule(15));
    await evaluate(deps(T0, read(10, { at: T0, reset: "2026-10-10T13:00:00Z" }), s));
    expect(wakes).toHaveLength(1);
    const later = Date.parse("2026-10-10T13:00:01Z");
    // The timer's own evaluation reads the held state; hand it the new window.
    wakes[0]!.fn();
    await evaluate(deps(later, read(100, { at: later, reset: "2026-10-10T18:00:00Z" }), s));
    expect(ruleStates(s)[0]!.active).toBe(false);
  });
});

describe("nothing here asks anybody for anything", () => {
  test("not one outgoing request while rules are evaluated, however many readings arrive", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = ((...a: Parameters<typeof fetch>) => { calls++; return realFetch(...a); }) as typeof fetch;
    try {
      const s = scope(usageRule(15), rule("l", [{ kind: "limit", provider: "codex" }]), rule("b", [{ kind: "budget" }]));
      for (let i = 0; i < 25; i++) await evaluate(deps(T0 + i * MIN, read(i % 2 ? 10 : 90, { at: T0 + i * MIN }), s));
      expect(calls).toBe(0);
    } finally { globalThis.fetch = realFetch; }
  });

  test("the module never sets an interval, and never fetches", async () => {
    const src = (await Bun.file(new URL("../src/orchpolicy.ts", import.meta.url).pathname).text())
      .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    expect(src).not.toContain("setInterval");
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toContain("getUsage(");
    expect(src).not.toContain("allProviderUsage(");
  });
});
