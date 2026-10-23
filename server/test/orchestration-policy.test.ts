/*
 * The policy model, with no server: what a policy may say, what it is refused
 * for, and what `resolve` picks. Every refusal is asserted on the sentence's
 * field name, because that is what a person is told.
 */
import { describe, expect, test } from "bun:test";
import {
  ROLE_IDS, chainFor, composePolicy, defaultStored, envelopeWithin, looksLikeSecret, resolve, ruleSentence, storedOf,
  validateStored, validatePolicy, DEFAULT_CEILING, DEFAULT_WORKER_ENVELOPE,
  type Policy, type PolicyRule, type RuleFacts,
} from "../../shared/orchestration.ts";
import { WORKER_ROLES, type RoleId } from "../../shared/workerRoles.ts";
import type { EngineReadiness } from "../../shared/types.ts";

const todayBase = () => {
  const workers = {} as Record<RoleId, { engine: string; model: string }>;
  for (const r of WORKER_ROLES) workers[r.id] = { engine: r.default.provider, model: r.default.model };
  return { orchestrator: { engine: "claude", model: "haiku" }, workers };
};
const policy = (over: Partial<Policy> = {}): Policy => ({ ...composePolicy(defaultStored(), todayBase()), ...over });
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const rule = (id: string, over: Partial<PolicyRule> = {}): PolicyRule => ({
  id, name: `Rule ${id}`, enabled: true, when: [{ kind: "always" }],
  workers: { builder: [{ engine: "opencode", model: "opencode/big-pickle" }] }, ...over,
});
const on = (...ids: string[]): RuleFacts => ({ on: (id) => ids.includes(id) });

function ready(id: string, role: { worker?: boolean; orchestrator?: boolean; why?: string } = {}): EngineReadiness {
  const v = (ok: boolean | undefined) => (ok === false ? { ok: false, why: role.why ?? `${id} is not ready` } : { ok: true });
  return {
    id, title: id, found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
    account: { signedIn: true }, answers: { state: "never" },
    roles: { worker: v(role.worker), orchestrator: v(role.orchestrator) }, missing: [],
    envelope: { via: null, enforced: "yes", note: "" },
  };
}
const allReady = ["claude", "codex", "antigravity", "gemini", "hermes", "opencode"].map((id) => ready(id));

