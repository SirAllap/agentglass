/*
 * Polaris without a server: the fourteen reasons in their order, the presets,
 * how stored settings are read, and which way each door setting narrows.
 */
import { describe, expect, test } from "bun:test";
import {
  ALSO_NEVER, CLASSES, DOOR_IDS, DOOR_MODES, GUARDRAILS, PRESETS, REASONS, REASON_CLASS, canRelaunch, checkDoor, classifyPr, defaultPolaris,
  doorNarrows, droppedJob, normalizePolaris, raisesToLive, resolvePolaris, safeDoor, validateStoredPolaris, withEnabled, withDoor, withPreset,
  type ClassifyOptions, type PolarisCheck, type PrFacts,
} from "../../shared/polaris.ts";

const ok = (name: string, required = true): PolarisCheck => ({ name, state: "success", required });
const red = (name: string, required = true, job?: PolarisCheck["job"]): PolarisCheck => ({ name, state: "failure", required, ...(job ? { job } : {}) });
const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  state: "OPEN", draft: false, excluded: false, labels: [], base: "main", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED", approvals: [{ isBot: false }], checks: [ok("build"), ok("test")], requiredNames: [], changedFiles: ["src/a.ts"], labelRules: [], ...over,
});
const dropped = { conclusion: "failure", stepConclusions: [null, null] };

/* One pull request per reason, each built so that every earlier reason is false. */
const BY_REASON: Record<string, [Partial<PrFacts>, ClassifyOptions?]> = {
  paused: [{ draft: true }],
  unknown: [{ mergeable: "UNKNOWN" }],
  conflict: [{ mergeable: "CONFLICTING" }],
  labels: [{ labelRules: [{ base: "main", paths: ["src/"], label: "fast-evals" }] }],
  inherited: [{ checks: [ok("build"), { ...red("test"), inherited: true }] }],
  failing: [{ checks: [ok("build"), red("test")] }],
  waiting: [{ checks: [ok("build"), { name: "test", state: "pending", required: true }] }],
  runner: [{ checks: [ok("build"), red("test", true, dropped)] }],
  behind: [{ mergeStateStatus: "BEHIND" }],
  changes: [{ reviewDecision: "CHANGES_REQUESTED" }],
  review: [{ reviewDecision: "REVIEW_REQUIRED", approvals: [] }],
  github: [{ mergeStateStatus: "BLOCKED" }],
  redsNamed: [{ checks: [ok("build"), red("lint", false)] }],
  ready: [{}],
};

