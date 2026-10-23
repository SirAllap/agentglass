/*
 * The "Right now" picture and the engine tiles, held without a renderer: what
 * each job runs on at this moment, why, and how a tile reads. Engine names come
 * from the provider table; the cases name engines by id.
 */
import { describe, expect, test } from "bun:test";
import { agentProvider } from "../../shared/agentKinds.ts";
import { CHAIN_MAX, composePolicy, defaultStored, type Policy, type PolicyRule, type Trigger } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import { becauseWords, chainAddFrom, clockPct, clockSegments, engineTileState, flowBecause, flowNodes, leftFromReading, meterGeometry, nowPct, pickEngine, pickModel, pickUndoable, roleWord, rulesHoldNow, testDraft, testItNow, triggerHolds, usageLeft, withBaseChoice } from "../src/components/orchestration/orchestrationCopy.ts";

const title = (id: string) => agentProvider(id)!.title;
const engine = (id: string, over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id, title: title(id), found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
  ...over,
});
const NO = (why: string) => ({ worker: { ok: false, why }, orchestrator: { ok: false, why } });
const READY = [engine("claude"), engine("opencode"), engine("hermes", { found: false, roles: NO("Hermes is not installed.") })];

const policy = (rules: PolicyRule[] = []): Policy => ({
  ...composePolicy(defaultStored(), {
    orchestrator: { engine: "claude", model: "sonnet" },
    workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
  }),
  rules,
});
const thin: PolicyRule = {
  id: "thin-week", name: "Thin week", enabled: true,
  when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 10 }],
  workers: { builder: [{ engine: "opencode", model: "big-pickle" }] },
};
const holds = (on: string[]) => ({ on: (id: string) => on.includes(id) });

describe("role words", () => {
  test("the chair is the main agent; workers keep their plural", () => {
    expect(roleWord("orchestrator")).toBe("main agent");
    expect(roleWord("builder")).toBe("builders");
  });
});

describe("the flow picture", () => {
  test("the default: every job on its base choice, 'no rule is on'", () => {
    const nodes = flowNodes(policy([thin]), holds([]), READY);
    expect(nodes.map((n) => n.field)).toEqual(["orchestrator", "scout", "builder", "reviewer", "verifier"]);
    expect(nodes[0]!.sentence).toBe(`The main agent is ${title("claude")} sonnet: no rule is on.`);
    expect(nodes[2]!.chain).toEqual([{ engine: "claude", model: "sonnet" }]);
  });

  test("a rule that holds names itself, and only the jobs it names move", () => {
    const nodes = flowNodes(policy([thin]), holds(["thin-week"]), READY);
    expect(nodes.find((n) => n.field === "builder")!.sentence).toBe(`The builders use ${title("opencode")} big-pickle: Thin week is on.`);
    expect(nodes.find((n) => n.field === "builder")!.chain).toEqual([{ engine: "opencode", model: "big-pickle" }]);
    expect(nodes.find((n) => n.field === "scout")!.because).toBe("no rule is on");
  });

  test("a chain with nothing ready says so and keeps the chain it tried", () => {
    const dead = policy([{ ...thin, workers: { builder: [{ engine: "hermes", model: "" }] } }]);
    const b = flowNodes(dead, holds(["thin-week"]), READY).find((n) => n.field === "builder")!;
    expect(b.ok).toBe(false);
    expect(b.sentence.startsWith("The builders cannot start: no engine in the chain is ready")).toBe(true);
    expect(b.chain).toEqual([{ engine: "hermes", model: "" }]);
  });

  test("becauseWords: a rule by name, or no rule", () => {
    expect(becauseWords({ ok: true, choice: { engine: "claude", model: "" }, from: "rule", ruleId: "x", ruleName: "Night shift", position: 0, ask: false, because: [] })).toBe("Night shift is on");
    expect(becauseWords({ ok: false, why: "x", from: "base", because: [] })).toBe("no rule is on");
  });
});

describe("test it now", () => {
  test("one sentence per job, from the draft policy and this machine", () => {
    const out = testItNow(policy([thin]), holds(["thin-week"]), READY);
    expect(out).toHaveLength(5);
    expect(out[2]).toContain("big-pickle");
  });
  test("before the machine is checked it says so and runs nothing", () => {
    expect(testItNow(policy(), holds([]), null)).toEqual(["This machine has not been checked yet."]);
  });
});

