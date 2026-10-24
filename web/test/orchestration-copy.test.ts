/*
 * The Orchestration page, held without a renderer: its sentences and its edits
 * are pure functions of what the server measured, so the tables below ARE the
 * contract. Engine names are read from the provider table, never typed into
 * the copy, so these cases name engines by id and expect the table's titles.
 */
import { describe, expect, test } from "bun:test";
import { agentProvider } from "../../shared/agentKinds.ts";
import { GAUGED_PROVIDERS, defaultStored, composePolicy, validatePolicy, type Policy, type PolicyRule, type Resolved } from "../../shared/orchestration.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import type { PolicyRuleState } from "../src/lib/api.ts";
import {
  CHAIN_TAIL, GAUGE_HELP, NO_WORKER_ENGINE, chainAdd, chainMove, chainRemove, engineOptions, exhausted, newRuleId, notReady,
  readyFor, ruleBadge, ruleLine, stepLimit, triggerWords, ungaugedEngines, usageChoices, withAsk, withBaseChoice, withRule, withRuleEnabled,
} from "../src/components/orchestration/orchestrationCopy.ts";

const title = (id: string) => agentProvider(id)!.title;

// The shape the probe answers with; each case changes what it must.
const engine = (id: string, over: Partial<EngineReadiness> = {}): EngineReadiness => ({
  id, title: title(id), found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
  ...over,
});
const OLD_HERMES = engine("hermes", {
  version: "0.21.0", min: "0.21.4", versionOk: false,
  roles: { worker: { ok: false, why: "0.21.0 is older than 0.21.4." }, orchestrator: { ok: false, why: "0.21.0 is older than 0.21.4." } },
  missing: [{ kind: "command", what: "0.21.0 is installed.", command: "hermes update" }],
});
const READY = [engine("claude"), engine("opencode"), OLD_HERMES];

const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({
  id: "thin-week", name: "Thin week", enabled: true,
  when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 10 }],
  workers: { builder: [{ engine: "opencode", model: "big-pickle" }, { engine: "hermes", model: "" }] },
  ...over,
});
const state = (over: Partial<PolicyRuleState> = {}): PolicyRuleState => ({
  scope: "global", ruleId: "thin-week", name: "Thin week", active: false, since: 0, reading: "", readingAt: 0, holding: "", ...over,
});

const policy = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});

describe("the sentence form of each trigger kind", () => {
  const CASES: [string, Parameters<typeof triggerWords>[0], string][] = [
    ["always", { kind: "always" }, "this always holds"],
    ["budget", { kind: "budget" }, "the project's budget is used up"],
    ["limit", { kind: "limit", provider: "codex" }, `the ${title("codex")} plan has run out in a window`],
    ["usage, 5 h", { kind: "usage", provider: "anthropic", window: "5h", remainingAtMost: 20 }, `20% or less of the ${title("claude")} 5 h plan is left`],
    ["usage, weekly", { kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 10 }, `10% or less of the ${title("claude")} weekly plan is left`],
    ["usage, either", { kind: "usage", provider: "codex", window: "either", remainingAtMost: 5 }, `5% or less is left in either ${title("codex")} window`],
    ["hours, some days", { kind: "hours", days: [1, 2, 3], from: "22:00", to: "07:00" }, "it is Mon, Tue, Wed, 22:00 to 07:00"],
    ["hours, every day", { kind: "hours", days: [0, 1, 2, 3, 4, 5, 6], from: "09:00", to: "17:30" }, "it is every day, 09:00 to 17:30"],
  ];
  test.each(CASES)("%s", (_n, t, want) => expect(triggerWords(t)).toBe(want));

  test("a rule reads as one sentence: when, then which engines, in order", () => {
    expect(ruleLine(rule())).toBe(
      `When 10% or less of the ${title("claude")} weekly plan is left: builders use ${title("opencode")} big-pickle, then ${title("hermes")}.`);
  });
  test("every condition and every named field is in the sentence", () => {
    const r = rule({
      when: [{ kind: "budget" }, { kind: "hours", days: [6], from: "00:00", to: "23:59" }],
      orchestrator: [{ engine: "claude", model: "haiku" }],
      workers: { scout: [{ engine: "opencode", model: "" }], verifier: [{ engine: "claude", model: "" }] },
    });
    expect(ruleLine(r)).toBe(
      `When the project's budget is used up and it is Sat, 00:00 to 23:59: the main agent is ${title("claude")} haiku; scouts use ${title("opencode")}; verifiers use ${title("claude")}.`);
  });
});

