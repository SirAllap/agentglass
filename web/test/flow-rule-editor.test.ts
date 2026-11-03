/*
 * The rule editor on the canvas. The rule it saves must be the rule the old rule
 * sheet saves for the same input, byte for byte: both build it with `buildRule`,
 * and the sheet's source is held to calling it, so a second way of building a
 * rule cannot creep back into either door.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { composePolicy, defaultStored, type Chain, type Policy, type PolicyRule, type Trigger } from "../../shared/orchestration.ts";
import { templateFlow } from "../../shared/flowTemplates.ts";
import type { Around } from "../src/components/orchestration/flow/AroundFlow.tsx";
import { buildRule, draftDirty, draftOf, draftRule, ruleProblem, setDraftChain, withField } from "../src/components/orchestration/ruleDraft.ts";
import { baseChainOf } from "../src/components/orchestration/flow/canvasRules.ts";
const { RuleEditor } = await import("../src/components/orchestration/flow/RuleEditor.tsx");

const DIR = join(import.meta.dir, "..", "src", "components", "orchestration");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const base = (): Policy => composePolicy(defaultStored(), {
  orchestrator: { engine: "claude", model: "sonnet" },
  workers: { scout: { engine: "claude", model: "sonnet" }, builder: { engine: "claude", model: "sonnet" }, reviewer: { engine: "claude", model: "sonnet" }, verifier: { engine: "claude", model: "haiku" } },
});
const chain = (...e: [string, string][]): Chain => e.map(([engine, model]) => ({ engine, model }));

/** Every kind of WHEN the rules have, so the equivalence covers each. */
const WHENS: Trigger[][] = [
  [{ kind: "always" }],
  [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 15 }],
  [{ kind: "usage", provider: "codex", window: "either", remainingAtMost: 5 }, { kind: "limit", provider: "opencode" }],
  [{ kind: "hours", days: [1, 2, 3, 4, 5], from: "23:00", to: "07:00" }, { kind: "budget" }],
];
const THENS: { orch?: Chain; workers: Partial<Record<"scout" | "builder" | "reviewer" | "verifier", Chain>> }[] = [
  { workers: { builder: chain(["opencode", "glm"]) } },
  { orch: chain(["claude", "haiku"]), workers: {} },
  { orch: chain(["claude", "haiku"]), workers: { reviewer: chain(["opencode", ""], ["claude", "sonnet"]), scout: chain(["claude", "haiku"]) } },
  { workers: { verifier: chain(["a", "1"], ["b", "2"], ["c", "3"], ["d", "4"]) } },
];

