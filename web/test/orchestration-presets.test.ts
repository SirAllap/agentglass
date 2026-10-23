/*
 * Quick setup and "Check my setup", held without a renderer: which preset is
 * offered on what a machine reports, the exact policy each one writes, how it
 * is undone, and what a dry run says. Engines are named by id and expected by
 * the provider table's title, so the copy cannot hold a name by hand.
 */
import { describe, expect, test } from "bun:test";
import { agentProvider } from "../../shared/agentKinds.ts";
import { CHAIN_MAX, composePolicy, defaultStored, validatePolicy, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import type { PolicyRuleState } from "../src/lib/api.ts";
import {
  BACK_LABEL, CHAIN_TAIL, PLAN_NEARLY_SPENT, PRESET_IDS, applyPreset, checkSetup, presetEngines, presetOffers, presetRuleId,
} from "../src/components/orchestration/orchestrationCopy.ts";

const title = (id: string) => agentProvider(id)!.title;
const engine = (id: string, over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id, title: title(id), found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
  ...over,
});
const no = (why: string) => ({ worker: { ok: false as const, why }, orchestrator: { ok: false as const, why } });
const OLD_HERMES = engine("hermes", { version: "0.21.0", min: "0.21.4", versionOk: false, roles: no("0.21.0 is older than 0.21.4.") });
const SIGNED_OUT = engine("claude", {
  account: { signedIn: false }, roles: no("Sign in first."),
  missing: [{ kind: "login", what: "Not signed in.", command: "claude login" }],
});
const GONE = (id: string) => engine(id, { found: false, path: null, version: null, roles: no("Not installed.") });

const OPENCODE_AND_CLAUDE = [engine("claude"), engine("opencode"), OLD_HERMES];
const policy = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const offer = (id: string, ready: EngineReadiness[] | null) => presetOffers(ready).find((o) => o.id === id)!;
const state = (over: Partial<PolicyRuleState> = {}): PolicyRuleState => ({
  scope: "global", ruleId: "x", name: "x", active: false, since: 0, reading: "", readingAt: 0, holding: "", ...over,
});

describe("which preset is offered", () => {
  // [what the machine reports, preset, blocked sentence or null]
  const CASES: [string, EngineReadiness[], string, string | null][] = [
    ["claude and opencode ready: orchestrates", OPENCODE_AND_CLAUDE, "claude-orchestrates", null],
    ["claude and opencode ready: all on claude", OPENCODE_AND_CLAUDE, "all-on-claude", null],
    ["claude and opencode ready: save my plan", OPENCODE_AND_CLAUDE, "save-my-plan", null],
    ["only claude ready: orchestrates needs another engine, and says which is old",
      [engine("claude"), OLD_HERMES], "claude-orchestrates", `Needs an engine besides ${title("claude")} that can work: ${title("hermes")} needs an update.`],
    ["only claude ready: save my plan needs the same",
      [engine("claude"), OLD_HERMES], "save-my-plan", `Needs an engine besides ${title("claude")} that can work: ${title("hermes")} needs an update.`],
    ["only claude ready: all on claude is fine", [engine("claude"), OLD_HERMES], "all-on-claude", null],
    ["claude signed out: orchestrates names it", [SIGNED_OUT, engine("opencode")], "claude-orchestrates", `${title("claude")} needs sign-in.`],
    ["claude signed out: all on claude names it", [SIGNED_OUT, engine("opencode")], "all-on-claude", `${title("claude")} needs sign-in.`],
    ["claude signed out: save my plan does not need it", [SIGNED_OUT, engine("opencode")], "save-my-plan", null],
    ["nothing else installed", [engine("claude"), GONE("opencode")], "claude-orchestrates", `Needs an engine besides ${title("claude")} that can work: ${title("opencode")} is not installed.`],
  ];
  test.each(CASES)("%s", (_n, ready, id, blocked) => expect(offer(id, ready).blocked).toBe(blocked));

  test("before the probe answers every preset is disabled and says so", () => {
    for (const o of presetOffers(null)) expect(o.blocked).toBe("Checking this machine.");
  });

  test("every engine a preset names reports ok for that role", () => {
    const ready = [engine("claude"), engine("opencode"), OLD_HERMES, engine("codex", { roles: { worker: { ok: true }, orchestrator: { ok: false, why: "x" } } }), GONE("qwen")];
    for (const id of PRESET_IDS) {
      const next = applyPreset(policy(), id, ready);
      expect(next).not.toBeNull();
      for (const r of next!.rules) {
        for (const chain of Object.values(r.workers ?? {})) {
          for (const c of chain) expect(ready.find((e) => e.id === c.engine)?.roles.worker.ok).toBe(true);
        }
      }
    }
  });

  test("a blocked preset applies nothing", () => {
    expect(applyPreset(policy(), "claude-orchestrates", [engine("claude"), OLD_HERMES])).toBeNull();
    expect(applyPreset(policy(), "claude-orchestrates", null)).toBeNull();
  });

  test("the others come in the stated order, Claude never among them, at most one chain's worth", () => {
    const all = ["claude", "antigravity", "hermes", "codex", "gemini", "opencode", "qwen"].map((id) => engine(id));
    const got = presetEngines(all);
    expect(got).not.toContain("claude");
    expect(got.length).toBe(CHAIN_MAX);
    expect(got).toEqual(["opencode", "hermes", "gemini", "codex"]);
    expect(presetEngines([engine("claude"), OLD_HERMES, engine("opencode")])).toEqual(["opencode"]);
  });
});