describe("the four not-ready states", () => {
  test("1. no engine can work: the card is one sentence, and the test that picks it", () => {
    expect(NO_WORKER_ENGINE).toBe("No engine on this machine can work for an orchestrator yet.");
    expect(readyFor("worker", [OLD_HERMES, engine("qwen", { roles: { worker: { ok: false, why: "x" }, orchestrator: { ok: false, why: "x" } } })])).toEqual([]);
    expect(readyFor("worker", READY)).toEqual(["claude", "opencode"]);
  });

  test("2. the chosen engine stopped being ready: the reason, and what runs instead", () => {
    const using: Resolved = { ok: true, choice: { engine: "opencode", model: "" }, from: "base", position: 1, ask: false, because: [] };
    expect(notReady({ engine: "hermes", model: "" }, "worker", using, READY)).toEqual({
      tone: "err", text: "Not ready", why: "0.21.0 is older than 0.21.4.", using: `Using ${title("opencode")} instead.`,
    });
    expect(notReady({ engine: "hermes", model: "" }, "worker", undefined, READY)?.using).toBeUndefined();
    expect(notReady({ engine: "claude", model: "" }, "worker", using, READY)).toBeNull();
    expect(notReady({ engine: "hermes", model: "" }, "worker", using, null)).toBeNull();
  });

  test("3. usage unknown: the rule's badge says it is holding, with how old the reading is", () => {
    expect(ruleBadge(rule(), state({ holding: "holding: the last usage reading is 47 min old" }), READY))
      .toEqual({ tone: "off", text: "Holding · last usage reading is 47 min old" });
  });

  test("4. the chain ran out: the card says so, with the words the seat received", () => {
    const out: Resolved = { ok: false, why: "no engine in the chain is ready: skipped Hermes: 0.21.0 is older than 0.21.4.", from: "base", because: [] };
    expect(exhausted(out)).toEqual({ tone: "err", text: "Nothing in this list is ready", sentence: out.why });
    expect(exhausted({ ok: true, choice: { engine: "claude", model: "" }, from: "base", position: 0, ask: false, because: [] })).toBeNull();
  });
});

describe("a rule's badge, in each of its states", () => {
  const CASES: [string, PolicyRule, PolicyRuleState | undefined, EngineReadiness[] | null, string, string][] = [
    ["switched off", rule({ enabled: false }), state(), READY, "off", "Off"],
    ["waiting", rule({ workers: { builder: [{ engine: "opencode", model: "" }] } }), state(), READY, "off", "Waiting"],
    ["no state yet", rule({ workers: { builder: [{ engine: "opencode", model: "" }] } }), undefined, READY, "off", "Waiting"],
    ["on now", rule({ workers: { builder: [{ engine: "opencode", model: "" }] } }), state({ active: true, reading: "weekly 8% left" }), READY, "warn", "On now · weekly 8% left"],
    ["holding", rule({ workers: { builder: [{ engine: "opencode", model: "" }] } }), state({ holding: "holding: the last usage reading is 47 min old" }), READY, "off", "Holding · last usage reading is 47 min old"],
    ["cannot apply: the only engine needs an update", rule({ workers: { builder: [{ engine: "hermes", model: "" }] } }), state({ active: true }), READY, "err", `Cannot apply · ${title("hermes")} needs an update`],
    ["applies: one engine in the chain is ready", rule(), state(), READY, "off", "Waiting"],
    ["unknown readiness does not claim a failure", rule({ workers: { builder: [{ engine: "hermes", model: "" }] } }), state(), null, "off", "Waiting"],
  ];
  test.each(CASES)("%s", (_n, r, s, ready, tone, text) => expect(ruleBadge(r, s, ready)).toEqual({ tone: tone as never, text }));
});

describe("the engine selects", () => {
  test("offer only engines whose role verdict is ok, and list the rest disabled with the reason", () => {
    const opts = engineOptions("worker", READY);
    const by = (id: string) => opts.find((o) => o.value === id)!;
    expect(by("claude").disabled).toBeUndefined();
    expect(by("opencode").disabled).toBeUndefined();
    expect(by("hermes")).toMatchObject({ disabled: true, hint: "0.21.0 is older than 0.21.4." });
    // An engine the probe has not answered for is listed too, never dropped.
    expect(by("codex")).toMatchObject({ disabled: true, hint: "This machine has not been checked for it yet." });
    expect(opts.map((o) => o.label)).toContain(title("hermes"));
  });
  test("the orchestrator role reads its own verdict, not the worker's", () => {
    const e = [engine("claude", { roles: { worker: { ok: true }, orchestrator: { ok: false, why: "Cannot orchestrate yet." } } })];
    expect(engineOptions("worker", e).find((o) => o.value === "claude")!.disabled).toBeUndefined();
    expect(engineOptions("orchestrator", e).find((o) => o.value === "claude")).toMatchObject({ disabled: true, hint: "Cannot orchestrate yet." });
  });
  test("a field the server holds fixed keeps one engine and says why for the rest", () => {
    const opts = engineOptions("orchestrator", READY, { engine: "claude", why: "Set when the seat opens." });
    expect(opts.filter((o) => !o.disabled).map((o) => o.value)).toEqual(["claude"]);
    expect(opts.find((o) => o.value === "opencode")!.hint).toBe("Set when the seat opens.");
  });
  test("before the probe answers, nothing is offered and it says it is checking", () => {
    expect(engineOptions("worker", null).every((o) => o.disabled && o.hint === "Checking this machine.")).toBe(true);
  });
});