describe("classifyPr: the fourteen reasons", () => {
  test("the table covers every reason, in the order they are asked", () => {
    expect(Object.keys(BY_REASON)).toEqual([...REASONS]);
    expect(REASONS).toHaveLength(14);
  });

  for (const r of REASONS) {
    test(`${r}: ${REASON_CLASS[r]}`, () => {
      const [over, opts] = BY_REASON[r]!;
      const v = classifyPr(facts(over), opts);
      expect(v).toMatchObject({ reason: r, cls: REASON_CLASS[r] });
      expect(v.sentence.length).toBeGreaterThan(5);
    });
  }

  test("the first match wins: each reason loses to the one before it", () => {
    let all: Partial<PrFacts> = {};
    for (const r of [...REASONS].reverse()) {
      all = { ...all, ...BY_REASON[r]![0] };
      expect(classifyPr(facts(all)).reason).toBe(r);
    }
  });

  test("inherited needs every red to be the base's: one of its own reds reads as failing", () => {
    const base = { ...red("test"), inherited: true };
    expect(classifyPr(facts({ checks: [ok("build"), base] }))).toMatchObject({ cls: "Needs you", reason: "inherited", names: ["test"] });
    expect(classifyPr(facts({ checks: [ok("build"), base, red("lint")] }))).toMatchObject({ reason: "failing" });
    // A dropped job is the runner's, never the base's, even if something marked it.
    expect(classifyPr(facts({ checks: [ok("build"), { ...red("test", true, dropped), inherited: true }] })).reason).toBe("runner");
  });

  test("the classes are the seven, and every reason maps into them", () => {
    expect(CLASSES).toHaveLength(7);
    for (const r of REASONS) expect(CLASSES).toContain(REASON_CLASS[r]);
  });

  test("landed is checked before the fourteen", () => {
    expect(classifyPr(facts({ state: "MERGED", draft: true, mergeable: "CONFLICTING" }))).toMatchObject({ cls: "Landed", reason: null });
    expect(classifyPr(facts({ state: "CLOSED" }))).toMatchObject({ cls: "Landed", reason: null });
  });

  test("paused by a number, by the label, and by a draft", () => {
    expect(classifyPr(facts({ excluded: true })).reason).toBe("paused");
    expect(classifyPr(facts({ labels: ["docked"] })).reason).toBe("paused");
    expect(classifyPr(facts({ labels: ["parked"] }), { dockLabel: "parked" }).reason).toBe("paused");
  });

  test("a missing label is named, and a rule for another base or other files does not apply", () => {
    const rule = { base: "main", paths: ["test/"], label: "fast-evals" };
    expect(classifyPr(facts({ labelRules: [rule], changedFiles: ["test/x.ts"] }))).toMatchObject({ reason: "labels", names: ["fast-evals"] });
    expect(classifyPr(facts({ labelRules: [rule], changedFiles: ["src/x.ts"] })).reason).toBe("ready");
    expect(classifyPr(facts({ labelRules: [{ ...rule, base: "release" }], changedFiles: ["test/x.ts"] })).reason).toBe("ready");
    expect(classifyPr(facts({ labelRules: [rule], changedFiles: ["test/x.ts"], labels: ["fast-evals"] })).reason).toBe("ready");
  });

  test("an optional red is split from the required ones only when every required check is ok", () => {
    // required ok, optional red: named, never blocking
    expect(classifyPr(facts({ checks: [ok("build"), red("lint", false)] })).reason).toBe("redsNamed");
    // a required check is still running: the optional red is not set aside
    expect(classifyPr(facts({ checks: [{ name: "build", state: "pending", required: true }, red("lint", false)] })).reason).toBe("failing");
    // nothing says what is required: any red fails
    expect(classifyPr(facts({ checks: [red("lint", undefined as never)] })).reason).toBe("failing");
    // the person chose to treat them as blocking
    expect(classifyPr(facts({ checks: [ok("build"), red("lint", false)] }), { redsNamed: "block" }).reason).toBe("failing");
    // required by name from branch protection
    expect(classifyPr(facts({ checks: [ok("build"), red("lint", false)], requiredNames: ["lint"] })).reason).toBe("failing");
  });

  test("a bot's approval is not a review when approvals are people only", () => {
    const botOnly = facts({ approvals: [{ isBot: true }] });
    expect(classifyPr(botOnly, { approvals: "people" })).toMatchObject({ reason: "review", sentence: "Only a bot reviewed." });
    expect(classifyPr(botOnly, { approvals: "any" }).reason).toBe("ready");
    expect(classifyPr(facts({ approvals: [{ isBot: true }, { isBot: false }] }), { approvals: "people" }).reason).toBe("ready");
  });

  test("runner trouble is a failure with no step conclusion, never a cancelled job", () => {
    expect(droppedJob(dropped)).toBe(true);
    expect(droppedJob({ conclusion: "failure", stepConclusions: [] })).toBe(true);
    expect(droppedJob({ conclusion: "failure", stepConclusions: ["success", null] })).toBe(false);
    expect(droppedJob({ conclusion: "cancelled", stepConclusions: [null] })).toBe(false);
    expect(classifyPr(facts({ checks: [ok("build"), red("test", true, { conclusion: "failure", stepConclusions: ["failure"] })] })).reason).toBe("failing");
  });

  test("waiting is asked before runner trouble", () => {
    const v = classifyPr(facts({ checks: [{ name: "a", state: "pending", required: true }, red("b", true, dropped)] }));
    expect(v.reason).toBe("waiting");
  });
});

describe("relaunch: the cap is the total attempts, counted per run", () => {
  test("below the cap and nothing running", () => {
    expect(canRelaunch({ attempt: 1, pending: false })).toBe(true);
    expect(canRelaunch({ attempt: 2, pending: false })).toBe(true);
    expect(canRelaunch({ attempt: 3, pending: false })).toBe(false);
    expect(canRelaunch({ attempt: 1, pending: true })).toBe(false);
    expect(canRelaunch({ attempt: 1, pending: false }, 1)).toBe(false);
    expect(canRelaunch({ attempt: 2, pending: false }, 9)).toBe(true);
  });
});