describe("what applying writes", () => {
  const ready = OPENCODE_AND_CLAUDE;
  const rulesOf = (id: Parameters<typeof applyPreset>[1]) => applyPreset(policy(), id, ready)!.rules;
  const oc = [{ engine: "opencode", model: "" }];

  test("orchestrates: one always rule, every role on the ready others; the base and the envelope are untouched", () => {
    const next = applyPreset(policy(), "claude-orchestrates", ready)!;
    expect(next.rules).toEqual([{
      id: presetRuleId("claude-orchestrates"), name: `Quick setup: ${title("claude")} orchestrates`, enabled: true,
      when: [{ kind: "always" }], workers: { scout: oc, builder: oc, reviewer: oc, verifier: oc },
    }]);
    expect({ ...next, rules: [] }).toEqual({ ...policy(), rules: [] });
  });

  test("all workers on claude: one always rule, every role on claude", () => {
    const c = [{ engine: "claude", model: "" }];
    expect(rulesOf("all-on-claude")).toEqual([{
      id: presetRuleId("all-on-claude"), name: `Quick setup: all workers on ${title("claude")}`, enabled: true,
      when: [{ kind: "always" }], workers: { scout: c, builder: c, reviewer: c, verifier: c },
    }]);
  });

  test("save my plan: when the weekly plan is nearly spent, builders move; nothing else is named", () => {
    expect(rulesOf("save-my-plan")).toEqual([{
      id: presetRuleId("save-my-plan"), name: `Quick setup: save my ${title("claude")} plan`, enabled: true,
      when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: PLAN_NEARLY_SPENT }],
      workers: { builder: oc },
    }]);
  });

  test("every policy it writes passes the server's schema", () => {
    for (const id of PRESET_IDS) {
      const v = validatePolicy(JSON.parse(JSON.stringify(applyPreset(policy(), id, ready))));
      expect(v.ok).toBe(true);
    }
  });

  test("the usage rule goes first, the always rule last, the person's own rules stay between, and a preset is never written twice", () => {
    const mine: PolicyRule = { id: "night", name: "Night", enabled: true, when: [{ kind: "hours", days: [1], from: "22:00", to: "06:00" }], workers: { scout: oc } };
    let p: Policy = { ...policy(), rules: [mine] };
    p = applyPreset(p, "claude-orchestrates", ready)!;
    p = applyPreset(p, "save-my-plan", ready)!;
    p = applyPreset(p, "save-my-plan", ready)!;
    expect(p.rules.map((r) => r.id)).toEqual([presetRuleId("save-my-plan"), "night", presetRuleId("claude-orchestrates")]);
  });

  test("the two always presets replace each other", () => {
    let p = applyPreset(policy(), "claude-orchestrates", ready)!;
    p = applyPreset(p, "all-on-claude", ready)!;
    expect(p.rules.map((r) => r.id)).toEqual([presetRuleId("all-on-claude")]);
  });

  test("it does not mutate what it was handed", () => {
    const before = JSON.stringify(policy());
    const p = policy();
    applyPreset(p, "claude-orchestrates", ready);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe("what a card says", () => {
  test("it says what it sets, in the sentence a rule has, and that the list ends in asking", () => {
    const o = offer("claude-orchestrates", OPENCODE_AND_CLAUDE);
    expect(o.says).toEqual([
      `The main agent stays ${title("claude")}.`,
      `When this always holds: scouts use ${title("opencode")}; builders use ${title("opencode")}; reviewers use ${title("opencode")}; verifiers use ${title("opencode")}. ${CHAIN_TAIL}`,
    ]);
    expect(offer("save-my-plan", OPENCODE_AND_CLAUDE).says).toEqual([
      `When ${PLAN_NEARLY_SPENT}% or less of the ${title("claude")} weekly plan is left: builders use ${title("opencode")}. ${CHAIN_TAIL}`,
      "Scouts and verifiers keep the engines they have.",
    ]);
  });
  test("the sentence under the card states what applying does and is not a question", () => {
    const o = offer("all-on-claude", OPENCODE_AND_CLAUDE);
    expect(o.confirm).toBe(`Adds one rule; nothing already running is moved. ${BACK_LABEL} puts the earlier setup back while nothing else has changed.`);
    expect(o.confirm).not.toContain("?");
  });
  test("every title comes from the table", () => {
    expect(PRESET_IDS.map((id) => offer(id, OPENCODE_AND_CLAUDE).title)).toEqual([
      `${title("claude")} orchestrates, others work`, `All workers on ${title("claude")}`, `Save my ${title("claude")} plan`,
    ]);
  });
});

describe("the chair claim", () => {
  const chairOn = (engine: string): Policy => ({ ...policy(), base: { ...policy().base, orchestrator: { ask: false, value: [{ engine, model: "" }] } } });
  const READY3 = [...OPENCODE_AND_CLAUDE, engine("codex")];
  test("the card says the chair stays only when the chair is that engine, and refuses with the reason when it is not", () => {
    expect(presetOffers(READY3, policy()).find((o) => o.id === "claude-orchestrates")!.says[0]).toBe(`The main agent stays ${title("claude")}.`);
    const o = presetOffers(READY3, chairOn("codex")).find((o) => o.id === "claude-orchestrates")!;
    expect(o.blocked).toBe(`The main agent is ${title("codex")}, not ${title("claude")}; change the main agent first.`);
    expect(applyPreset(chairOn("codex"), "claude-orchestrates", READY3)).toBeNull();
  });
  test("a rule of the person's that moves the chair refuses it too, and names the rule", () => {
    const moves = { id: "m", name: "Chair on Codex", enabled: true, when: [{ kind: "always" as const }], orchestrator: [{ engine: "codex", model: "" }] };
    const p: Policy = { ...policy(), rules: [moves] };
    expect(presetOffers(READY3, p).find((o) => o.id === "claude-orchestrates")!.blocked).toBe(`Rule "Chair on Codex" moves the main agent to ${title("codex")}; edit it first.`);
    expect(applyPreset(p, "claude-orchestrates", READY3)).toBeNull();
  });
  test("the other presets make no claim about the chair, so a chair on another engine does not stop them", () => {
    for (const id of ["all-on-claude", "save-my-plan"] as const) expect(applyPreset(chairOn("codex"), id, READY3)).not.toBeNull();
  });
  test("the dry run says when a preset that names Claude Code as the chair is not getting it", () => {
    const p = applyPreset(policy(), "claude-orchestrates", READY3)!;
    const moved: Policy = { ...p, base: { ...p.base, orchestrator: { ask: false, value: [{ engine: "codex", model: "" }] } } };
    const on = [state({ ruleId: presetRuleId("claude-orchestrates"), active: true })];
    expect(checkSetup(moved, on, READY3).rules[0]!.line).toContain(`${title("claude")} orchestrates, but the main agent would be ${title("codex")}`);
    expect(checkSetup(p, on, READY3).rules[0]!.line).not.toContain("but the chair");
  });
});

describe("Check my setup", () => {
  test("says who sits in the chair and which engine each role uses right now", () => {
    const p = policy();
    const c = checkSetup(p, [], OPENCODE_AND_CLAUDE);
    expect(c.chair).toBe(`${title("claude")} sonnet would run the main agent.`);
    expect(c.roles.map((r) => r.line)).toEqual([
      `Scouts would run on ${title("opencode")} opencode/big-pickle.`,
      `Builders would run on ${title("claude")} sonnet.`,
      `Reviewers would run on ${title("claude")} sonnet.`,
      `Verifiers would run on ${title("claude")} haiku.`,
    ]);
  });
  test("a rule that holds shows up as the reason, and an engine that is not ready is skipped with the reason", () => {
    const p = applyPreset({ ...policy(), base: { ...policy().base, workers: { ...policy().base.workers, builder: { value: [{ engine: "hermes", model: "" }], ask: false } } } }, "claude-orchestrates", OPENCODE_AND_CLAUDE)!;
    const c = checkSetup(p, [state({ ruleId: presetRuleId("claude-orchestrates"), active: true })], OPENCODE_AND_CLAUDE);
    expect(c.roles[1]!.line).toBe(`Builders would run on ${title("opencode")} opencode/big-pickle, from rule "Quick setup: ${title("claude")} orchestrates".`);
  });
  test("a chain with nothing ready says nobody and why", () => {
    const p: Policy = { ...policy(), base: { ...policy().base, workers: { ...policy().base.workers, builder: { value: [{ engine: "hermes", model: "" }], ask: false } } } };
    const c = checkSetup(p, [], OPENCODE_AND_CLAUDE);
    expect(c.roles[1]!.line).toBe(`Builders would have nobody: no engine in the chain is ready: skipped ${title("hermes")}: 0.21.0 is older than 0.21.4.`);
  });
  test("what would change if each rule held, one line per rule", () => {
    const p = applyPreset(policy(), "save-my-plan", OPENCODE_AND_CLAUDE)!;
    const c = checkSetup(p, [], OPENCODE_AND_CLAUDE);
    expect(c.rules).toEqual([{
      id: presetRuleId("save-my-plan"), name: `Quick setup: save my ${title("claude")} plan`,
      line: `If it held: builders would move from ${title("claude")} sonnet to ${title("opencode")}.`,
    }]);
  });
  test("a rule that already holds, one that is off, and one that changes nothing", () => {
    const base = applyPreset(policy(), "save-my-plan", OPENCODE_AND_CLAUDE)!;
    const id = presetRuleId("save-my-plan");
    expect(checkSetup(base, [state({ ruleId: id, active: true })], OPENCODE_AND_CLAUDE).rules[0]!.line).toBe("It holds now, so it is already in the answers above.");
    const off: Policy = { ...base, rules: base.rules.map((r) => ({ ...r, enabled: false })) };
    expect(checkSetup(off, [], OPENCODE_AND_CLAUDE).rules[0]!.line).toBe(`It is off. If it were on and held: builders would move from ${title("claude")} sonnet to ${title("opencode")}.`);
    const same: Policy = { ...policy(), rules: [{ id: "same", name: "Same", enabled: true, when: [{ kind: "always" }], workers: { scout: [{ engine: "opencode", model: "" }] } }] };
    expect(checkSetup(same, [], OPENCODE_AND_CLAUDE).rules[0]!.line).toBe("If it held: nothing would change.");
  });
  test("an earlier rule that wins a role is named, and the later rule is not reported as in effect", () => {
    const mine = { id: "mine", name: "Builders on Codex", enabled: true, when: [{ kind: "always" as const }], workers: { builder: [{ engine: "opencode", model: "" }] } };
    const p = applyPreset({ ...policy(), rules: [mine] }, "all-on-claude", OPENCODE_AND_CLAUDE)!;
    const on = [state({ ruleId: "mine", active: true }), state({ ruleId: presetRuleId("all-on-claude"), active: true })];
    const c = checkSetup(p, on, OPENCODE_AND_CLAUDE);
    expect(c.roles.find((r) => r.id === "builder")!.line).toContain('from rule "Builders on Codex"');
    const line = c.rules.find((r) => r.id === presetRuleId("all-on-claude"))!.line;
    expect(line).not.toContain("already in the answers above");
    expect(line).toBe('It holds now and applies to scouts, reviewers and verifiers; "Builders on Codex" comes first for builders.');
  });
  test("a role whose first choice cannot start says who takes over, in words", () => {
    const r = { id: "mine", name: "Hermes first", enabled: true, when: [{ kind: "always" as const }], workers: { builder: [{ engine: "hermes", model: "" }, { engine: "opencode", model: "" }] } };
    const c = checkSetup({ ...policy(), rules: [r] }, [state({ ruleId: "mine", active: true })], OPENCODE_AND_CLAUDE);
    const line = c.roles.find((x) => x.id === "builder")!.line;
    expect(line).toContain("opencode/big-pickle");
    expect(line).toContain(`because ${title("hermes")} needs an update, so it takes over`);
  });
  test("a rule that loses every field it names says it does not apply", () => {
    const first = { id: "first", name: "Everything on OpenCode", enabled: true, when: [{ kind: "always" as const }], workers: { scout: [{ engine: "opencode", model: "" }], builder: [{ engine: "opencode", model: "" }], reviewer: [{ engine: "opencode", model: "" }], verifier: [{ engine: "opencode", model: "" }] } };
    const p = applyPreset({ ...policy(), rules: [first] }, "all-on-claude", OPENCODE_AND_CLAUDE)!;
    const on = [state({ ruleId: "first", active: true }), state({ ruleId: presetRuleId("all-on-claude"), active: true })];
    expect(checkSetup(p, on, OPENCODE_AND_CLAUDE).rules[1]!.line).toBe('It holds now, but it does not apply: "Everything on OpenCode" comes first for scouts, builders, reviewers and verifiers.');
  });
  test("only the rule states of the scope being read count: a global rule that holds is not the project's rule that does not", () => {
    const p = applyPreset(policy(), "save-my-plan", OPENCODE_AND_CLAUDE)!;
    const id = presetRuleId("save-my-plan");
    const states = [state({ scope: "global", ruleId: id, active: true }), state({ scope: "/work/orbit", ruleId: id, active: false })];
    expect(checkSetup(p, states, OPENCODE_AND_CLAUDE, "/work/orbit").roles.find((r) => r.id === "builder")!.line).not.toContain("from rule");
    expect(checkSetup(p, states, OPENCODE_AND_CLAUDE, "/work/orbit").rules[0]!.line).not.toContain("It holds now");
    expect(checkSetup(p, states, OPENCODE_AND_CLAUDE, "global").roles.find((r) => r.id === "builder")!.line).toContain("from rule");
  });
  test("without a reading of the machine it says it cannot tell", () => {
    expect(checkSetup(policy(), [], null).chair).toBe("This machine has not been checked yet, so there is nothing to tell.");
  });
});

describe("the way back", () => {
  test("is offered only while the whole stored policy is exactly what applying produced", async () => {
    const { backAvailable, backOf } = await import("../src/components/orchestration/orchestrationCopy.ts");
    const before = policy();
    const next = applyPreset(before, "save-my-plan", OPENCODE_AND_CLAUDE)!;
    const b = backOf(before, next, "Save my plan");
    expect(backAvailable(b, next)).toBe(true);
    expect(backAvailable(b, { ...next, rules: [...next.rules, { ...next.rules[0]!, id: "later", name: "Later" }] })).toBe(false);
    expect(backAvailable(b, { ...next, rules: next.rules.map((r) => ({ ...r, enabled: false })) })).toBe(false);
    // Not a rule edit: a later change to a role, the envelope or a limit.
    expect(backAvailable(b, { ...next, workerDefault: { ...next.workerDefault, network: !next.workerDefault.network } })).toBe(false);
    expect(backAvailable(b, { ...next, base: { ...next.base, workers: { ...next.base.workers, builder: { ...next.base.workers.builder, value: [{ engine: "opencode", model: "" }] } } } })).toBe(false);
    expect(backAvailable(null, next)).toBe(false);
  });
  test("undoing removes only what the preset added and puts the earlier rules back in their order", async () => {
    const { backOf, undoPolicy } = await import("../src/components/orchestration/orchestrationCopy.ts");
    const mine = (id: string): Policy["rules"][number] => ({ id, name: id, enabled: true, when: [{ kind: "always" }], workers: { scout: [{ engine: "opencode", model: "" }] } });
    const before: Policy = { ...policy(), rules: [mine("a"), mine("b")] };
    const next = applyPreset(before, "save-my-plan", OPENCODE_AND_CLAUDE)!;
    const b = backOf(before, next, "x");
    expect(next.rules.map((r) => r.id)).toEqual([presetRuleId("save-my-plan"), "a", "b"]);
    // A later edit of the envelope is kept; the way back is gone for the page, but the function is what writes.
    const later: Policy = { ...next, workerDefault: { ...next.workerDefault, network: !next.workerDefault.network } };
    const undone = undoPolicy(later, b);
    expect(undone.rules.map((r) => r.id)).toEqual(["a", "b"]);
    expect(undone.workerDefault).toEqual(later.workerDefault);
    expect(undone.base).toEqual(later.base);
  });
  test("a preset that replaced another comes back where the replaced one stood", async () => {
    const { backOf, undoPolicy } = await import("../src/components/orchestration/orchestrationCopy.ts");
    const first = applyPreset(policy(), "claude-orchestrates", OPENCODE_AND_CLAUDE)!;
    const other: Policy = { ...first, rules: [{ ...first.rules[0]!, id: "x", name: "x" }, ...first.rules] };
    const second = applyPreset(other, "all-on-claude", OPENCODE_AND_CLAUDE)!;
    const undone = undoPolicy(second, backOf(other, second, "y"));
    expect(JSON.stringify(undone)).toBe(JSON.stringify(other));
  });
  test("the page says why it is gone", async () => {
    const { BACK_GONE } = await import("../src/components/orchestration/orchestrationCopy.ts");
    expect(BACK_GONE).toBe("Changed since — edit the rule below instead.");
  });
});