describe("the usage condition", () => {
  test("offers only providers that report a quota", () => {
    expect(usageChoices().map((c) => c.value)).toEqual([...GAUGED_PROVIDERS]);
    expect(usageChoices().map((c) => c.label)).toEqual(GAUGED_PROVIDERS.map((p) => title(p === "anthropic" ? "claude" : p)));
  });
  test("an engine with no gauge is absent from it and named in the help line, from the table", () => {
    const names = ungaugedEngines();
    expect(names).toContain(title("opencode"));
    expect(names).not.toContain(title("claude"));
    expect(names).not.toContain(title("codex"));
    expect(GAUGE_HELP()).toContain(`${title("opencode")}`);
    expect(GAUGE_HELP()).toContain("cannot watch");
    expect(GAUGE_HELP()).toContain("A failed start still moves to the next engine in the chain.");
  });
});

describe("edits", () => {
  test('"Ask when it runs" round-trips the flag through the server\'s own validator', () => {
    for (const field of ["orchestrator", "scout", "builder", "verifier"] as const) {
      const on = withAsk(policy(), field, true);
      const back = validatePolicy(JSON.parse(JSON.stringify(on)));
      expect(back.ok).toBe(true);
      if (!back.ok) continue;
      const flag = (p: Policy) => (field === "orchestrator" ? p.base.orchestrator.ask : p.base.workers[field].ask);
      expect(flag(back.value)).toBe(true);
      expect(flag(withAsk(back.value, field, false))).toBe(false);
      // Only that flag moved.
      const others = (["orchestrator", "scout", "builder", "verifier"] as const).filter((f) => f !== field);
      for (const o of others) expect(withAsk(policy(), o, false)).toEqual(policy());
    }
  });
  test("a base choice is one choice", () => {
    const p = withBaseChoice(policy(), "builder", { engine: "opencode", model: "big-pickle" });
    expect(p.base.workers.builder.value).toEqual([{ engine: "opencode", model: "big-pickle" }]);
    expect(p.base.workers.scout).toEqual(policy().base.workers.scout);
  });
  test("a chain holds four at most and moves inside its own bounds", () => {
    let c = [{ engine: "claude", model: "" }];
    for (const id of ["opencode", "hermes", "codex", "qwen"]) c = chainAdd(c, { engine: id, model: "" });
    expect(c.map((x) => x.engine)).toEqual(["claude", "opencode", "hermes", "codex"]);
    expect(chainMove(c, 0, -1)).toBe(c);
    expect(chainMove(c, 3, 1)).toBe(c);
    expect(chainMove(c, 0, 1).map((x) => x.engine)).toEqual(["opencode", "claude", "hermes", "codex"]);
    expect(chainRemove(c, 1).map((x) => x.engine)).toEqual(["claude", "hermes", "codex"]);
    expect(CHAIN_TAIL).toBe("Then ask me.");
  });
  test("rules: added, replaced by id, switched, with an id the validator takes", () => {
    const a = withRule(policy(), rule());
    expect(a.rules).toHaveLength(1);
    expect(withRule(a, rule({ name: "Renamed" })).rules.map((r) => r.name)).toEqual(["Renamed"]);
    expect(withRuleEnabled(a, "thin-week", false).rules[0]!.enabled).toBe(false);
    expect(newRuleId(a, "Thin week")).toBe("thin-week-2");
    expect(newRuleId(policy(), "  Night: builders (cheap)! ")).toBe("night-builders-cheap");
    expect(validatePolicy(JSON.parse(JSON.stringify(a))).ok).toBe(true);
  });
  test("a stepper stays inside the validator's range", () => {
    expect(stepLimit("maxWorkers", 12, 1)).toBe(12);
    expect(stepLimit("maxWorkers", 1, -1)).toBe(1);
    expect(stepLimit("maxRetries", 0, -1)).toBe(0);
    expect(stepLimit("maxRetries", 5, 1)).toBe(5);
    expect(stepLimit("turnMinutes", 30, 1)).toBe(31);
  });
});