describe("presets", () => {
  const modes = (p: keyof typeof PRESETS) => Object.fromEntries(DOOR_IDS.map((d) => [d, PRESETS[p].doors[d].mode]));

  test("Watch only", () => {
    expect(modes("watchOnly")).toEqual({
      follow: "on", dock: "on", cards: "off", cleared: "quiet", labels: "on", approvals: "people", redsNamed: "name", signals: "off", diagnose: "off",
      relaunch: "off", rerunButton: "off", beacon: "off", match: "use", course: "off", cleanup: "off", startSession: "off", lookAgain: "on",
    });
    expect(PRESETS.watchOnly.doors.lookAgain).toMatchObject({ minutes: 30, steps: 1 });
  });

  test("Guided is Watch only plus the drafting doors, relaunch as a dry run", () => {
    expect(modes("guided")).toEqual({ ...modes("watchOnly"), signals: "on", diagnose: "click", relaunch: "dry", rerunButton: "button", beacon: "draft", course: "hours", cleanup: "propose" });
    expect(PRESETS.guided.doors.relaunch.cap).toBe(3);
    expect(PRESETS.guided.doors.course.hours).toBe(24);
    expect(PRESETS.guided.doors.lookAgain.minutes).toBe(15);
  });

  test("Full autopilot is Guided plus the live doors", () => {
    expect(modes("fullAutopilot")).toEqual({ ...modes("guided"), cards: "on", diagnose: "auto", relaunch: "live", startSession: "click" });
    const d = PRESETS.fullAutopilot.doors;
    expect([d.cards.size, d.relaunch.cap, d.course.hours, d.startSession.tries, d.lookAgain.minutes, d.lookAgain.steps]).toEqual([2, 3, 4, 3, 5, 5]);
  });

  test("every preset door is a valid door", () => {
    for (const p of Object.values(PRESETS)) for (const d of DOOR_IDS) expect(checkDoor(d, p.doors[d])).toEqual({ value: p.doors[d] });
  });

  test("a door nobody set starts in its safe position, off or a dry run, never live", () => {
    for (const d of DOOR_IDS) expect(safeDoor(d).mode).toBe(DOOR_MODES[d][0]);
    expect(defaultPolaris()).toMatchObject({ enabled: false, preset: "none" });
  });
});

describe("stored settings are read, not trusted", () => {
  test("a missing key reads its default, an unknown key is kept, an unusable value falls back", () => {
    const n = normalizePolaris({ extra: 1, doors: { relaunch: { mode: "live", cap: 9, note: "x" }, dock: { mode: "bogus" }, future: { mode: "x" } } });
    expect(n.extra).toBe(1);
    expect(n.doors.relaunch).toMatchObject({ mode: "live", cap: 3, note: "x" });
    expect(n.doors.dock).toEqual(safeDoor("dock"));
    expect((n.doors as Record<string, unknown>).future).toEqual({ mode: "x" });
    expect(n.doors.follow).toEqual(safeDoor("follow"));
    expect(n.enabled).toBe(false);
  });

  test("a newer version is read and its number kept", () => {
    expect(normalizePolaris({ version: 7, enabled: true, doors: {} })).toMatchObject({ version: 7, enabled: true });
    expect(normalizePolaris(null).version).toBe(1);
    expect(normalizePolaris("junk").doors.follow.mode).toBe("off");
  });

  test("validate names the field it refuses and lets unknown keys through", () => {
    expect(validateStoredPolaris({ doors: { relaunch: { mode: "sometimes" } } })).toEqual({ ok: false, error: `relaunch.mode: one of ${DOOR_MODES.relaunch.join(", ")}` });
    expect(validateStoredPolaris({ doors: { relaunch: { mode: "dry", cap: 4 } } })).toEqual({ ok: false, error: "relaunch.cap: not a valid value" });
    expect(validateStoredPolaris({ enabled: "yes" })).toMatchObject({ ok: false });
    expect(validateStoredPolaris({ preset: "turbo" })).toMatchObject({ ok: false });
    expect(validateStoredPolaris({ newer: { a: 1 }, enabled: true })).toMatchObject({ ok: true, value: { newer: { a: 1 } } });
  });

  test("the project's door wins, then the global one, then the default", () => {
    const g = { enabled: true, preset: "guided", doors: { relaunch: { mode: "dry", cap: 3 }, beacon: { mode: "draft" } } };
    const p = { doors: { relaunch: { mode: "off", cap: 3 } } };
    const r = resolvePolaris(g, p);
    expect(r.layers).toMatchObject({ relaunch: "project", beacon: "global", follow: "default" });
    expect(r.settings.doors.relaunch.mode).toBe("off");
    expect(r.settings.doors.beacon.mode).toBe("draft");
    expect(r.enabledLayer).toBe("global");
    expect(r.settings.enabled).toBe(true);
    expect(resolvePolaris(g, { enabled: false }).settings.enabled).toBe(false);
  });

  test("a preset overwrites all seventeen doors; one door changed stores custom; enabling writes Guided only when nothing is stored", () => {
    const full = withPreset({ doors: { follow: { mode: "off" } } }, "fullAutopilot");
    expect(full.preset).toBe("fullAutopilot");
    expect(Object.keys(full.doors!)).toHaveLength(17);
    expect(withDoor(full, "relaunch", { mode: "dry", cap: 3 })).toMatchObject({ preset: "custom" });
    expect(withEnabled(null, true)).toMatchObject({ enabled: true, preset: "guided" });
    expect(withEnabled({ preset: "custom", doors: { follow: { mode: "on" } } }, true)).toEqual({ preset: "custom", doors: { follow: { mode: "on" } }, enabled: true });
    expect(withEnabled(withPreset(null, "guided"), false)).toMatchObject({ enabled: false, preset: "guided" });
  });
});