describe("engine tiles", () => {
  test("ready, with a word and not colour alone", () => {
    expect(engineTileState("claude", "worker", READY, false)).toMatchObject({ tone: "ok", word: "Ready" });
  });
  test("not installed carries the probe's reason", () => {
    const t = engineTileState("hermes", "worker", READY, false);
    expect(t).toMatchObject({ tone: "err", word: "Not installed", reason: "Hermes is not installed." });
  });
  test("a limit hit warns but does not disable", () => {
    expect(engineTileState("claude", "worker", READY, true)).toMatchObject({ tone: "warn", word: "Limit hit" });
  });
  test("unchecked and checking are never 'ready'", () => {
    expect(engineTileState("claude", "worker", null, false).word).toBe("Checking");
    expect(engineTileState("qwen", "worker", READY, false)).toMatchObject({ tone: "err", word: "Unchecked" });
  });
});

describe("the because line", () => {
  const line = (rules: PolicyRule[], on: string[], p = policy(rules)) => flowBecause(flowNodes(p, holds(on), READY), p);
  test("default: no rule is on", () => {
    expect(line([thin], [])).toBe("Because no rule is on: every job uses its own setting.");
  });
  test("a rule of the person's names itself, and says the other jobs keep their setting", () => {
    expect(line([thin], ["thin-week"])).toBe("Because \u201cThin week\u201d is on. The other jobs use their own setting.");
  });
  test("a ready-made setup is called that, without its Quick setup prefix", () => {
    const preset: PolicyRule = { ...thin, id: "preset-all-on-claude", name: "Quick setup: all workers on Claude Code", when: [{ kind: "always" }], workers: { scout: [{ engine: "claude", model: "" }], builder: [{ engine: "claude", model: "" }], verifier: [{ engine: "claude", model: "" }] } };
    expect(line([preset], ["preset-all-on-claude"])).toBe("Because of the ready-made setup \u201call workers on Claude Code\u201d. The other jobs use their own setting.");
  });
});

describe("tile picks", () => {
  const opts = [{ value: "claude", label: "Claude Code" }, { value: "hermes", label: "Hermes", disabled: true, hint: "Needs an update." }, { value: "opencode", label: "OpenCode" }];
  const cur = { engine: "claude", model: "sonnet" };
  test.each([
    ["a ready engine: its default model", "opencode", { engine: "opencode", model: "" }],
    ["a disabled tile: nothing", "hermes", null],
    ["an unknown engine: nothing", "nope", null],
    ["the engine already in place: nothing", "claude", null],
  ] as const)("pickEngine: %s", (_n, engine, want) => {
    expect(pickEngine(opts, cur, engine)).toEqual(want);
  });
  test("pickModel keeps the engine and does nothing for the model already set", () => {
    expect(pickModel(cur, "opus")).toEqual({ engine: "claude", model: "opus" });
    expect(pickModel(cur, "sonnet")).toBeNull();
  });
  test("chainAddFrom adds a ready engine last, never a disabled one, never past the end", () => {
    expect(chainAddFrom([cur], opts, "opencode")).toEqual([cur, { engine: "opencode", model: "" }]);
    expect(chainAddFrom([cur], opts, "hermes")).toBeNull();
    const full = Array.from({ length: CHAIN_MAX }, () => cur);
    expect(chainAddFrom(full, opts, "opencode")).toBeNull();
  });
  test("Undo is offered only while the stored choice is the one the press made", () => {
    const p = withBaseChoice(policy(), "builder", { engine: "opencode", model: "" });
    expect(pickUndoable(p, { field: "builder", from: cur, to: { engine: "opencode", model: "" } })).toBe(true);
    expect(pickUndoable(p, { field: "builder", from: cur, to: { engine: "claude", model: "" } })).toBe(false);
  });
});

