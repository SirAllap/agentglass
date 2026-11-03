/*
 * A role's engine, model, fallbacks and Ask, set from the Flow editor, are
 * POLICY: the call that goes out is the policy the page would have stored, and
 * the flow is never written. Asserted against the call, not the markup.
 */
import { describe, expect, test } from "bun:test";
import { composePolicy, defaultStored, validatePolicy } from "../../shared/orchestration.ts";
import { applyPolicyEdit, otherChainRule, savePolicyEdit, shownChain, SAVES_AT_ONCE } from "../src/components/orchestration/flow/PolicyRoleControls.tsx";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();
const base = composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const withFallback = applyPolicyEdit(base, "scout", { kind: "chain", chain: [{ engine: "opencode", model: "" }, { engine: "claude", model: "haiku" }] }, "Planner");
const ruleOf = (p: typeof base, role: string) => p.rules.find((r) => r.id === `fallback-${role}`);

describe("applyPolicyEdit", () => {
  test("add a fallback: base keeps one choice, rule fallback-<role> holds the chain", () => {
    expect(withFallback.base.workers.scout.value).toEqual([{ engine: "opencode", model: "" }]);
    const r = ruleOf(withFallback, "scout")!;
    expect(r.workers!.scout).toEqual([{ engine: "opencode", model: "" }, { engine: "claude", model: "haiku" }]);
    expect(r.name).toBe("Planner fallbacks");
    expect(r.when).toEqual([{ kind: "always" }]);
    expect(r.enabled).toBe(true);
    expect(shownChain(withFallback, "scout")).toHaveLength(2);
  });
  test("what is saved always passes the server's validator, and never holds a base chain", () => {
    expect(validatePolicy(JSON.parse(JSON.stringify(withFallback))).ok).toBe(true);
    for (const r of ["scout", "builder", "reviewer", "verifier"] as const) expect(withFallback.base.workers[r].value.length).toBe(1);
  });
  test("remove the last fallback: the rule is gone", () => {
    const next = applyPolicyEdit(withFallback, "scout", { kind: "chain", chain: [{ engine: "opencode", model: "" }] }, "Planner");
    expect(ruleOf(next, "scout")).toBeUndefined();
    expect(next.rules).toHaveLength(0);
  });
  test("adding again edits the same rule, not a second one", () => {
    const next = applyPolicyEdit(withFallback, "scout", { kind: "chain", chain: [...shownChain(withFallback, "scout"), { engine: "claude", model: "opus" }] }, "Planner");
    expect(next.rules.filter((r) => r.id === "fallback-scout")).toHaveLength(1);
    expect(ruleOf(next, "scout")!.workers!.scout).toHaveLength(3);
  });
  test("a new engine replaces the first step and keeps the fallbacks, base stays one choice", () => {
    const next = applyPolicyEdit(withFallback, "scout", { kind: "engine", choice: { engine: "claude", model: "" } }, "Planner");
    expect(next.base.workers.scout.value).toEqual([{ engine: "claude", model: "" }]);
    expect(ruleOf(next, "scout")!.workers!.scout).toEqual([{ engine: "claude", model: "" }, { engine: "claude", model: "haiku" }]);
  });
  test("another rule's chain is not touched; ours goes after it and the panel names it", () => {
    const other = { id: "quick-setup", name: "Quick setup", when: [{ kind: "always" as const }], workers: { scout: [{ engine: "claude", model: "opus" }] }, enabled: true };
    const p = { ...base, rules: [other] };
    expect(otherChainRule(p, "scout")?.id).toBe("quick-setup");
    const next = applyPolicyEdit(p, "scout", { kind: "chain", chain: [{ engine: "opencode", model: "" }, { engine: "claude", model: "haiku" }] }, "Planner");
    expect(next.rules.map((r) => r.id)).toEqual(["quick-setup", "fallback-scout"]);
    expect(next.rules[0]).toEqual(other);
  });
  test("an empty chain changes nothing", () => {
    expect(applyPolicyEdit(base, "builder", { kind: "chain", chain: [] })).toEqual(base);
  });
  test("Ask flips the flag and leaves the chain and the other roles alone", () => {
    const next = applyPolicyEdit(base, "verifier", { kind: "ask", ask: true });
    expect(next.base.workers.verifier.ask).toBe(true);
    expect(next.base.workers.verifier.value).toEqual(base.base.workers.verifier.value);
    expect(next.base.workers.builder).toEqual(base.base.workers.builder);
  });
});