describe("which way a door setting narrows", () => {
  const relaunch = (mode: string, cap = 3) => ({ mode, cap });
  test("a lower mode narrows, a higher one does not", () => {
    expect(doorNarrows("relaunch", relaunch("live"), relaunch("dry"))).toBe(true);
    expect(doorNarrows("relaunch", relaunch("dry"), relaunch("off"))).toBe(true);
    expect(doorNarrows("relaunch", relaunch("dry"), relaunch("live"))).toBe(false);
    expect(doorNarrows("approvals", { mode: "any" }, { mode: "people" })).toBe(true);
    expect(doorNarrows("redsNamed", { mode: "name" }, { mode: "block" })).toBe(true);
    expect(doorNarrows("relaunch", relaunch("dry"), relaunch("dry"))).toBe(false);
  });
  test("the same mode narrows when every changed setting moved its narrower way", () => {
    expect(doorNarrows("relaunch", relaunch("dry", 3), relaunch("dry", 1))).toBe(true);
    expect(doorNarrows("relaunch", relaunch("dry", 1), relaunch("dry", 3))).toBe(false);
    expect(doorNarrows("course", { mode: "hours", hours: 4 }, { mode: "hours", hours: 48 })).toBe(true);
    expect(doorNarrows("lookAgain", { mode: "on", minutes: 5, steps: 5 }, { mode: "on", minutes: 30, steps: 1 })).toBe(true);
    expect(doorNarrows("lookAgain", { mode: "on", minutes: 5, steps: 1 }, { mode: "on", minutes: 30, steps: 3 })).toBe(false);
  });
  test("a lower mode with one setting moved the wide way is the widest class, not a narrowing", () => {
    expect(doorNarrows("cards", { mode: "on", size: 2 }, { mode: "off", size: 4 })).toBe(false);
  });
  test("a setting with no direction is never a narrowing", () => {
    expect(doorNarrows("dock", { mode: "on", excluded: [] }, { mode: "on", excluded: [3] })).toBe(false);
  });
  test("a live position that is not a step back is only the person's", () => {
    expect(raisesToLive("relaunch", relaunch("dry"), relaunch("live"))).toBe(true);
    expect(raisesToLive("relaunch", relaunch("live", 3), relaunch("live", 1))).toBe(false);
    expect(raisesToLive("diagnose", { mode: "click" }, { mode: "auto" })).toBe(true);
    expect(raisesToLive("startSession", { mode: "off" }, { mode: "click" })).toBe(true);
    expect(raisesToLive("cards", { mode: "off" }, { mode: "on" })).toBe(true);
    expect(raisesToLive("follow", { mode: "off" }, { mode: "on" })).toBe(false);
  });
});

describe("guardrails", () => {
  test("four locked lines and the eight also-never", () => {
    expect(GUARDRAILS).toHaveLength(4);
    expect(GUARDRAILS[0]!.title).toBe("Polaris never merges");
    expect(ALSO_NEVER).toHaveLength(8);
  });
});