describe("the strips' geometry (percent of the strip's width)", () => {
  test.each([
    ["00:00", 0], ["06:00", 25], ["12:00", 50], ["22:00", 91.67], ["24:00", 100], ["junk", 0],
  ] as const)("clockPct %s", (t, want) => { expect(clockPct(t)).toBe(want); });
  test.each([
    ["a day window", "09:00", "17:00", [{ left: 37.5, width: 33.33 }]],
    ["across midnight: evening and morning", "22:00", "07:00", [{ left: 91.67, width: 8.33 }, { left: 0, width: 29.17 }]],
    ["ends at midnight: no morning piece", "20:00", "00:00", [{ left: 83.33, width: 16.67 }]],
    ["the same time twice: the whole day", "08:00", "08:00", [{ left: 0, width: 100 }]],
  ] as const)("clockSegments: %s", (_n, from, to, want) => { expect(clockSegments(from, to)).toEqual(want as never); });
  test("nowPct reads the clock's minutes", () => { expect(nowPct(new Date(2026, 9, 12, 18, 0))).toBe(75); });
  test.each([
    ["62 left, threshold 15", 62, 15, { fill: 62, mark: 15, holds: false }],
    ["8 left, threshold 15: holds", 8, 15, { fill: 8, mark: 15, holds: true }],
    ["no reading", null, 15, { fill: null, mark: 15, holds: null }],
    ["out of range clamps", 140, 120, { fill: 100, mark: 100, holds: true }],
  ] as const)("meterGeometry: %s", (_n, left, th, want) => { expect(meterGeometry(left, th)).toEqual(want); });
});

describe("a draft condition against the clock and the readings", () => {
  const night: Trigger = { kind: "hours", days: [1, 2, 3, 4, 5], from: "22:00", to: "07:00" };
  const monday = (h: number, m = 0) => new Date(2026, 9, 12, h, m);
  test.each([
    ["Mon 23:00 is inside", monday(23), true],
    ["Tue 06:00 is inside (Mon evening runs on)", new Date(2026, 9, 13, 6), true],
    ["Mon 12:00 is outside", monday(12), false],
    ["Sat 02:00 follows a Friday evening: inside", new Date(2026, 9, 17, 2), true],
    ["Sun 02:00 follows a Saturday not in the days: outside", new Date(2026, 9, 18, 2), false],
  ] as const)("hours %s", (_n, at, want) => { expect(triggerHolds(night, at, {})).toBe(want); });
  test("usage holds at or below the threshold, and is unknown without a reading", () => {
    const t = { kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 15 } as const;
    expect(triggerHolds(t, monday(1), { anthropic: 15 })).toBe(true);
    expect(triggerHolds(t, monday(1), { anthropic: 16 })).toBe(false);
    expect(triggerHolds(t, monday(1), {})).toBeNull();
  });
  test("a rule holds only when every condition does; one it cannot read makes it unknown", () => {
    const r = (when: PolicyRule["when"]): PolicyRule => ({ id: "d", name: "d", enabled: true, when });
    const u = { kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 15 } as const;
    expect(rulesHoldNow(r([night, u]), monday(23), { anthropic: 5 })).toBe(true);
    expect(rulesHoldNow(r([night, u]), monday(12), {})).toBe(false);
    expect(rulesHoldNow(r([night, u]), monday(23), {})).toBeNull();
  });
  test("readings become percent left per plan, the newest winning", () => {
    expect(leftFromReading("Claude 62% left")).toBe(62);
    expect(leftFromReading("nothing")).toBeNull();
    const st = (reading: string, readingAt: number) => ({ scope: "global", ruleId: reading, name: "", active: false, since: 0, reading, readingAt, holding: "" });
    expect(usageLeft([st("Claude 40% left", 1), st("Claude 30% left", 2), st("Codex 9% left", 1)], "global")).toEqual({ anthropic: 30, codex: 9 });
    expect(usageLeft([{ ...st("Claude 40% left", 1), scope: "/w/orbit" }], "global")).toEqual({});
  });
  test("Test it now puts the draft in force only when it holds, and says so", () => {
    const draft: PolicyRule = { id: "night", name: "Night", enabled: true, when: [night], workers: { builder: [{ engine: "opencode", model: "" }] } };
    const facts = { on: () => false };
    const inside = testDraft(policy(), draft, facts, monday(23), {}, READY);
    expect(inside.holds).toBe("This condition holds right now.");
    expect(inside.lines.join(" ")).toContain(`The builders use ${title("opencode")}: Night is on.`);
    const outside = testDraft(policy(), draft, facts, monday(12), {}, READY);
    expect(outside.holds).toContain("does not hold right now");
    expect(outside.lines.join(" ")).toContain(`The builders use ${title("claude")} sonnet: no rule is on.`);
    expect(testDraft(policy(), draft, facts, monday(12), {}, null).lines).toEqual(["This machine has not been checked yet."]);
  });
});
