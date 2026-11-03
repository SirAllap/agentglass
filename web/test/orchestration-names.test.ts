/*
 * One name per role: a role the person renamed in the flow ("Paco") is the
 * only name any sentence, group label or panel prints. The policy ids stay
 * `scout`, `reviewer`...; the policy's own words for them (Scout, Reviewer)
 * must not leak next to the flow's. Without a flow the shipped titles stay.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { composePolicy, defaultStored, type Policy, type PolicyRule } from "../../shared/orchestration.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import type { EngineReadiness } from "../../shared/types.ts";
import { agentProvider } from "../../shared/agentKinds.ts";
import { roleLabel, flowLikeOf, type FlowLike } from "../src/lib/roleLabel.ts";
import {
  checkSetup, fineTuneRow, flowNodes, presetDiagram, presetOffers, roleWord, ruleLine, testItNow, thenWords,
} from "../src/components/orchestration/orchestrationCopy.ts";
import { RuleSheet } from "../src/components/orchestration/RuleForm.tsx";

const eng = (id: string): EngineReadiness => ({
  id, title: agentProvider(id)!.title, found: true, path: `/usr/bin/${id}`, version: "1.0.0", min: null, versionOk: true,
  account: { signedIn: true }, answers: { state: "never" },
  roles: { worker: { ok: true }, orchestrator: { ok: true } },
  missing: [], envelope: { via: null, enforced: "yes", note: "" },
});
const READY = [eng("claude"), eng("opencode")];
const policy = (rules: PolicyRule[] = []): Policy => ({
  ...composePolicy(defaultStored(), {
    orchestrator: { engine: "claude", model: "sonnet" },
    workers: { scout: { engine: "opencode", model: "" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
  }),
  rules,
});
const everyRole: PolicyRule = {
  id: "all", name: "Thin week", enabled: true, when: [{ kind: "always" }],
  workers: { scout: [{ engine: "opencode", model: "" }], builder: [{ engine: "opencode", model: "" }], reviewer: [{ engine: "opencode", model: "" }], verifier: [{ engine: "opencode", model: "" }] },
};
const holds = { on: (id: string) => id === "all" };

/** The shipped flow with its Planner renamed Paco and its Inspector Ana. */
const named = (): FlowLike => {
  const f = templateFlow();
  return { roster: f.roster.map((r) => (r.policyRole === "scout" ? { ...r, name: "Paco" } : r.policyRole === "reviewer" ? { ...r, name: "Ana" } : r)) };
};
/** What a person reads: the text, and the labels a screen reader or a tooltip says. Ids in data-* and classes are not printed. */
const printed = (html: string): string =>
  [...html.matchAll(/(?:aria-label|title|data-tip)="([^"]*)"/g)].map((m) => m[1]).join("\n") + "\n" + html.replace(/<[^>]*>/g, "\n");
const POLICY_WORDS = /\b(Scouts?|scouts?|Reviewers?|reviewers?)\b/;

describe("roleLabel", () => {
  test("the flow's name wins; without a flow the shipped title, pluralised for a group", () => {
    expect(roleLabel("scout", named())).toEqual({ name: "Paco", plural: "Paco" });
    expect(roleLabel("scout")).toEqual({ name: "Scout", plural: "Scouts" });
    expect(roleLabel("scout", null).name).toBe("Scout");
  });
  test("a role the roster dropped falls back; the default flow prints the shipped flow names", () => {
    expect(roleLabel("verifier", { roster: [] }).name).toBe("Verifier");
    expect(roleLabel("scout", templateFlow()).name).toBe("Planner");
    expect(roleLabel("reviewer", templateFlow()).name).toBe("Inspector");
  });
  test("the main agent is the main agent whatever the flow says", () => {
    expect(roleLabel("orchestrator", named()).name).toBe("main agent");
  });
});

describe("a renamed role is the only name printed", () => {
  const flow = named();
  test("rule text, check, preset and test-it-now sentences", () => {
    const p = policy([everyRole]);
    const out = [
      thenWords(everyRole, flow), ruleLine(everyRole, flow), roleWord("scout", flow), fineTuneRow("reviewer", flow),
      ...flowNodes(p, holds, READY, flow).map((n) => n.sentence),
      ...testItNow(p, holds, READY, flow),
      ...checkSetup(p, [], READY, "global", flow).roles.map((r) => r.line),
      ...checkSetup(p, [], READY, "global", flow).rules.map((r) => r.line),
      ...presetOffers(READY, p, flow).flatMap((o) => o.says),
      ...presetDiagram(p, everyRole.workers!, flow).map((r) => r.word),
    ].join("\n");
    expect(out).toContain("Paco uses");
    expect(out).toContain("Ana uses");
    expect(out).toContain("Paco and Verifier keep the engines they have.");
    expect(out).not.toMatch(POLICY_WORDS);
  });
  test("the default flow keeps the shipped names", () => {
    expect(thenWords(everyRole, templateFlow())).toContain("Planner uses");
    expect(thenWords(everyRole)).toContain("Scout uses");
  });
  test("the rule sheet's group labels", () => {
    const html = renderToStaticMarkup(React.createElement(RuleSheet, {
      initial: everyRole, flow, policy: policy([everyRole]), readiness: READY, scope: "all projects", facts: holds,
      left: {}, now: new Date(0), onSave: async () => null, onCancel: () => {},
    }));
    expect(printed(html)).toContain("Paco");
    expect(printed(html)).toContain("Ana");
    expect(printed(html)).not.toMatch(POLICY_WORDS);
  });
  // The block panel moved to the Flow editor: its controls print the flow's name in flow-policy-controls.test.ts.
});
