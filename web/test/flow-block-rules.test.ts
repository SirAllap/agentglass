/*
 * The "why" and the rules of a block, in the editor's side panel. There is no
 * renderer to click with, so the panel and the sheet are rendered to markup, the
 * pure words are asserted directly, and the wiring that markup cannot show (the
 * page reading the policy again after a save) is asserted against source.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composePolicy, defaultStored, type Policy } from "../../shared/orchestration.ts";
import { RuleSheetHost } from "../src/components/orchestration/RuleSheetHost.tsx";
import { sheetOpen, sheetRuleFor } from "../src/components/orchestration/ruleSheetState.ts";
import { BlockRules } from "../src/components/orchestration/flow/BlockRules.tsx";
import { roleRuleDraft, roleWhen, roleWhy, rulesTouching } from "../src/components/orchestration/flow/blockRules.ts";
import type { Around } from "../src/components/orchestration/flow/AroundFlow.tsx";

const base = composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const policy = {
  ...base,
  rules: [{ id: "plan", name: "Plan low", enabled: true, when: [{ kind: "always" }], workers: { builder: [{ engine: "opencode", model: "" }] } }],
} as unknown as Policy;
const ready = [{ id: "claude", roles: { orchestrator: { ok: true }, worker: { ok: true } } }, { id: "opencode", roles: { orchestrator: { ok: true }, worker: { ok: true } } }] as never;
const around = (over: Partial<Around> = {}): Around => ({
  root: "/home/you/code/orbit", policy, readiness: ready, seat: null, gate: null, states: [], own: true, note: "",
  saveRule: async () => null, claim: async () => null, setGate: async () => {}, ...over,
});
const flow = { roster: [{ policyRole: "builder" as const, name: "Paco" }] };

const SRC = join(import.meta.dir, "..", "src", "components", "orchestration");
const isComment = (l: string) => ["//", "*", "/*"].some((m) => l.trim().startsWith(m));
const code = (f: string) => readFileSync(join(SRC, f), "utf8").split("\n").filter((l) => !isComment(l)).join("\n");

describe("the rules of a block", () => {
  test("only the rules that set this role touch it", () => {
    expect(rulesTouching(policy, "builder").map((r) => r.id)).toEqual(["plan"]);
    expect(rulesTouching(policy, "scout")).toEqual([]);
  });

  test("Why: the base choice when no rule moves the role", () => {
    expect(roleWhy(policy, "scout", ready, () => true, "all projects")).toBe("The base choice for all projects. No rule is on for this block.");
  });

  test("Why: the rule by name when one moves it", () => {
    expect(roleWhy(policy, "builder", ready, (id) => id === "plan", "all projects")).toContain("Moved by the rule “Plan low”");
    // A rule that does not hold right now is not the reason.
    expect(roleWhy(policy, "builder", ready, () => false, "all projects")).toContain("base choice");
  });

  test("When is the page's line", () => {
    expect(roleWhen("builder")).toBe("After the Orchestrator's handoff, and again after each round of findings.");
  });

  test("the panel prints Why, When, a chip per rule and the add button, with the flow's names", () => {
    const html = renderToStaticMarkup(createElement(BlockRules, { role: "builder", flow, a: around({ states: [{ scope: "/home/you/code/orbit", ruleId: "plan", active: true }] as never }) }));
    expect(html).toContain("Why it is set this way");
    expect(html).toContain("Moved by the rule");
    expect(html).toContain('data-rule-chip="plan"');
    expect(html).toContain("Add a rule for this block");
    expect(html).toContain("After the Orchestrator");
  });
});

describe("the sheet opened from the panel", () => {
  const host = (editing: string | null, seed = null as ReturnType<typeof roleRuleDraft> | null) =>
    renderToStaticMarkup(createElement(RuleSheetHost, { editing, seed, policy, flow, readiness: ready, states: [], root: "", scopeKey: "global", now: new Date(), save: async () => null, onClose: () => {} }));

  test("a rule id mounts RuleSheet on that rule", () => {
    expect(sheetRuleFor(policy, "plan", null)?.name).toBe("Plan low");
    expect(host("plan")).toContain("Plan low");
  });

  test("a rule that is gone mounts nothing", () => {
    expect(sheetOpen("ghost", sheetRuleFor(policy, "ghost", null))).toBe(false);
    expect(host("ghost")).toBe("");
    expect(host(null)).toBe("");
  });

  test("Add a rule pre-sets the role, with the flow's name", () => {
    const draft = roleRuleDraft(policy, "scout", { roster: [{ policyRole: "scout", name: "Ana" }] });
    expect(draft.name).toBe("Ana rule");
    expect(Object.keys(draft.workers ?? {})).toEqual(["scout"]);
    expect(draft.workers?.scout).toEqual(policy.base.workers.scout.value);
    expect(draft.id).toBe("");
    expect(Object.keys(roleRuleDraft(policy, "builder", flow).workers ?? {})).toEqual(["builder"]);
    const html = host("new", roleRuleDraft(policy, "builder", flow));
    expect(html).toContain("Paco rule");
  });

  test("the panel hands the sheet the editor's own save, and the page reads the policy again after it", () => {
    const rules = code("flow/BlockRules.tsx");
    expect(rules).toContain("<RuleSheetHost");
    expect(rules).toMatch(/const e = await a\.saveRule\(next\); if \(!e\) onSaved\?\.\(\)/);
    expect(code("flow/WorkerEditor.tsx")).toContain("<BlockRules");
    expect(code("flow/FlowEditor.tsx")).toContain("onRuleSaved={p.onPolicySaved}");
    expect(code("flow/FlowSlot.tsx")).toContain("onPolicySaved={onPolicySaved}");
    expect(code("OrchestrationPane.tsx")).toContain("onPolicySaved={() => loadPolicy(root)}");
  });

  test("the page no longer mounts the sheet: it returns with the conditions on the canvas", () => {
    expect(code("OrchestrationPane.tsx")).not.toContain("<RuleSheetHost");
    expect(code("OrchestrationPane.tsx")).not.toContain("<RuleSheet ");
  });
});