describe("savePolicyEdit", () => {
  test("posts the whole edited policy to /orchestration, once, and nothing to /flow", async () => {
    const calls: { url: string; body: any }[] = [];
    stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true, scope: "global", overrides: [], policy: applyPolicyEdit(base, "scout", { kind: "ask", ask: true }) }), { headers: { "content-type": "application/json" } });
    });
    const r = await savePolicyEdit(base, "scout", { kind: "ask", ask: true });
    expect("policy" in r).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/orchestration");
    expect(calls[0]!.url).not.toContain("/flow");
    expect(calls[0]!.body.policy.base.workers.scout.ask).toBe(true);
    expect(calls[0]!.body.root).toBeUndefined();
  });
  test("a refusal comes back as the server's sentence", async () => {
    stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: false, error: "No engine in the chain is ready." }), { status: 400, headers: { "content-type": "application/json" } }));
    expect(await savePolicyEdit(base, "builder", { kind: "ask", ask: true })).toEqual({ error: "No engine in the chain is ready." });
  });
});

describe("PolicyRoleControls prints the flow's name (moved from the page's block panel)", () => {
  // It reads the policy when it mounts, so the markup is not static: the label is held to its source.
  test("the model label and the fallback wording carry the name the flow gave the role", async () => {
    const s = await Bun.file(new URL("../src/components/orchestration/flow/PolicyRoleControls.tsx", import.meta.url)).text();
    expect(s).toContain("label={`Model for ${name}`}");
    expect(s).toContain("savePolicyEdit(policy, role, e, name, own");
  });
});

describe("the one worker editor, and the read-only panel", () => {
  const src = async (f: string) => await Bun.file(new URL(`../src/components/orchestration/flow/${f}`, import.meta.url)).text();
  test("the editor keeps the policy controls and no longer sends the person to the Agents page", async () => {
    const s = await src("WorkerEditor.tsx");
    expect(s).not.toContain("Agents page");
    expect(s).toContain("<PolicyRoleControls");
  });
  test("a policy role draws the mockup's three engine tiles, the ladder and the Ask row", async () => {
    const s = await src("PolicyRoleControls.tsx");
    expect(s).toContain('className="fe-eng"');
    expect(s).toContain("ENGINE_PLAN");
    expect(s).toContain("<ChainList");
    expect(s).toContain("Ask me when it runs");
    expect(s).not.toContain("<PickRow");
    expect(s).not.toContain("fe-tagmain");
  });
  test("the right panel is summary only: it never mounts a control that writes", async () => {
    const s = await src("WorkerPanel.tsx");
    expect(s).toContain("Configure");
    expect(s).not.toContain("<PolicyRoleControls");
    expect(s).not.toContain("<ReviewerControls");
    expect(s).not.toContain("<Switch");
  });
  test("the one-line honesty note says what saves at once", () => {
    expect(SAVES_AT_ONCE).toContain("save as soon as you change them");
  });
});

describe("in a project policy", () => {
  // The server refuses a project policy that moves a worker role (worker roles are global), so a new first step
  // lives in the role's rule and the base is left as it was.
  test("a new engine goes in the rule and the base is untouched", () => {
    const next = applyPolicyEdit(base, "scout", { kind: "engine", choice: { engine: "claude", model: "haiku" } }, "Planner", true);
    expect(next.base.workers.scout).toEqual(base.base.workers.scout);
    expect(shownChain(next, "scout", true)[0]).toEqual({ engine: "claude", model: "haiku" });
  });
  test("choosing the base's own choice again leaves no rule", () => {
    const first = base.base.workers.scout.value[0]!;
    const next = applyPolicyEdit(base, "scout", { kind: "engine", choice: first }, "Planner", true);
    expect(next.rules.find((r) => r.id === "fallback-scout")).toBeUndefined();
  });
});