describe("the saved rule is the rule sheet's rule", () => {
  test("the sheet builds its rule with buildRule and judges it with ruleProblem; the canvas editor uses the same two", () => {
    const sheet = strip(readFileSync(join(DIR, "RuleForm.tsx"), "utf8"));
    expect(sheet).toContain("buildRule(");
    expect(sheet).toContain("ruleProblem(");
    expect(sheet).not.toMatch(/Object\.fromEntries\(ROLE_IDS/);
    const editor = strip(readFileSync(join(DIR, "flow", "RuleEditor.tsx"), "utf8"));
    expect(editor).toContain("ruleProblem(");
    expect(strip(readFileSync(join(DIR, "ruleDraft.ts"), "utf8"))).toContain("export function buildRule(");
  });
  test("for every kind of WHEN and every shape of THEN, the draft's rule and the sheet's parts give the same bytes", () => {
    const p = base();
    for (const when of WHENS) for (const then of THENS) {
      const sheet = buildRule({ id: null, name: "  Night shift ", when, enabled: true, orch: then.orch, workers: then.workers }, p);
      const canvas = draftRule({ ...draftOf(null, { when, name: "  Night shift ", orch: then.orch, workers: then.workers }) }, p);
      expect(JSON.stringify(canvas)).toBe(JSON.stringify(sheet));
    }
  });
  test("the stored shape is pinned: id from the name, trimmed name, orchestrator before workers, workers in role order", () => {
    const r = buildRule({ id: null, name: " Cheap Reviews ", when: [{ kind: "always" }], enabled: true, orch: chain(["claude", "haiku"]), workers: { verifier: chain(["claude", "haiku"]), scout: chain(["opencode", ""]) } }, base());
    expect(JSON.stringify(r)).toBe('{"id":"cheap-reviews","name":"Cheap Reviews","when":[{"kind":"always"}],"enabled":true,"orchestrator":[{"engine":"claude","model":"haiku"}],"workers":{"scout":[{"engine":"opencode","model":""}],"verifier":[{"engine":"claude","model":"haiku"}]}}');
  });
  test("an edited rule keeps its id and its switch", () => {
    const old: PolicyRule = { id: "keep-me", name: "Old", enabled: false, when: [{ kind: "always" }], workers: { builder: chain(["opencode", "glm"]) } };
    const r = draftRule({ ...draftOf(old), name: "New name" }, base());
    expect(r).toMatchObject({ id: "keep-me", name: "New name", enabled: false });
  });
  test("the two refusals use the sheet's sentences", () => {
    expect(ruleProblem({ name: " ", orch: undefined, workers: {} })).toBe("Give the rule a name: it is what the Lantern and the log show.");
    expect(ruleProblem({ name: "x", orch: undefined, workers: {} })).toBe("A rule has to change something: switch on the main agent or one of the jobs.");
    expect(ruleProblem({ name: "x", orch: undefined, workers: { builder: chain(["a", ""]) } })).toBeNull();
  });
});

describe("the draft", () => {
  test("pressing a block adds it with the chain it uses now; pressing it again changes nothing", () => {
    const p = base();
    const d = withField(draftOf(null), "builder", baseChainOf(p, "builder"));
    expect(d.workers.builder).toEqual(p.base.workers.builder.value);
    expect(withField(d, "builder", chain(["x", "y"])).workers.builder).toEqual(p.base.workers.builder.value);
    expect(withField(d, "orchestrator", baseChainOf(p, "orchestrator")).orch).toEqual(p.base.orchestrator.value);
  });
  test("switching a role off removes its chain and remembers it, so it fades instead of vanishing; adding it back clears that", () => {
    const p = base();
    let d = withField(draftOf(null), "reviewer", baseChainOf(p, "reviewer"));
    d = setDraftChain(d, "reviewer", undefined);
    expect(d.workers.reviewer).toBeUndefined();
    expect(d.off).toEqual(["reviewer"]);
    d = withField(d, "reviewer", baseChainOf(p, "reviewer"));
    expect(d.off).toEqual([]);
  });
  test("a rule with unsaved edits is dirty; the rule as it was is not", () => {
    const p = base();
    const old: PolicyRule = { id: "a", name: "A", enabled: true, when: [{ kind: "always" }], workers: { builder: chain(["opencode", "glm"]) } };
    expect(draftDirty(draftOf(old), old, p)).toBe(false);
    expect(draftDirty({ ...draftOf(old), name: "B" }, old, p)).toBe(true);
    expect(draftDirty(setDraftChain(draftOf(old), "builder", chain(["opencode", "glm"], ["claude", ""])), old, p)).toBe(true);
    expect(draftDirty(draftOf(null), null, p)).toBe(false);
    expect(draftDirty(draftOf(null, { name: "Night shift" }), null, p)).toBe(true);
  });
});

describe("the editor drawn", () => {
  const around = (): Around => ({
    root: "~/code/orbit", policy: base(), readiness: null, seat: null, gate: null, states: [], own: true, note: "",
    saveRule: async () => null, claim: async () => null, setGate: async () => {},
  } as unknown as Around);
  const html = (d = draftOf(null, { when: [{ kind: "usage", provider: "anthropic", window: "weekly", remainingAtMost: 15 }] }), initial: PolicyRule | null = null) =>
    renderToStaticMarkup(React.createElement(RuleEditor, { a: around(), flow: templateFlow(), policy: base(), initial, draft: d, onDraft() {}, onLeave() {}, onSaved() {}, onTested() {} }));
  test("a new rule: name, WHEN with its strip, the hint to press a block, the sentence, Test, Cancel and Save for the scope; no Delete", () => {
    const h = html();
    expect(h).toContain("Name this condition");
    expect(h).toContain("data-when");
    expect(h).toContain('data-strip="meter"');
    expect(h).toContain("Press a block on the canvas");
    expect(h).toContain("What this would do");
    expect(h).toContain("Test it now");
    expect(h).toContain("Save for orbit");
    expect(h).not.toContain("data-delete");
  });
  test("several lines say all must hold, the hours line draws the day strip with now, and a line can be added", () => {
    const h = html(draftOf(null, { when: [{ kind: "hours", days: [1, 2], from: "23:00", to: "07:00" }, { kind: "budget" }, { kind: "always" }] }));
    expect(h).toContain("all of these must hold");
    expect(h).toContain('data-strip="clock"');
    expect(h).toContain('data-mark="now"');
    expect(h).toContain("+ add a line");
  });
  test("a block in the rule shows its steps with the block panel's controls, up to four, then ask me", () => {
    const four = draftOf(null, { workers: { builder: chain(["opencode", "glm"], ["claude", "sonnet"], ["codex", ""], ["hermes", ""]) } });
    const h = html(four);
    expect(h).toContain("Builder uses, in order:");
    expect((h.match(/data-step="/g) ?? []).length).toBe(4);
    expect(h).toContain("4 steps at most. Then ask me.");
    expect(h).not.toContain("data-add-step");
    expect(h).toContain('data-ctl="engine"');
    expect(h).toContain("Model");
    const two = html(draftOf(null, { workers: { builder: chain(["opencode", "glm"], ["claude", "sonnet"]) } }));
    expect(two).toContain("data-add-step");
    expect(two).toContain("Then ask me.");
    expect(two).toContain("move step 1 up");
    expect(two).toContain("remove step 2");
  });
  test("the main agent is a role of the rule, and a role switched off says it keeps its usual choice", () => {
    const h = html(draftOf(null, { orch: chain(["claude", "haiku"]), off: ["scout"] }));
    expect(h).toContain("The main agent uses, in order:");
    expect(h).toContain("Role off in this rule");
  });
  test("an existing rule can be deleted", () => {
    const old: PolicyRule = { id: "a", name: "A", enabled: true, when: [{ kind: "always" }], workers: { builder: chain(["opencode", "glm"]) } };
    expect(html(draftOf(old), old)).toContain("data-delete");
  });
});