describe("validatePolicy: what it refuses, naming the field", () => {
  test("today's base with no rules is valid and comes back unchanged", () => {
    const p = policy();
    const v = validatePolicy(clone(p));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.value).toEqual(p);
  });

  const refused: [string, (p: Policy) => unknown, string][] = [
    ["an unknown key at the top", (p) => ({ ...p, secretSauce: 1 }), "policy.secretSauce"],
    ["an unknown key inside a rule", (p) => ({ ...p, rules: [{ ...rule("a"), apiKey: "x" }] }), "policy.rules[0].apiKey"],
    ["a chain of zero", (p) => ({ ...p, rules: [rule("a", { workers: { builder: [] } })] }), "policy.rules[0].workers.builder"],
    ["a chain of five", (p) => ({ ...p, rules: [rule("a", { orchestrator: Array.from({ length: 5 }, (_, i) => ({ engine: "claude", model: `m${i}` })) })] }), "policy.rules[0].orchestrator"],
    ["remainingAtMost 0", (p) => ({ ...p, rules: [rule("a", { when: [{ kind: "usage", provider: "anthropic", window: "5h", remainingAtMost: 0 }] })] }), "remainingAtMost"],
    ["remainingAtMost 100", (p) => ({ ...p, rules: [rule("a", { when: [{ kind: "usage", provider: "anthropic", window: "5h", remainingAtMost: 100 }] })] }), "remainingAtMost"],
    ["remainingAtMost 12.5", (p) => ({ ...p, rules: [rule("a", { when: [{ kind: "usage", provider: "anthropic", window: "5h", remainingAtMost: 12.5 }] })] }), "remainingAtMost"],
    ["a provider with no gauge", (p) => ({ ...p, rules: [rule("a", { when: [{ kind: "usage", provider: "antigravity", window: "5h", remainingAtMost: 10 }] })] }), "provider"],
    ["an engine that is not in the table", (p) => ({ ...p, rules: [rule("a", { workers: { builder: [{ engine: "emacs", model: "" }] } })] }), "engine"],
    ["a model with a space", (p) => ({ ...p, rules: [rule("a", { workers: { builder: [{ engine: "claude", model: "big pickle" }] } })] }), "model"],
    ["a model with a quote", (p) => ({ ...p, rules: [rule("a", { workers: { builder: [{ engine: "claude", model: 'x"y' }] } })] }), "model"],
    ["a key in a model field", (p) => ({ ...p, rules: [rule("a", { workers: { builder: [{ engine: "claude", model: "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }] } })] }), "looks like a key"],
    ["a bare token in a model field", (p) => ({ ...p, rules: [rule("a", { workers: { builder: [{ engine: "claude", model: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7" }] } })] }), "looks like a key"],
    ["a key in a rule name", (p) => ({ ...p, rules: [rule("a", { name: "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" })] }), "policy.rules[0].name"],
    ["a key in a deny prefix", (p) => ({ ...p, workerDefault: { ...p.workerDefault, deny: ["sk-live-0123456789"] } }), "deny[0]"],
    ["a rule that changes nothing", (p) => ({ ...p, rules: [rule("a", { workers: undefined })] }), "changes nothing"],
    ["a rule with no trigger", (p) => ({ ...p, rules: [rule("a", { when: [] })] }), "policy.rules[0].when"],
    ["a repeated entry in a chain", (p) => ({ ...p, rules: [rule("a", { orchestrator: [{ engine: "claude", model: "" }, { engine: "claude", model: "" }] })] }), "repeats"],
    ["a repeated rule id", (p) => ({ ...p, rules: [rule("a"), rule("a")] }), "policy.rules[1].id"],
    ["a default wider than the ceiling (network)", (p) => ({ ...p, ceiling: { ...DEFAULT_CEILING, network: false }, workerDefault: { ...DEFAULT_WORKER_ENVELOPE, network: true } }), "policy.workerDefault"],
    ["a default wider than the ceiling (commit)", (p) => ({ ...p, ceiling: { ...DEFAULT_CEILING, commit: false }, workerDefault: { ...DEFAULT_WORKER_ENVELOPE, commit: true } }), "policy.workerDefault"],
    ["a default that denies less than the ceiling", (p) => ({ ...p, ceiling: { ...DEFAULT_CEILING, deny: ["make deploy"] }, workerDefault: { ...DEFAULT_WORKER_ENVELOPE, deny: [] } }), "policy.workerDefault"],
    ["a write wider than the worktree", (p) => ({ ...p, ceiling: { ...p.ceiling, write: "repo" } }), "policy.ceiling.write"],
    ["a push grant, which has no field", (p) => ({ ...p, ceiling: { ...p.ceiling, push: true } }), "policy.ceiling.push"],
    ["a limit out of range", (p) => ({ ...p, limits: { ...p.limits, maxWorkers: 0 } }), "policy.limits.maxWorkers"],
    ["a limit that is not a number", (p) => ({ ...p, limits: { ...p.limits, turnMinutes: "30" } }), "policy.limits.turnMinutes"],
    ["hours with a bad time", (p) => ({ ...p, rules: [rule("a", { when: [{ kind: "hours", days: [1], from: "9:00", to: "17:00" }] })] }), "from"],
    ["hours with a day 7", (p) => ({ ...p, rules: [rule("a", { when: [{ kind: "hours", days: [7], from: "09:00", to: "17:00" }] })] }), "days"],
    ["a trigger kind that does not exist", (p) => ({ ...p, rules: [rule("a", { when: [{ kind: "moon" } as never] })] }), "when[0].kind"],
    ["ask that is not a boolean", (p) => ({ ...p, base: { ...p.base, orchestrator: { ...p.base.orchestrator, ask: "yes" } } }), "ask"],
  ];
  for (const [name, make, field] of refused) {
    test(`refuses ${name}`, () => {
      const v = validatePolicy(clone(make(policy())));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.error).toContain(field);
    });
  }

  test("a model name with the provider/name[tag] shape is accepted", () => {
    const p = policy({ rules: [rule("a", { workers: { builder: [{ engine: "opencode", model: "opencode/nemotron-3-ultra-free" }, { engine: "claude", model: "claude-sonnet-5-5[1m]" }] } })] });
    expect(validatePolicy(clone(p)).ok).toBe(true);
  });

  test("nothing in a refused policy is half kept", () => {
    const p = policy({ rules: [rule("a"), rule("b", { workers: { builder: [] } })] });
    const v = validatePolicy(clone(p));
    expect(v.ok).toBe(false);
    expect(v).not.toHaveProperty("value");
  });

  test("looksLikeSecret leaves real model names alone", () => {
    for (const m of ["haiku", "claude-sonnet-5-5", "opencode/big-pickle", "gpt-5.5-codex", "gemini-2.5-pro", "hermes-4-405b", "qwen3-coder-plus"]) {
      expect(looksLikeSecret(m)).toBe(false);
    }
  });
});

describe("validateStored", () => {
  test("the default stored policy is valid and survives a round trip through compose and split", () => {
    const s = defaultStored();
    expect(validateStored(clone(s)).ok).toBe(true);
    expect(storedOf(composePolicy(s, todayBase()))).toEqual(s);
  });
  test("an unknown key is refused by name", () => {
    const v = validateStored({ ...defaultStored(), base: {} });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("policy.base");
  });
});

describe("resolve", () => {
  test("with no rules it is today's base, for every role (property over the role ids)", () => {
    const base = todayBase();
    const r = resolve(policy(), on(), allReady);
    expect(r.orchestrator.ok && r.orchestrator.choice).toEqual(base.orchestrator);
    for (const id of ROLE_IDS) {
      const w = r.workers[id];
      expect(w.ok && w.choice).toEqual(base.workers[id]);
      expect(w.ok && w.from).toBe("base");
    }
  });

  test("the first enabled rule that is on wins, per field", () => {
    const p = policy({ rules: [
      rule("a", { workers: { builder: [{ engine: "hermes", model: "" }] } }),
      rule("b", { workers: { builder: [{ engine: "opencode", model: "opencode/big-pickle" }], scout: [{ engine: "opencode", model: "opencode/big-pickle" }] } }),
    ] });
    const r = resolve(p, on("a", "b"), allReady);
    expect(r.workers.builder.ok && r.workers.builder.choice.engine).toBe("hermes");
    // `a` names no scout, so the next rule that does gets that field.
    expect(r.workers.scout.ok && r.workers.scout.ruleId).toBe("b");
    expect(r.workers.verifier.ok && r.workers.verifier.from).toBe("base");
  });

  test("a rule that only names workers leaves the chair alone", () => {
    const r = resolve(policy({ rules: [rule("a")] }), on("a"), allReady);
    expect(r.orchestrator.ok && r.orchestrator.from).toBe("base");
    expect(r.workers.builder.ok && r.workers.builder.from).toBe("rule");
  });

  test("a rule that is off, or not enabled, is not consulted", () => {
    const p = policy({ rules: [rule("a"), rule("b", { enabled: false })] });
    expect(resolve(p, on(), allReady).workers.builder.ok && true).toBe(true);
    expect((resolve(p, on(), allReady).workers.builder as { from: string }).from).toBe("base");
    expect((resolve(p, on("b"), allReady).workers.builder as { from: string }).from).toBe("base");
  });

  test("a not-ready first entry is skipped with a line that says why, and the second is chosen", () => {
    const p = policy({ rules: [rule("a", { workers: { builder: [{ engine: "hermes", model: "" }, { engine: "opencode", model: "opencode/big-pickle" }] } })] });
    const rd = [ready("hermes", { worker: false, why: "0.21.0 is older than 0.21.4" }), ...allReady.filter((e) => e.id !== "hermes")];
    const b = resolve(p, on("a"), rd).workers.builder;
    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.choice.engine).toBe("opencode");
      expect(b.position).toBe(1);
      expect(b.because.join(" ")).toContain("skipped Hermes: 0.21.0 is older than 0.21.4");
    }
  });

  test("an engine the probe has not seen is skipped, not guessed", () => {
    const p = policy({ rules: [rule("a", { workers: { builder: [{ engine: "hermes", model: "" }] } })] });
    const b = resolve(p, on("a"), []).workers.builder;
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.why).toContain("has not been checked");
  });

  test("an exhausted chain refuses and never names an engine outside it", () => {
    const p = policy({ rules: [rule("a", { workers: { builder: [{ engine: "hermes", model: "" }, { engine: "opencode", model: "x" }] } })] });
    const rd = allReady.map((e) => (e.id === "hermes" || e.id === "opencode" ? ready(e.id, { worker: false }) : e));
    const b = resolve(p, on("a"), rd).workers.builder;
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.from).toBe("rule");
      expect(b.why).toContain("skipped Hermes");
      expect(b.why).toContain("skipped OpenCode");
      expect(b).not.toHaveProperty("choice");
    }
  });

  test("the chair uses the orchestrator verdict, a worker the worker verdict", () => {
    const rd = allReady.map((e) => (e.id === "claude" ? ready("claude", { orchestrator: false, why: "no screen facet" }) : e));
    const r = resolve(policy(), on(), rd);
    expect(r.orchestrator.ok).toBe(false);
    expect(r.workers.builder.ok).toBe(true);
  });

  test("ask follows the base only, and a winning rule does not ask", () => {
    const p = policy({ rules: [rule("a")] });
    p.base.workers.builder.ask = true;
    const r = resolve(p, on(), allReady);
    expect(r.workers.builder.ok && r.workers.builder.ask).toBe(true);
    const r2 = resolve(p, on("a"), allReady);
    expect(r2.workers.builder.ok && r2.workers.builder.ask).toBe(false);
  });
});

describe("the owner's case, as a fixture with invented names", () => {
  // Claude Code on a personal plan only orchestrates; two other engines do the
  // work, whenever the rule is on. Representable, valid, and resolvable.
  const chain = [{ engine: "hermes", model: "" }, { engine: "opencode", model: "opencode/big-pickle" }];
  const owner = (): Policy => policy({
    rules: [{ id: "claude-orchestrates", name: "Claude only orchestrates", enabled: true, when: [{ kind: "always" }],
      workers: { scout: chain, builder: chain, verifier: chain } }],
  });

  test("is a valid policy", () => {
    expect(validatePolicy(clone(owner())).ok).toBe(true);
  });
  test("the chair stays on Claude and every role goes to the first ready of the other two", () => {
    const r = resolve(owner(), on("claude-orchestrates"), allReady);
    expect(r.orchestrator.ok && r.orchestrator.choice.engine).toBe("claude");
    for (const id of ROLE_IDS) {
      const w = r.workers[id];
      expect(w.ok && w.choice.engine).toBe("hermes");
    }
  });
  test("with Hermes unavailable the work moves to OpenCode, still never to Claude", () => {
    const rd = allReady.map((e) => (e.id === "hermes" ? ready("hermes", { worker: false }) : e));
    const r = resolve(owner(), on("claude-orchestrates"), rd);
    for (const id of ROLE_IDS) {
      const w = r.workers[id];
      expect(w.ok && w.choice.engine).toBe("opencode");
    }
  });
  test("with both unavailable it refuses instead of handing the work to the chair's engine", () => {
    const rd = allReady.map((e) => (e.id === "hermes" || e.id === "opencode" ? ready(e.id, { worker: false }) : e));
    const r = resolve(owner(), on("claude-orchestrates"), rd);
    for (const id of ROLE_IDS) expect(r.workers[id].ok).toBe(false);
  });
  test("reads as one sentence", () => {
    const w = "Hermes, then OpenCode (opencode/big-pickle)";
    expect(ruleSentence(owner().rules[0]!)).toBe(`When always: scout is ${w}; builder is ${w}; verifier is ${w}.`);
  });
});

describe("envelopeWithin, the ceiling's one test", () => {
  const e = (over: Partial<typeof DEFAULT_CEILING> = {}) => ({ ...DEFAULT_WORKER_ENVELOPE, ...over });
  test("narrower or equal is within", () => {
    expect(envelopeWithin(e(), DEFAULT_CEILING)).toBe(true);
    expect(envelopeWithin(e({ write: "none" }), e())).toBe(true);
  });
  test("each lifted switch outside the ceiling is refused", () => {
    expect(envelopeWithin(e({ network: true }), e())).toBe(false);
    expect(envelopeWithin(e({ commit: true }), e())).toBe(false);
    expect(envelopeWithin(e({ deny: [] }), e({ deny: ["make deploy"] }))).toBe(false);
    expect(envelopeWithin(e({ deny: ["make deploy", "make db"] }), e({ deny: ["make deploy"] }))).toBe(true);
  });
});

describe("ruleSentence", () => {
  test("a usage rule names the percent, the window and the chain", () => {
    const s = ruleSentence(rule("a", { when: [{ kind: "usage", provider: "anthropic", window: "5h", remainingAtMost: 15 }], enabled: false }));
    expect(s).toBe("When Claude has 15% or less left in the 5 h window: builder is OpenCode (opencode/big-pickle). (off)");
  });
});

describe("a rule link with no model", () => {
  // The "all workers on Claude" preset writes `{ engine: "claude", model: "" }`
  // for every role. Read as "the CLI's default" it replaced the base's haiku /
  // sonnet / haiku with the expensive default, silently, for every worker.
  const anyClaude = (): PolicyRule => rule("all", { workers: Object.fromEntries(ROLE_IDS.map((r) => [r, [{ engine: "claude", model: "" }]])) });

  test("keeps the base's model for the same engine, in resolve and in chainFor", () => {
    const base = todayBase();
    const p = policy({ rules: [anyClaude()] });
    const r = resolve(p, on("all"), allReady);
    for (const id of ROLE_IDS) {
      const w = r.workers[id];
      expect(w.ok && w.choice).toEqual(base.workers[id]);
      expect(w.ok && w.from).toBe("rule");
      expect(chainFor(p, on("all"), id)).toEqual([base.workers[id]]);
    }
  });

  test("an explicit model in the rule still wins, and another engine gets no borrowed model", () => {
    const p = policy({ rules: [rule("x", { workers: {
      builder: [{ engine: "claude", model: "opus" }],
      scout: [{ engine: "opencode", model: "" }],
    } })] });
    const r = resolve(p, on("x"), allReady);
    expect(r.workers.builder.ok && r.workers.builder.choice.model).toBe("opus");
    expect(r.workers.scout.ok && r.workers.scout.choice).toEqual({ engine: "opencode", model: "" });
  });
});
